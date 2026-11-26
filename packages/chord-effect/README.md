# @effectified/pi-chord

[`@earendil-works/chord`](../chord/README.md) in Effect terms, for the parts a Pi application meets: the context every
Pi call takes, and Chord's JSON, SQLite, delta and output values. For `effect` 4.1.

- **A Chord context from the fiber.** Pi Durable, Chord and the Pi packages built on them take a Chord `Context`: a
  cancellation signal, a telemetry span and values. `ChordContext.scoped` gives one that is cancelled when the
  fiber's scope closes, so interrupting the fiber cancels the Pi call; `ChordContext.timeout` one that is cancelled
  after a span of the `Clock`. Both carry the fiber's current Effect span, so Pi's spans nest under it.
- **Chord's values.** The JSON type of Chord's documents, the SQLite database Pi's storages open, the delta ops of a
  changing document and bounded output, each from its own subpath. What throws in Chord fails with a tagged error here.

- **Chord's store.** `Store.open` and `Store.importArchive` give a store for the life of a scope; its commits and
  archives are Streams.
- **Chord's runtime.** A host (`Host.make`) is a scoped resource whose calls are Effects. A facet (`Facet.make`) has
  Effect handlers that run with the services of where it was made. Links (`Link`) and clients (`Client`) are scoped,
  and what they report (messages, connection states, the active theme and language) are Streams, as are Chord's
  watchables (`@effectified/pi-chord/watch`).

The package adds no behaviour of its own. `test/index.test.ts` records what it does with every value Chord exports,
and why a value is not wrapped yet.

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

## The store

`Store` is Chord's store: the SQLite tables and documents a Chord host persists, and where Pi Durable's storage can
live (`store` of `@effectified/pi-durable/storage/store`).

```typescript
import { Effect, Stream } from "effect";
import { sqliteBackend, Store } from "@effectified/pi-chord";
import { openNodeSqliteDatabase } from "@effectified/pi-chord/sqlite/node";

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
```

- `Store.open(backend, options?)` and `Store.importArchive(backend, parts, options?)` give Chord's own `Store`, so
  it goes where Chord takes one (a host's `store`, Pi Durable's storage). The store closes when the scope closes.
  A failure closes the backend.
- `Store.committed(store)` is a Stream of the store's `lastSeq` after each publication of commits.
- `Store.archive(store)` and `Store.hostArchive(store, address)` are Streams of archive parts. Reading one holds the
  store's commit queue until the Stream ends or its scope closes.
- `Store.encodeJsonl` and `Store.decodeJsonl` turn parts into JSONL bytes and back. `Store.readHostArchive(parts)`
  checks a host's data archive.
- A refused archive, a closed store or a line that is no JSON fails with `ChordFailed`, Chord's `ChordError` as a
  tagged error (`code`, `reason`, `message`, `details`). The database's own errors fail with `SqliteError`. When the
  Stream of parts fails, the import fails with that failure.

## Hosts and facets

A Chord app is made of objects served by facets on hosts. `Host.make(options)` is Chord's `createHost` for the life of
a scope. `Facet.make(setup)` is Chord's `defineFacet` with Effect handlers: wrap each one with `lift`.

```typescript
import { Context, Effect } from "effect";
import { constant, Facet, Host, local, method, obj, Reference, str } from "@effectified/pi-chord";

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
```

- `lift(handler)` turns an Effect handler into the function Chord calls (a method, an `on` routine, a job's run).
  Its last argument is the call's `ctx`: the Effect runs with it as `ParentContext` (of
  `@effectified/pi-chord/context`), so the calls it makes act for the caller, and it is interrupted when Chord cancels
  the call. Failing with `ChordFailed` or `PluginFailed` reaches the caller with that code (`invalid`, `forbidden`, a
  plugin's own); any other failure is an internal error.
- A host's calls are Effects: `load`, `reload`, `registry`, `revoke`, `accept` and `connect` (a link), `route` (its
  `resolve` an Effect), `root` (a body that is an Effect, its failure the Effect's), and the host data calls.
  `get` and `hold` give references released when the scope closes.
- `references(Type)` and `activity` are Streams. `errors` is a Stream of Chord's `onError`, and each error is also
  logged on the Effect logger. `Host.of(host, errors)` gives this API for a host Chord made itself.
- `Reference.call(reference.method, args)` calls a method under the fiber's `ParentContext`, interrupting the fiber
  cancels it; `Reference.state(reference)` is a Stream of its state. Every call fails with `ChordCallError`.
- `defineFacet` is offered for a facet without Effect handlers, and so are Chord's own facets (`themesFacet()`,
  `translationsFacet()`, `themeChoiceFacet()`, `localeChoiceFacet()`) and `constant`. `Facet.evaluate` runs a
  registered plugin script and `Facet.loadSet` loads a set of them, as a client does.

