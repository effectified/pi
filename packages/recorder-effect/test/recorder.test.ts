import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Harness } from "@effectified/pi-durable";
import { answer, type FauxResponseStep, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Fiber, Latch, Layer, Option, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { fromEntry } from "../src/from-entry.ts";
import { Cursor, Recorder } from "../src/index.ts";
import { App, ids, refused, type TestSink, testSink } from "./support.ts";

/** A harness on scripted responses with the test tools; a failed model response is not tried again. */
function harness(responses: ReadonlyArray<FauxResponseStep>) {
	return TestHarness.layer({
		extensions: [App],
		responses,
		harness: { settings: { retry: { enabled: false } } },
	});
}

/** The harness with a running pump that delivers to `sink`. */
function recorded(responses: ReadonlyArray<FauxResponseStep>, sink: TestSink, options?: Recorder.Options) {
	return Recorder.layer(options).pipe(Layer.provideMerge(harness(responses)), Layer.provide(sink.layer));
}

/** Two turns: the first calls `echo` and answers, the second answers. Fixed call id and timestamps. */
const TWO_TURNS = [
	fauxAssistantMessage([fauxText("Calling."), fauxToolCall("echo", { text: "hi" }, { id: "call-1" })], {
		stopReason: "toolUse",
		timestamp: 111,
	}),
	fauxAssistantMessage([fauxText("Said.")], { timestamp: 222 }),
	fauxAssistantMessage([fauxText("Again said.")], { timestamp: 333 }),
];

const twoTurns = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	yield* root.prompt("Say hi.", { requestId: "one" });
	yield* root.prompt("Again.", { requestId: "two" });
	yield* root.waitForIdle;
	return yield* Stream.runCollect(root.entries({ order: "ascending" }));
});

/** The cursor of a conversation: the entry its records are delivered through, 0 while it has none. */
const delivered = (conversationId: ConversationId) =>
	Effect.map(Harness.snapshot(Cursor), (cursors) => Option.getOrUndefined(cursors)?.[conversationId] ?? 0);

/** A run stored before any pump exists, then delivered by a pump built on it: `sink` gets what recovery delivers. */
const recovered = (sink: TestSink) =>
	Effect.gen(function* () {
		const entries = yield* twoTurns;
		yield* Recorder.flushAll.pipe(Effect.provide(Recorder.layer()));
		return entries;
	}).pipe(Effect.provide(harness(TWO_TURNS)), Effect.provide(sink.layer));

