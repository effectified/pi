import type { TaskId } from "@earendil-works/pi-durable";
import { SchemaDecodeError } from "@gunta/pi-schema-effect";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Signal } from "../src/index.ts";
import * as Step from "../src/task-step.ts";

type State = { readonly phase: "wait"; readonly at: Date } | { readonly phase: "done" };

/** Encoders whose JSON differs from the value: a Date travels as epoch milliseconds, a result in upper case. */
const encoders: Step.Encoders<State, string> = {
	state: (state) => {
		const checkpoint: Step.Checkpoint =
			state.phase === "wait" ? { phase: state.phase, at: state.at.getTime() } : { phase: state.phase };
		return Effect.succeed(checkpoint);
	},
	result: (result) => Effect.succeed(result.toUpperCase()),
};

const Answer = Signal.make("step.answer", 1, Schema.Struct({ text: Schema.String }));

const CHILD = 7 as TaskId;

const toPi = (step: Step.Step<State, string> | Step.Unchanged) => Effect.runPromise(Step.toPi(step, encoders));

describe("the constructors", () => {
	it("build each member of the union with its tag", () => {
		const at = new Date(5);
		expect(Step.next<State>({ phase: "done" })).toEqual({ _tag: "Next", state: { phase: "done" } });
		expect(Step.sleep<State>({ state: { phase: "wait", at }, until: 9 })).toEqual({
			_tag: "Sleep",
			state: { phase: "wait", at },
			until: 9,
		});
		expect(Step.sleepUntil<State>(9, { phase: "done" })).toEqual({
			_tag: "Sleep",
			state: { phase: "done" },
			until: 9,
		});
		expect(Step.wait<State>({ state: { phase: "done" }, on: [CHILD], policy: "any" })).toEqual({
			_tag: "Wait",
			state: { phase: "done" },
			on: [CHILD],
			policy: "any",
		});
		expect(Step.complete("ok")).toEqual({ _tag: "End", outcome: { status: "completed", result: "ok" } });
		expect(Step.fail({ message: "declined", detail: { code: 3 } })).toEqual({
			_tag: "End",
			outcome: { status: "failed", error: { message: "declined", detail: { code: 3 } } },
		});
		expect(Step.fail({ message: "declined" }, "partial")).toEqual({
			_tag: "End",
			outcome: { status: "failed", error: { message: "declined" }, result: "partial" },
		});
		expect(Step.aborted()).toEqual({ _tag: "End", outcome: { status: "aborted" } });
		expect(Step.aborted("user", "partial")).toEqual({
			_tag: "End",
			outcome: { status: "aborted", reason: "user", result: "partial" },
		});
		expect(Step.unchanged).toEqual({ _tag: "Unchanged" });
		expect(Step.committed).toEqual({ _tag: "Committed" });
	});
});

describe("toPi", () => {
	it("gives Pi no state for Unchanged", async () => {
		expect(await toPi(Step.unchanged)).toBeUndefined();
	});

	it("encodes the state of a next step, a sleep and a wait", async () => {
		const at = new Date(5);
		expect(await toPi(Step.next({ phase: "wait", at }))).toEqual({
			status: "running",
			checkpoint: { phase: "wait", at: 5 },
		});
		expect(await toPi(Step.sleepUntil(9, { phase: "wait", at }))).toEqual({
			status: "sleeping",
			checkpoint: { phase: "wait", at: 5 },
			until: 9,
		});
		expect(await toPi(Step.wait({ state: { phase: "done" }, on: [CHILD], policy: "failFast" }))).toEqual({
			status: "waiting",
			checkpoint: { phase: "done" },
			on: [CHILD],
			policy: "failFast",
		});
	});

	it("gives a sleep Pi's keys of its signals, and no `until` when it has none", async () => {
		const slept = await toPi(Step.sleep({ state: { phase: "done" }, signals: [Answer.key("first")] }));
		expect(slept).toEqual({
			status: "sleeping",
			checkpoint: { phase: "done" },
			signals: [{ signal: "step.answer", key: "first" }],
		});
	});

	it("encodes the result of an outcome that has one, and leaves the rest of the outcome as it is", async () => {
		expect(await toPi(Step.complete("ok"))).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: "OK" },
		});
		expect(await toPi(Step.fail({ message: "declined" }, "partial"))).toEqual({
			status: "terminal",
			outcome: { status: "failed", error: { message: "declined" }, result: "PARTIAL" },
		});
		expect(await toPi(Step.fail({ message: "declined" }))).toEqual({
			status: "terminal",
			outcome: { status: "failed", error: { message: "declined" } },
		});
		expect(await toPi(Step.aborted("user"))).toEqual({
			status: "terminal",
			outcome: { status: "aborted", reason: "user" },
		});
	});

	it("fails with the encoder's failure", async () => {
		const refused = new SchemaDecodeError({ issues: [{ path: "", message: "no" }] });
		const failing: Step.Encoders<State, string> = { ...encoders, result: () => Effect.fail(refused) };
		const failure = await Effect.runPromise(Effect.flip(Step.toPi(Step.complete("ok"), failing)));
		expect(failure).toBe(refused);
	});
});
