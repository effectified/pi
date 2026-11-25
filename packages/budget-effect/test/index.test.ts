import { describe, expect, it } from "vitest";
import * as Package from "../src/index.ts";

describe("the public surface", () => {
	it("exports the ports, the layers, the data and the errors, and nothing else", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"BudgetEvent",
			"BudgetEvents",
			"BudgetRequest",
			"BudgetedModels",
			"Estimator",
			"InvalidPriceTable",
			"Lease",
			"LeaseFenced",
			"ModelPrice",
			"NoProviderSession",
			"Outcome",
			"PriceMissing",
			"PriceTable",
			"Prices",
			"Refusal",
			"Settlement",
			"Share",
			"ShareDocument",
			"ShareExhausted",
			"Shares",
			"Spend",
			"SpentUsage",
			"TokenUsage",
			"continueStopped",
			"onStorageFork",
			"refusalOf",
			"stopOf",
		]);
		expect(Object.keys(Package.BudgetedModels).sort()).toEqual(["layer", "layerWithShares"]);
	});
});
