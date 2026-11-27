// The driver's durable record of the forks it asked for, in the source actor's own SQLite: the intent written before
// each fork call, the actor the call gave, and what destroying it answered.

import { ActorId, ActorInfo, ActorSql } from "@effectified/pi-durable-rivet";
import { Array as Arr, type Cause, Effect, Option, Predicate, Schema } from "effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Bytes } from "../driver.ts";
import { JobKey, SwarmId } from "../ids.ts";

/**
 * The actor's database could not be read or written, or held a row of another shape: the same call may work later.
 * `cause` is what failed: Effect's `SqlError`, a `SchemaError` or a `MigrationError`.
 */
export class RecordFailure extends Schema.TaggedError<RecordFailure, { readonly brand: unique symbol }>()(
	"SwarmRecordFailure",
	{ reason: Schema.String, cause: Schema.Defect() },
) {}

/**
 * What the record holds for one job of one swarm. Choose with `Held.match`.
 *
 * - `Intended`: a fork was asked for, and its call has not returned here: the fork may exist.
 * - `Made`: the fork is the actor `actorId`.
 * - `Destroyed`: the fork was destroyed, with the bytes it wrote when they were known.
 *
 * `baseBytes` is the size of the source's database when the fork was first asked for, when it could be read.
 */
export const Held = Schema.TaggedUnion({
	Intended: { baseBytes: Schema.Option(Bytes) },
	Made: { actorId: ActorId, baseBytes: Schema.Option(Bytes) },
	Destroyed: { bytesWritten: Schema.Option(Bytes) },
});

/** What the record holds for one job of one swarm. */
export type Held = typeof Held.Type;

/** What the record holds for a fork that was asked for and not destroyed. Choose with `LiveHeld.match`. */
export const LiveHeld = Schema.Union([Held.cases.Intended, Held.cases.Made]).pipe(Schema.toTaggedUnion("_tag"));

/** A fork that was asked for and not destroyed, with the job it is for. */
export const Live = Schema.Struct({ jobKey: JobKey, held: LiveHeld });

/** A fork that was asked for and not destroyed, with the job it is for. */
export type Live = typeof Live.Type;

/**
 * Makes the record's tables, or brings them up to this version, through Effect's `Migrator` with a table of its own.
 * The driver's Layer runs it at each wake, and the fork hygiene before it claims the record; the record's other
 * operations expect the tables.
 */
export const migrate: Effect.Effect<void, RecordFailure, ActorSql> = Effect.flatMap(ActorSql, (sql) =>
	Migrator.make({})({ loader: MIGRATIONS, table: "swarm_rivet_migrations" }).pipe(
		Effect.provideService(SqlClient.SqlClient, sql),
		Effect.asVoid,
		Effect.mapError(failed),
	),
);

/** What the record holds for the job, if a fork was ever asked for. */
export function find(swarmId: SwarmId, jobKey: JobKey): Effect.Effect<Option.Option<Held>, RecordFailure, ActorSql> {
	return recorded((sql) =>
		Effect.map(
			SqlSchema.findOneOption({
				Request: Job,
				Result: Row,
				execute: (job) =>
					sql`SELECT ${sql.literal(COLUMNS)} FROM ${sql(TABLE)} WHERE swarm_id = ${job.swarmId} AND job_key = ${job.jobKey}`,
			})({ swarmId, jobKey }),
			Option.map(heldOf),
		),
	);
}

/**
 * Records that a fork is about to be asked for, with the size of this actor's database now: written before the fork
 * call, so a fork whose call never returns is still found. A job that has a record keeps it.
 */
