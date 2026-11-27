import type { TaskId } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type Address, Digest, Request } from "../src/index.ts";
import { id } from "../src/request.ts";

/** Two digests: 64 hexadecimal digits each. */
const A = Digest.Digest.make("a".repeat(64));
const B = Digest.Digest.make("b".repeat(64));

const stored = {
	id: `12:0:${A}`,
	conversation: 1,
	task: 12,
	callId: "call-1",
	tool: "write",
	arguments: { text: "hi", options: { force: true, tags: ["a", null] } },
	digest: A,
	askedAt: 1_000,
	expiresAt: 2_000,
};

describe("id", () => {
	it("joins the task, the number of the ask and the digest, so each of them changes it", () => {
		expect(id(12 as TaskId, 0, A)).toBe(`12:0:${A}`);
		const ids = [id(12 as TaskId, 0, A), id(13 as TaskId, 0, A), id(12 as TaskId, 1, A), id(12 as TaskId, 0, B)];
		expect(new Set(ids).size).toBe(4);
	});
});

describe("Request", () => {
	it("decodes a stored request as it is, and encodes it to the same JSON", async () => {
		const request = await Effect.runPromise(Schema.decodeUnknownEffect(Request)(stored));
		expect(request).toEqual(stored);
		expect(await Effect.runPromise(Schema.encodeEffect(Request)(request))).toEqual(stored);
		// A request is the address its decision goes to.
		const address: Address = request;
		expect([address.task, address.id]).toEqual([12, `12:0:${A}`]);
	});

	it("rejects a request without a digest or with one that is not 64 hexadecimal digits, with a task that is no integer, or with arguments that are no JSON object", async () => {
		const { digest: _digest, ...withoutDigest } = stored;
		const rejected = [
			withoutDigest,
			{ ...stored, digest: "abc" },
			{ ...stored, digest: "A".repeat(64) },
			{ ...stored, task: 1.5 },
			{ ...stored, arguments: ["hi"] },
		];
		for (const value of rejected) {
			const error = await Effect.runPromise(Effect.flip(Schema.decodeUnknownEffect(Request)(value)));
			expect(error._tag).toBe("SchemaError");
		}
	});
});
