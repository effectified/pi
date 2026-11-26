// The composition's three parts as the arguments of a Rivet actor: the shape `Actor.make` of the Rivet host takes.
// Nothing is hosted here, and no engine runs: the actor form of the composition is `ThreadActor.make`, built on these
// parts, and test/rivet-suite.ts runs it on an engine.

import type { DurableError, Harness } from "@effectified/pi-durable";
import { Actor } from "@effectified/pi-durable-rivet";
import { Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Composition } from "../src/index.ts";
import { config, outside, ports, providers } from "./world.ts";

/** What the harness of an actor runs on: `Composition.layer`, with the product's ports kept for the other two parts. */
const layerOf = () => {
	const state = outside();
	// Merged, not only provided: `harness` takes the `PiTelemetry` and `services` the `RecordSink` from what this
	// Layer provides.
	return Composition.layer(config(state, providers())).pipe(Layer.provideMerge(ports(state)));
};

describe("the composition as the parts of a Rivet actor", () => {
	it("is an actor definition: the layer with the ports, the harness options as an Effect, and the services", () => {
		const layer = layerOf();
		// Said to require everything `layer` provides, which the host allows of `services`: see the next test.
		const services: Layer.Layer<Composition.Services, DurableError, Harness.Harness | Layer.Success<typeof layer>> =
			Composition.services();
		const actor = Actor.make("thread", { layer, harness: Composition.harness(), services, actions: {} });
		expect(actor.name).toBe("thread");
		expect(Object.keys(actor.actions)).toEqual([]);
	});

	it("takes services that require less than `layer` provides, beside a `harness` that needs more of it", () => {
		const layer = layerOf();
		// `services` requires nothing of `PiTelemetry`, which `harness` needs: the host reads what `layer` provides off
		// `layer` alone.
		const actor = Actor.make("thread", {
			layer,
			harness: Composition.harness(),
			services: Composition.services(),
			actions: {},
		});
		expect(actor.name).toBe("thread");
	});
});
