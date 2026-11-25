import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Outcome } from "../src/index.ts";
import { of } from "../src/outcome.ts";

describe("of", () => {
	it("is undecided while the key holds nothing, expired after its deadline, and else the decision itself", () => {
		const approval = { _tag: "Approved", digest: "d", by: "ada", at: 1 } as const;
		const denial = { _tag: "Denied", digest: "d", by: "bob", at: 2, note: "No." } as const;
		expect(of(Option.none())).toEqual({ _tag: "Undecided" });
		expect(of(Option.some({ kind: "expired" }))).toEqual({ _tag: "Expired" });
		expect(of(Option.some({ kind: "value", value: approval }))).toBe(approval);
		expect(of(Option.some({ kind: "value", value: denial }))).toBe(denial);
	});
});

describe("Outcome", () => {
	it("decodes each of its four members from JSON, and nothing else", async () => {
		const decode = Schema.decodeUnknownEffect(Outcome);
		const members = [
			{ _tag: "Approved", digest: "d", by: "ada", at: 1 },
			{ _tag: "Denied", digest: "d", by: "bob", at: 2 },
			{ _tag: "Expired" },
			{ _tag: "Undecided" },
		];
		expect(await Effect.runPromise(Effect.forEach(members, (member) => decode(member)))).toEqual(members);
		const error = await Effect.runPromise(Effect.flip(decode({ _tag: "Pending" })));
		expect(error._tag).toBe("SchemaError");
	});
});