describe("Recorder.layer", () => {
	it("delivers exactly the records of a two-turn run with one tool call, in order, with their ids", async () => {
		const sink = testSink();
		const entries = await Effect.runPromise(recovered(sink));
		expect(entries.map((entry) => [entry.id, entry.kind])).toEqual([
			[7, "pi.user"],
			[10, "pi.system"],
			[11, "pi.assistant"],
			[13, "pi.tool-result"],
			[15, "pi.assistant"],
			[16, "pi.user"],
			[19, "pi.assistant"],
		]);
		const model = { provider: "faux", model: "faux-1", api: "scripted", responseModel: null, responseId: null };
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, fromProvider: false };
		const tokens = { input: 0, cacheWrite1h: null, reasoning: null };
		const from = (entry: number, time: unknown) => ({ conversation: 1, entry, time, advisory: false });
		const clock = expect.any(Number);
		expect(sink.stored).toEqual([
			{
				_tag: "Message",
				id: "1:7:0:message",
				...from(7, clock),
				role: "user",
				entryKind: "pi.user",
				text: "Say hi.",
				images: [],
			},
			{
				_tag: "ModelCall",
				id: "1:11:0:model",
				...from(11, 111),
				task: 9,
				...model,
				stopReason: "toolUse",
				error: null,
				usage: { ...tokens, output: 7, cacheRead: 0, cacheWrite: 143, totalTokens: 150 },
				cost: zero,
				durationMs: null,
			},
			{
				_tag: "Message",
				id: "1:11:0:message",
				...from(11, 111),
				role: "assistant",
				entryKind: "pi.assistant",
				text: "Calling.",
				images: [],
			},
			{
				_tag: "ToolCallRequested",
				id: "1:11:0:call:0",
				...from(11, 111),
				callId: "call-1",
				name: "echo",
				arguments: { text: "hi" },
				argumentsError: null,
			},
			{
				_tag: "ToolCallResult",
				id: "1:13:0:result",
				...from(13, clock),
				callId: "call-1",
				name: "echo",
				isError: false,
				codes: [],
				diagnostics: [],
				text: "hi",
				images: [],
				details: null,
				usage: null,
				cost: null,
				durationMs: clock,
			},
			{
				_tag: "ModelCall",
				id: "1:15:0:model",
				...from(15, 222),
				task: 14,
				...model,
				stopReason: "stop",
				error: null,
				usage: { ...tokens, output: 2, cacheRead: 143, cacheWrite: 14, totalTokens: 159 },
				cost: zero,
				durationMs: null,
			},
			{
				_tag: "Message",
				id: "1:15:0:message",
				...from(15, 222),
				role: "assistant",
				entryKind: "pi.assistant",
				text: "Said.",
				images: [],
			},
			{
				_tag: "Message",
				id: "1:16:0:message",
				...from(16, clock),
				role: "user",
				entryKind: "pi.user",
				text: "Again.",
				images: [],
			},
			{
				_tag: "ModelCall",
				id: "1:19:0:model",
				...from(19, 333),
				task: 18,
				...model,
				stopReason: "stop",
				error: null,
				usage: { ...tokens, output: 3, cacheRead: 157, cacheWrite: 8, totalTokens: 168 },
				cost: zero,
				durationMs: null,
			},
			{
				_tag: "Message",
				id: "1:19:0:message",
				...from(19, 333),
				role: "assistant",
				entryKind: "pi.assistant",
				text: "Again said.",
				images: [],
			},
		]);
		// The whole run was there when the pump started: one batch.
		expect(sink.attempts).toHaveLength(1);
	});

	it("gives a second identical run on a fresh storage the same ids, with a pump started late or running", async () => {
		const late = [testSink(), testSink()] as const;
		for (const sink of late) await Effect.runPromise(recovered(sink));
		expect(ids(late[1].stored)).toEqual(ids(late[0].stored));
		expect(ids(late[0].stored)).toHaveLength(10);
		const running = [testSink(), testSink()] as const;
		for (const sink of running) {
			await Effect.runPromise(
				Effect.andThen(twoTurns, Recorder.flushAll).pipe(Effect.provide(recorded(TWO_TURNS, sink))),
			);
		}
		expect(ids(running[1].stored)).toEqual(ids(running[0].stored));
		// The cursor document a pump creates when it starts takes one id of Pi's counter: every entry id is one higher.
		expect(ids(running[0].stored)).toEqual([
			"1:8:0:message",
			"1:12:0:model",
			"1:12:0:message",
			"1:12:0:call:0",
			"1:14:0:result",
			"1:16:0:model",
			"1:16:0:message",
			"1:17:0:message",
			"1:20:0:model",
			"1:20:0:message",
		]);
	});

	it("follows a run as it commits, without a flush: every entry's records once, in entry order", async () => {
		const sink = testSink();
		const result = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				yield* sink.when(() => sink.stored.length === 7);
				const first = sink.attempts.length;
				yield* root.prompt("Again.", { requestId: "two" });
				yield* sink.when(() => sink.stored.length === 10);
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				// The cursor's commit follows the sink's success.
				yield* sink.when(() => sink.attempts.length > first);
				yield* Recorder.flush(root.id);
				return { entries, first, cursor: yield* delivered(root.id) };
			}).pipe(Effect.provide(recorded(TWO_TURNS, sink))),
		);
		expect(sink.stored).toEqual(result.entries.flatMap(fromEntry));
		expect(ids(sink.stored)).toEqual(
			[
				[0, "message"],
				[2, "model"],
				[2, "message"],
				[2, "call:0"],
				[3, "result"],
				[4, "model"],
				[4, "message"],
				[5, "message"],
				[6, "model"],
				[6, "message"],
			].map(([index, part]) => `1:${result.entries[Number(index)]?.id}:0:${part}`),
		);
		expect(result.cursor).toBe(result.entries.at(-1)?.id);
		// The second turn came in a batch of its own, and no batch is empty.
		expect(sink.attempts.length).toBeGreaterThan(result.first);
		expect(sink.attempts.every((batch) => batch.length > 0)).toBe(true);
	});

	it("gives a failing sink the same batch again, and moves the cursor only once the sink took it", async () => {
		const fourth = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// Three failures, then a call that holds until the test has looked at the cursor.
		const sink = testSink((call) => {
			if (call <= 3) return Effect.fail(refused);
			fourth.resolve();
			return Effect.promise(() => release.promise);
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				yield* root.waitForIdle;
				const head = Option.getOrThrow(yield* root.head);
				return yield* Effect.gen(function* () {
					yield* Effect.promise(() => fourth.promise);
					const during = yield* delivered(root.id);
					release.resolve();
					yield* Recorder.flush(root.id);
					return { head, during, after: yield* delivered(root.id) };
				}).pipe(Effect.provide(Recorder.layer({ retry: Schedule.spaced("1 millis") })));
			}).pipe(Effect.provide(harness([answer("Hi.")])), Effect.provide(sink.layer)),
		);
		expect(sink.attempts).toHaveLength(4);
		expect(ids(sink.attempts[0]!)).toEqual(["1:7:0:message", "1:11:0:model", "1:11:0:message"]);
		for (const again of sink.attempts.slice(1)) expect(again).toEqual(sink.attempts[0]);
		expect(result.during).toBe(0);
		expect(result.after).toBe(result.head);
		expect(sink.stored).toEqual(sink.attempts[0]);
	});

	it("fails a flush when the retry schedule ends, loses nothing, and delivers at the next flush", async () => {
		let down = true;
		const sink = testSink(() => (down ? Effect.fail(refused) : Effect.void));
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				yield* root.waitForIdle;
				return yield* Effect.gen(function* () {
					const failed = yield* Effect.flip(Recorder.flush(root.id));
					const between = yield* delivered(root.id);
					const tried = sink.attempts.length;
					down = false;
					yield* Recorder.flushAll;
					return { failed, between, tried, after: yield* delivered(root.id) };
				}).pipe(Effect.provide(Recorder.layer({ retry: Schedule.recurs(1) })));
			}).pipe(Effect.provide(harness([answer("Hi.")])), Effect.provide(sink.layer)),
		);
		expect(result.failed).toBe(refused);
		// One try and one retry by the flush; the pump's own attempt may have made two more.
		expect(result.tried).toBeGreaterThanOrEqual(2);
		expect(result.between).toBe(0);
		expect(result.after).toBe(11);
		for (const again of sink.attempts) expect(again).toEqual(sink.attempts[0]);
		expect(ids(sink.stored)).toEqual(["1:7:0:message", "1:11:0:model", "1:11:0:message"]);
	});

	it("records a tool's own error result and a blocked call as error results, told apart by the code", async () => {
		const sink = testSink();
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Try both.", { requestId: "one" });
				yield* Recorder.flushAll;
			}).pipe(
				Effect.provide(
					recorded(
						[
							toolCall("fails", {}, { id: "call-f" }),
							toolCall("forbidden", {}, { id: "call-b" }),
							answer("Neither worked."),
						],
						sink,
					),
				),
			),
		);
		const results = sink.stored.filter((record) => record._tag === "ToolCallResult");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			callId: "call-f",
			name: "fails",
			isError: true,
			codes: [],
			diagnostics: [],
			text: "no such record",
			details: { looked: 3 },
		});
		expect(results[1]).toMatchObject({
			callId: "call-b",
			name: "forbidden",
			isError: true,
			codes: ["blocked"],
			diagnostics: [{ severity: "error", code: "blocked", message: "Tool call blocked: read only" }],
			text: "<harness>\n[error] Tool call blocked: read only\n</harness>",
			details: null,
		});
		expect(sink.stored.filter((record) => record._tag === "ToolCallRequested").map((call) => call.callId)).toEqual([
			"call-f",
			"call-b",
		]);
	});

	it("records a failed model attempt from the entry Pi commits for it, with its error text and usage", async () => {
		const sink = testSink();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("Say hi.", { requestId: "one" });
				yield* Recorder.flushAll;
				return { settled, ledger: yield* Harness.usage };
			}).pipe(
				Effect.provide(
					recorded([fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" })], sink),
				),
			),
		);
		expect(result.settled).toMatchObject({
			status: "unanswered",
			reason: "model_error",
			detail: "provider exploded",
		});
		expect(sink.stored.map((record) => record._tag)).toEqual(["Message", "ModelCall"]);
		const failed = sink.stored[1];
		expect(failed).toMatchObject({
			_tag: "ModelCall",
			stopReason: "error",
			error: "provider exploded",
			advisory: false,
		});
		// Pi adds the failed attempt's usage to its ledger in the commit that stores the entry: the record has the same.
		expect(failed?._tag === "ModelCall" && failed.usage.totalTokens).toBe(
			result.ledger.models["faux/faux-1"]?.totalTokens,
		);
	});

	it("delivers a fork's own entries only, and starts its cursor at the entry it was forked at", async () => {
		const sink = testSink();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				yield* Recorder.flushAll;
				const before = sink.stored.length;
				const at = Option.getOrThrow(yield* root.head);
				const fork = yield* root.fork({ at, ownership: { kind: "ownerless" } });
				// An empty fork has nothing of its own: a flush of it delivers nothing.
				yield* Recorder.flush(fork.id);
				const empty = sink.stored.length - before;
				yield* fork.prompt("Now the opposite.", { requestId: "two" });
				yield* root.prompt("And you?", { requestId: "three" });
				yield* Recorder.flushAll;
				const visible = yield* Stream.runCollect(fork.entries({ order: "ascending" }));
				return { fork: fork.id, at, before, empty, visible, cursor: yield* delivered(fork.id) };
			}).pipe(Effect.provide(recorded([answer("Hi."), answer("Bye."), answer("Me too.")], sink))),
		);
		const own = result.visible.filter((entry) => entry.conversationId === result.fork);
		// The fork sees its parent's entries, and they are not its to deliver.
		expect(result.visible.length).toBeGreaterThan(own.length);
		expect(result.empty).toBe(0);
		expect(sink.stored.filter((record) => record.conversation === result.fork)).toEqual(own.flatMap(fromEntry));
		expect(own.flatMap(fromEntry).map((record) => record._tag)).toEqual(["Message", "ModelCall", "Message"]);
		expect(new Set(ids(sink.stored)).size).toBe(sink.stored.length);
		expect(result.cursor).toBe(own.at(-1)?.id);
	});

	it("records a task-owned child conversation, under the child's id", async () => {
		const sink = testSink();
		const child = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Delegate.", { requestId: "one" });
				yield* Harness.waitForIdle;
				yield* Recorder.flushAll;
				const owned = yield* Harness.commit((tx) => tx.scanConversations({}, 10));
				return owned.items.find((conversation) => conversation.owner !== undefined);
			}).pipe(
				Effect.provide(
					recorded(
						[
							toolCall("subagent", { task: "Count to three." }, { id: "call-s" }),
							answer("One, two, three."),
							answer("The subagent counted."),
						],
						sink,
					),
				),
			),
		);
		expect(child?.owner?.conversationId).toBe(1);
		const records = sink.stored.filter((record) => record.conversation === child?.id);
		expect(records.map((record) => [record._tag, record._tag === "Message" ? record.text : null])).toEqual([
			["Message", "Count to three."],
			["ModelCall", null],
			["Message", "One, two, three."],
		]);
		const result = sink.stored.find((record) => record._tag === "ToolCallResult");
		expect(result).toMatchObject({
			conversation: 1,
			callId: "call-s",
			isError: false,
			text: `child ${child?.id} answered`,
		});
		expect(new Set(ids(sink.stored)).size).toBe(sink.stored.length);
	});

	it("delivers a long history in batches of a hundred entries, in order", async () => {
		const sink = testSink();
		const cursor = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.commit((tx) =>
					Effect.forEach(Array.from({ length: 250 }), (_, index) =>
						tx.appendEntry(root.id, {
							kind: "app.import",
							model: [{ role: "user", content: `line ${index}`, timestamp: index }],
						}),
					),
				);
				yield* Recorder.flush(root.id);
				return yield* delivered(root.id);
			}).pipe(Effect.provide(recorded([], sink))),
		);
		expect(sink.attempts.map((batch) => batch.length)).toEqual([100, 100, 50]);
		expect(sink.stored.map((record) => record._tag === "Message" && record.text)).toEqual(
			Array.from({ length: 250 }, (_, index) => `line ${index}`),
		);
		const last = sink.stored.at(-1);
		expect(cursor).toBe(last?._tag === "Message" ? last.entry : undefined);
	});

	it("moves the cursor past entries that give no record, without calling the sink", async () => {
		const sink = testSink();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				// A plain reset: an entry of Pi's own without a model message.
				yield* root.reset();
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				yield* Recorder.flush(root.id);
				return { entries, cursor: yield* delivered(root.id) };
			}).pipe(Effect.provide(recorded([], sink))),
		);
		expect(result.entries.map((entry) => [entry.kind, entry.model])).toEqual([["pi.reset", undefined]]);
		expect(result.cursor).toBe(result.entries[0]?.id);
		expect(sink.attempts).toEqual([]);
	});

	it("delivers an entry without a model message as a record of its kind and data, in order with the messages around it", async () => {
		const sink = testSink();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				yield* root.waitForIdle;
				// What a plugin's task stores beside the transcript: here, a verdict about the answer.
				const verdict = yield* root.commit((tx) =>
					tx.appendEntry(root.id, { kind: "review.verdict", data: { outcome: "passed", time: 444 } }),
				);
				yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "app.note" }));
				yield* root.prompt("Again.", { requestId: "two" });
				yield* root.waitForIdle;
				yield* Recorder.flush(root.id);
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return { verdict: verdict.id, entries, cursor: yield* delivered(root.id) };
			}).pipe(Effect.provide(recorded([answer("Hi."), answer("Hi again.")], sink))),
		);
		expect(sink.stored).toEqual(result.entries.flatMap(fromEntry));
		expect(sink.stored.map((record) => record._tag)).toEqual([
			"Message",
			"ModelCall",
			"Message",
			"Entry",
			"Entry",
			"Message",
			"ModelCall",
			"Message",
		]);
		expect(sink.stored.filter((record) => record._tag === "Entry")).toEqual([
			{
				_tag: "Entry",
				id: `1:${result.verdict}:entry`,
				conversation: 1,
				entry: result.verdict,
				kind: "review.verdict",
				data: { outcome: "passed", time: 444 },
				task: null,
				time: 444,
				advisory: false,
			},
			{
				_tag: "Entry",
				id: `1:${result.verdict + 1}:entry`,
				conversation: 1,
				entry: result.verdict + 1,
				kind: "app.note",
				data: null,
				task: null,
				time: null,
				advisory: false,
			},
		]);
		expect(new Set(ids(sink.stored)).size).toBe(sink.stored.length);
		expect(result.cursor).toBe(result.entries.at(-1)?.id);
	});

	it("keeps the id of every record it gave before: the entry records only add ids of a form of their own", async () => {
		// The ids of the two-turn run, as they were before entries without messages gave records.
		const BEFORE = [
			"1:8:0:message",
			"1:12:0:model",
			"1:12:0:message",
			"1:12:0:call:0",
			"1:14:0:result",
			"1:16:0:model",
			"1:16:0:message",
			"1:17:0:message",
			"1:20:0:model",
			"1:20:0:message",
		];
		const plain = testSink();
		await Effect.runPromise(
			Effect.andThen(twoTurns, Recorder.flushAll).pipe(Effect.provide(recorded(TWO_TURNS, plain))),
		);
		expect(ids(plain.stored)).toEqual(BEFORE);

		// The same run with a plugin's entry stored after it: every id above is there unchanged, and one more.
		const noted = testSink();
		const note = await Effect.runPromise(
			Effect.gen(function* () {
				yield* twoTurns;
				const root = yield* TestHarness.root;
				const stored = yield* root.commit((tx) =>
					tx.appendEntry(root.id, { kind: "review.verdict", data: { outcome: "passed" } }),
				);
				yield* Recorder.flushAll;
				return stored.id;
			}).pipe(Effect.provide(recorded(TWO_TURNS, noted))),
		);
		expect(ids(noted.stored)).toEqual([...BEFORE, `1:${note}:entry`]);
		expect(noted.stored.slice(0, BEFORE.length).map((record) => record._tag)).toEqual(
			plain.stored.map((record) => record._tag),
		);
	});
});

