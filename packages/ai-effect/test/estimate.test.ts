// pi-ai's token estimates, offered as they are by the estimate subpath.

import { describe, expect, it } from "vitest";
import { estimateContextTokens, estimateTextTokens } from "../src/estimate.ts";

describe("the estimate subpath", () => {
	it("estimates as pi-ai does: about 3.5 characters a token", () => {
		expect(estimateTextTokens("1234567")).toBe(2);
		const estimate = estimateContextTokens([{ role: "user", content: "1234567", timestamp: 0 }]);
		expect(estimate).toEqual({ tokens: 2, usageTokens: 0, trailingTokens: 2, lastUsageIndex: null });
	});
});
