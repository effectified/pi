// The durable record of a fork's hygiene, on the adapter over the stand-in database.

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as ForkRecord from "../src/fork-record.ts";
import * as Database from "../src/sqlite-database.ts";
import { standIn } from "./raw-stand-in.ts";

const first = { actorId: "source-a", key: ["a"], forkedAt: 1_000 };
const second = { actorId: "source-b", key: ["b"], forkedAt: 2_000 };

describe("ForkRecord.record", () => {
	it("finds nothing for a fork whose hygiene was not recorded", async () => {
		const database = Database.make(standIn().raw);
		const found = await Effect.runPromise(
			Effect.flatMap(ForkRecord.record(database, "pi_"), (forks) => forks.find(first)),
		);
		expect(found).toEqual(Option.none());
	});

	it("records a fork with its input, and each fork of a chain by itself", async () => {
		const database = Database.make(standIn().raw);
		const found = await Effect.runPromise(
			Effect.gen(function* () {
				const forks = yield* ForkRecord.record(database, "pi_");
				yield* forks.mark(first, Option.some({ job: 7, tags: ["x", null] }), 1_500);
				yield* forks.mark(second, Option.none(), 2_500);
				// A second record of the same fork changes nothing: the first one stands.
				yield* forks.mark(first, Option.some("other"), 9_000);
				return [yield* forks.find(first), yield* forks.find(second), yield* forks.find({ ...first, forkedAt: 1 })];
			}),
		);
		expect(found).toEqual([
			Option.some(Option.some({ job: 7, tags: ["x", null] })),
			Option.some(Option.none()),
			Option.none(),
		]);
		expect(
			await database.all("SELECT source_actor_id, forked_at, hygiene_at FROM pi_rivet_fork ORDER BY forked_at"),
		).toEqual([
			{ source_actor_id: "source-a", forked_at: 1_000, hygiene_at: 1_500 },
			{ source_actor_id: "source-b", forked_at: 2_000, hygiene_at: 2_500 },
		]);
	});

	it("keeps its table under the prefix, and reads it again from another record of the same database", async () => {
		const database = Database.make(standIn().raw);
		await Effect.runPromise(
			Effect.flatMap(ForkRecord.record(database, "app_"), (forks) => forks.mark(first, Option.some(1), 1)),
		);
		const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
		expect(tables.map((table) => table.name)).toEqual(["app_rivet_fork"]);
		const again = await Effect.runPromise(
			Effect.flatMap(ForkRecord.record(database, "app_"), (forks) => forks.find(first)),
		);
		expect(again).toEqual(Option.some(Option.some(1)));
	});

	it("fails for a prefix that is no SQLite identifier, before any statement", async () => {
		const { raw, statements } = standIn();
		const failed = await Effect.runPromise(Effect.flip(ForkRecord.record(Database.make(raw), "pi-; DROP")));
		expect(failed._tag).toBe("UnexpectedError");
		expect(failed.message).toBe('Invalid SQLite schema prefix "pi-; DROP"');
		expect(statements()).toBe(0);
	});
});
