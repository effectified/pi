// What the host provides inside an actor, without an engine: Pi's storage on the actor's database, under a prefix.

import { Storage } from "@gunta/pi-durable-effect";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ActorDatabase, storage } from "../src/actor-context.ts";
import * as Database from "../src/sqlite-database.ts";
import { standIn } from "./raw-stand-in.ts";

describe("storage", () => {
	it("opens Pi's storage on the actor's database under the prefix, beside the product's own tables", async () => {
		const database = Database.make(standIn().raw);
		await database.exec("CREATE TABLE product_notes (text TEXT)");
		const minted = await Effect.runPromise(
			Storage.HarnessStorage.use((opened) => Effect.promise(() => opened.mintId())).pipe(
				Effect.provide(storage({ prefix: "pi_" })),
				Effect.provide(Layer.succeed(ActorDatabase, database)),
			),
		);
		expect(typeof minted).toBe("number");
		const tables = (await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
			(table) => table.name,
		);
		expect(tables).toContain("product_notes");
		expect(tables).toContain("pi_entries");
		expect(tables.filter((name) => name !== "product_notes" && !name.startsWith("pi_"))).toEqual([]);
	});

	it("fails with a typed error for a prefix Pi refuses", async () => {
		const failed = await Effect.runPromise(
			Effect.flip(
				Storage.HarnessStorage.use((opened) => Effect.succeed(opened)).pipe(
					Effect.provide(storage({ prefix: "sqlite_" })),
					Effect.provide(Layer.succeed(ActorDatabase, Database.make(standIn().raw))),
				),
			),
		);
		expect(failed._tag).toBe("UnexpectedError");
		expect(failed.message).toBe('SQLite schema prefix "sqlite_" is reserved');
	});
});
