import { Registry } from "@effectified/pi-durable";
import { Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { ForkDriver } from "../src/driver.ts";
import * as ForkSetup from "../src/fork-setup.ts";
import { extension, named } from "../src/swarm.ts";
import { Measure } from "./support.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("a swarm definition", () => {
	it("has its name, its compiled work, and a coordinator task named for it under swarm.", () => {
		expect(Measure.name).toBe("measure");
		expect(Measure.work.name).toBe("measure");
		expect(Measure.task.name).toBe("swarm.coordinator.measure");
	});

	it("is installed by an extension named swarm that has the coordinators and no tool or hook", () => {
		const installed = extension([Measure]);
		expect(installed.name).toBe("swarm");
		expect(installed.tasks).toEqual([Measure.task]);
		expect([installed.tools, installed.hooks]).toEqual([undefined, undefined]);
	});

	it("makes the registry require a ForkDriver and the product's fork setup", () => {
		const registry = Registry.layer([extension([Measure])]);
		const requirements: Equal<Layer.Services<typeof registry>, ForkDriver | ForkSetup.ForkSetup> = true;
		// @ts-expect-error The coordinators need a ForkDriver, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, unknown> = registry;
		// @ts-expect-error A driver alone is not enough: nobody decided about the forks.
		const undecided: Layer.Layer<Registry.Registry, unknown, ForkDriver> = registry;
		// The stated choice of a product that wants nothing done to a fork.
		const decided: Layer.Layer<Registry.Registry, unknown, ForkDriver> = Layer.provide(registry, ForkSetup.none);
		expect([requirements, unprovided, undecided, Layer.isLayer(decided)]).toEqual([true, registry, registry, true]);
	});
});

describe("named", () => {
	it("turns every tool and extension of an agent change into its name, and keeps the rest", () => {
		expect(
			named({
				model: { provider: "p", modelId: "m" },
				instructions: "Be brief.",
				extensions: { add: [{ name: "search" }], remove: ["write"] },
				tools: { remove: [{ name: "bash" }] },
				modelTools: ["read", { name: "grep" }],
			}),
		).toEqual({
			model: { provider: "p", modelId: "m" },
			instructions: "Be brief.",
			extensions: { add: ["search"], remove: ["write"] },
			tools: { remove: ["bash"] },
			modelTools: ["read", "grep"],
		});
	});

	it("keeps a cleared field cleared and an absent one absent", () => {
		expect(named({ tools: null, extensions: [{ name: "a" }] })).toEqual({ tools: null, extensions: ["a"] });
		expect(named({})).toEqual({});
	});
});