## Links, clients and watches

- `Link.memoryPair`, `Link.ipc(port)` and `Link.webSocket(socket)` give Chord's links for the life of a scope.
  `Link.messages(link)` is a Stream of what arrives on a link no host took; `Link.send` and `Link.close` are Effects.
- `Client.start(options)` is Chord's `startClient` for the life of a scope: its callbacks (`open`, `fetchScript`,
  `serverBase`, `outdated`, `canRetry`) are Effects, its `connection` and `errors` are Streams, and its `host` is a
  `Host`. `Client.keepConnected(options)` is Chord's connection loop alone. Both run their timers on the `Clock`
  (`Client.environment`), so `TestClock` drives them.
- `Client.activeTheme(host, mode, modes?)`, `Client.activeLanguage(host, preferred, devices?)` and
  `Client.hostLanguage(host)` are Chord's followers as Streams; they stop when their scope closes.
- `changes(watchable)` and `values(watchable)` of `@effectified/pi-chord/watch` are Streams of a Chord watchable (a
  document, a derive, a reference's member, a registry's value): the value now, then its changes, folded while the
  consumer is busy. A failure of the source fails the Stream with `WatchFailed`.

## SQLite on a Durable Object, compression, Chord's telemetry store

- `database(ctx.storage)` of `@effectified/pi-chord/sqlite/cloudflare` is Chord's `SqliteDatabase` on a SQLite-backed
  Durable Object, tested in workerd through Miniflare. Chord's store does not open on it in Chord 1.6.1: its schema
  check (`PRAGMA encoding`) is not authorized in workerd.
- `nodeCompression` of `@effectified/pi-chord/compression` is Chord's compressor for `Host.make({ compression })`.
- `make(database, options?)` of `@effectified/pi-chord/telemetry-sqlite` is Chord's SQLite telemetry adapter,
  recording for the life of a scope (a Pi `TelemetryContext` and a `TelemetryStore`); `flush`, `findTraces`,
  `getTrace` and `findMetrics` are Effects, on it or on a store file another process writes, which
  `openTelemetryStore(path)` of `@effectified/pi-chord/telemetry-sqlite/node` opens read-only for a scope.

## Errors

One closed union, `ChordFailure`: `PathError`, `UnsafePathError`, `InvalidOp`, `NotJson`, `InvalidSchemaPrefix`,
`SqliteError`, and `ChordCallError` of Chord's runtime: `ChordFailed` (Chord's `ChordError`) and `PluginFailed` (a
plugin's `PluginError`). `ScriptFailed` (a plugin script that would not evaluate) and `WatchFailed` (a watch that
failed) are their modules' own. Chord's error classes map to their tags through records keyed by Chord's exports, so a
class Chord adds fails to compile until it has one.

## The root

`@effectified/pi-chord` re-exports every type of Chord's root and its declaration vocabulary: contracts and their
schemas (`local`, `remote`, `obj`, `str`, ...), method errors (`ChordError`, `forbidden`, `invalid`), registries,
state, job, table and query declarations, codecs, themes, messages and formats. They are synchronous and free of I/O.

## Not covered

- **Chord's app kit.** The app server (`/app`), HTTP, workers, plugins, the surfaces, the web, terminal and React
  sides, session sync and telemetry ingest: 14 subpaths, each recorded `open` in `test/index.test.ts` with why.
- **`Progress`** of `/output`: it paces promise-returning writes on its own timers.
- **Timers of Chord's own** (the telemetry store's one-second flush, a host's heartbeats and timeouts) run on the real
  clock, not the `Clock`; the client's connection loop does follow the `Clock`.
- **The store's surface for adapters** (`findDocument`, `applyBatch`, ...): Chord marks it internal. Pi Durable's
  storage uses it; an application reaches it as `store` of `@effectified/pi-durable/storage/store`.
- **A client page's stylesheets and telemetry** (`ClientOptions.styles`, `telemetry`): passed to Chord as they are.
