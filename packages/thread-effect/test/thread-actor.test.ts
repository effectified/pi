// The thread actor's definition without an engine: the product's own actions beside the fixed ones, its own Layer on
// the open harness, and what their types refuse. What an actor does is in rivet-suite.ts.

import { Harness } from "@effectified/pi-durable";
import { Action, ActorDatabase } from "@effectified/pi-durable-rivet";
import { Context, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadKey, Threads } from "../src/index.ts";
import { ThreadActor } from "../src/rivet.ts";
import { config, outside, ports, providers } from "./world.ts";

/** A service of the product's own, which its `ports` Layer provides beside the ports. */
class Desk extends Context.Service<Desk, { readonly name: string }>()("test/Desk") {}

/** A service nothing in an actor provides. */
class Elsewhere extends Context.Service<Elsewhere, { readonly name: string }>()("test/Elsewhere") {}

/** An action on the actor's database, the composition's `Threads` and the product's own service. */
const brief = Action.make({
	input: Schema.Struct({ thread: ThreadKey }),
	output: Schema.Struct({ desk: Schema.String, alive: Schema.Boolean }),
	handler: ({ thread }) =>
		Effect.gen(function* () {
			yield* ActorDatabase;
			const desk = yield* Desk;
			const probe = yield* Threads.Threads.use((threads) => threads.probe(thread));
			return { desk: desk.name, alive: probe.alive };
		}).pipe(Effect.orDie),
});

/** A Layer of the product on the open harness: it uses the composition's services and the product's own. */
const onOpen = Layer.effectDiscard(
	Effect.gen(function* () {
		yield* Desk;
		yield* Harness.Harness;
		yield* Threads.Threads.use((threads) => threads.probe(ThreadKey.make("nobody")));
	}).pipe(Effect.orDie),
);

/** An action that needs what no actor has. */
const stray = Action.make({
	input: Schema.Null,
	output: Schema.String,
	handler: () => Elsewhere.use((elsewhere) => Effect.succeed(elsewhere.name)),
});

describe("a thread actor with actions of its product", () => {
	it("holds them beside the fixed ones, each run with what the actor, the composition and the ports provide", () => {
		const state = outside();
		const actor = ThreadActor.make("thread", {
			composition: config(state, providers()),
			ports: Layer.merge(ports(state), Layer.succeed(Desk, { name: "front" })),
			actions: { brief },
			services: onOpen,
		});
		expect(actor.name).toBe("thread");
		expect(Object.keys(actor.actions)).toEqual(expect.arrayContaining(["brief", "start", "runSwarm", "forkAccount"]));
		// The definition is typed by both: a caller's `Client.call` knows the product's action and the fixed ones.
		const typed: { readonly brief: typeof brief; readonly start: ThreadActor.Actions["start"] } = actor.actions;
		expect(typed.brief).toBe(brief);
	});

	it("is the same actor without them", () => {
		const state = outside();
		const actor: ThreadActor.Definition<"thread"> = ThreadActor.make("thread", {
			composition: config(state, providers()),
			ports: ports(state),
		});
		expect(Object.keys(actor.actions)).not.toContain("brief");
	});

	it("takes no product action under a fixed name, and nothing that needs what the actor does not provide", () => {
		const state = outside();
		const options = { composition: config(state, providers()), ports: ports(state) };
		const reserved = () =>
			// @ts-expect-error: `start` is a fixed action of a thread actor.
			ThreadActor.make("thread", { ...options, actions: { start: stray } });
		const hosts = () =>
			// @ts-expect-error: `destroy` is the host's own action.
			ThreadActor.make("thread", { ...options, actions: { destroy: brief } });
		const needy = () =>
			// @ts-expect-error: nothing in the actor provides `Elsewhere`.
			ThreadActor.make("thread", { ...options, actions: { stray } });
		const unprovided = () =>
			// @ts-expect-error: these ports do not provide `Desk`, which `brief` needs.
			ThreadActor.make("thread", { ...options, actions: { brief } });
		const closed = () =>
			// @ts-expect-error: these ports do not provide `Desk`, which the product's Layer on the harness needs.
			ThreadActor.make("thread", { ...options, services: onOpen });
		expect([reserved, hosts, needy, unprovided, closed].map((make) => typeof make)).toEqual(
			Array(5).fill("function"),
		);
	});
});