export function intend(swarmId: SwarmId, jobKey: JobKey): Effect.Effect<void, RecordFailure, ActorSql> {
	return recorded((sql) =>
		Effect.gen(function* () {
			const size = yield* SqlSchema.findOne({ Request: Schema.Void, Result: Size, execute: () => sql.unsafe(SIZE) })(
				undefined,
			);
			yield* sql`INSERT INTO ${sql(TABLE)} ${sql.insert({ swarm_id: swarmId, job_key: jobKey, base_bytes: size.bytes })}
				ON CONFLICT (swarm_id, job_key) DO NOTHING`;
		}),
	);
}

/** Records the actor a fork call gave. A destroyed fork stays destroyed. */
export function made(swarmId: SwarmId, jobKey: JobKey, actorId: ActorId): Effect.Effect<void, RecordFailure, ActorSql> {
	return recorded(
		(sql) =>
			sql`UPDATE ${sql(TABLE)} SET actor_id = ${actorId}
				WHERE swarm_id = ${swarmId} AND job_key = ${jobKey} AND destroyed = 0`,
	);
}

/** Records that the job's fork was destroyed, for good, with the bytes it wrote when they are known. */
export function destroyed(
	swarmId: SwarmId,
	jobKey: JobKey,
	bytesWritten: Option.Option<number>,
): Effect.Effect<void, RecordFailure, ActorSql> {
	const row = { swarm_id: swarmId, job_key: jobKey, destroyed: 1, bytes_written: Option.getOrNull(bytesWritten) };
	return recorded(
		(sql) =>
			sql`INSERT INTO ${sql(TABLE)} ${sql.insert(row)}
				ON CONFLICT (swarm_id, job_key) DO UPDATE SET destroyed = 1, bytes_written = excluded.bytes_written`,
	);
}

/** Every fork of the swarm that was asked for and not destroyed, in the order the forks were asked for. */
export function live(swarmId: SwarmId): Effect.Effect<Array<Live>, RecordFailure, ActorSql> {
	return recorded((sql) =>
		Effect.map(
			SqlSchema.findAll({
				Request: SwarmId,
				Result: Row,
				execute: (swarm) =>
					sql`SELECT ${sql.literal(COLUMNS)} FROM ${sql(TABLE)} WHERE swarm_id = ${swarm} AND destroyed = 0 ORDER BY rowid`,
			})(swarmId),
			(rows) => Arr.map(rows, (row) => ({ jobKey: row.job_key, held: liveOf(row) })),
		),
	);
}

/**
 * Makes the record this actor's own: forgets every fork, and names the actor as the owner, in one transaction. What a
 * copy of an actor's database does first, in the fork hygiene, because the forks it lists belong to the actor it was
 * copied from. An interrupted claim is rolled back.
 */
export const claim: Effect.Effect<void, RecordFailure, ActorSql | ActorInfo> = Effect.andThen(
	migrate,
	ActorInfo.use((info) =>
		recorded((sql) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`DELETE FROM ${sql(TABLE)}`;
					yield* sql`DELETE FROM ${sql(OWNER)}`;
					yield* sql`INSERT INTO ${sql(OWNER)} ${sql.insert({ actor_id: info.actorId })}`;
				}),
			),
		),
	),
);

/**
 * The actor is a fork, and the record it holds was never made its own: the fork hygiene did not run in it. Its
 * record lists the forks of the actor it was copied from, and its storage holds that actor's coordinators, live.
 */
export class Unclean extends Schema.TaggedError<Unclean, { readonly brand: unique symbol }>()("SwarmForkUnclean", {}) {
	override get message(): string {
		return "This actor is a fork whose swarm fork hygiene did not run: put forkHygiene of @effectified/pi-swarm/rivet into the forkHygiene of Actor.make";
	}
}

/**
 * Fails with `Unclean` in an actor fork whose record is not its own. An actor that is no fork has nothing copied, and
 * passes without a read.
 */
