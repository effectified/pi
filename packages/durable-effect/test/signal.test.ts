import type { TaskId } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Gate, Harness, Hook, Signal, Tool } from "../src/index.ts";
import { answer, TestHarness, toolCall } from "../src/testing/index.ts";
import { untilTask } from "./until-task.ts";

// A value whose type differs from its JSON form: a Date travels as an ISO string.
const Decision = Signal.make("test.decision", 1, Schema.Struct({ allow: Schema.Boolean, at: Schema.Date }));

const MISSING_TASK = 999_999 as TaskId;

/**
 * A harness with one `write` call parked on `Decision` under the key `decide`. `asked` gets the task that waits, and
 * `read` every state the gate read.
 */
function parked() {
	const asked = Promise.withResolvers<TaskId>();
	const read: unknown[] = [];
	const written: string[] = [];
	const Write = Tool.make("write", {
		description: "Write a text.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		handler: ({ text }) =>
			Effect.sync(() => {
				written.push(text);
				return `wrote ${text}`;
			}),
	});
	const Gated = Hook.beforeTool((_call, api) =>
		Effect.gen(function* () {
			const state = yield* api.readSignal(Decision, "decide");
			read.push(Option.getOrUndefined(state));
			if (Option.isNone(state)) {
				asked.resolve(api.taskId);
				return Gate.park({ signals: [Decision.key("decide")] });
			}
			return state.value.kind === "value" && state.value.value.allow ? Gate.allow : Gate.block("Not allowed");
		}),
	);
	const layer = TestHarness.layer({
		extensions: [Extension.make({ name: "app", tools: [Write], hooks: [Gated] })],
		responses: [toolCall("write", { text: "hi" }, { id: "call-1" }), answer("Done.")],
	});
	return { asked: asked.promise, read, written, layer };
}

/** Submits the input and waits until the call's park is stored. */
const untilParked = (asked: Promise<TaskId>) =>
	Effect.gen(function* () {
		const root = yield* TestHarness.root;
		const submission = yield* root.submit({ type: "input", content: "Write hi." });
		const taskId = yield* Effect.promise(() => asked);
		yield* untilTask("sleeping", taskId);
		return { root, submission, taskId };
	});

describe("make", () => {
	it("keeps the name, version and schema, and builds Pi's token once, on first use", async () => {
		expect([Decision.name, Decision.version, Decision.schema.fields.allow]).toEqual([
			"test.decision",
			1,
			Schema.Boolean,
		]);
		const [first, second] = await Effect.runPromise(Effect.all([Decision.token, Decision.token]));
		expect(first).toBe(second);
		expect([first.name, first.version, first.key("k")]).toEqual([
			"test.decision",
			1,
			{ signal: "test.decision", key: "k" },
		]);
	});

	it("encodes a value to the JSON Pi stores and decodes it back", async () => {
		const at = new Date("2026-11-24T10:00:00.000Z");
		const json = await Effect.runPromise(Decision.encode({ allow: true, at }));
		expect(json).toEqual({ allow: true, at: "2026-11-24T10:00:00.000Z" });
		expect(await Effect.runPromise(Decision.decode(json))).toEqual({ allow: true, at });
	});

	it("fails every use that needs Pi's token with SchemaConversionError when Pi rejects the definition", async () => {
		const badName = Signal.make("bad/name", 1, Schema.String);
		const badVersion = Signal.make("test.versioned", 0, Schema.String);
		const errors = await Effect.runPromise(
			Effect.all([Effect.flip(badName.token), Effect.flip(badName.encode("x")), Effect.flip(badVersion.token)]),
		);
		expect(errors.map((error) => [error._tag, error.message])).toEqual([
			["SchemaConversionError", 'Signal name "bad/name" must be non-empty, without "/"'],
			["SchemaConversionError", 'Signal name "bad/name" must be non-empty, without "/"'],
			["SchemaConversionError", "Signal test.versioned version must be a positive integer"],
		]);
		// Reading needs the schema only: what was stored still decodes, which is why `stateIn` declares no
		// SchemaConversionError.
		const memos = { "pi.signal.test.versioned/k": { version: 0, value: "x" } };
		const read = await Effect.runPromise(
			Effect.all([badName.decode("x"), Signal.stateIn({ memos }, badVersion, "k")]),
		);
		expect(read).toEqual(["x", Option.some({ kind: "value", value: "x" })]);
	});
});

