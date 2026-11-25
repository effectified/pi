import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BudgetRequest, LeaseFenced, Outcome, Settlement } from "../src/index.ts";

describe("the lease port's data", () => {
	it("LeaseFenced carries the product's reason", () => {
		const error = new LeaseFenced({ reason: "expired" });
		expect(error._tag).toBe("LeaseFenced");
		expect(error.message).toBe("The budget lease is fenced: expired");
	});

	it("a request names its kind, its model, and its session and conversation when known", () => {
		const decode = Schema.decodeUnknownSync(BudgetRequest);
		expect(decode({ kind: "chat", provider: "acme", model: "large" })).toEqual({
			kind: "chat",
			provider: "acme",
			model: "large",
		});
		expect(decode({ kind: "deferred", provider: "acme", model: "large", session: "s", conversation: 2 })).toEqual({
			kind: "deferred",
			provider: "acme",
			model: "large",
			session: "s",
			conversation: 2,
		});
		expect(() => decode({ kind: "embedding", provider: "acme", model: "large" })).toThrow();
	});

	it("a settlement is the usage, its cost in micro units, and one of three outcomes", () => {
		const codec = Schema.toCodecJson(Settlement);
		const settlement = {
			usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
			cost: 35n,
			outcome: "failed",
		} as const;
		expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(settlement))).toEqual(settlement);
		expect(Outcome.literals).toEqual(["returned", "failed", "aborted"]);
	});
});
