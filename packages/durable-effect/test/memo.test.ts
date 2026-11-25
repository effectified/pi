import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Memo from "../src/memo.ts";

/** Pi's memos of one task: the first writer of a name wins. */
function source() {
	const stored = new Map<string, JsonValue>();
	const contexts: Context[] = [];
	const api = {
		memo: async (name: string, ...rest: readonly unknown[]) => {
			contexts.push(rest[rest.length - 1] as Context);
			if (rest.length === 2 && !stored.has(name)) stored.set(name, rest[0] as JsonValue);
			return stored.get(name);
		},
	} as Memo.Source;
	return { api, contexts };
}

describe("fromPi", () => {
	it("reads a memo as an Option: none before anything was written", async () => {
		const memo = Memo.fromPi(source().api);
		expect(Option.isNone(await Effect.runPromise(memo<string>("guard.until")))).toBe(true);
	});

	it("writes a candidate once: the first writer wins, and every later call gets its value", async () => {
		const memo = Memo.fromPi(source().api);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const first = yield* memo("guard.until", 100);
				const second = yield* memo("guard.until", 200);
				return { first, second, read: Option.getOrThrow(yield* memo<number>("guard.until")) };
			}),
		);
		expect(outcome).toEqual({ first: 100, second: 100, read: 100 });
	});

	it("stores null and false, which are values, not absent candidates", async () => {
		const memo = Memo.fromPi(source().api);
		const outcome = await Effect.runPromise(Effect.all([memo("a", null), memo("b", false), memo<null>("a")]));
		expect(outcome).toEqual([null, false, Option.some(null)]);
	});

	it("calls Pi under the parent context it is given", async () => {
		const { api, contexts } = source();
		const controller = new AbortController();
		const parent = { abortSignal: controller.signal } as Context;
		await Effect.runPromise(Memo.fromPi(api, parent)("a", 1));
		controller.abort();
		expect(contexts.map((context) => context.abortSignal?.aborted)).toEqual([true]);
	});
});