describe("Harness.signal", () => {
	it("fails with SchemaDecodeError for a value outside the schema, before anything is stored", async () => {
		const scene = parked();
		const seen = await runTest(
			Effect.gen(function* () {
				const { root, taskId } = yield* untilParked(scene.asked);
				const before = Option.getOrThrow(yield* Harness.getTask(taskId));
				const outside = { allow: "yes", at: new Date(0) };
				// @ts-expect-error `allow` is a boolean: the value's type comes from the schema.
				const sent = Harness.signal(taskId, Decision, "decide", outside);
				const error = yield* Effect.flip(sent);
				const after = Option.getOrThrow(yield* Harness.getTask(taskId));
				yield* root.abort();
				return { error, before, after };
			}).pipe(Effect.provide(scene.layer)),
		);
		expect(seen.error).toMatchObject({
			_tag: "SchemaDecodeError",
			issues: [{ path: "/allow", message: "Expected boolean" }],
		});
		// The task record is as it was: no memo holds a value, and the call still sleeps on its key.
		expect(seen.after).toEqual(seen.before);
		expect(seen.after.memos).toBeUndefined();
		expect(scene.read).toEqual([undefined]);
		expect(scene.written).toEqual([]);
	});

	it("delivers a value that arrives decoded where the gate reads it, and the call continues", async () => {
		const scene = parked();
		const at = new Date("2026-11-24T10:00:00.000Z");
		const seen = await runTest(
			Effect.gen(function* () {
				const { submission, taskId } = yield* untilParked(scene.asked);
				const delivered = yield* Harness.signal(taskId, Decision, "decide", { allow: true, at });
				const stored = Option.getOrThrow(yield* Harness.getTask(taskId)).memos;
				const duplicate = yield* Harness.signal(taskId, Decision, "decide", { allow: false, at });
				const settled = yield* submission.wait;
				yield* Harness.waitForIdle;
				const closed = yield* Harness.signal(taskId, Decision, "decide", { allow: false, at });
				const notFound = yield* Harness.signal(MISSING_TASK, Decision, "decide", { allow: false, at });
				return { delivered, stored, duplicate, closed, notFound, settled };
			}).pipe(Effect.provide(scene.layer)),
		);
		expect([seen.delivered, seen.duplicate, seen.closed, seen.notFound]).toEqual([
			"delivered",
			"duplicate",
			"closed",
			"not_found",
		]);
		// Pi stores the JSON form under the signal's name and key.
		expect(seen.stored).toMatchObject({
			"pi.signal.test.decision/decide": { version: 1, value: { allow: true, at: "2026-11-24T10:00:00.000Z" } },
		});
		// The gate read nothing, parked, and read the decoded value after the wake: `at` is a Date again.
		expect(scene.read).toEqual([undefined, { kind: "value", value: { allow: true, at } }]);
		expect(scene.written).toEqual(["hi"]);
		expect(seen.settled.status).toBe("done");
	});

	it("answers invalid, as Pi does, for an empty key", async () => {
		const scene = parked();
		const result = await runTest(
			Effect.gen(function* () {
				const { root, taskId } = yield* untilParked(scene.asked);
				const invalid = yield* Harness.signal(taskId, Decision, "", { allow: true, at: new Date(0) });
				yield* root.abort();
				return invalid;
			}).pipe(Effect.provide(scene.layer)),
		);
		expect(result).toBe("invalid");
	});
});

