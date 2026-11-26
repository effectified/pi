// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the package, this file its sources), and what the README leaves to the reader
// (`root`, `span`) is made here.

import { sleep } from "@earendil-works/chord";
import { InMemoryTelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	BACKGROUND_CONTEXT,
	ChordContext,
	type Context,
	createContextKey,
	withContextValue,
	withTelemetry,
} from "../src/context.ts";
import { apply, decoder, encoder, type Op } from "../src/delta.ts";
import { copyJson, isJsonValue, NotJson } from "../src/json.ts";
import { openNodeSqliteDatabase } from "../src/node/sqlite.ts";
import { applySqliteMigrations, validateSqliteSchemaPrefix } from "../src/sqlite.ts";
import { run } from "./run.ts";

/** A stand-in for a Pi Durable conversation: its submission waits on Chord's own `sleep` under the context it takes. */
function conversation(ms: number) {
	const contexts: Context[] = [];
	const root = {
		submit: (_input: { readonly type: "input"; readonly content: string }, context: Context) => {
			contexts.push(context);
			return sleep(ms, context).then(() => "submitted");
		},
	};
	return { root, contexts };
}

describe("README: A Chord context from the fiber", () => {
	it("cancels the Pi call when the fiber is interrupted", async () => {
		const { root, contexts } = conversation(60_000);
		// README: scoped.
		const submit = Effect.scoped(
			Effect.gen(function* () {
				// Cancelled when this scope closes: interrupting the fiber cancels the submission in Pi.
				const context = yield* ChordContext.scoped();
				return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, context));
			}),
		);

		await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(submit, { startImmediately: true });
				yield* Fiber.interrupt(fiber);
			}),
		);
		expect(contexts[0]?.abortSignal?.aborted).toBe(true);
	});

	it("cancels the Pi call after thirty seconds of the Clock", async () => {
		const { root, contexts } = conversation(3_600_000);
		// README: timeout.
		// Pi's calls made with `deadline` are cancelled after thirty seconds of the Clock.
		const bounded = Effect.scoped(
			Effect.gen(function* () {
				const deadline = yield* ChordContext.timeout(Duration.seconds(30));
				return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, deadline));
			}),
		);

		const reason = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Effect.exit(bounded), { startImmediately: true });
				yield* TestClock.adjust("30 seconds");
				yield* Fiber.join(fiber);
				return contexts[0]?.abortSignal?.reason;
			}),
		);
		expect(reason).toMatchObject({ name: "TimeoutError" });
	});

	it("carries the telemetry span and values", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const seen = await telemetry.startSpan({ name: "chat.turn" }, (span: TelemetrySpan) => {
			// README: telemetry and values.
			const Tenant = createContextKey<string>("app.tenant");

			// span: `PiTelemetry.currentSpan` of `@effectified/pi-telemetry`, read in the Effect span to continue.
			const traced = Effect.scoped(
				Effect.gen(function* () {
					const context = yield* ChordContext.scoped(
						withContextValue(Tenant, "acme", withTelemetry(span, BACKGROUND_CONTEXT)),
					);
					context.value(Tenant); // "acme"
					return context.telemetry; // span: Pi's spans under this context are children of the Effect span
				}),
			);

			return run(traced).then((handle) => ({ handle, span }));
		});
		expect(seen.handle).toBe(seen.span);
	});
});

describe("README: JSON", () => {
	it("copies strict JSON and fails with NotJson", async () => {
		const seen = await run(
			Effect.gen(function* () {
				// README: JSON.
				// { title: "Report" }
				const copy = yield* copyJson({ title: "Report", note: undefined }, { omitUndefinedProperties: true });
				isJsonValue(copy); // true
				const failure = yield* Effect.flip(copyJson({ at: new Date(0) })); // NotJson
				return { copy, valid: isJsonValue(copy), failure };
			}),
		);
		expect(seen.copy).toEqual({ title: "Report" });
		expect(seen.valid).toBe(true);
		expect(seen.failure).toBeInstanceOf(NotJson);
	});
});

describe("README: SQLite", () => {
	it("opens a database, migrates it and checks a prefix", async () => {
		// README: SQLite.
		const notes = Effect.scoped(
			Effect.gen(function* () {
				// Closed when the scope closes. Hand it to whatever takes a Chord `SqliteDatabase`.
				const database = yield* openNodeSqliteDatabase(":memory:");
				yield* applySqliteMigrations(
					database,
					[{ version: 1, statements: ["CREATE TABLE notes (body TEXT NOT NULL) STRICT"] }],
					{ table: "app_schema" },
				);
				yield* validateSqliteSchemaPrefix("app_"); // fails with InvalidSchemaPrefix for "sqlite_app" or "1app"
				return database;
			}),
		);

		const database = await run(notes);
		// The scope of `notes` closed the database.
		await expect(database.get("SELECT 1")).rejects.toThrow();
	});
});

describe("README: Deltas", () => {
	it("applies, encodes and decodes ops", async () => {
		const seen = await run(
			Effect.gen(function* () {
				// README: Deltas.
				const ops: Op[] = [
					["a", ["title"], " 2"],
					["p", ["tags"], 1, 0, ["b"]],
				];
				// { title: "Draft 2", tags: ["a", "b"] }
				const value = yield* apply({ title: "Draft", tags: ["a"] }, ops);

				// The wire form: an encoder and a decoder per state stream.
				const encoding = encoder();
				const decoding = yield* decoder;
				const decoded = yield* decoding.decode(encoding.encode(ops)); // ops again
				return { value, decoded, ops };
			}),
		);
		expect(seen.value).toEqual({ title: "Draft 2", tags: ["a", "b"] });
		expect(seen.decoded).toEqual(seen.ops);
	});
});
