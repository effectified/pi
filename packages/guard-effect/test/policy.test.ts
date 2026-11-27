import { ToolName } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidPolicy, Matcher, Policy } from "../src/index.ts";

const labels = ["public", "internal", "confidential"];

const invalid = (policy: Policy.Encoded) => Effect.runPromise(Effect.flip(Policy.decode(policy)));

describe("Policy", () => {
	it("is data: a policy written as JSON decodes to the value the guard takes", () => {
		const json = {
			denied: [{ _tag: "Word", words: ["approve", "sign"], position: "first" }],
			classifications: labels,
			toolCeilings: { search: "public" },
			modelCeilings: [{ provider: "acme", modelId: "small", ceiling: "internal" }],
			ungranted: { tools: [] },
		};
		const policy = Schema.decodeUnknownSync(Policy.Policy)(JSON.parse(JSON.stringify(json)));
		expect(policy).toEqual(json);
		expect(() => Schema.decodeUnknownSync(Policy.Policy)({ ...json, classifications: "public" })).toThrow();
	});

	it("empty denies nothing, has no classifications and gives a conversation without a grant no tool", () => {
		expect(Policy.empty).toEqual({
			denied: [],
			classifications: [],
			toolCeilings: {},
			modelCeilings: [],
			ungranted: { tools: [] },
		});
	});
});

describe("validate and decode", () => {
	const written: Policy.Encoded = {
		denied: [Matcher.firstWord(["approve"])],
		classifications: labels,
		toolCeilings: { search: "public" },
		modelCeilings: [{ provider: "acme", modelId: "small", ceiling: "internal" }],
		ungranted: { tools: ["read"], classification: "confidential" },
	};

	it("gives back a policy that holds together", async () => {
		const policy = Schema.decodeSync(Policy.Policy)(written);
		expect(await Effect.runPromise(Policy.validate(policy))).toBe(policy);
		expect(await Effect.runPromise(Policy.validate(Policy.empty))).toBe(Policy.empty);
	});

	it("decodes a policy as a product writes it, plain names and all, to the same value", async () => {
		expect(await Effect.runPromise(Policy.decode(written))).toEqual(written);
		expect(await Effect.runPromise(Policy.decode(Policy.empty))).toEqual(Policy.empty);
	});

	it("fails with InvalidPolicy naming the contradiction", async () => {
		const base = { ...Policy.empty, classifications: labels };
		const reasons = await Promise.all([
			invalid({ ...base, classifications: ["public", "public"] }),
			invalid({ ...base, classifications: ["public", ""] }),
			invalid({ ...base, toolCeilings: { search: "secret" } }),
			invalid({ ...base, modelCeilings: [{ provider: "acme", modelId: "small", ceiling: "secret" }] }),
			invalid({
				...base,
				modelCeilings: [
					{ provider: "acme", modelId: "small", ceiling: "public" },
					{ provider: "acme", modelId: "small", ceiling: "internal" },
				],
			}),
			invalid({ ...base, ungranted: { tools: [], classification: "secret" } }),
			invalid({ ...Policy.empty, toolCeilings: { search: "public" } }),
			invalid({ ...base, denied: [Matcher.prefix("")] }),
			invalid({ ...base, denied: [Matcher.exact(ToolName.make(""))] }),
			invalid({ ...base, denied: [Matcher.firstWord(["sign", ""])] }),
		]);
		expect(reasons.every((error) => error instanceof InvalidPolicy)).toBe(true);
		expect(reasons.map((error) => error.message)).toEqual([
			"A classification is listed twice",
			"A classification is empty",
			"The ceiling secret of tool search is not a classification",
			"The ceiling secret of model acme/small is not a classification",
			"Model acme/small has two ceilings",
			"The classification secret of a conversation without a grant is not a classification",
			"The ceiling public of tool search is not a classification",
			"A denied prefix is empty",
			"A denied name is empty",
			"A denied word is empty",
		]);
	});
});

describe("denying", () => {
	it("gives the first matcher that names the tool, and none for a tool no matcher names", () => {
		const verbs = Matcher.firstWord(["approve", "sign"]);
		const drop = Matcher.exact(ToolName.make("drop_table"));
		const policy = { ...Policy.empty, denied: [drop, verbs, Matcher.prefix("sign")] };
		expect(Policy.denying(policy, "signDocument")).toEqual(Option.some(verbs));
		expect(Policy.denying(policy, "drop_table")).toEqual(Option.some(drop));
		// Data-last, as a pipe reads it.
		expect(Option.isSome(Policy.denying("approve_claim")(policy))).toBe(true);
		expect(Policy.denying(policy, "signature_lookup")).toEqual(Option.some(Matcher.prefix("sign")));
		expect(Policy.denying(policy, "search")).toEqual(Option.none());
		expect(Policy.denying(Policy.empty, "approve")).toEqual(Option.none());
	});
});