describe("stateIn", () => {
	it("reads a key's state from a task's record as the task's own readSignal gives it, a deadline that passed too", async () => {
		const inside: unknown[] = [];
		const asked = Promise.withResolvers<TaskId>();
		const Write = Tool.make("write", {
			description: "Write a text.",
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			handler: ({ text }) => Effect.succeed(`wrote ${text}`),
		});
		// Parks on `first` with a deadline that passes at once, then on `second` without one.
		const Gated = Hook.beforeTool((_call, api) =>
			Effect.gen(function* () {
				const first = yield* api.readSignal(Decision, "first");
				if (Option.isNone(first)) return Gate.park({ signals: [Decision.key("first")], until: yield* api.now });
				const second = yield* api.readSignal(Decision, "second");
				inside.push(first.value, Option.getOrUndefined(second));
				if (Option.isSome(second)) return Gate.allow;
				asked.resolve(api.taskId);
				return Gate.park({ signals: [Decision.key("second")] });
			}),
		);
		const at = new Date("2026-11-25T08:00:00.000Z");
		const seen = await runTest(
			Effect.gen(function* () {
				const { submission, taskId } = yield* untilParked(asked.promise);
				const record = Option.getOrThrow(yield* Harness.getTask(taskId));
				const outside = [
					yield* Signal.stateIn(record, Decision, "first"),
					yield* Signal.stateIn(record, Decision, "second"),
				];
				yield* Harness.signal(taskId, Decision, "second", { allow: true, at });
				const inCommit = yield* Harness.commit((tx) =>
					Effect.flatMap(tx.task(taskId), (found) => Signal.stateIn(Option.getOrThrow(found), Decision, "second")),
				);
				yield* submission.wait;
				yield* Harness.waitForIdle;
				const ended = yield* Signal.stateIn(Option.getOrThrow(yield* Harness.getTask(taskId)), Decision, "second");
				return { outside: outside.map(Option.getOrUndefined), inCommit, ended };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Write], hooks: [Gated] })],
						responses: [toolCall("write", { text: "hi" }, { id: "call-1" }), answer("Done.")],
					}),
				),
			),
		);
		// What the gate read inside the task: `first` expired, `second` empty; then `second` with its value.
		expect(inside).toEqual([
			{ kind: "expired" },
			undefined,
			{ kind: "expired" },
			{ kind: "value", value: { allow: true, at } },
		]);
		expect(seen.outside).toEqual([{ kind: "expired" }, undefined]);
		expect(Option.getOrThrow(seen.inCommit)).toEqual({ kind: "value", value: { allow: true, at } });
		// Pi drops a task's memos with its outcome.
		expect(Option.isNone(seen.ended)).toBe(true);
	});

	it("reads only the task's own memo of that signal and key, and refuses what is not Pi's memo of this version", async () => {
		const memos = {
			"pi.signal.test.decision/newer": { version: 2, value: { allow: true, at: "2026-11-25T08:00:00.000Z" } },
			"pi.signal.test.decision/odd": "not a memo",
			"pi.signal.test.decision/wrong": { version: 1, value: { allow: "yes" } },
			"pi.signal.other/key": { version: 1, value: { allow: true, at: "2026-11-25T08:00:00.000Z" } },
		};
		const read = (key: string) => Effect.runPromise(Effect.result(Signal.stateIn({ memos }, Decision, key)));
		const messages = async (key: string) => {
			const result = await read(key);
			return result._tag === "Failure" ? [result.failure._tag, result.failure.message] : ["read"];
		};
		// `toString` is no memo: only own properties count.
		expect((await read("toString"))._tag).toBe("Success");
		expect(await Effect.runPromise(Signal.stateIn({ memos }, Decision, "toString"))).toEqual(Option.none());
		expect(await Effect.runPromise(Signal.stateIn({ memos }, Decision, "key"))).toEqual(Option.none());
		expect(await Effect.runPromise(Signal.stateIn({}, Decision, "key"))).toEqual(Option.none());
		expect(await messages("newer")).toEqual([
			"SchemaDecodeError",
			"Memo pi.signal.test.decision/newer cannot be read: it holds version 2, not 1",
		]);
		expect(await messages("odd")).toEqual([
			"SchemaDecodeError",
			"Memo pi.signal.test.decision/odd cannot be read: it is not a signal memo of Pi Durable 1.6.0",
		]);
		expect((await messages("wrong"))[0]).toBe("SchemaDecodeError");
		// Data-last on the record, for a pipe.
		const piped = await Effect.runPromise(Effect.flatMap(Effect.succeed({ memos }), Signal.stateIn(Decision, "key")));
		expect(piped).toEqual(await Effect.runPromise(Signal.stateIn({ memos }, Decision, "key")));
	});
});
