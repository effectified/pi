// Test helper: a sink that keeps what it is given and can be told to fail or to wait, and the tools the tests call.

import { Extension, Gate, Hook, Tool } from "@gunta/pi-durable-effect";
import { Effect, Latch, Layer, Option, Schema } from "effect";
import { RecordSink, RecordSinkError, type Records } from "../src/index.ts";

/** What a test sink does with one call: nothing (the batch is stored), fail, or wait. */
export type Behaviour = (call: number, records: ReadonlyArray<Records.Record>) => Effect.Effect<void, RecordSinkError>;

/** A sink in memory, standing for a product's store: it outlives the harnesses of a test. */
export interface TestSink {
	readonly layer: Layer.Layer<RecordSink>;
	/** Every batch the sink was called with, in call order, whatever became of the call. */
	readonly attempts: Array<ReadonlyArray<Records.Record>>;
	/** Every record of a call that succeeded, in delivery order, duplicates included. */
	readonly stored: Array<Records.Record>;
	/** Succeeds once `holds` is true, asked now and after every call and every stored batch. */
	readonly when: (holds: () => boolean) => Effect.Effect<void>;
}

/** A sink that stores every batch `behaviour` lets through; without one, every batch. */
export function testSink(behaviour: Behaviour = () => Effect.void): TestSink {
	const attempts: Array<ReadonlyArray<Records.Record>> = [];
	const stored: Array<Records.Record> = [];
	const waits: Array<{ readonly holds: () => boolean; readonly latch: Latch.Latch }> = [];
	const changed = () => {
		for (const wait of waits) if (wait.holds()) wait.latch.openUnsafe();
	};
	const layer = Layer.succeed(RecordSink, {
		deliver: (records) =>
			Effect.suspend(() => {
				attempts.push(records);
				changed();
				return Effect.map(behaviour(attempts.length, records), () => {
					stored.push(...records);
					changed();
				});
			}),
	});
	const when = (holds: () => boolean) =>
		Effect.suspend(() => {
			if (holds()) return Effect.void;
			const latch = Latch.makeUnsafe();
			waits.push({ holds, latch });
			return latch.await;
		});
	return { layer, attempts, stored, when };
}

/** The failure of a test sink. */
export const refused = new RecordSinkError({ cause: new Error("the store is down") });

/** The records of entry-derived kinds only, in delivery order. */
export function committed(records: ReadonlyArray<Records.Record>): ReadonlyArray<Records.Record> {
	return records.filter((record) => !record.advisory);
}

/** The ids of `records`, in order. */
export function ids(records: ReadonlyArray<Records.Record>): ReadonlyArray<string> {
	return records.map((record) => record.id);
}

/** Says a text back. */
export const Echo = Tool.make("echo", {
	description: "Say it back.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
	handler: ({ text }) => Effect.succeed(text),
});

/** Returns an error result of its own. */
export const Fails = Tool.make("fails", {
	description: "Always fails.",
	parameters: Schema.Struct({}),
	success: Schema.String,
	handler: () => Effect.succeed(Tool.error("no such record", { details: { looked: 3 } })),
});

/** A tool a gate never lets run. */
export const Forbidden = Tool.make("forbidden", {
	description: "Never allowed.",
	parameters: Schema.Struct({}),
	success: Schema.String,
	handler: () => Effect.succeed("ran"),
});

/** A subagent: a conversation owned by the call's task, asked `task` and waited for. */
export const Subagent = Tool.make("subagent", {
	description: "Delegate a task to a subagent.",
	parameters: Schema.Struct({ task: Schema.String }),
	success: Schema.String,
	replay: "safe",
	handler: ({ task }, api) =>
		Effect.gen(function* () {
			const child = yield* api.commit((tx) =>
				Effect.gen(function* () {
					const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					yield* tx.configure(created.id, { tools: { remove: ["subagent"] } });
					return created.id;
				}),
			);
			const handle = Option.getOrThrow(yield* api.conversation(child));
			const submission = yield* handle.submit({ type: "input", content: task, requestId: `subagent:${api.taskId}` });
			const settled = yield* submission.wait;
			return settled.status === "done" ? `child ${child} answered` : Tool.error(`No answer: ${settled.reason}`);
		}),
});

/** The tools above, behind a gate that blocks `forbidden`. */
export const App = Extension.make({
	name: "app",
	tools: [Echo, Fails, Forbidden, Subagent],
	hooks: [Hook.beforeTool((call) => Effect.succeed(call.name === "forbidden" ? Gate.block("read only") : Gate.allow))],
});
