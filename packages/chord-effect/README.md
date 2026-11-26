# @effectified/pi-chord

[`@earendil-works/chord`](../chord/README.md) in Effect terms, for the parts a Pi application meets: the context every
Pi call takes, and Chord's JSON, SQLite, delta and output values. For `effect` 4.1.

- **A Chord context from the fiber.** Pi Durable, Chord and the Pi packages built on them take a Chord `Context`: a
  cancellation signal, a telemetry span and values. `ChordContext.scoped` gives one that is cancelled when the
  fiber's scope closes, so interrupting the fiber cancels the Pi call; `ChordContext.timeout` one that is cancelled
  after a span of the `Clock`. Both carry the fiber's current Effect span, so Pi's spans nest under it.
- **Chord's values.** The JSON type of Chord's documents, the SQLite database Pi's storages open, the delta ops of a
  changing document and bounded output, each from its own subpath. What throws in Chord fails with a tagged error here.

The package adds no behaviour of its own. Chord's runtime (hosts, facets, clients, the store, plugins, the app kit and
the surfaces) is not wrapped; `test/index.test.ts` records why, value by value.

## Installation

```bash
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-chord-0.1.0.tgz effect
```

## A Chord context from the fiber

`@effectified/pi-chord/context` has Chord's context type and its derivations, and `ChordContext`, which makes one
from Effect:

```typescript
import { Effect } from "effect";
import { ChordContext } from "@effectified/pi-chord/context";

// root: a conversation of a Pi Durable harness (`harness.root()`).
const submit = Effect.scoped(
	Effect.gen(function* () {
		// Cancelled when this scope closes: interrupting the fiber cancels the submission in Pi.
		const context = yield* ChordContext.scoped();
		return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, context));
	}),
);
```

- **`ChordContext.scoped(parent?)`** is a child of `parent` (default: `BACKGROUND_CONTEXT`) that is cancelled when
  the current scope closes, whatever its exit: the context lives as long as its scope. Interrupting the fiber closes
  its scope. Its telemetry is the fiber's current span ([Telemetry and values](#telemetry-and-values)); the parent's
  values and cancellation are kept.
- **`ChordContext.timeout(duration, parent?)`** is cancelled after `duration` of the `Clock`, with the reason
  `AbortSignal.timeout` gives (a `DOMException` named `TimeoutError`), or when its scope closes. `TestClock.adjust`
  moves it in a test.
- **`ChordContext.aborted(context)`** completes with the abort reason once `context` is cancelled; it never completes
  for a context that cannot be. Race a wait against it, as Chord's `awaitWithContext` does.
- **Chord's derivations** (`withContextValue`, `withTelemetry`, `withAbortSignal`, `withoutAbortSignal`) are offered
  as they are. `withAbortSignal` is for a signal the caller already has, such as the one `Effect.callback` gives.

```typescript
import { Duration, Effect } from "effect";
import { ChordContext } from "@effectified/pi-chord/context";

// Pi's calls made with `deadline` are cancelled after thirty seconds of the Clock.
const bounded = Effect.scoped(
	Effect.gen(function* () {
		const deadline = yield* ChordContext.timeout(Duration.seconds(30));
		return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, deadline));
	}),
);
```

### Telemetry and values

A context carries the span Pi's calls start their spans under, and values keyed by a `ContextKey`.

`ChordContext.scoped` and `ChordContext.timeout` put the fiber's current Effect span into the context they make,
through the `PiTelemetry` adapter of [`@effectified/pi-telemetry`](../telemetry-effect/README.md): the spans Pi
starts under the context are children of the Effect span that made it. Provide `PiTelemetry.layer` once, and no Pi
call needs its span passed by hand:

```typescript
import { Effect } from "effect";
import { ChordContext } from "@effectified/pi-chord/context";
import { PiTelemetry } from "@effectified/pi-telemetry";

// root: a conversation of a Pi Durable harness (`harness.root()`).
const turn = Effect.scoped(
	Effect.gen(function* () {
		const context = yield* ChordContext.scoped();
		return yield* Effect.promise(() => root.submit({ type: "input", content: "Hello" }, context));
	}),
).pipe(Effect.withSpan("chat.turn"), Effect.provide(PiTelemetry.layer));
// The trace: chat.turn > the spans Pi starts for the submission
```

