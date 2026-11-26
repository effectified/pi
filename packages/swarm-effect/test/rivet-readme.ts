// Test helper: the README's Rivet example, as it stands there, on a local engine of its own, registered once per
// runtime by rivet-readme.node.test.ts and rivet-readme.bun.test.ts. Skipped when the engine binary is not installed.
// Only the imports differ (the README names the package, this file its sources).

import { Registry } from "@effectified/pi-durable";
import { answer, type FauxResponseFactory, ScriptedModels, TestHarness } from "@effectified/pi-durable/testing";
import { Action, Actor, Client, Self } from "@effectified/pi-durable-rivet";
import type * as LocalEngine from "@effectified/pi-durable-rivet/node";
import { Effect, Layer, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import * as Rivet from "../src/rivet.ts";

// The work of one kind of swarm, and a scripted model, as in the quick start.
const Covers = Swarm.make({
	name: "covers",
	input: Schema.Struct({ topic: Schema.String }),
	result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
	prompt: ({ topic }) => `Does the document you read cover ${topic}?`,
});
const scripted: FauxResponseFactory = (context) => {
	const asked = context.messages.findLast((message) => message.role === "user")?.content;
	const topic = /cover (\w+)\?/.exec(String(asked))?.[1];
	return answer(topic === undefined ? "I have read it." : JSON.stringify({ topic, covered: topic !== "Zig" }));
};

// What the actor's harness runs on. The registry needs the driver and the product's fork setup; the driver needs the
// engine's client, which the host makes from the actor's own context.
const layer = Layer.mergeAll(
	Registry.layer([Swarm.extension([Covers])]),
	Layer.effectDiscard(
		ScriptedModels.use((models) => models.setResponses(Array.from({ length: 20 }, () => scripted))),
	).pipe(Layer.provideMerge(ScriptedModels.layer())),
).pipe(
	Layer.provideMerge(Rivet.layer()),
	Layer.provide(Self.client),
	// No guard and no budget here. Every fork is an actor of this definition and runs the setup itself.
	Layer.provideMerge(Swarm.ForkSetup.none),
	Layer.orDie,
);

// One definition is the source of a swarm and each of its forks.
const Agent = Actor.make("agent", {
	layer,
	forkHygiene: [Rivet.forkHygiene],
	actions: {
		...Rivet.actions,
		// Primes the root conversation and starts a swarm on it. It answers once the swarm is stored.
		start: Action.make({
			input: Schema.Struct({ id: Schema.String, topics: Schema.Array(Schema.String) }),
			output: Schema.Null,
			handler: ({ id, topics }) =>
				Effect.gen(function* () {
					const root = yield* TestHarness.root;
					yield* root.prompt("Read this document: ...", { requestId: "prime" });
					const jobs = topics.map((topic) => ({ key: topic, input: { topic } }));
					yield* Swarm.start(Covers, { id, source: root.id, jobs, cap: 2, onFailure: "collect" });
					return null;
				}).pipe(Effect.orDie),
		}),
		// Whether the swarm still runs. Its coordinator sleeps between two questions to its forks.
		running: Action.make({
			input: Schema.String,
			output: Schema.Boolean,
			handler: (id) => Effect.orDie(Effect.map(Swarm.status(id), (status) => status.running)),
		}),
		// The topics the document covers, from the result of a swarm that has ended.
		covered: Action.make({
			input: Schema.String,
			output: Schema.Array(Schema.String),
			handler: (id) =>
				Effect.orDie(
					Effect.map(Swarm.result(Covers, id), (outcome) =>
						outcome.jobs.flatMap((job) => (job._tag === "Success" && job.value.covered ? [job.value.topic] : [])),
					),
				),
		}),
	},
});

const program = Effect.gen(function* () {
	const agent = yield* Client.getOrCreate(Agent, ["document-7"]);
	yield* Client.call(agent, "start", { id: "covers-1", topics: ["Rust", "Go", "Zig"] });
	// The swarm runs in the actor. An action does not wait for it: Rivet ends an action after its timeout.
	yield* Effect.repeat(Client.call(agent, "running", "covers-1"), {
		while: (running) => running,
		schedule: Schedule.spaced("200 millis"),
	});
	return yield* Client.call(agent, "covered", "covers-1");
});

/** Registers the example on the local engine of one runtime: the host's `node` or `bun` entry. */
export function registerRivetReadme(runtime: string, engines: typeof LocalEngine): void {
	// Locally: an engine of this process's own, on a free port, hosting the actor and its forks in this process.
	const main = Effect.scoped(
		Effect.gen(function* () {
			const local = yield* engines.serve({ actors: [Agent] });
			return yield* Effect.provide(program, Client.layer({ endpoint: local.endpoint }));
		}),
	);

	describe.skipIf(!Effect.runSync(engines.available))(`the README's Rivet example (${runtime})`, () => {
		it("primes an actor, runs a swarm on forks of it, and reads the typed result", async () => {
			expect(await Effect.runPromise(main)).toEqual(["Rust", "Go"]);
		}, 60_000);
	});
}
