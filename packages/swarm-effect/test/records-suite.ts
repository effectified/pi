// Test helper: the Rivet driver's record of forks (src/rivet/records.ts) on a real SQLite `SqlClient` as the actor's
// `ActorSql`, registered once per driver by sqlite-suites.ts. An engine runs the record in rivet-suite.ts.

import { runTest } from "@effectified/pi-ai/testing";
import { ActorInfo, ActorSql, type Identity } from "@effectified/pi-durable-rivet";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { expect, it } from "vitest";
import * as Records from "../src/rivet/records.ts";
import type { ClientLayer } from "./kill-resume.ts";

/** An actor with this fork chain: `source` names the actor it was forked from. */
const actor = (actorId: string, source: Option.Option<string>): Identity => ({
	actorId,
	name: "agent",
	key: [actorId],
	namespace: "default",
	forkChain: Option.match(source, {
		onNone: () => [],
		onSome: (from) => [{ actorId: from, key: [from], forkedAt: 1 }],
	}),
	forkInput: Option.none(),
});

/** Registers the record's tests on the driver's client of an in-memory database. */
export function registerRecords(client: ClientLayer): void {
	/** Runs `program` as the actor `identity`, on one database the program's `SqlClient` also reaches. */
	const inActor = <A, E>(
		identity: Identity,
		program: Effect.Effect<A, E, ActorSql | ActorInfo | SqlClient>,
	): Promise<A> =>
		runTest(
			Effect.provide(
				program,
				Layer.mergeAll(Layer.effect(ActorSql, SqlClient), Layer.succeed(ActorInfo, identity)).pipe(
					Layer.provideMerge(client(":memory:")),
					Layer.orDie,
				),
			),
		);
	const source = actor("source", Option.none());

	it("makes its tables through migrations of its own, once, and keeps the tables of the record before them", () =>
		inActor(
			source,
			Effect.gen(function* () {
				const sql = yield* SqlClient;
				// The tables as the record made them before it had versions, with a fork in them.
				yield* sql`CREATE TABLE swarm_rivet_fork (swarm_id TEXT NOT NULL, job_key TEXT NOT NULL, actor_id TEXT,
					base_bytes INTEGER, destroyed INTEGER NOT NULL DEFAULT 0, bytes_written INTEGER,
					PRIMARY KEY (swarm_id, job_key)) STRICT`;
				yield* sql`INSERT INTO swarm_rivet_fork (swarm_id, job_key, actor_id) VALUES ('s', 'kept', 'fork-0')`;
				yield* Records.migrate;
				yield* Records.migrate;
				const versions = yield* sql<{
					readonly migration_id: number;
				}>`SELECT migration_id FROM swarm_rivet_migrations`;
				expect(versions.map((row) => row.migration_id)).toEqual([1]);
				expect(yield* Records.find("s", "kept")).toEqual(
					Option.some({ _tag: "Made", actorId: "fork-0", baseBytes: Option.none() }),
				);
			}),
		));

	it("records the intent, the actor a fork call gave and its destruction, and lists the live forks in order", () =>
		inActor(
			source,
			Effect.gen(function* () {
				yield* Records.migrate;
				yield* Records.intend("s", "a");
				yield* Records.intend("s", "b");
				yield* Records.intend("s", "c");
				yield* Records.made("s", "b", "fork-b");
				yield* Records.destroyed("s", "c", Option.some(42));
				// A destroyed fork stays destroyed, and a job that has a record keeps it.
				yield* Records.made("s", "c", "fork-late");
				yield* Records.intend("s", "b");
				const intended = Option.getOrThrow(yield* Records.find("s", "a"));
				expect(intended._tag).toBe("Intended");
				expect(intended._tag === "Intended" && Option.isSome(intended.baseBytes)).toBe(true);
				expect(yield* Records.find("s", "c")).toEqual(
					Option.some({ _tag: "Destroyed", bytesWritten: Option.some(42) }),
				);
				expect(yield* Records.find("s", "none")).toEqual(Option.none());
				const live = yield* Records.live("s");
				expect(live.map(({ jobKey, held }) => [jobKey, held._tag])).toEqual([
					["a", "Intended"],
					["b", "Made"],
				]);
			}),
		));

	it("fails with the decode's cause kept when a row has another shape", () =>
		inActor(
			source,
			Effect.gen(function* () {
				yield* Records.migrate;
				const sql = yield* SqlClient;
				yield* sql`INSERT INTO swarm_rivet_fork (swarm_id, job_key, destroyed) VALUES ('s', 'odd', 2)`;
				const failed = yield* Effect.flip(Records.find("s", "odd"));
				expect(failed._tag).toBe("SwarmRecordFailure");
				expect((failed.cause as { readonly _tag: string })._tag).toBe("SchemaError");
			}),
		));

	it("is claimed by a fork in one transaction: a claim that fails leaves the record as it was", () =>
		inActor(
			actor("fork", Option.some("source")),
			Effect.gen(function* () {
				yield* Records.migrate;
				yield* Records.intend("s", "copied");
				// A fork whose hygiene did not run holds its source's record, which is not its own.
				expect((yield* Effect.flip(Records.requireClean))._tag).toBe("SwarmForkUnclean");
				const sql = yield* SqlClient;
				yield* sql`CREATE TEMP TRIGGER refuse BEFORE INSERT ON swarm_rivet_owner BEGIN SELECT RAISE(ABORT, 'refused'); END`;
				const failed = yield* Effect.flip(Records.claim);
				expect(failed.reason).toContain("refused");
				expect(Option.isSome(yield* Records.find("s", "copied"))).toBe(true);
				yield* sql`DROP TRIGGER refuse`;
				yield* Records.claim;
				expect(yield* Records.find("s", "copied")).toEqual(Option.none());
				yield* Records.requireClean;
			}),
		));

	it("lets an actor that is no fork pass its check without a read", () =>
		inActor(source, Effect.andThen(Records.requireClean, Effect.succeed("passed"))).then((passed) =>
			expect(passed).toBe("passed"),
		));
}