describe("Recorder.flush", () => {
	it("waits until the sink took the records, for one conversation and for the harness", async () => {
		const release = Latch.makeUnsafe();
		const sink = testSink(() => release.await);
		const result = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				const one = yield* Effect.forkChild(Recorder.flush(root.id), { startImmediately: true });
				const all = yield* Effect.forkChild(Recorder.flushAll, { startImmediately: true });
				// The sink holds the batch: neither flush may return before it took it.
				yield* sink.when(() => sink.attempts.length === 1);
				yield* TestClock.adjust("1 hour");
				const waiting = [one.pollUnsafe(), all.pollUnsafe(), sink.stored.length];
				yield* release.open;
				yield* Fiber.join(one);
				yield* Fiber.join(all);
				return { waiting, head: Option.getOrThrow(yield* root.head), cursor: yield* delivered(root.id) };
			}).pipe(Effect.provide(recorded([answer("Hi.")], sink))),
		);
		expect(result.waiting).toEqual([undefined, undefined, 0]);
		expect(sink.stored.map((record) => record._tag)).toEqual(["Message", "ModelCall", "Message"]);
		expect(result.cursor).toBe(result.head);
	});

	it("covers a commit its caller just made, and delivers nothing for an unknown conversation", async () => {
		const sink = testSink();
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.commit((tx) =>
					tx.appendEntry(root.id, { kind: "app.note", model: [{ role: "user", content: "noted", timestamp: 5 }] }),
				);
				yield* Recorder.flushAll;
				expect(sink.stored.map((record) => record._tag === "Message" && record.text)).toEqual(["noted"]);
				yield* Recorder.flush(999 as ConversationId);
				expect(sink.stored).toHaveLength(1);
			}).pipe(Effect.provide(recorded([], sink))),
		);
	});

	it("leaves a quiet harness alone: no commit and no sink call once everything is delivered", async () => {
		const sink = testSink();
		const quiet = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Say hi.", { requestId: "one" });
				yield* Harness.waitForIdle;
				yield* Recorder.flushAll;
				const calls = sink.attempts.length;
				let commits = 0;
				const harnessService = yield* Harness.Harness;
				const observation = harnessService.observeCommits({ advance: () => void commits++, end: () => {} });
				// Any timer of the pump or of Pi fires within an hour.
				yield* TestClock.adjust("1 hour");
				observation.detach();
				return { commits, calls: sink.attempts.length - calls };
			}).pipe(Effect.provide(recorded([answer("Hi.")], sink))),
		);
		expect(quiet).toEqual({ commits: 0, calls: 0 });
	});

	it("delivers nothing again when a second pump starts on a storage that is up to date", async () => {
		const first = testSink();
		const second = testSink();
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* twoTurns;
				yield* Recorder.flushAll;
				yield* Recorder.flushAll.pipe(Effect.provide(Recorder.layer()), Effect.provide(second.layer));
			}).pipe(Effect.provide(recorded(TWO_TURNS, first))),
		);
		expect(first.stored).toHaveLength(10);
		expect(second.attempts).toEqual([]);
	});
});
