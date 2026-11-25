// The kinds of tokens pi-ai prices and the usage of nothing, against pi-ai's own pricing.

import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { emptyUsage, TOKEN_KINDS } from "../src/index.ts";

const MODEL: Model<Api> = {
	id: "priced",
	name: "priced",
	api: "faux",
	provider: "faux",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("TOKEN_KINDS", () => {
	it("are the kinds pi-ai prices: a million tokens of one kind cost that kind's rate, and nothing else", () => {
		for (const kind of TOKEN_KINDS) {
			const cost = calculateCost(MODEL, { ...emptyUsage(), [kind]: 1000000 });
			expect(cost[kind]).toBe(MODEL.cost[kind]);
			expect(cost.total).toBe(MODEL.cost[kind]);
		}
	});
});

describe("emptyUsage", () => {
	it("counts and costs nothing, and pi-ai prices it at zero", () => {
		const usage: Usage = emptyUsage();
		expect(usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(calculateCost(MODEL, usage).total).toBe(0);
	});

	it("is a new object each time, so pricing one leaves the next alone", () => {
		calculateCost(MODEL, { ...emptyUsage(), input: 1000000 });
		const priced = emptyUsage();
		priced.cost.total = 5;
		expect(emptyUsage().cost.total).toBe(0);
	});
});
