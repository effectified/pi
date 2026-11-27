// The testing entry without an engine: what `observed` adds to an actor, and the engine with its client in one step.
// engine-suite.ts and the swarm's rivet-suite.ts use it on a real engine.

import { Effect, type Scope } from "effect";
import { describe, expect, it } from "vitest";
import { ActorId, type Client, EngineUnavailable } from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";
import { Agent } from "./agent.ts";

/** The actions of a rivetkit definition, as `actor()` was given them. */
const actionsOf = (definition: typeof Agent): Record<string, unknown> & { readonly pi: Record<string, unknown> } =>
	// Rivet's untyped boundary: a definition's config is the object `actor()` was given.
	(definition.rivet.config as { readonly actions: Record<string, unknown> & { readonly pi: Record<string, unknown> } })
		.actions;

describe("Testing", () => {
	it("observes an actor: the same definition, with the test's actions under the host's own name", () => {
		const observed = Testing.observed(Agent);
		expect([observed.name, observed.actions]).toEqual([Agent.name, Agent.actions]);
		expect(Object.keys(actionsOf(observed)).sort()).toEqual(Object.keys(actionsOf(Agent)).sort());
		expect(Object.keys(actionsOf(observed).pi).sort()).toEqual([
			"lineage",
			"status",
			"testScheduleWake",
			"testSchedules",
			"testSleep",
			"wake",
		]);
		expect(Object.keys(actionsOf(Agent).pi).sort()).toEqual(["lineage", "status", "wake"]);
	});

	it("has recorded nothing of an actor that never ran here", async () => {
		const handle: Client.Handle = { definition: Agent, actorId: ActorId.make("never"), key: ["never"] };
		expect(await Effect.runPromise(Testing.lifecycle(handle))).toEqual([]);
	});

	it("starts the engine it is given and builds a client of its endpoint, for the scope", async () => {
		const served: Array<unknown> = [];
		const serve = (options: { readonly actors: ReadonlyArray<unknown> }) =>
			Effect.sync(() => {
				served.push(options);
				// The discard port: the client is built, and never asked.
				return { endpoint: "http://127.0.0.1:9" };
			});
		const hosted = await Effect.runPromise(Effect.scoped(Testing.hosted(serve, { actors: [] })));
		expect(hosted.endpoint).toBe("http://127.0.0.1:9");
		expect(served).toEqual([{ actors: [] }]);
		const failing = (): Effect.Effect<{ readonly endpoint: string }, EngineUnavailable, Scope.Scope> =>
			Effect.fail(new EngineUnavailable({ code: "port", message: "taken", retryable: true }));
		const failed = await Effect.runPromise(Effect.flip(Effect.scoped(Testing.hosted(failing, {}))));
		expect(failed.code).toBe("port");
	});
});
