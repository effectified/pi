// Test helper: the recorder's kill-and-resume suite, registered once per SQLite driver by sqlite-suites.ts.
//
// One scripted run on a SQLite file: an input, a model turn that calls the tool `write`, the tool, and a model turn
// that answers. A first harness with its pump is closed while the run or the delivery stands at one place; a second
// harness with a new pump, on the same file and the same sink, finishes both. The places:
//
//   undelivered      entries are committed, the sink was handed a batch and stored nothing of it
//   unacknowledged   the sink stored a batch, and the pump never got to commit the cursor
//   request:1        the first model request is in flight
//   request:2        the second model request is in flight
//   tool             the tool's handler runs
//
// Not covered, because a test cannot stop a run there: a crash, which Pi counts differently from a close (a request it
// cut off is a failed attempt, and a response that arrived and was not committed leaves no entry and so no record).

import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { EntryRecord, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { Extension, Harness, Storage, Tool } from "@effectified/pi-durable";
import { answer, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { expect, it } from "vitest";
import { fromEntry } from "../src/from-entry.ts";
import { Advisory, Cursor, Recorder, RecordSink, type Records } from "../src/index.ts";
import { committed, ids } from "./support.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

/** Runs `use` with the path of a database file that is removed afterwards. */
export type WithDatabaseFile = <A>(use: (filename: string) => Promise<A>) => Promise<A>;

/** A place where the first harness is closed. */
type Stop = "undelivered" | "unacknowledged" | "request:1" | "request:2" | "tool";

const INTERRUPTED = "Tool write was interrupted and may have partially run";

/** Registers the suite's cases inside a `describe` of the caller. */
export function registerKillResume(client: ClientLayer, withDatabaseFile: WithDatabaseFile): void {
	const play = (stopAt: Stop | undefined, replay: "safe" | "unsafe" = "unsafe") =>
		withDatabaseFile((filename) => run(client(filename), stopAt, replay));

	it("an uninterrupted run delivers every record once: eight from entries, two notices of requests", async () => {
		const whole = await play(undefined);
		expect(whole.first).toEqual([]);
		expect(whole.settled).toMatchObject({ requestId: "run", status: "done" });
		expect(whole.entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		expect(committed(whole.second)).toEqual(whole.entries.flatMap(fromEntry));
		expect(committed(whole.second).map((record) => record._tag)).toEqual([
			"Message",
			"ModelCall",
			"ToolCallRequested",
			"ToolCallResult",
			"ModelCall",
			"Message",
		]);
		expect(whole.second.filter((record) => record.advisory)).toHaveLength(2);
		expect(new Set(ids(whole.second)).size).toBe(8);
		expect(whole.cursor).toBe(whole.entries.at(-1)?.id);
	});

	it("a close after the entries are committed and before delivery loses nothing: the next pump delivers them", async () => {
		const whole = await play(undefined);
		const resumed = await play("undelivered");
		expectNothingLostOrChanged(resumed, whole);
		// The first harness committed the whole run and delivered none of it.
		expect(resumed.entriesAtClose).toBe(5);
		expect(committed(resumed.first)).toEqual([]);
		expect(resumed.cursorAtClose).toBeUndefined();
		// So nothing is delivered twice, and the second pump delivers in entry order.
		expect(ids(committed(resumed.second))).toEqual(ids(committed(whole.second)));
		expect(normalised(resumed)).toEqual(normalised(whole));
	});

	it("a close after delivery and before the cursor commit delivers that batch again, with the same ids and content", async () => {
		const whole = await play(undefined);
		const resumed = await play("unacknowledged");
		expectNothingLostOrChanged(resumed, whole);
		// The sink stored a batch, and the cursor never moved.
		const twice = committed(resumed.first);
		expect(twice.length).toBeGreaterThan(0);
		expect(resumed.cursorAtClose).toBeUndefined();
		// The second pump starts from the cursor: the whole run again, the stored batch included.
		expect(committed(resumed.second)).toEqual(resumed.entries.flatMap(fromEntry));
		expect(committed(resumed.second).slice(0, twice.length)).toEqual(twice);
		const counts = occurrences([...resumed.first, ...resumed.second]);
		expect([...counts].filter(([, count]) => count > 1).map(([id]) => id)).toEqual(ids(twice));
		expect(normalised(resumed)).toEqual(normalised(whole));
	});

	for (const stopAt of ["request:1", "request:2"] as const) {
		it(`a close during ${stopAt} sends the request again, as Pi documents, and records the run as uninterrupted`, async () => {
			const whole = await play(undefined);
			const resumed = await play(stopAt);
			expectNothingLostOrChanged(resumed, whole);
			// A close is not a crash: the stopped request left no entry, so no model call record of an aborted attempt.
			expect(modelCalls(resumed).map((call) => call.stopReason)).toEqual(["toolUse", "stop"]);
			expect(resumed.requests).toEqual(stopAt === "request:1" ? [1, 2] : [2, 1]);
			// Pi asked the hook again for the request it sends again: the same notice, twice, with the time of the first.
			const notices = [...resumed.first, ...resumed.second].filter((record) => record.advisory);
			const repeated = [...occurrences(notices)].filter(([, count]) => count > 1).map(([id]) => id);
			expect(repeated).toEqual([resumed.first.findLast((record) => record.advisory)?.id]);
			expect(normalised(resumed)).toEqual(normalised(whole));
		});
	}

	it("a close during a replay-unsafe tool call records the interrupted result Pi writes, under the same ids", async () => {
		const whole = await play(undefined);
		const resumed = await play("tool");
		expectNothingLostOrChanged(resumed, whole);
		expect(resumed.toolRuns).toEqual([1, 0]);
		// The documented difference (spec 8.4, `execute`): the call never runs again, and its result says so.
		const result = (outcome: Outcome) =>
			[...outcome.first, ...outcome.second].find((r) => r._tag === "ToolCallResult");
		expect(result(whole)).toMatchObject({ isError: false, codes: [], text: "wrote hi" });
		expect(result(resumed)).toMatchObject({
			id: result(whole)?.id,
			callId: "call-1",
			name: "write",
			isError: true,
			codes: ["interrupted"],
			diagnostics: [{ severity: "error", code: "interrupted", message: INTERRUPTED }],
			text: `<harness>\n[error] ${INTERRUPTED}\n</harness>`,
		});
		// Every other record is the uninterrupted run's.
		const others = (outcome: Outcome) => normalised(outcome).filter((record) => record._tag !== "ToolCallResult");
		expect(others(resumed)).toEqual(others(whole));
	});

	it("a close during a replay-safe tool call runs the tool again and records the run as uninterrupted", async () => {
		const whole = await play(undefined, "safe");
		const resumed = await play("tool", "safe");
		expectNothingLostOrChanged(resumed, whole);
		expect(resumed.toolRuns).toEqual([1, 1]);
		expect(normalised(resumed)).toEqual(normalised(whole));
	});
}

/**
 * What every case must hold. Across both harnesses every record id of the uninterrupted run was delivered at least
 * once and no other, a record delivered more than once has the same content each time, every record is what the
 * committed entries give, and the cursor ends at the newest entry.
 */
function expectNothingLostOrChanged(resumed: Outcome, whole: Outcome): void {
	const all = [...resumed.first, ...resumed.second];
	expect(new Set(ids(all))).toEqual(new Set(ids(whole.second)));
	const first = new Map<string, Records.Record>();
	for (const record of all) if (!first.has(record.id)) first.set(record.id, record);
	// Every delivery of a record equals its first.
	expect(all).toEqual(all.map((record) => first.get(record.id)));
	const derived = resumed.entries.flatMap(fromEntry);
	expect([...ids(committed([...first.values()]))].sort()).toEqual([...ids(derived)].sort());
	for (const record of derived) expect(first.get(record.id)).toEqual(record);
	expect(resumed.settled).toEqual(whole.settled);
	expect(resumed.cursor).toBe(resumed.entries.at(-1)?.id);
	expect(resumed.entries.map((entry) => [entry.id, entry.kind])).toEqual(
		whole.entries.map((entry) => [entry.id, entry.kind]),
	);
}

/** How often each record id was delivered. */
function occurrences(records: ReadonlyArray<Records.Record>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
	return counts;
}

function modelCalls(outcome: Outcome): ReadonlyArray<Records.ModelCall> {
	return unique(outcome).filter((record) => record._tag === "ModelCall");
}

/** The records of both harnesses, each id once, ordered by id. */
function unique(outcome: Outcome): ReadonlyArray<Records.Record> {
	const byId = new Map([...outcome.first, ...outcome.second].map((record) => [record.id, record]));
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/**
 * `unique` without what differs between two runs of the same script: clock times, durations, and the token counts
 * of the scripted provider, which simulates a prompt cache per provider instance, and the second harness has a new one.
 */
function normalised(outcome: Outcome): ReadonlyArray<Record<string, unknown>> {
	return unique(outcome).map((record) => {
		const { time: _time, ...rest } = record;
		if (rest._tag === "ModelCall") return { ...rest, durationMs: null, usage: null };
		if (rest._tag === "ToolCallResult") return { ...rest, durationMs: null };
		return rest;
	});
}

/** What the scenario left. */
interface Outcome {
	/** What the sink stored while the first harness ran, in order; empty without a stop. */
	readonly first: ReadonlyArray<Records.Record>;
	/** What it stored while the second harness ran. */
	readonly second: ReadonlyArray<Records.Record>;
	/** The root's cursor when the first harness closed; undefined when it had none, or without a stop. */
	readonly cursorAtClose: number | undefined;
	/** The entries the root had when the first harness closed. */
	readonly entriesAtClose: number;
	/** The root's cursor at the end. */
	readonly cursor: number | undefined;
	/** Model requests the first and the second harness received. */
	readonly requests: readonly [number, number];
	/** Runs of the tool's handler in the first and the second harness. */
	readonly toolRuns: readonly [number, number];
	readonly settled: SettledSubmissionRecord;
	readonly entries: ReadonlyArray<EntryRecord>;
}

/** Runs the scenario on the database of `client`: with `stopAt` in two harnesses, without in one (`second`). */
async function run(
	client: Layer.Layer<SqlClient, SqlError>,
	stopAt: Stop | undefined,
	replay: "safe" | "unsafe",
): Promise<Outcome> {
	const storage = Storage.sql().pipe(Layer.provide(client), Layer.orDie);
	const live = (of: Leg) =>
		Recorder.layer().pipe(
			Layer.provideMerge(
				TestHarness.layer({
					extensions: [of.extension, Advisory.extension],
					responses: [of.model, of.model, of.model],
					storage,
				}),
			),
			Layer.provide(of.sink),
		);
	const input = { type: "input", content: "Write hi.", requestId: "run" } as const;
	const cursorOf = Effect.map(Harness.snapshot(Cursor), (cursors) => Option.getOrUndefined(cursors)?.[1]);
	const first = leg(stopAt, replay);
	const closed =
		stopAt === undefined
			? { cursor: undefined, entries: 0 }
			: await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						const submission = yield* root.submit(input);
						// A stop in the delivery lets the run finish first, so the close cuts off nothing else.
						if (stopAt === "undelivered" || stopAt === "unacknowledged") yield* submission.wait;
						yield* Effect.promise(() => first.stopped);
						const entries = yield* Stream.runCollect(root.entries());
						return { cursor: yield* cursorOf, entries: entries.length };
						// Leaving the scope closes the pump and the harness where they stand.
					}).pipe(Effect.provide(live(first))),
				);
	const second = leg(undefined, replay);
	const finished = await Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* TestHarness.root;
			// The same request id finds the submission the first harness admitted.
			const submission = yield* root.submit(input);
			const settled = yield* submission.wait;
			yield* Harness.waitForIdle;
			yield* Recorder.flushAll;
			const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
			return { settled, entries, cursor: yield* cursorOf };
		}).pipe(Effect.provide(live(second))),
	);
	return {
		first: first.stored,
		second: second.stored,
		cursorAtClose: closed.cursor,
		entriesAtClose: closed.entries,
		cursor: finished.cursor,
		requests: [first.counts.requests, second.counts.requests],
		toolRuns: [first.counts.tool, second.counts.tool],
		settled: finished.settled,
		entries: finished.entries,
	};
}

