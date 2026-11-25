// Test helper: the kill-and-resume suite (PRD section 10), registered once per SQLite driver by a platform test file.
//
// One scripted run on a SQLite file: an input, a model turn that calls the tool `write`, the tool, and a model turn
// that answers. A first harness is closed while the run stands at one boundary; a second harness on the same file lets
// it finish. The boundaries covered, in run order, each reached through a hook, the tool handler or the scripted model:
//
//   beforeRequest:1   the input is admitted and the first request prepared, not sent
//   request:1         the first model request is in flight
//   afterResponse:1   the first response arrived, not committed
//   beforeTool        the tool-calling answer is committed, the call not started (before its intent)
//   tool              the call's intent is committed and its handler runs
//   afterTool         the handler returned, its result not committed
//   afterTools        the tool result is committed, the round not ended
//   beforeRequest:2   the round ended and the second request is prepared, not sent
//   request:2         the second model request is in flight
//   afterResponse:2   the second response arrived, not committed
//   onYield           the answer is about to be committed
//   afterRun          the answer is committed and the input settled, the run not ended
//
// Not covered, because nothing of this package can stop a run there: the instants between one of Pi's commits and its
// next line of code (between the intent commit and the handler's start, for one), and a crash, which Pi counts
// differently from a close (Pi Durable README, "Failures and Recovery").

