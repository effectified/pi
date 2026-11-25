import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Kept from "../src/kept.ts";

const Count = Schema.Struct({ count: Schema.Number });
const decode = Schema.decodeUnknownEffect(Count);

/** Memos in a map, with Pi's rule: the first writer of a name wins. */
function memos(stored = new Map<string, unknown>()) {
	const memo = (name: string, candidate?: unknown) =>
		Effect.sync(() => {
			if (candidate === undefined) return Option.fromUndefinedOr(stored.get(name));
			if (!stored.has(name)) stored.set(name, candidate);
			return stored.get(name);
		});
	// The fake has the two call forms of Pi's memo in one signature, which its overloads cannot be checked against.
	return { memo: memo as unknown as Kept.Memos, stored };
}

describe("Kept.once", () => {
	it("makes the value once per name, and returns the kept one afterwards", async () => {
		let made = 0;
		const make = Effect.sync(() => ({ count: ++made }));
		const { memo, stored } = memos();
		const values = await Effect.runPromise(
			Effect.all([
				Kept.once(memo, "a", decode, make),
				Kept.once(memo, "a", decode, make),
				Kept.once(memo, "b", decode, make),
			]),
		);
		expect(values).toEqual([{ count: 1 }, { count: 1 }, { count: 2 }]);
		expect([...stored]).toEqual([
			["a", { count: 1 }],
			["b", { count: 2 }],
		]);
	});

	it("makes the value when the memo holds another shape", async () => {
		const { memo } = memos(new Map([["a", { total: 7 }]]));
		expect(await Effect.runPromise(Kept.once(memo, "a", decode, Effect.succeed({ count: 3 })))).toEqual({ count: 3 });
	});
});

describe("Kept.read", () => {
	it("reads a kept value, and none for a missing memo and for one of another shape", async () => {
		const { memo } = memos(
			new Map<string, unknown>([
				["kept", { count: 2 }],
				["other", { total: 7 }],
			]),
		);
		const read = await Effect.runPromise(
			Effect.all([
				Kept.read(memo, "kept", decode),
				Kept.read(memo, "missing", decode),
				Kept.read(memo, "other", decode),
			]),
		);
		expect(read).toEqual([Option.some({ count: 2 }), Option.none(), Option.none()]);
	});
});