/** One harness of the scenario. */
type Leg = ReturnType<typeof leg>;

/** The model, the tool and the sink of one harness: they count what happens, and hold the run or the delivery at `stopAt`. */
function leg(stopAt: Stop | undefined, replay: "safe" | "unsafe") {
	const stored: Array<Records.Record> = [];
	const counts = { requests: 0, tool: 0 };
	const stopped = Promise.withResolvers<void>();
	/** Never returns: the closing harness, or the closing pump, interrupts it. */
	const hold = Effect.suspend(() => {
		stopped.resolve();
		return Effect.never;
	});
	// The model answers from what it is shown, so a request that is sent again gets the same turn.
	const model: FauxResponseFactory = (context, options) => {
		counts.requests += 1;
		const second = context.messages.some((message) => message.role === "toolResult");
		const turn = second ? answer("Written.") : toolCall("write", { text: "hi" }, { id: "call-1" });
		if (stopAt !== (second ? "request:2" : "request:1")) return turn;
		stopped.resolve();
		// A closing harness aborts the request; the scripted provider answers then, so its stream ends.
		return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(turn), { once: true }));
	};
	const Write = Tool.make("write", {
		description: "Write a text.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		replay,
		handler: ({ text }) =>
			Effect.suspend(() => {
				counts.tool += 1;
				return stopAt === "tool" ? hold : Effect.succeed(`wrote ${text}`);
			}),
	});
	const sink = Layer.succeed(RecordSink, {
		deliver: (records) =>
			Effect.suspend(() => {
				// A notice comes from a hook that holds its model request, so the stops in the delivery let it through.
				const notice = records.every((record) => record.advisory);
				if (stopAt === "undelivered" && !notice) return hold;
				stored.push(...records);
				return stopAt === "unacknowledged" && !notice ? hold : Effect.void;
			}),
	});
	return {
		stored,
		counts,
		stopped: stopped.promise,
		model,
		sink,
		extension: Extension.make({ name: "app", tools: [Write] }),
	};
}
