import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { KEY, Released } from "../src/hold.ts";
import { held } from "../src/signalled.ts";

const DECISION = { _tag: "Accept" as const, by: "user:ada" };

describe("Signalled.held", () => {
	const read = (memos?: Record<string, unknown>) =>
		Effect.runPromise(held(memos === undefined ? {} : { memos }, Released, KEY));

	it("reads the value a delivery stored in the task's memo, also once a wake used it", async () => {
		const stored = { version: 1, value: DECISION };
		expect(await read({ "pi.signal.review.release/release": stored })).toEqual(Option.some(DECISION));
		expect(await read({ "pi.signal.review.release/release": { ...stored, consumed: true } })).toEqual(
			Option.some(DECISION),
		);
	});

	it("reads none for a task without memos, another key, an expired key, and a value outside the schema", async () => {
		expect(await read()).toEqual(Option.none());
		expect(await read({ "pi.signal.review.release/other": { version: 1, value: DECISION } })).toEqual(Option.none());
		expect(await read({ "pi.signal.review.release/release": { expired: true } })).toEqual(Option.none());
		expect(await read({ "pi.signal.review.release/release": { version: 1, value: { _tag: "Shrug" } } })).toEqual(
			Option.none(),
		);
	});
});
