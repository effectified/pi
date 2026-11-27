import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { Subject } from "../src/check.ts";
import { Check, type Finding } from "../src/index.ts";
import * as Report from "../src/report.ts";

const SUBJECT = { answer: "It is 42.", pass: 1, transcript: [] } as unknown as Subject;
const FOUND: Finding = { severity: "warn", text: "Show the multiplication." };

/** Memos in a map, with Pi's rule: the first writer of a name wins. */
function memos(stored = new Map<string, unknown>()) {
	const memo = (name: string, candidate?: unknown) =>
		Effect.sync(() => {
			if (candidate === undefined) return Option.fromUndefinedOr(stored.get(name));
			if (!stored.has(name)) stored.set(name, candidate);
			return stored.get(name);
		});
	// The fake has the two call forms of Pi's memo in one signature, which its overloads cannot be checked against.
	return { memo: memo as unknown as Report.Memos, stored };
}

class Down extends Schema.TaggedError<Down, { readonly brand: unique symbol }>()("Down", { service: Schema.String }) {
	override get message(): string {
		return `${this.service} is down`;
	}
}

describe("Report.of", () => {
	it("reports what a check found", async () => {
		const found = Check.make("app.found", () => Effect.succeed([FOUND]));
		expect(await Effect.runPromise(Report.of(found, SUBJECT))).toEqual({ _tag: "Found", findings: [FOUND] });
	});

	it("reports a failure of the check, typed or thrown, as failed, and never fails itself", async () => {
		const failing = Check.make("app.failing", () => Effect.fail(new Down({ service: "The index" })));
		const dying = Check.make("app.dying", () => Effect.die(new Error("boom")));
		const throwing = Check.make("app.throwing", () => {
			throw new Error("thrown");
		});
		const reports = await Effect.runPromise(
			Effect.forEach([failing, dying, throwing], (check) => Report.of(check, SUBJECT)),
		);
		expect(reports).toEqual([
			{ _tag: "Failed", error: "The index is down" },
			{ _tag: "Failed", error: "boom" },
			{ _tag: "Failed", error: "thrown" },
		]);
	});

	it("leaves an interruption an interruption", async () => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Report.of(
						Check.make("app.slow", () => Effect.never),
						SUBJECT,
					),
				);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(fiber);
				return yield* Fiber.await(fiber);
			}),
		);
		expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
	});
});

describe("Report.once", () => {
	it("asks a check once: the memo answers every later call", async () => {
		let runs = 0;
		const counted = Check.make("app.counted", () =>
			Effect.sync(() => {
				runs += 1;
				return [FOUND];
			}),
		);
		const { memo, stored } = memos();
		const reports = await Effect.runPromise(
			Effect.all([
				Report.once(memo, "review.check/1/app.counted", counted, SUBJECT),
				Report.once(memo, "review.check/1/app.counted", counted, SUBJECT),
			]),
		);
		expect(reports).toEqual([
			{ _tag: "Found", findings: [FOUND] },
			{ _tag: "Found", findings: [FOUND] },
		]);
		expect(runs).toBe(1);
		expect([...stored]).toEqual([["review.check/1/app.counted", { _tag: "Found", findings: [FOUND] }]]);
	});

	it("keeps a failure too: a check that failed is not asked again", async () => {
		let runs = 0;
		const failing = Check.make("app.failing", () =>
			Effect.suspend(() => {
				runs += 1;
				return Effect.fail("down");
			}),
		);
		const { memo } = memos();
		const again = Effect.all([Report.once(memo, "m", failing, SUBJECT), Report.once(memo, "m", failing, SUBJECT)]);
		expect(await Effect.runPromise(again)).toEqual([
			{ _tag: "Failed", error: "down" },
			{ _tag: "Failed", error: "down" },
		]);
		expect(runs).toBe(1);
	});

	it("keeps one memo per name", async () => {
		const { memo, stored } = memos();
		const first = Check.make("app.same", () => Effect.succeed([FOUND]));
		const second = Check.make("app.same", () => Effect.succeed([]));
		const reports = await Effect.runPromise(
			Effect.all([
				Report.once(memo, "review.check/1/app.same", first, SUBJECT),
				Report.once(memo, "review.check/2/app.same", second, SUBJECT),
			]),
		);
		expect(reports).toEqual([
			{ _tag: "Found", findings: [FOUND] },
			{ _tag: "Found", findings: [] },
		]);
		expect(stored.size).toBe(2);
	});

	it("runs the check when the memo holds another shape, and returns what it found", async () => {
		const { memo } = memos(new Map([["m", { verdict: "fine" }]]));
		const found = Check.make("app.found", () => Effect.succeed([FOUND]));
		expect(await Effect.runPromise(Report.once(memo, "m", found, SUBJECT))).toEqual({
			_tag: "Found",
			findings: [FOUND],
		});
	});

	it("turns findings that cannot be stored into a failure, and stores that", async () => {
		const { memo, stored } = memos();
		const loose = Check.make("app.loose", () => Effect.succeed([{ ...FOUND, location: undefined }]));
		const report = await Effect.runPromise(Report.once(memo, "m", loose, SUBJECT));
		expect(report).toMatchObject({
			_tag: "Failed",
			error: expect.stringMatching(/^The findings cannot be stored: /),
		});
		expect(stored.get("m")).toEqual(report);
	});
});
