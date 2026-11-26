// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the package, this file its sources), and what the README leaves to the reader
// (`root`) is made here.

import { sleep } from "@earendil-works/chord";
import { traceIn } from "@earendil-works/chord/context";
import { PiTelemetry } from "@effectified/pi-telemetry";
import { Context, Duration, Effect, Fiber, Option, Stream, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	BACKGROUND_CONTEXT,
	type Context as CallContext,
	ChordContext,
	createContextKey,
	withContextValue,
} from "../src/context.ts";
import { apply, decoder, encoder, type Op } from "../src/delta.ts";
import { constant, Facet, Host, local, method, obj, Reference, Store, sqliteBackend, str } from "../src/index.ts";
import { copyJson, isJsonValue, NotJson } from "../src/json.ts";
import { openNodeSqliteDatabase } from "../src/node/sqlite.ts";
import { applySqliteMigrations, validateSqliteSchemaPrefix } from "../src/sqlite.ts";
import { run } from "./run.ts";

/**
 * A stand-in for a Pi Durable conversation: its submission starts a span under the context it takes, as Pi's do, and
 * waits on Chord's own `sleep` under that context.
 */
function conversation(ms: number) {
	const contexts: CallContext[] = [];
	const root = {
		submit: (_input: { readonly type: "input"; readonly content: string }, context: CallContext) => {
			contexts.push(context);
			return traceIn({ name: "pi.durable.submit" }, (traced) => sleep(ms, traced), context).then(() => "submitted");
		},
	};
	return { root, contexts };
}

/** Effect's own in-memory spans, kept in start order. */
function recording(): { readonly tracer: Tracer.Tracer; readonly spans: Tracer.NativeSpan[] } {
	const spans: Tracer.NativeSpan[] = [];
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options);
			spans.push(span);
			return span;
		},
	});
	return { tracer, spans };
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

	it("nests Pi's spans under the Effect span", async () => {
		const { root } = conversation(0);
		// README: telemetry.
		// root: a conversation of a Pi Durable harness (`harness.root()`).
		const turn = Effect.scoped(
			Effect.gen(function* () {
				const context = yield* ChordContext.scoped();
				return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, context));
			}),
		).pipe(Effect.withSpan("chat.turn"), Effect.provide(PiTelemetry.layer));
		// The trace: chat.turn > the spans Pi starts for the submission

		const { tracer, spans } = recording();
		await run(Effect.provideService(turn, Tracer.Tracer, tracer));
		expect(spans.map((span) => [span.name, Option.getOrUndefined(span.parent)?.spanId])).toEqual([
			["chat.turn", undefined],
			["pi.durable.submit", spans[0]?.spanId],
		]);
	});

	it("carries values", async () => {
		// README: values.
		const Tenant = createContextKey<string>("app.tenant");

		const tenant = Effect.scoped(
			Effect.gen(function* () {
				const context = yield* ChordContext.scoped(withContextValue(Tenant, "acme", BACKGROUND_CONTEXT));
				return context.value(Tenant); // "acme"
			}),
		);

		expect(await run(tenant)).toBe("acme");
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

describe("README: The store", () => {
	it("copies a store through JSONL bytes", async () => {
		// README: store.
		const copy = Effect.scoped(
			Effect.gen(function* () {
				// Open for the scope; the store owns the database and closes it with itself.
				const store = yield* Store.open(sqliteBackend(yield* openNodeSqliteDatabase(":memory:")));
				// Its state as archive parts, written as JSONL bytes and read back into a second store.
				const bytes = yield* Stream.runCollect(Store.encodeJsonl(Store.archive(store)));
				const backup = sqliteBackend(yield* openNodeSqliteDatabase(":memory:"));
				const restored = yield* Store.importArchive(backup, Store.decodeJsonl(Stream.fromIterable(bytes)));
				return yield* Store.lastSeq(restored);
			}),
		);

		expect(await run(copy)).toBe(0);
	});
});

class Greetings extends Context.Service<Greetings, { readonly hello: (name: string) => Effect.Effect<string> }>()(
	"app/Greetings",
) {}

const Greeter = local("example.greeter", {
	version: 1,
	params: { language: str() },
	members: { language: str(), greet: method(obj({ name: str() }), str()) },
});

// The app's principal: who a host acts for.
type User = { readonly kind: "user"; readonly name: string };

describe("README: Hosts and facets", () => {
	it("serves a facet whose handlers are Effects", async () => {
		// README: hosts.
		const greet = Effect.scoped(
			Effect.gen(function* () {
				// The handlers run with the `Greetings` of this Effect's context.
				const facet = yield* Facet.make<User, Greetings>((host, _self, lift) => {
					host.serve(Greeter, ({ language }) => ({
						language: constant(language),
						greet: lift(({ name }, _ctx) => Greetings.use((greetings) => greetings.hello(name))),
					}));
				});
				const host = yield* Host.make<User>({ principal: { kind: "user", name: "owner" } });
				yield* host.load([{ name: "@example/greeter", facet }]);
				// Released when the scope closes; so is the host.
				const english = yield* host.get(Greeter, { language: "en" });
				return yield* Reference.call(english.greet, { name: "Ada" });
			}),
		);

		const greeted = await run(
			Effect.provideService(greet, Greetings, { hello: (name) => Effect.succeed(`Hello ${name}`) }),
		);
		expect(greeted).toBe("Hello Ada");
	});
});
