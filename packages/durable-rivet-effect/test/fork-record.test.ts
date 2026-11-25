// The durable record of a fork's hygiene, on the adapter over the stand-in database.

import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as ForkRecord from "../src/fork-record.ts";
import * as Database from "../src/sqlite-database.ts";
import { standIn } from "./raw-stand-in.ts";

const first = { actorId: "source-a", key: ["a"], forkedAt: 1_000 };
const second = { actorId: "source-b", key: ["b"], forkedAt: 2_000 };

describe("ForkRecord.record", () => {
	it("finds nothing for a fork whose hygiene was not recorded", () =>
		runTest(
			Effect.gen(function* () {
				const forks = yield* ForkRecord.record(Database.make(standIn().raw), "pi_");
				expect(yield* forks.find(first)).toEqual(Option.none());
			}),
		));

	it("records a fork with its input, and each fork of a chain by itself", () =>
		runTest(
			Effect.gen(function* () {
				const database = Database.make(standIn().raw);
				const forks = yield* ForkRecord.record(database, "pi_");
				yield* forks.mark(first, Option.some({ job: 7, tags: ["x", null] }), 1_500);
				yield* forks.mark(second, Option.none(), 2_500);
				// JSON's own `null` is an input, which is not the absence of one.
				const third = { actorId: "source-c", key: ["c"], forkedAt: 3_000 };
				yield* forks.mark(third, Option.some(null), 3_500);
				expect(yield* forks.find(third)).toEqual(Option.some(Option.some(null)));
				// A second record of the same fork changes nothing: the first one stands.
				yield* forks.mark(first, Option.some("other"), 9_000);
				expect([
					yield* forks.find(first),
					yield* forks.find(second),
					yield* forks.find({ ...first, forkedAt: 1 }),
				]).toEqual([
					Option.some(Option.some({ job: 7, tags: ["x", null] })),
					Option.some(Option.none()),
					Option.none(),
				]);
				const rows = yield* Effect.promise(() =>
					database.all(
						"SELECT source_actor_id, forked_at, input, hygiene_at FROM pi_rivet_fork WHERE forked_at < 3000 ORDER BY forked_at",
					),
				);
				expect(rows).toEqual([
					{
						source_actor_id: "source-a",
						forked_at: 1_000,
						input: '{"job":7,"tags":["x",null]}',
						hygiene_at: 1_500,
					},
					{ source_actor_id: "source-b", forked_at: 2_000, input: null, hygiene_at: 2_500 },
				]);
			}),
		));

	it("keeps its table under the prefix, and reads it again from another record of the same database", () =>
		runTest(
			Effect.gen(function* () {
				const database = Database.make(standIn().raw);
				yield* Effect.flatMap(ForkRecord.record(database, "app_"), (forks) => forks.mark(first, Option.some(1), 1));
				const tables = yield* Effect.promise(() =>
					database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"),
				);
				expect(tables.map((table) => table.name)).toEqual(["app_rivet_fork"]);
				const again = yield* Effect.flatMap(ForkRecord.record(database, "app_"), (forks) => forks.find(first));
				expect(again).toEqual(Option.some(Option.some(1)));
			}),
		));

	it("fails find with a typed error, not a defect, for an input that is no JSON", () =>
		runTest(
			Effect.gen(function* () {
				const database = Database.make(standIn().raw);
				const forks = yield* ForkRecord.record(database, "pi_");
				yield* Effect.promise(() =>
					database.run(
						"INSERT INTO pi_rivet_fork (source_actor_id, forked_at, input, hygiene_at) VALUES (?, ?, ?, ?)",
						first.actorId,
						first.forkedAt,
						"{not json",
						1_500,
					),
				);
				const failed = yield* Effect.flip(forks.find(first));
				expect(failed._tag).toBe("UnexpectedError");
				// The other forks of the record still read.
				expect(yield* forks.find(second)).toEqual(Option.none());
			}),
		));

	it("fails for a prefix that is no SQLite identifier, before any statement", () =>
		runTest(
			Effect.gen(function* () {
				const { raw, statements } = standIn();
				const failed = yield* Effect.flip(ForkRecord.record(Database.make(raw), "pi-; DROP"));
				expect(failed._tag).toBe("UnexpectedError");
				expect(failed.message).toBe('Invalid SQLite schema prefix "pi-; DROP"');
				expect(statements()).toBe(0);
			}),
		));
});
