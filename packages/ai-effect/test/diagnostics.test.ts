// An assistant message diagnostic stamped by Clock.

import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { createAssistantMessageDiagnostic } from "../src/index.ts";
import { runTest } from "../src/testing/index.ts";

describe("createAssistantMessageDiagnostic", () => {
	it("describes the error as pi-ai does, at the time of the clock", async () => {
		const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
		const diagnostic = await runTest(
			Effect.andThen(TestClock.adjust(5000), createAssistantMessageDiagnostic("transport", error, { attempt: 2 })),
		);
		expect(diagnostic).toMatchObject({
			type: "transport",
			timestamp: 5000,
			error: { name: "Error", message: "reset", code: "ECONNRESET" },
			details: { attempt: 2 },
		});
	});
});