import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Extension, Gate, Harness, Hook, Storage, Tool } from "../src/index.ts";
import { answer, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";
import { normalise } from "./parity.ts";
import type { ClientLayer, WithDatabaseFile } from "./sqlite-suites.ts";

/** Everything an uninterrupted run reaches, in order. */
const RUN = [
	"beforeRequest:1",
	"request:1",
	"afterResponse:1",
	"beforeTool",
	"tool",
	"afterTool",
	"afterTools",
	"beforeRequest:2",
	"request:2",
	"afterResponse:2",
	"onYield",
	"afterRun",
] as const;

/** A place where the run can be stopped. */
type Boundary = (typeof RUN)[number];

/**
 * Where the second harness takes the run up after a stop at each boundary: the first step whose commit the close
 * came before. Pi documents each repeat: a request a close stopped, or whose answer was not committed, is sent again
 * (README, "Failures and Recovery": "A close is not a crash: a request it stopped is sent again"), hooks whose answer
 * was not committed are asked again (spec 7.2: "a crash before the consuming commit may rerun them"), and a call cut
 * off after its intent runs again only when the tool is replay-safe (spec 8.4, `execute`).
 */
const RESUMES_AT: Readonly<Record<Boundary, Boundary>> = {
	"beforeRequest:1": "beforeRequest:1",
	"request:1": "beforeRequest:1",
	"afterResponse:1": "beforeRequest:1",
	beforeTool: "beforeTool",
	tool: "tool",
	afterTool: "tool",
	afterTools: "afterTools",
	"beforeRequest:2": "beforeRequest:2",
	"request:2": "beforeRequest:2",
	"afterResponse:2": "beforeRequest:2",
	onYield: "beforeRequest:2",
	afterRun: "afterRun",
};

const INTERRUPTED = "Tool write was interrupted and may have partially run";

/** Registers the suite for one driver. */
export function registerKillResume(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);
	const play = (stopAt: Boundary | undefined, replay: "safe" | "unsafe") =>
		withDatabaseFile((filename) => run(client(filename), stopAt, replay));
	const requests = (reached: ReadonlyArray<Boundary>) => reached.filter((at) => at.startsWith("request:")).length;

	describe(`kill and resume (${driver})`, () => {
		it("an uninterrupted run reaches every boundary once and leaves five entries", async () => {
			const whole = await play(undefined, "unsafe");
			assert.deepEqual(whole.second, RUN);
			assert.deepEqual(whole.requests, [0, 2]);
			assert.partialDeepEqual(whole.settled, { requestId: "run", status: "done" });
			assert.deepEqual(
				whole.transcript.map((entry) => entry.kind),
				["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"],
			);
			assert.partialDeepEqual(whole.transcript[3], {
				model: [{ role: "toolResult", isError: false, content: [{ type: "text", text: "wrote hi" }] }],
			});
		});

		for (const stopAt of RUN) {
			it(`a close at ${stopAt} resumes without running an unsafe tool twice or doubling an entry`, async () => {
				const whole = await play(undefined, "unsafe");
				const resumed = await play(stopAt, "unsafe");
				// An unsafe call cut off after its intent never runs again: Pi writes its result instead.
				const cutOff = RESUMES_AT[stopAt] === "tool";
				const takenUpAt = cutOff ? "afterTool" : RESUMES_AT[stopAt];
				assert.deepEqual(resumed.first, RUN.slice(0, RUN.indexOf(stopAt) + 1));
				assert.deepEqual(resumed.second, RUN.slice(RUN.indexOf(takenUpAt)));
				assert.deepEqual(resumed.requests, [requests(resumed.first), requests(resumed.second)]);
				assert.strictEqual([...resumed.first, ...resumed.second].filter((at) => at === "tool").length, 1);
				assert.deepEqual(resumed.settled, whole.settled);
				if (!cutOff) {
					assert.deepEqual(resumed.transcript, whole.transcript);
					return;
				}
				// The same entries with the same ids; the tool's result says what happened, and the model answers it.
				assert.deepEqual(resumed.transcript.slice(0, 3), whole.transcript.slice(0, 3));
				assert.deepEqual(
					resumed.transcript.map((entry) => [entry.id, entry.kind]),
					whole.transcript.map((entry) => [entry.id, entry.kind]),
				);
				assert.partialDeepEqual(resumed.transcript[4], {
					model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Written." }] }],
				});
				assert.partialDeepEqual(resumed.transcript[3], {
					id: whole.transcript[3]?.id,
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "call-1",
							isError: true,
							content: [{ type: "text", text: `<harness>\n[error] ${INTERRUPTED}\n</harness>` }],
						},
					],
					data: { diagnostics: [{ severity: "error", code: "interrupted", message: INTERRUPTED }] },
				});
			});
		}

		for (const stopAt of ["tool", "afterTool"] as const) {
			it(`a close at ${stopAt} runs a replay-safe tool again, as Pi documents, and leaves the same transcript`, async () => {
				const whole = await play(undefined, "safe");
				const resumed = await play(stopAt, "safe");
				assert.deepEqual(resumed.first, RUN.slice(0, RUN.indexOf(stopAt) + 1));
				assert.deepEqual(resumed.second, RUN.slice(RUN.indexOf("tool")));
				assert.strictEqual([...resumed.first, ...resumed.second].filter((at) => at === "tool").length, 2);
				assert.deepEqual(resumed.requests, [1, 1]);
				assert.deepEqual(resumed.settled, whole.settled);
				assert.deepEqual(resumed.transcript, whole.transcript);
			});
		}
	});
}

/** What the scenario left: what each harness reached and was asked, how the input settled, and the transcript. */
interface Outcome {
	readonly first: ReadonlyArray<Boundary>;
	readonly second: ReadonlyArray<Boundary>;
	/** Model requests the first and the second harness received. */
	readonly requests: readonly [number, number];
	readonly settled: SettledSubmissionRecord;
	readonly transcript: ReadonlyArray<Record<string, unknown>>;
}

