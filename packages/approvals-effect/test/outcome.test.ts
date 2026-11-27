import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Approved, Denied, Digest, Outcome } from "../src/index.ts";
import { of } from "../src/outcome.ts";

const D = Digest.Digest.make("d".repeat(64));

describe("of", () => {
	it("is undecided while the key holds nothing, expired after its deadline, and else the decision itself", () => {
		const approval = Approved.make({ digest: D, by: "ada", at: 1 });
		const denial = Denied.make({ digest: D, by: "bob", at: 2, note: "No." });
		expect(of(Option.none())).toEqual({ _tag: "Undecided" });
		expect(of(Option.some({ kind: "expired" }))).toEqual({ _tag: "Expired" });
		expect(of(Option.some({ kind: "value", value: approval }))).toBe(approval);
		expect(of(Option.some({ kind: "value", value: denial }))).toBe(denial);
	});
});

describe("Outcome", () => {
	it("decodes each of its four members from JSON, and nothing else, and matches on each", async () => {
		const decode = Schema.decodeUnknownEffect(Outcome);
		const members = [
			{ _tag: "Approved", digest: D, by: "ada", at: 1 },
			{ _tag: "Denied", digest: D, by: "bob", at: 2 },
			{ _tag: "Expired" },
			{ _tag: "Undecided" },
		];
		const decoded = await Effect.runPromise(Effect.forEach(members, (member) => decode(member), { concurrency: 1 }));
		expect(decoded).toEqual(members);
		expect(
			decoded.map((outcome) =>
				Outcome.match(outcome, {
					Approved: ({ by }) => `approved by ${by}`,
					Denied: ({ by }) => `denied by ${by}`,
					Expired: () => "expired",
					Undecided: () => "undecided",
				}),
			),
		).toEqual(["approved by ada", "denied by bob", "expired", "undecided"]);
		const error = await Effect.runPromise(Effect.flip(decode({ _tag: "Pending" })));
		expect(error._tag).toBe("SchemaError");
	});
});
