import { Extension, Registry } from "@effectified/pi-durable";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { extension, Inbox, type Policy } from "../src/index.ts";

class Limits extends Context.Service<Limits, { readonly longest: number }>()("test/Limits") {}

const limited: Policy<Limits> = {
	expiresAfter: "1 hour",
	rule: (call) => Limits.use((limits) => Effect.succeed(String(call.arguments.text).length > limits.longest)),
};

const inbox = Layer.succeed(Inbox, { publish: () => Effect.void });

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("extension", () => {
	it("is named approvals and holds the gate, then the record", () => {
		const approvals = extension({ tools: ["write"], expiresAfter: "1 hour" });
		expect(approvals.name).toBe("approvals");
		expect(approvals.hooks).toHaveLength(2);
		expect(approvals.tools).toBeUndefined();
	});

	it("makes the registry require the Inbox and what the policy's rule needs, until a Layer provides both", async () => {
		const registry = Registry.layer([Extension.make({ name: "app" }), extension(limited)]);
		const requirements: Equal<Layer.Services<typeof registry>, Inbox | Limits> = true;
		// @ts-expect-error The rule needs Limits and the gate needs the Inbox, which nothing provides.
		const unprovided: Layer.Layer<Registry.Registry, unknown> = registry;
		// @ts-expect-error The Inbox alone is not enough: the rule needs Limits.
		const half: Layer.Layer<Registry.Registry, unknown> = registry.pipe(Layer.provide(inbox));
		const provided: Layer.Layer<Registry.Registry, unknown> = registry.pipe(
			Layer.provide(inbox),
			Layer.provide(Layer.succeed(Limits, { longest: 5 })),
		);
		// Without a rule, only the Inbox is needed.
		const plain = Registry.layer([extension({ tools: ["write"], expiresAfter: "1 hour" })]);
		const plainRequirements: Equal<Layer.Services<typeof plain>, Inbox> = true;
		expect([requirements, plainRequirements]).toEqual([true, true]);
		expect([unprovided, half].every(Layer.isLayer)).toBe(true);
		const built = await Effect.runPromise(Effect.scoped(Layer.build(provided)));
		expect(Context.get(built, Registry.Registry)).toBeDefined();
	});
});
