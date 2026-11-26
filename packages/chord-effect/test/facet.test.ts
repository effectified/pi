import { Context, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
	type Facet as ChordFacet,
	ChordFailed,
	constant,
	Facet,
	Host,
	local,
	method,
	nul,
	obj,
	PluginFailed,
	type Principal,
	Reference,
	str,
} from "../src/index.ts";
import { run } from "./run.ts";

class Greetings extends Context.Service<Greetings, { readonly hello: (name: string) => Effect.Effect<string> }>()(
	"test/Greetings",
) {}

const Greeter = local("example.greeter", {
	version: 1,
	params: { language: str() },
	members: {
		language: str(),
		greet: method(obj({ name: str() }), str()),
		refuse: method(nul()),
		quota: method(nul()),
		hang: method(nul()),
	},
});

/** The greeter facet, its handlers Effects that use `Greetings`; `hung` learns when `hang` is interrupted. */
function greeter(hung: Deferred.Deferred<void>): Effect.Effect<ChordFacet.Facet<Principal>, never, Greetings> {
	return Facet.make<Principal, Greetings>((host, _self, lift) => {
		host.serve(Greeter, ({ language }) => ({
			language: constant(language),
			greet: lift(({ name }, _ctx) => Greetings.use((greetings) => greetings.hello(name))),
			refuse: lift((_ctx) => Effect.fail(new ChordFailed({ code: "invalid", reason: "args", message: "no" }))),
			quota: lift((_ctx) => Effect.fail(new PluginFailed({ code: "quota", message: "over", details: { left: 0 } }))),
			hang: lift((_ctx) => Effect.onInterrupt(Effect.never, () => Deferred.succeed(hung, undefined))),
		}));
	});
}

const services = Effect.provideService(Greetings, { hello: (name) => Effect.succeed(`Hello ${name}`) });

describe("Facet.make", () => {
	it("serves a type whose handlers are Effects that run with the services of where it was made", async () => {
		const answer = await run(
			services(
				Effect.gen(function* () {
					const facet = yield* greeter(yield* Deferred.make<void>());
					const host = yield* Host.make({});
					yield* host.load([{ name: "@example/greeter", facet }]);
					const english = yield* host.get(Greeter, { language: "en" });
					return [english.language.value, yield* Reference.call(english.greet, { name: "Ada" })];
				}),
			),
		);
		expect(answer).toEqual(["en", "Hello Ada"]);
	});

	it("gives the caller a handler's ChordFailed and PluginFailed with their code", async () => {
		const [refused, over] = await run(
			services(
				Effect.gen(function* () {
					const facet = yield* greeter(yield* Deferred.make<void>());
					const host = yield* Host.make({});
					yield* host.load([{ name: "@example/greeter", facet }]);
					const greeter_ = yield* host.get(Greeter, { language: "en" });
					return [
						yield* Effect.exit(Reference.call(greeter_.refuse)),
						yield* Effect.exit(Reference.call(greeter_.quota)),
					];
				}),
			),
		);
		expect(refused).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args", message: "no" }));
		expect(over).toMatchObject(Exit.fail({ _tag: "PluginFailed", code: "quota", details: { left: 0 } }));
	});

	it("interrupts a handler when its caller is interrupted", async () => {
		await run(
			services(
				Effect.gen(function* () {
					const hung = yield* Deferred.make<void>();
					const facet = yield* greeter(hung);
					const host = yield* Host.make({});
					yield* host.load([{ name: "@example/greeter", facet }]);
					const greeter_ = yield* host.get(Greeter, { language: "en" });
					const call = yield* Effect.forkChild(Reference.call(greeter_.hang), { startImmediately: true });
					yield* Effect.yieldNow;
					yield* Fiber.interrupt(call);
					yield* Deferred.await(hung);
				}),
			),
		);
	});
});

describe("Facet.evaluate", () => {
	it("gives the facet a registered script exports, and fails with ScriptFailed when it throws", async () => {
		const [facet, failed] = await run(
			Effect.all([
				Effect.exit(
					Facet.evaluate(
						{
							plugin: "@example/script",
							digest: "d1",
							run: (_require, module) => {
								Object.assign(module, { exports: { default: { setup: () => {} } } });
							},
						},
						{},
					),
				),
				Effect.exit(
					Facet.evaluate(
						{
							plugin: "@example/script",
							digest: "d2",
							run: () => {
								throw new Error("broken");
							},
						},
						{},
					),
				),
			]),
		);
		expect(Exit.isSuccess(facet)).toBe(true);
		expect(failed).toMatchObject(Exit.fail({ _tag: "ScriptFailed", plugin: "@example/script" }));
	});
});
