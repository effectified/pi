import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@effectified/pi-ai/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { LeaseFenced, PriceMissing, type Refusal, refusalOf, ShareExhausted } from "../src/index.ts";
import { refusalText } from "../src/refusal.ts";

const read = (detail: unknown) => Effect.runSync(refusalOf(detail));

/** Words pi-ai retries a request for, and words it compacts and sends a request again for. */
const HOSTILE = "429 rate limit overloaded timeout ECONNRESET: prompt is too long, maximum context length exceeded";

const REFUSALS: ReadonlyArray<Refusal> = [
	new LeaseFenced({ reason: HOSTILE }),
	new PriceMissing({ provider: HOSTILE, model: "timeout-503" }),
	new ShareExhausted({ conversation: 7, cap: 1_000_000n, settled: 12_345_678_901_234_567_890n }),
];

describe("a refusal as the text of an error", () => {
	it("reads back as the same typed refusal", () => {
		for (const refusal of REFUSALS) {
			const back = Option.getOrThrow(read(refusalText(refusal)));
			expect(back).toBeInstanceOf(refusal.constructor);
			expect(back).toEqual(refusal);
		}
	});

	it("is one fixed sentence per kind and the refusal in hexadecimal: no word of a label or an id", () => {
		expect(refusalText(new LeaseFenced({ reason: "expired" }))).toBe(
			`Budget: the lease is fenced, so the request was not sent. [budget:${hex('{"_tag":"LeaseFenced","reason":"expired"}')}]`,
		);
		const texts = REFUSALS.map(refusalText);
		expect(texts.map((text) => text.replace(/ \[budget:[0-9a-f]+\]$/, ""))).toEqual([
			"Budget: the lease is fenced, so the request was not sent.",
			"Budget: the model has no price, so the request was not sent.",
			"Budget: the conversation has used up its share, so the request was not sent.",
		]);
		for (const text of texts) expect(text).not.toMatch(/429|timeout|too long/);
	});

	it("is an error pi-ai neither retries nor takes for a context overflow, whatever the label says", () => {
		for (const refusal of REFUSALS) {
			const message = {
				...fauxAssistantMessage(""),
				stopReason: "error" as const,
				errorMessage: refusalText(refusal),
			};
			expect(isRetryableAssistantError(message)).toBe(false);
			expect(isContextOverflow(message, 1000)).toBe(false);
		}
		// The same label as plain text is what the hexadecimal form protects against.
		const plain = { ...fauxAssistantMessage(""), stopReason: "error" as const, errorMessage: HOSTILE };
		expect(isRetryableAssistantError(plain)).toBe(true);
	});

	it("is found behind words Pi puts before an error's text", () => {
		const refusal = new LeaseFenced({ reason: "out of money: ¥0 left" });
		expect(read(`Compaction failed: ${refusalText(refusal)}`)).toEqual(Option.some(refusal));
	});

	it("reads nothing from a detail that is no refusal of this package", () => {
		expect(read(undefined)).toEqual(Option.none());
		expect(read("boom")).toEqual(Option.none());
		expect(read({ reason: "expired" })).toEqual(Option.none());
		expect(read("[budget:zz]")).toEqual(Option.none());
		expect(read(`[budget:${hex("not json")}]`)).toEqual(Option.none());
		expect(read(`[budget:${hex('{"_tag":"Other","reason":"x"}')}]`)).toEqual(Option.none());
	});

	it("says in its message what was refused", () => {
		expect(REFUSALS[2]?.message).toBe(
			"Conversation 7 has settled 12345678901234567890 of its cap of 1000000 micro units",
		);
	});
});

function hex(text: string): string {
	return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
