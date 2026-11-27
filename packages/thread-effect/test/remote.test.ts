// The caller's side of the thread actors without an engine: which actor each operation asks, by the thread's key or
// by the product's own function of it, and how a product action is called for a thread. What needs an actor is in
// rivet-suite.ts.

import { Action, Client } from "@effectified/pi-durable-rivet";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { type ClientRaw, RivetError } from "rivetkit/client";
import { describe, expect, it } from "vitest";
import * as Swarm from "@effectified/pi-swarm";
import { RequestKey, ThreadKey, ThreadNotFound } from "../src/index.ts";
import { Remote, ThreadActor } from "../src/rivet.ts";
import { config, outside, ports, providers, work } from "./world.ts";

/** What the product action `brief` refuses with. */
class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {
	reason: Schema.String,
}) {}

/** A thread actor with one product action, which nothing hosts here: only its name and its schemas are used. */
const Desk = (() => {
	const state = outside();
	return ThreadActor.make("desk", {
		composition: config(state, providers()),
		ports: ports(state),
		actions: {
			brief: Action.make({
				input: Schema.Struct({ text: Schema.String }),
				output: Schema.Struct({ length: Schema.Number }),
				error: Refused,
				handler: ({ text }) =>
					text === "" ? Effect.fail(new Refused({ reason: "empty" })) : Effect.succeed({ length: text.length }),
			}),
		},
	});
})();

/** The actor a thread's key names when a product keeps several threads in one: what stands before the first slash. */
const deskOf = (thread: string): Client.Key => [thread.slice(0, thread.indexOf("/"))];

/** One request the stand-in engine got: a lookup of an actor by key, or an action of one actor. */
type Asked =
	| { readonly kind: "get" | "getOrCreate"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "action"; readonly actor: string; readonly name: string; readonly input: unknown };

/** The JSON a value of `schema` crosses as: what an action's answer holds. */
const wire = <S extends Action.Wire>(schema: S, value: S["Type"]) =>
	Schema.encodeUnknownSync(Schema.toCodecJson(schema))(value);

/**
 * A stand-in for rivetkit's client: an engine whose actors are those a `getOrCreate` made, each answering the actions
 * in `answers` with a success of that JSON, or a failure when the test names one. A cast: only what `Client` calls.
 */
function engine(answers: Readonly<Record<string, unknown>>, failures: Readonly<Record<string, unknown>> = {}) {
	const asked: Array<Asked> = [];
	const actors = new Set<string>();
	const idOf = (key: ReadonlyArray<string>) => `actor:${key.join("|")}`;
	const client = {
		getOrCreate: (_name: string, key: Array<string>) => ({
			resolve: () => {
				asked.push({ kind: "getOrCreate", key });
				actors.add(idOf(key));
				return Promise.resolve(idOf(key));
			},
		}),
		get: (_name: string, key: Array<string>) => ({
			resolve: () => {
				asked.push({ kind: "get", key });
				return actors.has(idOf(key))
					? Promise.resolve(idOf(key))
					: Promise.reject(new RivetError("actor", "not_found", "no such actor"));
			},
		}),
		getForId: (_name: string, actor: string) => ({
			action: ({ name, args }: { readonly name: string; readonly args: ReadonlyArray<unknown> }) => {
				asked.push({ kind: "action", actor, name, input: args[0] });
				return Promise.resolve(
					Object.hasOwn(failures, name)
						? { _tag: "failure", error: failures[name] }
						: { _tag: "success", value: answers[name] },
				);
			},
		}),
	} as unknown as ClientRaw;
	return { asked, context: Context.make(Client.RivetClient, client) };
}

const ANSWERS = {
	start: { created: true, key: "job-1" },
	probe: { alive: true },
	probeSwarm: { alive: false, jobKeys: ["rust"] },
	destroyFork: wire(Schema.Struct({ bytesWritten: Schema.Option(Schema.Number) }), {
		bytesWritten: Option.some(4096),
	}),
	brief: { length: 5 },
};

/** The `Remote` of `Desk` on a stand-in engine, with the options a test gives. */
const remoteOn = (served: ReturnType<typeof engine>, options?: Remote.Options) =>
	Effect.runSync(
		Effect.map(
			Effect.provideContext(Layer.build(Remote.layer(Desk, options)), served.context).pipe(Effect.scoped),
			Context.get(Remote.Remote),
		),
	);

