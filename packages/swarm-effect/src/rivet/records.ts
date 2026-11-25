// The driver's durable record of the forks it asked for, in the source actor's own SQLite: the intent written before
// each fork call, the actor the call gave, and what destroying it answered.

import { ActorDatabase, ActorInfo } from "@gunta/pi-durable-rivet-effect";
import { Effect, Option, Predicate, Schema } from "effect";

/** The actor's database could not be read or written: the same call may work later. */
export class RecordFailure extends Schema.TaggedError<RecordFailure>()("SwarmRecordFailure", {
	reason: Schema.String,
}) {}

/**
 * What the record holds for one job of one swarm.
 *
 * - `Intended`: a fork was asked for, and its call has not returned here: the fork may exist.
 * - `Made`: the fork is the actor `actorId`.
 * - `Destroyed`: the fork was destroyed, with the bytes it wrote when they were known.
 *
 * `baseBytes` is the size of the source's database when the fork was first asked for, when it could be read.
 */
export type Held =
	| { readonly _tag: "Intended"; readonly baseBytes: Option.Option<number> }
	| { readonly _tag: "Made"; readonly actorId: string; readonly baseBytes: Option.Option<number> }
	| { readonly _tag: "Destroyed"; readonly bytesWritten: Option.Option<number> };

/** A fork that was asked for and not destroyed, with the job it is for. */
export interface Live {
	readonly jobKey: string;
	readonly held: Exclude<Held, { readonly _tag: "Destroyed" }>;
}

