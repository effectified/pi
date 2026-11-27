// The caller's side without an engine: what a call's types say, and what an engine that cannot be reached gives.
// Everything that needs an actor is in engine.test.ts.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ActorId, type CallError, Client } from "../src/index.ts";
import { Agent, type Refused } from "./agent.ts";

/**
 * An endpoint nothing listens on, the discard port of the loopback interface, without rivetkit's first lookup: with
 * it, rivetkit waits for the engine without end and no request fails.
 */
const unreachable = Client.layer({ endpoint: "http://127.0.0.1:9", disableMetadataLookup: true });

describe("Client", () => {
	it("types a call by the action's schemas", () => {
		const handle: Client.Handle<typeof Agent> = { definition: Agent, actorId: ActorId.make("none"), key: ["none"] };
		// An action with an error schema fails with that error, decoded; one without has no failure of its own.
		const refuse: Effect.Effect<null, Client.ActionFailure<Refused> | CallError, Client.RivetClient> = Client.call(
			handle,
			"refuse",
			{ reason: "no" },
		);
		const ask: Effect.Effect<
			ReadonlyArray<string>,
			Client.ActionFailure<never> | CallError,
			Client.RivetClient
		> = Client.call(handle, "ask", { text: "hello", requestId: "first" });
		// @ts-expect-error: `ask` takes a text and a request id.
		Client.call(handle, "ask", { text: 5 });
		// @ts-expect-error: the actor has no such action.
		Client.call(handle, "missing", null);
		expect([Effect.isEffect(refuse), Effect.isEffect(ask)]).toEqual([true, true]);
	});

	it("fails with a retryable EngineUnavailable when the engine cannot be reached", async () => {
		const failed = await Effect.runPromise(
			Effect.flip(Client.getOrCreate(Agent, ["nobody"])).pipe(Effect.provide(unreachable)),
		);
		expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "transport", retryable: true });
	}, 30_000);
});
