// Test helper: the README's example, as it stands there, on a local engine of its own, registered once per runtime
// by readme.node.test.ts and readme.bun.test.ts. Skipped when the engine binary is not installed.

import { Registry } from "@effectified/pi-durable";
import { answer, ScriptedModels, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Action, Actor, Client } from "../src/index.ts";
import type * as LocalEngine from "../src/node.ts";

// What the harness runs on beside its storage: a registry and the models. Built at each wake of the actor.
const layer = Layer.merge(
	Registry.layer([]),
	// No provider and no key: the model says how many questions the conversation holds.
	Layer.effectDiscard(
		ScriptedModels.use((models) =>
			models.setResponses(
				Array.from({ length: 100 }, () => (context) => {
					const asked = context.messages.filter((message) => message.role === "user").length;
					return answer(`That was question ${asked}.`);
				}),
			),
		),
	).pipe(Layer.provideMerge(ScriptedModels.layer())),
).pipe(Layer.orDie);

const Agent = Actor.make("agent", {
	layer,
	actions: {
		// Prompts the root conversation and gives the model's answer.
		ask: Action.make({
			input: Schema.Struct({ text: Schema.String, requestId: Schema.String }),
			output: Schema.String,
			handler: ({ text, requestId }) =>
				Effect.gen(function* () {
					const root = yield* TestHarness.root;
					yield* root.prompt(text, { requestId });
					const last = (yield* root.context()).messages.at(-1);
					return last?.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "";
				}).pipe(Effect.orDie),
		}),
	},
});

const program = Effect.gen(function* () {
	// One actor is one harness storage, found by its key.
	const agent = yield* Client.getOrCreate(Agent, ["demo"]);
	const first = yield* Client.call(agent, "ask", { text: "Hello.", requestId: "hello" });
	// A fork is made of an idle harness: the new actor sees the transcript and continues alone.
	yield* Client.waitForIdle(agent);
	const fork = yield* Client.fork(agent, { key: ["demo", "what-if"], input: { reason: "what if" } });
	const second = yield* Client.call(fork, "ask", { text: "And then?", requestId: "then" });
	const again = yield* Client.call(agent, "ask", { text: "Still there?", requestId: "still" });
	const lineage = yield* Client.lineage(fork);
	yield* Client.destroy(fork);
	return { first, second, again, forkedFrom: lineage.chain.map((link) => link.key) };
});

/** Registers the example on the local engine of one runtime: `src/node.ts` or `src/bun.ts`. */
export function registerReadme(runtime: string, engines: typeof LocalEngine): void {
	// Locally: an engine of this process's own, on a free port, hosting the actor in this process.
	const main = Effect.scoped(
		Effect.gen(function* () {
			const engine = yield* engines.serve({ actors: [Agent] });
			return yield* Effect.provide(program, Client.layer({ endpoint: engine.endpoint }));
		}),
	);

	describe.skipIf(!Effect.runSync(engines.available))(`the README's example (${runtime})`, () => {
		it("prompts an actor, forks it, and both continue alone", async () => {
			expect(await Effect.runPromise(main)).toEqual({
				first: "That was question 1.",
				second: "That was question 2.",
				again: "That was question 2.",
				forkedFrom: [["demo"]],
			});
		}, 60_000);
	});
}
