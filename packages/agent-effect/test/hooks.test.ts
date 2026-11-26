import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider } from "@effectified/pi-ai/testing";
import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type Hooks, toPi } from "../src/hooks.ts";
import { runner } from "../src/runner.ts";

class Prefix extends Context.Service<Prefix, string>()("test/Prefix") {}

const run = runner(Context.make(Prefix, "key-"));

const turn: AgentTurnContext = {
	message: fauxAssistantMessage("done"),
	toolResults: [],
	context: { messages: [] },
	newMessages: [],
};

describe("toPi", () => {
	it("replaces each hook by Pi's callback, which runs the Effect with the given services", async () => {
		const hooks: Hooks<Prefix> = {
			getApiKey: (provider) => Prefix.use((prefix) => Effect.succeed(`${prefix}${provider}`)),
			finishTurn: () => Effect.succeed({ action: "end" }),
			onPayload: (payload) => Effect.succeed({ wrapped: payload }),
		};
		const pi = toPi(hooks, run, () => undefined);
		expect(await pi.getApiKey?.("openai")).toBe("key-openai");
		expect(await pi.finishTurn?.(turn)).toEqual({ action: "end" });
		expect(await pi.onPayload?.(1, fauxProvider().getModel())).toEqual({ wrapped: 1 });
		expect(pi.beforeToolCall).toBeUndefined();
	});

	it("keeps the other fields and drops prepareNextTurn, which the loop and the agent take in their own shapes", () => {
		const pi = toPi(
			{ temperature: 0.2, prepareNextTurn: () => Effect.succeed(undefined) } satisfies Hooks<never> & {
				temperature: number;
			},
			runner(Context.empty()),
			() => undefined,
		);
		expect(pi).toEqual({ temperature: 0.2 });
	});

	it("runs a hook with Pi's signal when Pi gives one, else with the run's", async () => {
		const run = new AbortController();
		const pis = new AbortController();
		const pi = toPi(
			{ transformContext: () => Effect.never, convertToLlm: () => Effect.never } satisfies Hooks<never>,
			runner(Context.empty()),
			() => run.signal,
		);
		const settle = (promise: PromiseLike<unknown> | unknown) =>
			Promise.resolve(promise).then(
				() => "resolved",
				() => "rejected",
			);
		// transformContext gets Pi's signal: aborting it interrupts the hook.
		const transforming = settle(pi.transformContext?.([], pis.signal));
		pis.abort();
		expect(await transforming).toBe("rejected");
		// convertToLlm gets no signal from Pi: the run's signal interrupts it.
		const converting = settle(pi.convertToLlm?.([]));
		run.abort();
		expect(await converting).toBe("rejected");
	});
});
