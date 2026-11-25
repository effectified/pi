// What an actor definition takes, without an engine: the harness options as they are, or as an Effect on what
// `layer` provides. engine-suite.ts runs an actor whose options are such an Effect.

import { Registry } from "@gunta/pi-durable-effect";
import { ScriptedModels } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Actor, ActorInfo } from "../src/index.ts";

/** A service of a product, which its harness options are made from. */
class Telemetry extends Context.Service<Telemetry, { readonly name: string }>()("test/Telemetry") {}

/** A service no Layer of these tests provides. */
class Missing extends Context.Service<Missing, { readonly name: string }>()("test/Missing") {}

const base = Layer.merge(Registry.layer([]), ScriptedModels.layer()).pipe(Layer.orDie);
const withTelemetry = Layer.merge(base, Layer.succeed(Telemetry, { name: "product" }));

describe("Actor.make", () => {
	it("takes the harness options as they are", () => {
		const plain = Actor.make("plain", { layer: base, harness: { identity: undefined }, actions: {} });
		const none = Actor.make("none", { layer: base, actions: {} });
		expect([plain.name, none.name]).toEqual(["plain", "none"]);
	});

	it("takes them as an Effect on what `layer` provides and on the actor's own services", () => {
		const made = Actor.make("made", {
			layer: withTelemetry,
			harness: Effect.gen(function* () {
				const telemetry = yield* Telemetry;
				const { actorId } = yield* ActorInfo;
				return { conversationCreated: () => Effect.log(telemetry.name, actorId) };
			}),
			actions: {},
		});
		// An Effect that fails: the failure is a harness that did not open, as a Layer's is.
		const failing = Actor.make("failing", {
			layer: withTelemetry,
			harness: Effect.flatMap(Telemetry, () => Effect.fail("no telemetry")),
			actions: {},
		});
		expect([made.name, failing.name]).toEqual(["made", "failing"]);
	});

	it("does not take an Effect that needs what `layer` does not provide", () => {
		const unprovided = Actor.make("unprovided", {
			layer: base,
			// @ts-expect-error: nothing provides `Missing`.
			harness: Effect.map(Missing, () => ({})),
			actions: {},
		});
		expect(unprovided.name).toBe("unprovided");
	});
});