/** What the record holds for the job, if a fork was ever asked for. */
export function find(
	swarmId: string,
	jobKey: string,
): Effect.Effect<Option.Option<Held>, RecordFailure, ActorDatabase> {
	return Effect.map(
		table((database) =>
			database.get<Row>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE swarm_id = ? AND job_key = ?`, swarmId, jobKey),
		),
		(row) => Option.map(Option.fromUndefinedOr(row), heldOf),
	);
}

/**
 * Records that a fork is about to be asked for, with the size of this actor's database now: written before the fork
 * call, so a fork whose call never returns is still found. A job that has a record keeps it.
 */
export function intend(swarmId: string, jobKey: string): Effect.Effect<void, RecordFailure, ActorDatabase> {
	return table(async (database) => {
		const size = await database.get<{ readonly bytes: number | null }>(SIZE);
		await database.run(
			`INSERT INTO ${TABLE} (swarm_id, job_key, base_bytes) VALUES (?, ?, ?)
			 ON CONFLICT (swarm_id, job_key) DO NOTHING`,
			swarmId,
			jobKey,
			size?.bytes ?? null,
		);
	});
}

/** Records the actor a fork call gave. A destroyed fork stays destroyed. */
export function made(
	swarmId: string,
	jobKey: string,
	actorId: string,
): Effect.Effect<void, RecordFailure, ActorDatabase> {
	return table((database) =>
		database.run(
			`UPDATE ${TABLE} SET actor_id = ? WHERE swarm_id = ? AND job_key = ? AND destroyed = 0`,
			actorId,
			swarmId,
			jobKey,
		),
	);
}

/** Records that the job's fork was destroyed, for good, with the bytes it wrote when they are known. */
export function destroyed(
	swarmId: string,
	jobKey: string,
	bytesWritten: Option.Option<number>,
): Effect.Effect<void, RecordFailure, ActorDatabase> {
	return table((database) =>
		database.run(
			`INSERT INTO ${TABLE} (swarm_id, job_key, destroyed, bytes_written) VALUES (?, ?, 1, ?)
			 ON CONFLICT (swarm_id, job_key) DO UPDATE SET destroyed = 1, bytes_written = excluded.bytes_written`,
			swarmId,
			jobKey,
			Option.getOrNull(bytesWritten),
		),
	);
}

/** Every fork of the swarm that was asked for and not destroyed, in the order the forks were asked for. */
export function live(swarmId: string): Effect.Effect<Array<Live>, RecordFailure, ActorDatabase> {
	return Effect.map(
		table((database) =>
			database.all<Row>(
				`SELECT ${COLUMNS} FROM ${TABLE} WHERE swarm_id = ? AND destroyed = 0 ORDER BY rowid`,
				swarmId,
			),
		),
		(rows) => rows.map((row) => ({ jobKey: row.job_key, held: liveOf(row) })),
	);
}

/**
 * Makes the record this actor's own: forgets every fork, and names the actor as the owner. What a copy of an actor's
 * database does first, in the fork hygiene, because the forks it lists belong to the actor it was copied from.
 */
export const claim: Effect.Effect<void, RecordFailure, ActorDatabase | ActorInfo> = ActorInfo.use((info) =>
	table((database) =>
		database.transaction(async (transaction) => {
			await transaction.run(`DELETE FROM ${TABLE}`);
			await transaction.run(`DELETE FROM ${OWNER}`);
			await transaction.run(`INSERT INTO ${OWNER} (actor_id) VALUES (?)`, info.actorId);
		}),
	),
);

/**
 * The actor is a fork, and the record it holds was never made its own: the fork hygiene did not run in it. Its
 * record lists the forks of the actor it was copied from, and its storage holds that actor's coordinators, live.
 */
export class Unclean extends Schema.TaggedError<Unclean>()("SwarmForkUnclean", {}) {
	override get message(): string {
		return "This actor is a fork whose swarm fork hygiene did not run: put forkHygiene of @gunta/pi-swarm-effect/rivet into the forkHygiene of Actor.make";
	}
}

/**
 * Fails with `Unclean` in an actor fork whose record is not its own. An actor that is no fork has nothing copied, and
 * passes without a read.
 */
export const requireClean: Effect.Effect<void, Unclean | RecordFailure, ActorDatabase | ActorInfo> = ActorInfo.use(
	(info) =>
		info.forkChain.length === 0
			? Effect.void
			: Effect.flatMap(
					table((database) => database.get<{ readonly actor_id: string }>(`SELECT actor_id FROM ${OWNER}`)),
					(owner) => (owner?.actor_id === info.actorId ? Effect.void : Effect.fail(new Unclean())),
				),
);

// Outside Pi's table prefix, and prefixed for this plugin: the actor's database is shared with Pi and the product.
const TABLE = "swarm_rivet_fork";

// One row: the actor whose record this is, written by the fork hygiene. A copied database names the source.
const OWNER = "swarm_rivet_owner";

const COLUMNS = "job_key, actor_id, base_bytes, destroyed, bytes_written";

// What the Rivet host answers when it destroys an actor: the page count times the page size.
const SIZE = "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()";

const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
	swarm_id TEXT NOT NULL,
	job_key TEXT NOT NULL,
	actor_id TEXT,
	base_bytes INTEGER,
	destroyed INTEGER NOT NULL DEFAULT 0,
	bytes_written INTEGER,
	PRIMARY KEY (swarm_id, job_key)
) STRICT;
CREATE TABLE IF NOT EXISTS ${OWNER} (actor_id TEXT NOT NULL) STRICT`;

/** One row, as SQLite gives it. */
interface Row {
	readonly job_key: string;
	readonly actor_id: string | null;
	readonly base_bytes: number | null;
	readonly destroyed: number;
	readonly bytes_written: number | null;
}

function heldOf(row: Row): Held {
	return row.destroyed === 1 ? { _tag: "Destroyed", bytesWritten: Option.fromNullOr(row.bytes_written) } : liveOf(row);
}

function liveOf(row: Row): Live["held"] {
	const baseBytes = Option.fromNullOr(row.base_bytes);
	return row.actor_id === null ? { _tag: "Intended", baseBytes } : { _tag: "Made", actorId: row.actor_id, baseBytes };
}

/** The actor's database, as the Rivet host provides it. */
type Database = (typeof ActorDatabase)["Service"];

/** One use of the tables, which are made on the first use of a database. */
function table<A>(use: (database: Database) => Promise<A>): Effect.Effect<A, RecordFailure, ActorDatabase> {
	return ActorDatabase.use((database) =>
		Effect.tryPromise({
			try: async () => {
				if (!tables.has(database)) {
					await database.exec(CREATE);
					tables.add(database);
				}
				return use(database);
			},
			catch: (cause) => new RecordFailure({ reason: Predicate.isError(cause) ? cause.message : String(cause) }),
		}),
	);
}

// Keyed by the database and held weakly: the tables are made once per wake of an actor, and none is kept for a
// closed one.
const tables = new WeakSet<Database>();