When the fiber is in a span, its span replaces the parent's. In a fiber with no span, or in a program without
`PiTelemetry`, the context keeps its parent's telemetry. Chord's `withTelemetry`, offered as it is, sets a span handle
from elsewhere (a Pi invocation's) on a context.

Values are set with Chord's `withContextValue`, which this subpath offers as it is:

```typescript
import { Effect } from "effect";
import { BACKGROUND_CONTEXT, ChordContext, createContextKey, withContextValue } from "@effectified/pi-chord/context";

const Tenant = createContextKey<string>("app.tenant");

const tenant = Effect.scoped(
	Effect.gen(function* () {
		const context = yield* ChordContext.scoped(withContextValue(Tenant, "acme", BACKGROUND_CONTEXT));
		return context.value(Tenant); // "acme"
	}),
);
```

## JSON

```typescript
import { Effect } from "effect";
import { copyJson, isJsonValue } from "@effectified/pi-chord/json";

// { title: "Report" }
const copy = yield* copyJson({ title: "Report", note: undefined }, { omitUndefinedProperties: true });
isJsonValue(copy); // true
const failure = yield* Effect.flip(copyJson({ at: new Date(0) })); // NotJson
```

`copyJson` fails with `NotJson` where Chord throws: a non-finite number, a cycle, a non-plain object, a symbol key, an
accessor property. `JsonValue` and `JsonRepresentation` are re-exported types.

## SQLite

`@effectified/pi-chord/sqlite` has the `SqliteDatabase` type Pi's SQLite storages open, Chord's rule for a table
prefix and its migrations. `@effectified/pi-chord/sqlite/node` opens one on `node:sqlite` (Node, and Bun, which has
it) for the life of a scope.

```typescript
import { Effect } from "effect";
import { applySqliteMigrations, validateSqliteSchemaPrefix } from "@effectified/pi-chord/sqlite";
import { openNodeSqliteDatabase } from "@effectified/pi-chord/sqlite/node";

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
```

- `validateSqliteSchemaPrefix` fails with `InvalidSchemaPrefix`.
- `applySqliteMigrations` applies, in one transaction, the migrations newer than the version its table records. It
  fails with `InvalidSchemaPrefix` for a table name Chord refuses, and with `SqliteError` for what Chord or the
  database rejects with (versions that are not 1, 2, 3, ..., a database newer than the migrations, a failed
  statement). Chord takes no signal there: an interrupted fiber waits until the transaction ended.
- `openNodeSqliteDatabase(path, options?)` makes the file's directory and puts the file in WAL mode, unless
  `mode: "read-only"`; it fails with `SqliteError` for a file it cannot open.

## Deltas

`@effectified/pi-chord/delta` has Chord's delta ops: the changes of a JSON value, as Pi Durable's document watches
deliver them.

```typescript
import { Effect } from "effect";
import { apply, decoder, encoder, type Op } from "@effectified/pi-chord/delta";

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
```

`apply`, `applyImmutable`, `applyImmutableBatches` and a decoder's `decode` fail with a `DeltaError`: `PathError` (a
path that does not resolve), `UnsafePathError` (a segment that reaches the prototype chain, or an index past the end)
or `InvalidOp` (not an op). `validateOp`, `validateWireOp` and `validateSafePath` are Chord's checks as Effects. The
encoder, the tracker (`track`, `appendText`), `diffRevisions`, `PendingOps` and the predicates are Chord's own.

## Bounded output

`@effectified/pi-chord/output` offers Chord's `OutputBuffer` (the head or tail window of a long stream), `boundOutput`,
`sanitizeOutput` and the byte helpers as they are: synchronous and free of I/O.

## Errors

One closed union, `ChordFailure`: `PathError`, `UnsafePathError`, `InvalidOp`, `NotJson`, `InvalidSchemaPrefix`,
`SqliteError`. Chord's delta error classes map to their tags through a record keyed by Chord's exports, so a class
Chord adds there fails to compile until it has one.

## The root

`@effectified/pi-chord` re-exports every type of Chord's root and its declaration vocabulary: contracts and their
schemas (`local`, `remote`, `obj`, `str`, ...), method errors (`ChordError`, `forbidden`, `invalid`), registries,
state, job, table and query declarations, codecs, themes, messages and formats. They are synchronous and free of I/O.

## Not covered

- **Chord's runtime.** Hosts and facets, links, the store, clients, plugins, the app kit, HTTP, workers, the web,
  terminal and React surfaces, session sync and Chord's own telemetry store. Each subpath's values are recorded `open`
  in `test/index.test.ts` with the reason.
- **`Progress`** of `/output`: it paces promise-returning writes on its own timers.
- **`/sqlite/cloudflare`**: it needs a Durable Object's storage, which only workerd provides.
