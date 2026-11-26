// A transaction whose rollback fails, on a raw database that reports it. Chord's contract for a `SqliteDatabase`: when
// the callback rejects and the rollback fails, the adapter rejects with an error other than the callback's, so no
// caller takes the callback's error for a rollback that happened. Rivet hides a failed rollback (the gap the adapter's
// doc names); this pins that the adapter itself adds none.

import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as SqliteDatabase from "../src/sqlite-database.ts";
import { standIn } from "./raw-stand-in.ts";

/** A raw database whose transactions cannot roll back: a rejected callback rejects with both errors, as a driver's. */
function failingRollback() {
	const inner = standIn().raw;
	const asked = { transactions: 0 };
	const raw: SqliteDatabase.RawDatabase = {
		execute: (query, ...args) => inner.execute(query, ...args),
		transaction: async (callback) => {
			asked.transactions += 1;
			try {
				return await callback(inner);
			} catch (error) {
				throw new AggregateError([error, new Error("rollback failed: disk I/O error")], "rollback failed");
			}
		},
	};
	return { raw, asked };
}

describe("a transaction whose rollback fails", () => {
	it("rejects with an error other than the callback's, and does not run the callback again", () =>
		runTest(
			Effect.gen(function* () {
				const { raw, asked } = failingRollback();
				const database = SqliteDatabase.make(raw);
				const failure = new Error("callback failed");
				let calls = 0;
				const rejected = yield* Effect.promise(() =>
					database
						.transaction(async () => {
							calls += 1;
							throw failure;
						})
						.catch((error: unknown) => error),
				);
				expect(rejected).not.toBe(failure);
				expect(rejected).toBeInstanceOf(AggregateError);
				expect((rejected as AggregateError).errors[0]).toBe(failure);
				expect({ calls, transactions: asked.transactions }).toEqual({ calls: 1, transactions: 1 });
			}),
		));
});
