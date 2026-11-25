import type { ConversationId } from "@earendil-works/pi-durable";
import { Context, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { Call, Policy } from "../src/index.ts";
import { needsApproval } from "../src/policy.ts";

const call = (tool: string): Call => ({
	tool,
	arguments: { text: "hi" },
	conversation: 1 as ConversationId,
	callId: "call-1",
});

describe("needsApproval", () => {
	it("is true for a tool the policy names, without asking the rule", async () => {
		let asked = 0;
		const policy: Policy = {
			tools: ["write", "delete"],
			expiresAfter: "1 hour",
			rule: () =>
				Effect.sync(() => {
					asked += 1;
					return false;
				}),
		};
		expect(await Effect.runPromise(needsApproval(policy, call("delete")))).toBe(true);
		expect(asked).toBe(0);
		expect(await Effect.runPromise(needsApproval(policy, call("read")))).toBe(false);
		expect(asked).toBe(1);
	});

	it("is false for every other tool when the policy has no rule", async () => {
		expect(await Effect.runPromise(needsApproval({ expiresAfter: "1 hour" }, call("write")))).toBe(false);
		expect(await Effect.runPromise(needsApproval({ tools: [], expiresAfter: "1 hour" }, call("write")))).toBe(false);
	});

	it("is the rule's answer about the call, with the rule's service", async () => {
		class Risky extends Context.Service<Risky, { readonly tools: ReadonlyArray<string> }>()("test/Risky") {}
		const seen: Call[] = [];
		const policy: Policy<Risky> = {
			expiresAfter: "1 hour",
			rule: (asked) =>
				Risky.use((risky) =>
					Effect.sync(() => {
						seen.push(asked);
						return risky.tools.includes(asked.tool);
					}),
				),
		};
		const answers = await Effect.runPromise(
			Effect.all([needsApproval(policy, call("bash")), needsApproval(policy, call("read"))]).pipe(
				Effect.provideService(Risky, { tools: ["bash"] }),
			),
		);
		expect(answers).toEqual([true, false]);
		expect(seen).toEqual([call("bash"), call("read")]);
	});

	it("is true when the rule fails, dies or throws: it fails closed", async () => {
		const rules: ReadonlyArray<NonNullable<Policy["rule"]>> = [
			() => Effect.fail("no answer"),
			() => Effect.die(new Error("broken")),
			() => {
				throw new Error("thrown");
			},
		];
		for (const rule of rules) {
			expect(await Effect.runPromise(needsApproval({ expiresAfter: "1 hour", rule }, call("write")))).toBe(true);
		}
	});

	it("is interrupted with its rule, and answers nothing then", async () => {
		const policy: Policy = { expiresAfter: "1 hour", rule: () => Effect.never };
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(needsApproval(policy, call("write")));
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(fiber);
				return yield* Fiber.await(fiber);
			}),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});
});
