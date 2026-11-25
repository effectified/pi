// The examples of README.md, as they stand there, each run once.

import { Extension, Gate, Harness, Hook, Registry, Storage } from "@gunta/pi-durable-effect";
import { answer, ScriptedModels, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { Advisory, Cursor, onStorageFork, Recorder, RecordSink, RecordSinkError, type Records } from "../src/index.ts";
import { Echo } from "./support.ts";

describe("README", () => {
	it("quick start: a run's records reach a store keyed by record id", async () => {
		// Your store, keyed by record id: a record that comes twice is written once.
		const store = new Map<string, Records.Record>();
		const Sink = Layer.succeed(RecordSink, {
			deliver: (records) =>
				Effect.sync(() => {
					for (const record of records) store.set(record.id, record);
				}),
		});

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			yield* root.prompt("Say hi.", { requestId: "greeting" });
			// Do not answer the caller before the record is written.
			yield* Recorder.flush(root.id);
			return [...store.keys()];
		});

		const live = Recorder.layer().pipe(
			Layer.provideMerge(TestHarness.layer({ responses: [answer("Hi.")] })),
			Layer.provide(Sink),
		);

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual([
			"1:8:0:message",
			"1:11:0:model",
			"1:11:0:message",
		]);
	});

	it("records: a product maps each kind onto its own command", async () => {
		const command = (record: Records.Record): string => {
			switch (record._tag) {
				case "Message":
					return `message ${record.role}: ${record.text}`;
				case "ModelCall":
					return record.stopReason === "error" || record.stopReason === "aborted"
						? `model call failed: ${record.error}`
						: `model call returned: ${record.usage.totalTokens} tokens, ${record.cost.total}`;
				case "ToolCallRequested":
					return `tool ${record.name} requested`;
				case "ToolCallResult":
					return record.isError
						? `tool ${record.name} failed: ${record.codes.join()}`
						: `tool ${record.name} returned`;
				case "Entry":
					return `entry ${record.kind}: ${JSON.stringify(record.data)}`;
				case "ModelCallRequested":
					return "model call requested";
			}
		};

		const commands: Array<string> = [];
		const Sink = Layer.succeed(RecordSink, {
			deliver: (records) => Effect.sync(() => void commands.push(...records.map(command))),
		});
		const Guards = Extension.make({
			name: "guards",
			hooks: [Hook.beforeTool((call) => Effect.succeed(call.name === "echo" ? Gate.block("not now") : Gate.allow))],
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "greeting" });
				// What a plugin stores beside the transcript, such as a review's verdict.
				yield* root.commit((tx) =>
					tx.appendEntry(root.id, { kind: "review.verdict", data: { outcome: "passed" } }),
				);
				yield* Recorder.flushAll;
			}).pipe(
				Effect.provide(
					Recorder.layer().pipe(
						Layer.provideMerge(
							TestHarness.layer({
								extensions: [Guards, Extension.make({ name: "app", tools: [Echo] }), Advisory.extension],
								responses: [toolCall("echo", { text: "hi" }), answer("It was refused.")],
							}),
						),
						Layer.provide(Sink),
					),
				),
			),
		);
		expect(commands.filter((line) => line !== "model call requested")).toEqual([
			"message user: Say hi.",
			expect.stringMatching(/^model call returned: \d+ tokens, 0$/),
			"tool echo requested",
			"tool echo failed: blocked",
			expect.stringMatching(/^model call returned: \d+ tokens, 0$/),
			"message assistant: It was refused.",
			'entry review.verdict: {"outcome":"passed"}',
		]);
		expect(commands.filter((line) => line === "model call requested")).toHaveLength(2);
	});

	it("the sink: a service of the product behind the port, idempotent by record id, retried by a schedule", async () => {
		// A service of your program: here, a table with an upsert.
		class Rows extends Context.Service<
			Rows,
			{ readonly upsert: (id: string, row: Records.Record) => Effect.Effect<void, Error> }
		>()("app/Rows") {}

		const Sink = Layer.effect(
			RecordSink,
			Effect.gen(function* () {
				const rows = yield* Rows;
				return {
					deliver: (records: ReadonlyArray<Records.Record>) =>
						Effect.forEach(records, (record) => rows.upsert(record.id, record), { discard: true }).pipe(
							Effect.mapError((cause) => new RecordSinkError({ cause })),
						),
				};
			}),
		);

		const live = Recorder.layer({ retry: Schedule.spaced("250 millis") });

		const table = new Map<string, Records.Record>();
		let writes = 0;
		const rows = Layer.succeed(Rows, {
			// The first write fails, so the pump delivers the batch a second time.
			upsert: (id, row) =>
				writes++ === 0 ? Effect.fail(new Error("busy")) : Effect.sync(() => void table.set(id, row)),
		});
		const again = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "greeting" });
				yield* Recorder.flush(root.id);
				// A delivery that comes twice changes nothing.
				const before = new Map(table);
				yield* RecordSink.use((sink) => sink.deliver([...table.values()]));
				return before;
			}).pipe(
				Effect.provide(live.pipe(Layer.provideMerge(TestHarness.layer({ responses: [answer("Hi.")] })))),
				Effect.provide(Sink),
				Effect.provide(rows),
			),
		);
		expect([...table.keys()]).toEqual(["1:8:0:message", "1:11:0:model", "1:11:0:message"]);
		expect(table).toEqual(again);
		expect(writes).toBe(7);
	});

	it("flush: the caller is answered once the records are in the sink", async () => {
		const answerTheCaller = Effect.gen(function* () {
			const root = yield* Harness.root;
			const settled = yield* root.prompt("Summarise record 42.", { requestId: "summary-42" });
			yield* Recorder.flush(root.id); // this conversation
			yield* Recorder.flushAll; // every conversation, a subagent's too
			return settled;
		});

		const stored: Array<Records.Record> = [];
		const Sink = Layer.succeed(RecordSink, { deliver: (records) => Effect.sync(() => void stored.push(...records)) });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				// The root exists, on the scripted model, before the example asks for it.
				yield* TestHarness.root;
				const settled = yield* answerTheCaller;
				return { settled, stored: stored.length };
			}).pipe(
				Effect.provide(
					Recorder.layer().pipe(
						Layer.provideMerge(TestHarness.layer({ responses: [answer("It is called Answer.")] })),
						Layer.provide(Sink),
					),
				),
			),
		);
		expect(result.settled.status).toBe("done");
		expect(result.stored).toBe(3);
	});

	it("the advisory record: the extension goes last in the registry, which then needs the sink", async () => {
		const Guards = Extension.make({
			name: "guards",
			hooks: [
				Hook.beforeTool((call) => Effect.succeed(call.name === "write" ? Gate.block("read only") : Gate.allow)),
			],
		});
		const App = Extension.make({ name: "app", tools: [Echo] });

		const registry = Registry.layer([Guards, App, Advisory.extension]);

		const stored: Array<Records.Record> = [];
		const Sink = Layer.succeed(RecordSink, { deliver: (records) => Effect.sync(() => void stored.push(...records)) });
		const harness = Harness.layer().pipe(
			Layer.provide(registry),
			Layer.provide(Storage.memory),
			Layer.provideMerge(ScriptedModels.layer({ api: "scripted" })),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses([answer("Hi.")]));
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "greeting" });
				yield* Recorder.flushAll;
			}).pipe(Effect.provide(Recorder.layer().pipe(Layer.provideMerge(harness), Layer.provide(Sink)))),
		);
		const notice = stored.find((record) => record._tag === "ModelCallRequested");
		const call = stored.find((record) => record._tag === "ModelCall");
		expect(notice).toMatchObject({ advisory: true, conversation: 1, task: call?.task });
		expect(notice?.after).toBeLessThan(call?.entry ?? 0);
		expect(stored.indexOf(notice!)).toBeLessThan(stored.indexOf(call!));
	});

	it("a forked storage: one Effect moves the cursors to the head", async () => {
		const onFork = onStorageFork; // Effect<void, DurableError, Harness>

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "greeting" });
				yield* onFork;
				return { head: Option.getOrThrow(yield* root.head), cursors: yield* Harness.snapshot(Cursor) };
			}).pipe(Effect.provide(TestHarness.layer({ responses: [answer("Hi.")] }))),
		);
		expect(result.cursors).toEqual(Option.some({ "1": result.head }));
	});
});