/** Runs the scenario on the database of `client`: with `stopAt` in two harnesses, without in one (`second`). */
async function run(
	client: Layer.Layer<SqlClient, SqlError>,
	stopAt: Boundary | undefined,
	replay: "safe" | "unsafe",
): Promise<Outcome> {
	const storage = Storage.sql().pipe(Layer.provide(client), Layer.orDie);
	const harness = (of: Leg) =>
		TestHarness.layer({ extensions: [of.extension], responses: [of.model, of.model, of.model], storage });
	const input = { type: "input", content: "Write hi.", requestId: "run" } as const;
	const first = leg(stopAt, replay);
	const firstRequests =
		stopAt === undefined
			? 0
			: await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						yield* root.submit(input);
						yield* Effect.promise(() => first.stopped);
						return yield* ScriptedModels.use((models) => models.callCount);
						// Leaving the scope closes the harness while the run stands at `stopAt`.
					}).pipe(Effect.provide(harness(first))),
				);
	const second = leg(undefined, replay);
	const finished = await Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* TestHarness.root;
			// The same request id finds the submission the first harness admitted.
			const submission = yield* root.submit(input);
			const settled = yield* submission.wait;
			yield* Harness.waitForIdle;
			const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
			return { settled, entries, requests: yield* ScriptedModels.use((models) => models.callCount) };
		}).pipe(Effect.provide(harness(second))),
	);
	return {
		first: first.reached,
		second: second.reached,
		requests: [firstRequests, finished.requests],
		settled: finished.settled,
		transcript: transcript(finished.entries),
	};
}

/** One harness of the scenario. */
type Leg = ReturnType<typeof leg>;

/** The extension and model of one harness: they record what the run reaches, and hold it at `stopAt`. */
function leg(stopAt: Boundary | undefined, replay: "safe" | "unsafe") {
	const reached: Boundary[] = [];
	const stopped = Promise.withResolvers<void>();
	/** Records that the run reached `boundary`, and says whether it stops there. */
	const mark = (boundary: Boundary): boolean => {
		reached.push(boundary);
		if (boundary !== stopAt) return false;
		stopped.resolve();
		return true;
	};
	/** A hook or handler step: at the stop it never returns, until the closing harness interrupts it. */
	const step = (boundary: Boundary): Effect.Effect<void> =>
		Effect.suspend(() => (mark(boundary) ? Effect.never : Effect.void));
	const none = <A>(boundary: Boundary): Effect.Effect<Option.Option<A>> => Effect.as(step(boundary), Option.none());
	// The model answers from what it is shown, so a request that is sent again gets the same turn.
	const model: FauxResponseFactory = (context, options) => {
		const second = context.messages.some((message) => message.role === "toolResult");
		const turn = second ? answer("Written.") : toolCall("write", { text: "hi" }, { id: "call-1" });
		if (!mark(second ? "request:2" : "request:1")) return turn;
		// A closing harness aborts the request; the scripted provider answers then, so its stream ends.
		return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(turn), { once: true }));
	};
	const Write = Tool.make("write", {
		description: "Write a text.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		replay,
		handler: ({ text }) => Effect.as(step("tool"), `wrote ${text}`),
	});
	const extension = Extension.make({
		name: "app",
		tools: [Write],
		hooks: [
			Hook.beforeRequest(({ messages }) =>
				none(messages.some((message) => message.role === "toolResult") ? "beforeRequest:2" : "beforeRequest:1"),
			),
			Hook.afterResponse((message) =>
				step(message.stopReason === "toolUse" ? "afterResponse:1" : "afterResponse:2"),
			),
			Hook.beforeTool(() => Effect.as(step("beforeTool"), Gate.allow)),
			Hook.afterTool(() => none("afterTool")),
			Hook.afterTools(() => none("afterTools")),
			Hook.onYield(() => none("onYield")),
			Hook.afterRun(() => none("afterRun")),
		],
	});
	return { reached, stopped: stopped.promise, extension, model };
}

/**
 * The entries as `normalise` leaves them, without the cache counts of a message's usage: the scripted provider
 * simulates a prompt cache per provider instance, and the second harness has a new one.
 */
function transcript(entries: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>> {
	return JSON.parse(
		JSON.stringify(normalise(entries), (key, field: unknown) =>
			key === "cacheRead" || key === "cacheWrite" ? undefined : field,
		),
	);
}