describe("the actor of a thread, as a caller finds it", () => {
	it("is the actor under the thread's key when the product says nothing else", async () => {
		const served = engine(ANSWERS);
		const remote = remoteOn(served);
		const started = await Effect.runPromise(
			remote.threads.start(work("desk/a", "Say hi."), RequestKey.make("job-1")),
		);
		const probed = await Effect.runPromise(remote.threads.probe(ThreadKey.make("desk/a")));
		expect([started, probed]).toEqual([{ created: true, key: "job-1" }, { alive: true }]);
		expect(served.asked.filter((request) => request.kind !== "action")).toEqual([
			{ kind: "getOrCreate", key: ["desk/a"] },
			{ kind: "get", key: ["desk/a"] },
		]);
	});

	it("is the actor the product's function of the thread's key names, for a thread, a swarm and a fork alike", async () => {
		const served = engine(ANSWERS);
		const remote = remoteOn(served, { actorKey: deskOf });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				return {
					// Two threads of one actor: each is started and asked under its own key, in the actor of both.
					first: yield* remote.threads.start(work("desk/a", "Say hi."), RequestKey.make("job-1")),
					second: yield* remote.threads.start(work("desk/b", "Say hi again."), RequestKey.make("job-2")),
					probe: yield* remote.threads.probe(ThreadKey.make("desk/b")),
					// A swarm id names its thread, and the thread names the actor.
					swarm: yield* remote.swarms.probe(Swarm.SwarmId.make("desk/a/covers-1")),
					fork: yield* remote.forks.destroy({
						swarmId: Swarm.SwarmId.make("desk/a/covers-1"),
						jobKey: Swarm.JobKey.make("rust"),
					}),
					// An actor nothing created is not created to be asked.
					absent: yield* remote.threads.probe(ThreadKey.make("shelf/a")),
					missing: yield* Effect.flip(remote.threads.outcome(ThreadKey.make("shelf/a"))),
				};
			}),
		);
		expect(result).toEqual({
			first: { created: true, key: "job-1" },
			second: { created: true, key: "job-1" },
			probe: { alive: true },
			swarm: { alive: false, jobKeys: ["rust"] },
			fork: { bytesWritten: Option.some(4096) },
			absent: { alive: false },
			missing: new ThreadNotFound({ thread: ThreadKey.make("shelf/a") }),
		});
		expect(served.asked.filter((request) => request.kind !== "action")).toEqual([
			{ kind: "getOrCreate", key: ["desk"] },
			{ kind: "getOrCreate", key: ["desk"] },
			{ kind: "get", key: ["desk"] },
			{ kind: "get", key: ["desk"] },
			{ kind: "get", key: ["desk"] },
			{ kind: "get", key: ["shelf"] },
			{ kind: "get", key: ["shelf"] },
		]);
		// Inside the actor a thread and a swarm keep their own keys: the function names the actor, nothing else.
		expect(
			served.asked.flatMap((request) =>
				request.kind === "action" ? [[request.actor, request.name, request.input]] : [],
			),
		).toEqual([
			["actor:desk", "start", { work: expect.objectContaining({ thread: "desk/a" }), key: "job-1" }],
			["actor:desk", "start", { work: expect.objectContaining({ thread: "desk/b" }), key: "job-2" }],
			["actor:desk", "probe", { thread: "desk/b" }],
			["actor:desk", "probeSwarm", { swarmId: "desk/a/covers-1" }],
			["actor:desk", "destroyFork", { swarmId: "desk/a/covers-1", jobKey: "rust" }],
		]);
	});
});

describe("a product action of a thread actor, called for a thread", () => {
	const productOn = (served: ReturnType<typeof engine>) =>
		Effect.runSync(Effect.provideContext(Remote.product(Desk, { actorKey: deskOf }), served.context));

	it("reaches the thread's actor typed by its schemas, and creates the actor only when asked to", async () => {
		const served = engine(ANSWERS);
		const product = productOn(served);
		// No actor yet: `call` creates none and says so.
		const before = await Effect.runPromise(
			Effect.flip(product.call(ThreadKey.make("desk/a"), "brief", { text: "hello" })),
		);
		expect(before).toEqual(new ThreadNotFound({ thread: ThreadKey.make("desk/a") }));
		expect(served.asked).toEqual([{ kind: "get", key: ["desk"] }]);
		// `callOrCreate` gives the actor its work before anything started in it.
		const created: { readonly length: number } = await Effect.runPromise(
			product.callOrCreate(ThreadKey.make("desk/a"), "brief", { text: "hello" }),
		);
		const found = await Effect.runPromise(product.call(ThreadKey.make("desk/b"), "brief", { text: "again" }));
		expect([created, found]).toEqual([{ length: 5 }, { length: 5 }]);
		expect(served.asked.slice(1)).toEqual([
			{ kind: "getOrCreate", key: ["desk"] },
			{ kind: "action", actor: "actor:desk", name: "brief", input: { text: "hello" } },
			{ kind: "get", key: ["desk"] },
			{ kind: "action", actor: "actor:desk", name: "brief", input: { text: "again" } },
		]);
		// @ts-expect-error: `brief` takes a text.
		product.call("desk/a", "brief", { text: 5 });
		// @ts-expect-error: the actor has no such product action.
		product.call("desk/a", "missing", null);
		// @ts-expect-error: a fixed action is an operation of `Remote`, not a product action.
		product.call("desk/a", "probe", { thread: "desk/a" });
	});

	it("fails with the action's own error, decoded, and with what every operation of the client fails with", async () => {
		const served = engine(ANSWERS, { brief: wire(Refused, new Refused({ reason: "empty" })) });
		const product = productOn(served);
		const refused: Refused | Remote.Failure = await Effect.runPromise(
			Effect.flip(product.callOrCreate(ThreadKey.make("desk/a"), "brief", { text: "" })),
		);
		expect(refused).toEqual(new Refused({ reason: "empty" }));
		const missing = await Effect.runPromise(
			Effect.flip(product.call(ThreadKey.make("shelf/a"), "brief", { text: "" })),
		);
		expect(missing).toEqual(new ThreadNotFound({ thread: ThreadKey.make("shelf/a") }));
	});
});
