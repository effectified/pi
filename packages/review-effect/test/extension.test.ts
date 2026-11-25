import { Extension, Hook, Registry } from "@gunta/pi-durable-effect";
import { answer } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Check, Citations, extension, NAME, state } from "../src/index.ts";
import { ask, findings, POLICY, scene } from "./scene.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("extension", () => {
	it("is named review, and holds one hook and the review task", () => {
		const made = extension({ policy: POLICY });
		expect([NAME, made.name, made.hooks?.length, made.tasks?.map((task) => task.name)]).toEqual([
			"review",
			"review",
			1,
			["review.answer"],
		]);
	});

	it("is asked after an onYield hook before it that does not answer, and a hook after it is never asked", async () => {
		const asked: string[] = [];
		const silent = (name: string) =>
			Extension.make({
				name,
				hooks: [
					Hook.onYield(() =>
						Effect.sync(() => {
							asked.push(name);
							return Option.none();
						}),
					),
				],
			});
		const between = scene({
			before: [silent("before")],
			after: [silent("after")],
			author: [answer("It is 42.")],
			reviewer: [findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* submission.wait;
				yield* root.waitForIdle;
				return yield* state(root);
			}).pipe(Effect.provide(between.layer)),
		);
		// Pi takes the first answer: the review's. The hook before it had declined; the one after it was not asked.
		expect(asked).toEqual(["before"]);
		expect(result._tag).toBe("Reviewed");
	});

	it("requires what its checks need: a registry does not build without it", () => {
		class Glossary extends Context.Service<Glossary, { readonly banned: ReadonlyArray<string> }>()("app/Glossary") {}
		const Wording = Check.make("app.wording", () => Glossary.use(() => Effect.succeed([])));
		const reviewed = Registry.layer([extension({ policy: POLICY, checks: [Citations.check(() => []), Wording] })]);
		const requirements: Equal<Layer.Services<typeof reviewed>, Citations.Verifier | Glossary> = true;
		// @ts-expect-error The registry requires Citations.Verifier and Glossary, which nothing provided.
		const unprovided: Layer.Layer<Registry.Registry, unknown, never> = reviewed;
		const verifier = Layer.succeed(Citations.Verifier, {
			verify: () => Effect.succeed({ _tag: "Verified" as const }),
		});
		// @ts-expect-error One of the two is still missing.
		const half: Layer.Layer<Registry.Registry, unknown, never> = Layer.provide(reviewed, verifier);
		const provided: Layer.Layer<Registry.Registry, unknown, never> = Layer.provide(
			reviewed,
			Layer.merge(verifier, Layer.succeed(Glossary, { banned: ["Obviously"] })),
		);
		const plain: Layer.Layer<Registry.Registry, unknown, never> = Registry.layer([extension({ policy: POLICY })]);
		expect([requirements, ...[unprovided, half, provided, plain].map(Layer.isLayer)]).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
	});
});
