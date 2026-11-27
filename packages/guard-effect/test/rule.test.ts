import type { ConversationId } from "@earendil-works/pi-durable";
import { ToolCallId, ToolName } from "@effectified/pi-durable";
import { Context, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Rule } from "../src/index.ts";
import { names } from "./guarded.ts";

const Search = {
	name: ToolName.make("search"),
	parameters: Schema.Struct({ query: Schema.String, since: Schema.optionalKey(Schema.Date) }),
};

const call: Rule.Call = {
	name: ToolName.make("search"),
	conversationId: 7 as ConversationId,
	callId: ToolCallId.make("call-1"),
	nested: false,
	grant: { tools: names("search"), classification: "internal" },
};

class Limits extends Context.Service<Limits, { readonly longest: number }>()("test/Limits") {}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("make", () => {
	it("gives the rule the arguments decoded by the tool's parameters, and the call", async () => {
		const seen: unknown[] = [];
		const rule = Rule.make("note", Search, (params, about) =>
			Effect.sync(() => {
				seen.push(params, about);
				return Rule.allow;
			}),
		);
		const outcome = await Effect.runPromise(rule.run({ query: "claims", since: "2026-11-25T00:00:00.000Z" }, call));
		expect(outcome).toEqual({ _tag: "Allow" });
		expect(seen).toEqual([{ query: "claims", since: new Date("2026-11-25T00:00:00.000Z") }, call]);
		expect([rule.name, rule.tool]).toEqual(["note", "search"]);
	});

	it("passes a block on with its reason", async () => {
		const rule = Rule.make("short", Search, ({ query }) =>
			Effect.succeed(query.length > 5 ? Rule.block("query too long") : Rule.allow),
		);
		expect(await Effect.runPromise(rule.run({ query: "a long query" }, call))).toEqual({
			_tag: "Block",
			reason: "query too long",
		});
		expect(await Effect.runPromise(rule.run({ query: "ok" }, call))).toEqual({ _tag: "Allow" });
	});

	it("encodes rewritten arguments back to the JSON Pi takes", async () => {
		const rule = Rule.make("recent", Search, ({ query }) =>
			Effect.succeed(Rule.rewrite({ query: query.trim(), since: new Date("2026-01-01T00:00:00.000Z") })),
		);
		expect(await Effect.runPromise(rule.run({ query: "  claims " }, call))).toEqual({
			_tag: "Rewrite",
			arguments: { query: "claims", since: "2026-01-01T00:00:00.000Z" },
		});
	});

	it("fails, so the guard blocks, when the arguments do not decode or the check fails", async () => {
		let asked = 0;
		const rule = Rule.make("count", Search, () =>
			Effect.sync(() => {
				asked += 1;
				return Rule.allow;
			}),
		);
		const undecoded = await Effect.runPromise(Effect.flip(rule.run({ query: 1 }, call)));
		const excess = await Effect.runPromise(Effect.flip(rule.run({ query: "a", other: true }, call)));
		expect([Schema.isSchemaError(undecoded), Schema.isSchemaError(excess), asked]).toEqual([true, true, 0]);
		const failing = Rule.make("broken", Search, () => Effect.fail("no decision"));
		expect(await Effect.runPromise(Effect.flip(failing.run({ query: "a" }, call)))).toBe("no decision");
	});

	it("needs what its check needs", async () => {
		const rule = Rule.make("limit", Search, ({ query }) =>
			Limits.use(({ longest }) => Effect.succeed(query.length > longest ? Rule.block("too long") : Rule.allow)),
		);
		const needs: Equal<Rule.Services<typeof rule>, Limits> = true;
		const none: Equal<Rule.Services<Rule.Rule<never>>, never> = true;
		expect([needs, none]).toEqual([true, true]);
		const outcome = rule.run({ query: "claims" }, call).pipe(Effect.provideService(Limits, { longest: 3 }));
		expect(await Effect.runPromise(outcome)).toEqual({ _tag: "Block", reason: "too long" });
	});
});

describe("outcomes", () => {
	it("are tagged values", () => {
		expect(Rule.allow).toEqual({ _tag: "Allow" });
		expect(Rule.block("why")).toEqual({ _tag: "Block", reason: "why" });
		expect(Rule.rewrite({ a: 1 })).toEqual({ _tag: "Rewrite", arguments: { a: 1 } });
	});
});
