import { Effect, PubSub } from "effect";
import { describe, expect, it } from "vitest";
import * as Enforced from "../src/enforced.ts";
import { type Guard, Policy, type Refusal } from "../src/index.ts";

/** A guard's service as `Guard.fromPolicy` makes it. */
const service = (): Guard.Service => ({
	policy: Policy.empty,
	refusals: Effect.runSync(PubSub.unbounded<Refusal.Refusal>()),
});

describe("any", () => {
	it("is false for a guard that built no registry, and true once one was bound", () => {
		const guard = service();
		expect(Enforced.any(guard)).toBe(false);
		Enforced.bind(guard, { name: "guard" });
		expect(Enforced.any(guard)).toBe(true);
		expect(Enforced.any(service())).toBe(false);
	});
});

describe("owns", () => {
	it("compares the object a registry of this guard holds, never the name", () => {
		const guard = service();
		const [first, second] = [{ name: "guard" }, { name: "guard" }];
		Enforced.bind(guard, first);
		expect(Enforced.owns(guard, first)).toBe(true);
		expect(Enforced.owns(guard, { name: "guard" })).toBe(false);
		expect(Enforced.owns(guard, undefined)).toBe(false);
		// One guard may build several registries, each with its own extension object.
		Enforced.bind(guard, second);
		expect([Enforced.owns(guard, first), Enforced.owns(guard, second)]).toEqual([true, true]);
		expect(Enforced.owns(service(), first)).toBe(false);
	});
});
