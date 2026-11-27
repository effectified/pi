import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { approve, Decision, Digest, deny } from "../src/index.ts";

const request = { digest: Digest.Digest.make("d".repeat(64)) };

const D = request.digest;

describe("approve and deny", () => {
	it("make a decision for the request's digest, by the principal, at the Clock's time", async () => {
		const made = await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(42_000);
				const approval = yield* approve(request, "user:ada");
				yield* TestClock.adjust(1_000);
				return [approval, yield* deny(request, "user:bob", "Not today."), yield* deny(request, "user:bob")];
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(made).toEqual([
			{ _tag: "Approved", digest: request.digest, by: "user:ada", at: 42_000 },
			{ _tag: "Denied", digest: request.digest, by: "user:bob", at: 43_000, note: "Not today." },
			{ _tag: "Denied", digest: request.digest, by: "user:bob", at: 43_000 },
		]);
		// A denial without a note has no `note` at all, so it is the same JSON when it is stored.
		expect(Object.keys(made[2] ?? {})).toEqual(["_tag", "digest", "by", "at"]);
	});
});

describe("Decision", () => {
	const decode = Schema.decodeUnknownEffect(Decision);

	it("decodes both decisions from their JSON, and matches on them", async () => {
		const approved = { _tag: "Approved", digest: D, by: "ada", at: 1 };
		const denied = { _tag: "Denied", digest: D, by: "bob", at: 2, note: "No." };
		const decoded = await Effect.runPromise(Effect.all([decode(approved), decode(denied)], { concurrency: 1 }));
		expect(decoded).toEqual([approved, denied]);
		const notes = decoded.map((decision) =>
			Decision.match(decision, { Approved: () => "approved", Denied: ({ note }) => `denied: ${note}` }),
		);
		expect(notes).toEqual(["approved", "denied: No."]);
	});

	it("rejects another tag, a missing principal, a digest that is not one and an approval that is no object", async () => {
		const rejected = [
			{ _tag: "Maybe", digest: D, by: "ada", at: 1 },
			{ _tag: "Approved", digest: D, at: 1 },
			{ _tag: "Approved", digest: "d", by: "ada", at: 1 },
			true,
		];
		for (const value of rejected) {
			const error = await Effect.runPromise(Effect.flip(decode(value)));
			expect(error._tag).toBe("SchemaError");
		}
	});
});
