// Working with actors from inside an actor, without an engine: the definition and the handle an actor has of itself,
// and the client its context gives. engine-suite.ts uses all of it in a real actor.

import { Effect, Layer, Option } from "effect";
import type { ClientRaw } from "rivetkit/client";
import { describe, expect, it } from "vitest";
import { ActorEngine, ActorId, ActorInfo, Client, type Identity, Self } from "../src/index.ts";
import { Agent } from "./agent.ts";

const info: Identity = {
	actorId: ActorId.make("actor-1"),
	name: "agent",
	key: ["tenant", "primed"],
	namespace: "default",
	forkChain: [],
	forkInput: Option.none(),
};

const inActor = Layer.succeed(ActorInfo, info);

describe("Self", () => {
	it("gives the actor's definition as a caller needs it: its registered name, and the actions asked for", async () => {
		const { transcript } = Agent.actions;
		const own = await Effect.runPromise(Self.definition({ transcript }).pipe(Effect.provide(inActor)));
		expect(own).toEqual({ name: "agent", actions: { transcript } });
	});

	it("gives a handle of the actor itself, which the caller's side takes as any other", async () => {
		const { transcript } = Agent.actions;
		const own = await Effect.runPromise(Self.handle({ transcript }).pipe(Effect.provide(inActor)));
		expect(own).toEqual({
			definition: { name: "agent", actions: { transcript } },
			actorId: "actor-1",
			key: ["tenant", "primed"],
		});
		// Typed by the actions it was given: this one, and no other.
		const call: Effect.Effect<ReadonlyArray<string>, unknown, Client.RivetClient> = Client.call(
			own,
			"transcript",
			null,
		);
		// @ts-expect-error: the handle was made for `transcript` alone.
		Client.call(own, "ask", { text: "hello", requestId: "first" });
		expect(Effect.isEffect(call)).toBe(true);
	});

	it("finds an actor of its own definition by key through the client of the context", async () => {
		const asked: Array<[string, ReadonlyArray<string>]> = [];
		// A stand-in for the client rivetkit makes from the actor's context: the test gives only what is called.
		const client = {
			get: (name: string, key: ReadonlyArray<string>) => ({
				resolve: () => {
					asked.push([name, key]);
					return Promise.resolve("actor-2");
				},
			}),
		} as unknown as ClientRaw;
		const engine = Layer.succeed(ActorEngine, { connect: Effect.sync(() => client) });
		const found = await Effect.runPromise(
			Self.find({}, ["tenant", "other"]).pipe(
				Effect.provide(Self.client),
				Effect.provide(engine),
				Effect.provide(inActor),
			),
		);
		expect(Option.map(found, (handle) => [handle.definition.name, handle.actorId, handle.key])).toEqual(
			Option.some(["agent", "actor-2", ["tenant", "other"]]),
		);
		expect(asked).toEqual([["agent", ["tenant", "other"]]]);
	});
});