export const requireClean: Effect.Effect<void, Unclean | RecordFailure, ActorSql | ActorInfo> = ActorInfo.use((info) =>
	info.forkChain.length === 0
		? Effect.void
		: Effect.flatMap(
				recorded((sql) =>
					SqlSchema.findOneOption({
						Request: Schema.Void,
						Result: Owner,
						execute: () => sql`SELECT actor_id FROM ${sql(OWNER)}`,
					})(undefined),
				),
				(owner) =>
					Option.exists(owner, (row) => row.actor_id === info.actorId)
						? Effect.void
						: Effect.fail(Unclean.make({})),
			),
);

// Outside Pi's table prefix, and prefixed for this plugin: the actor's database is shared with Pi and the product.
const TABLE = "swarm_rivet_fork";

// One row: the actor whose record this is, written by the fork hygiene. A copied database names the source.
const OWNER = "swarm_rivet_owner";

const COLUMNS = "job_key, actor_id, base_bytes, destroyed, bytes_written";

// What the Rivet host answers when it destroys an actor: the page count times the page size.
const SIZE = "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()";

/**
 * The record's versions. The first is the tables as the record made them before it had versions, so a database that
 * holds them keeps them.
 */
const MIGRATIONS = Migrator.fromRecord({
	"1_fork_record": Effect.flatMap(SqlClient.SqlClient, (sql) =>
		Effect.andThen(
			sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
				swarm_id TEXT NOT NULL,
				job_key TEXT NOT NULL,
				actor_id TEXT,
				base_bytes INTEGER,
				destroyed INTEGER NOT NULL DEFAULT 0,
				bytes_written INTEGER,
				PRIMARY KEY (swarm_id, job_key)
			) STRICT`,
			sql`CREATE TABLE IF NOT EXISTS ${sql(OWNER)} (actor_id TEXT NOT NULL) STRICT`,
		),
	),
});

/** One job of one swarm, as the record is asked about it. */
const Job = Schema.Struct({ swarmId: SwarmId, jobKey: JobKey });

/** One row of the record, decoded: SQLite gives `destroyed` as 0 or 1, and sizes as integers. */
const Row = Schema.Struct({
	job_key: JobKey,
	actor_id: Schema.NullOr(ActorId),
	base_bytes: Schema.NullOr(Bytes),
	destroyed: Schema.Literals([0, 1]),
	bytes_written: Schema.NullOr(Bytes),
});

/** The size of the database; NULL where a pragma gives nothing. */
const Size = Schema.Struct({ bytes: Schema.NullOr(Bytes) });

const Owner = Schema.Struct({ actor_id: ActorId });

function heldOf(row: typeof Row.Type): Held {
	return row.destroyed === 1
		? Held.cases.Destroyed.make({ bytesWritten: Option.fromNullOr(row.bytes_written) })
		: liveOf(row);
}

function liveOf(row: typeof Row.Type): Live["held"] {
	const baseBytes = Option.fromNullOr(row.base_bytes);
	return row.actor_id === null
		? Held.cases.Intended.make({ baseBytes })
		: Held.cases.Made.make({ actorId: row.actor_id, baseBytes });
}

/** What a use of the record can fail with, before it is a `RecordFailure`. */
type Failure = SqlError | Schema.SchemaError | Cause.NoSuchElementError | Migrator.MigrationError;

/** One use of the record, on the actor's database; every failure is a `RecordFailure` with its cause. */
function recorded<A>(
	use: (sql: SqlClient.SqlClient) => Effect.Effect<A, Failure>,
): Effect.Effect<A, RecordFailure, ActorSql> {
	return Effect.flatMap(ActorSql, (sql) => Effect.mapError(use(sql), failed));
}

/** The failure, with a reason in words: for a statement, what the database said, which Effect's message leaves out. */
function failed(cause: Failure): RecordFailure {
	// A trust boundary: what the driver threw is unknown to Effect's error, and kept as it is.
	const said = cause._tag === "SqlError" ? cause.reason.cause : undefined;
	const reason = Predicate.isError(said) ? `${cause.message}: ${said.message}` : cause.message;
	return RecordFailure.make({ reason, cause });
}
