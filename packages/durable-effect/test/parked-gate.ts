// Test helper: a gate that parks a tool call across a close and a reopen of a SQLite file, registered once per
// SQLite driver by a platform test file.

import type { JsonValue } from "@earendil-works/chord/json";
import type { TaskId, TaskRecord } from "@earendil-works/pi-durable";
import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { type DurableError, Extension, Gate, Harness, Hook, Signal, Storage, Tool } from "../src/index.ts";
import { answer, type FauxResponseStep, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";
import type { ClientLayer, WithDatabaseFile } from "./sqlite-suites.ts";

const Approval = Signal.make("test.approval", 1, Schema.Struct({ allow: Schema.Boolean, by: Schema.String }));

/** Registers the suite for one driver. */
export function registerParkedGate(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);

	describe(`a parked gate (${driver})`, () => {
		it("stays parked across a close and a reopen, and continues once when the signal arrives", () =>
			withDatabaseFile(async (filename) => {
				const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
				let runs = 0;
				// What an approvals host keeps: the task that asked, and what each pass of the gate read.
				const asked: TaskId[] = [];
				const passes: string[] = [];
				const parked = Promise.withResolvers<void>();
				const Write = Tool.make("write", {
					description: "Write a text.",
					parameters: Schema.Struct({ text: Schema.String }),
					success: Schema.String,
					handler: ({ text }) =>
						Effect.sync(() => {
							runs += 1;
							return `wrote ${text}`;
						}),
				});
				const Approvals = Hook.beforeTool((call, api) =>
					Effect.gen(function* () {
						const state = yield* api.readSignal(Approval, call.id);
						if (Option.isNone(state)) {
							passes.push("nothing yet");
							asked.push(api.taskId);
							parked.resolve();
							return Gate.park({ signals: [Approval.key(call.id)] });
						}
						if (state.value.kind === "expired") return Gate.block("No approval in time");
						passes.push(`${state.value.value.by}: ${state.value.value.allow}`);
						// The call continues with the value the signal brought.
						return state.value.value.allow
							? Gate.rewrite({ text: `${String(call.arguments.text)}, approved by ${state.value.value.by}` })
							: Gate.block("Not approved");
					}),
				);
				const harness = (responses: ReadonlyArray<FauxResponseStep>) =>
					TestHarness.layer({
						extensions: [Extension.make({ name: "approvals", tools: [Write], hooks: [Approvals] })],
						responses,
						storage,
					});
				const input = { type: "input", content: "Write hi.", requestId: "run" } as const;

				await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						yield* root.submit(input);
						yield* Effect.promise(() => parked.promise);
						yield* sleeping(asked[0]!, () => true);
					}).pipe(
						Effect.provide(harness([toolCall("write", { text: "hi" }, { id: "call-1" }), answer("Unused.")])),
					),
				);
				assert.deepEqual({ runs, asked: asked.length, passes }, { runs: 0, asked: 1, passes: ["nothing yet"] });

				const resumed = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						const submission = yield* root.submit(input);
						const taskId = asked[0]!;
						// Reopening wakes a parked gate, so the gates installed now decide (spec 7.2): it parks again.
						const before = yield* sleeping(taskId, () => passes.length === 2);
						const delivered = yield* Harness.signal(taskId, Approval, "call-1", { allow: true, by: "ada" });
						const again = yield* Harness.signal(taskId, Approval, "call-1", { allow: false, by: "bob" });
						const settled = yield* submission.wait;
						yield* Harness.waitForIdle;
						const late = yield* Harness.signal(taskId, Approval, "call-1", { allow: false, by: "eve" });
						const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
						const requests = yield* ScriptedModels.use((models) => models.callCount);
						return { before, delivered, again, late, settled, entries, requests };
					}).pipe(Effect.provide(harness([answer("Written.")]))),
				);
				assert.partialDeepEqual(resumed.before, {
					kind: "pi.tool",
					state: { status: "sleeping", signals: [{ signal: "test.approval", key: "call-1" }] },
				});
				assert.deepEqual([resumed.delivered, resumed.again, resumed.late], ["delivered", "duplicate", "closed"]);
				assert.strictEqual(runs, 1);
				assert.strictEqual(resumed.requests, 1);
				assert.partialDeepEqual(resumed.settled, { requestId: "run", status: "done" });
				// The pass of the first harness, the pass the reopen woke, and the pass the signal woke.
				assert.deepEqual(passes, ["nothing yet", "nothing yet", "ada: true"]);
				assert.deepEqual(
					resumed.entries.map((entry) => entry.kind),
					["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"],
				);
				assert.partialDeepEqual(resumed.entries[3]?.model?.[0], {
					role: "toolResult",
					isError: false,
					content: [{ type: "text", text: "wrote hi, approved by ada" }],
				});
				assert.partialDeepEqual(resumed.entries[4]?.model?.[0], {
					role: "assistant",
					content: [{ type: "text", text: "Written." }],
				});
			}));
	});
}

/** The record of the tool call `taskId` once `ready` holds and its park is stored: polls, since nothing announces it. */
function sleeping(
	taskId: TaskId,
	ready: () => boolean,
): Effect.Effect<TaskRecord<JsonValue, JsonValue, unknown>, DurableError, Harness.Harness> {
	return Effect.flatMap(Harness.getTask(taskId), (found) => {
		const record = Option.getOrThrow(found);
		return ready() && record.state.status === "sleeping"
			? Effect.succeed(record)
			: Effect.andThen(
					Effect.sleep("1 millis"),
					Effect.suspend(() => sleeping(taskId, ready)),
				);
	});
}
