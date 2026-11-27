// Test helper: the Rivet driver (src/rivet/driver.ts) without an engine, on a real SQLite `SqlClient` as the actor's
// `ActorSql`, registered once per driver by sqlite-suites.ts: what it checks where it is made, and how it looks up the
// forks whose fork calls never returned. An engine runs the whole driver in rivet-suite.ts.

import { runTest } from "@effectified/pi-ai/testing";
import { ActorId, ActorInfo, ActorSql, Client, type Identity } from "@effectified/pi-durable-rivet";
import { Effect, Layer, Option, type Scope } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { expect, it } from "vitest";
import { ForkDriver } from "../src/driver.ts";
import { JobKey, SwarmId } from "../src/ids.ts";
import * as Rivet from "../src/rivet.ts";
import * as Records from "../src/rivet/records.ts";
import type { ClientLayer } from "./kill-resume.ts";

/** The actor the driver runs in: no fork, so its record is its own. */
const source: Identity = {
	actorId: ActorId.make("source"),
	name: "agent",
	key: ["source"],
	namespace: "default",
	forkChain: [],
	forkInput: Option.none(),
};

/** What the engine stand-in saw of the driver's lookups by key. */
interface Lookups {
	calls: number;
	inFlight: number;
	/** The most lookups that were in flight at once. */
	most: number;
}

/**
 * An engine that answers no lookup by key: each one fails a few milliseconds after it was made, as a request that
 * cannot reach the engine does. It counts the lookups in flight.
 */
function unreachable(): { readonly lookups: Lookups; readonly client: Client.RivetClient["Service"] } {
	const lookups: Lookups = { calls: 0, inFlight: 0, most: 0 };
	const resolve = () => {
		lookups.calls += 1;
		lookups.inFlight += 1;
		lookups.most = Math.max(lookups.most, lookups.inFlight);
		return new Promise<string>((_resolve, reject) =>
			setTimeout(() => {
				lookups.inFlight -= 1;
				reject(new Error("The engine cannot be reached"));
			}, 20),
		);
	};
	// A stand-in with the one call of rivetkit's client that a lookup by key makes: `get(name, key).resolve()`.
	const client = { get: () => ({ resolve }) } as unknown as Client.RivetClient["Service"];
	return { lookups, client };
}

/** Registers the driver's tests on the driver's client of an in-memory database. */
export function registerDriver(client: ClientLayer): void {
	/** Runs `program` in the actor `source`, on one database the program's `SqlClient` also reaches, and `engine`. */
	const inActor = <A, E>(
		engine: Client.RivetClient["Service"],
		program: Effect.Effect<A, E, ActorSql | ActorInfo | SqlClient | Client.RivetClient | Scope.Scope>,
	): Promise<A> =>
		runTest(
			Effect.provide(
				program,
				Layer.mergeAll(
					Layer.effect(ActorSql, SqlClient),
					Layer.succeed(ActorInfo, source),
					Layer.succeed(Client.RivetClient, engine),
				).pipe(Layer.provideMerge(client(":memory:")), Layer.orDie),
			),
		);

	it("refuses options off their schema where it is made, before it reads or asks anything", async () => {
		const seen = await inActor(
			unreachable().client,
			Effect.gen(function* () {
				const refused = yield* Effect.flip(Layer.build(Rivet.layer({ pollMillis: -1 })));
				const sql = yield* SqlClient;
				const tables = yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'swarm_rivet%'`;
				// An interval of 0 asks at once, and is one.
				yield* Layer.build(Rivet.layer({ pollMillis: 0 }));
				return { refused: refused._tag, message: refused.message, tables };
			}),
		);
		expect(seen).toEqual({ refused: "SchemaError", message: expect.stringContaining("pollMillis"), tables: [] });
	});

	it("looks up the forks whose fork calls never returned one at a time", async () => {
		const engine = unreachable();
		const failed = await inActor(
			engine.client,
			Effect.gen(function* () {
				yield* Records.migrate;
				// A swarm whose fork calls were cut off three times, as by three crashes of a swarm of cap one.
				for (const jobKey of ["a", "b", "c"]) yield* Records.intend(SwarmId.make("s"), JobKey.make(jobKey));
				const driver = yield* ForkDriver;
				return yield* Effect.flip(driver.list(SwarmId.make("s")));
			}).pipe(Effect.provide(Rivet.layer())),
		);
		// The first lookup that fails ends the listing: the coordinator lists again later.
		expect(failed).toMatchObject({ _tag: "ForkRetryLater", operation: "list" });
		expect(engine.lookups).toEqual({ calls: 1, inFlight: 0, most: 1 });
	});
}
