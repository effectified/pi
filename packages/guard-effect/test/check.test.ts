import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Check from "../src/check.ts";
import { Matcher, Policy, Rule } from "../src/index.ts";

const Text = Schema.Struct({ text: Schema.String });
const Search = { name: "search", parameters: Text };
const Write = { name: "write", parameters: Text };

const policy: Policy.Policy = {
	...Policy.empty,
	denied: [Matcher.firstWord(["delete"])],
	classifications: ["public", "internal"],
	toolCeilings: { search: "public" },
};

const about = (name: string, grant: Rule.Call["grant"]): Rule.Call => ({
	name,
	conversationId: 1 as ConversationId,
	callId: "call-1",
	nested: false,
	grant,
});

/** A rule that records that it was asked, and with what. */
const recorded = (
	name: string,
	tool: typeof Search,
	asked: string[],
	answer: (text: string) => Rule.Outcome<typeof Text.Type>,
) =>
	Rule.make(name, tool, ({ text }) =>
		Effect.sync(() => {
			asked.push(`${name}:${text}`);
			return answer(text);
		}),
	);

const decide = (rules: ReadonlyArray<Rule.Rule<never>>, name: string, grant: Rule.Call["grant"]) =>
	Effect.runPromise(Check.decide(policy, rules, { text: "a" }, about(name, grant)));

describe("decide", () => {
	it("passes a call of a granted tool no rule stops, with its arguments untouched", async () => {
		const verdict = await decide([], "write", { tools: ["write"] });
		expect(verdict).toEqual({ _tag: "Pass", arguments: Option.none() });
	});

	it("refuses a name the policy denies, even when the grant lists it", async () => {
		expect(await decide([], "delete_all", { tools: ["delete_all"] })).toEqual({ _tag: "Refuse", rule: "denied" });
	});

	it("refuses a tool outside the grant before any rule is asked", async () => {
		const asked: string[] = [];
		const rule = recorded("seen", Write, asked, () => Rule.allow);
		expect(await decide([rule], "write", { tools: ["search"] })).toEqual({ _tag: "Refuse", rule: "allow-list" });
		expect(await decide([rule], "write", { tools: [] })).toEqual({ _tag: "Refuse", rule: "allow-list" });
		expect(asked).toEqual([]);
	});

	it("refuses a tool whose ceiling is below the conversation's classification, or that has none", async () => {
		const grant = (classification?: string) => ({ tools: ["search"], ...(classification ? { classification } : {}) });
		expect(await decide([], "search", grant("public"))).toEqual({ _tag: "Pass", arguments: Option.none() });
		expect(await decide([], "search", grant("internal"))).toEqual({ _tag: "Refuse", rule: "ceiling" });
		expect(await decide([], "search", grant())).toEqual({ _tag: "Refuse", rule: "ceiling" });
	});

	it("asks the rules of the tool in order, each with the arguments the one before left", async () => {
		const asked: string[] = [];
		const rules = [
			recorded("first", Write, asked, () => Rule.allow),
			recorded("other-tool", Search, asked, () => Rule.block("never asked")),
			recorded("second", Write, asked, (text) => Rule.rewrite({ text: `${text}b` })),
			recorded("third", Write, asked, (text) => Rule.rewrite({ text: `${text}c` })),
		];
		const verdict = await decide(rules, "write", { tools: ["write"] });
		expect(verdict).toEqual({ _tag: "Pass", arguments: Option.some({ text: "abc" }) });
		expect(asked).toEqual(["first:a", "second:a", "third:ab"]);
	});

	it("stops at the first rule that blocks, with its name and reason", async () => {
		const asked: string[] = [];
		const rules = [
			recorded("first", Write, asked, () => Rule.block("not this text")),
			recorded("second", Write, asked, () => Rule.allow),
		];
		expect(await decide(rules, "write", { tools: ["write"] })).toEqual({
			_tag: "Refuse",
			rule: "argument",
			name: "first",
			reason: "not this text",
		});
		expect(asked).toEqual(["first:a"]);
	});

	it("refuses when a rule fails, with a failure or a defect, and never fails itself", async () => {
		const failing = Rule.make("failing", Write, () => Effect.fail(new Error("the lookup is down")));
		const dying = Rule.make("dying", Write, () => Effect.die(new Error("a bug")));
		const throwing = Rule.make("throwing", Write, (): Effect.Effect<Rule.Outcome<typeof Text.Type>> => {
			throw new Error("a throw");
		});
		const grant = { tools: ["write"] };
		expect(await decide([failing], "write", grant)).toEqual({
			_tag: "Refuse",
			rule: "argument-failed",
			name: "failing",
		});
		expect(await decide([dying], "write", grant)).toEqual({ _tag: "Refuse", rule: "argument-failed", name: "dying" });
		expect(await decide([throwing], "write", grant)).toEqual({
			_tag: "Refuse",
			rule: "argument-failed",
			name: "throwing",
		});
	});
});
