# Packages

Fifteen packages, each with its own README as its reference. The examples in a README are run by that package's
tests. [How pi-effect Works](how-it-works.md) says how the kinds layer.

## Choose a package

| Need | Package | Kind | Entry exports | README |
|---|---|---|---|---|
| An agent thread worked from one call, guarded, budgeted, routed, recorded, reviewed | `@effectified/pi-thread` | composition | `Composition.open`, `Threads`, `Swarms`, `OutcomeSink`, `Outcome`; `/rivet`: `ThreadActor`, `Remote` | [thread](../../thread-effect/README.md) |
| The durable harness: conversations, commits, tools, hooks, gates, signals, tasks, documents, entries | `@effectified/pi-durable` | facade | `Harness`, `Registry`, `Extension`, `Tool`, `Hook`, `Gate`, `Signal`, `Task`, `Doc`, `Entry`, `Storage`; `/testing`: `TestHarness` | [durable](../../durable-effect/README.md) |
| Models: requests as `Stream` and `Effect`, the two `effect/ai` bridges, the key of a request | `@effectified/pi-ai` | facade | `Models`, `getModel`, `stream`, `complete`, `PiLanguageModel`, `EffectProvider`, `requestKey`, `ANSWERED`; `/testing`: `ScriptedModels`, `runTest`, `conditions` | [ai](../../ai-effect/README.md) |
| Effect `Schema` to and from the JSON Schema of tool parameters | `@effectified/pi-schema` | facade | `toJsonSchema`, `fromJsonSchema`, `decodeUnknown`, `encode`, `validator` | [schema](../../schema-effect/README.md) |
| Pi's spans, metrics and events on Effect's tracer, metrics and logger | `@effectified/pi-telemetry` | facade | `PiTelemetry` | [telemetry](../../telemetry-effect/README.md) |
| The Chord context of a Pi call from the calling fiber; Chord's JSON, SQLite, delta and output values | `@effectified/pi-chord` | facade | Chord's declaration vocabulary; `/context`: `ChordContext`; `/json`, `/sqlite`, `/sqlite/node`, `/delta`, `/output` | [chord](../../chord-effect/README.md) |
| A harness inside a Rivet actor: actor SQLite as storage, schedules as wake-ups, actor forks | `@effectified/pi-durable-rivet` | host | `Actor`, `Action`, `Client`, `Host`, `Self`, `ActorSql`, `ActorInfo`; `/node` and `/bun`: `serve`; `/testing` | [rivet host](../../durable-rivet-effect/README.md) |
| An exact tool allow-list per conversation, denied verbs, argument rules, classification ceilings | `@effectified/pi-guard` | plugin | `Guard`, `Conversations`, `Policy`, `Matcher`, `Rule`, `Refused` | [guard](../../guard-effect/README.md) |
| Money reserved and settled for every provider request under the product's lease | `@effectified/pi-budget` | plugin | `BudgetedModels`, `Lease`, `Estimator`, `Prices`, `Shares`, `Spend`, `stopOf`, `continueStopped` | [budget](../../budget-effect/README.md) |
| Aliases served by routes, fallback, limiter, prices, per-conversation constraints | `@effectified/pi-router` | plugin | `Router`, `RouteTable`, `ConstraintSource`, `AttemptSettlement`, `priceRows`, `RouteEvents` | [router](../../router-effect/README.md) |
| A person's approval of a tool call, bound to its arguments | `@effectified/pi-approvals` | plugin | `extension`, `Inbox`, `decide`, `approve`, `deny`, `pending`, `applied` | [approvals](../../approvals-effect/README.md) |
| Every message, model call and tool call to the product's sink, at least once, under fixed ids | `@effectified/pi-recorder` | plugin | `Recorder`, `RecordSink`, `Records`, `Advisory`, `onStorageFork` | [recorder](../../recorder-effect/README.md) |
| Review by a model of another family, checks, corrections, holds a person releases | `@effectified/pi-review` | plugin | `extension`, `Policy`, `Check`, `Citations`, `state`, `verdicts`, `release`, `retry` | [review](../../review-effect/README.md) |
| Tools that delegate to declared child agents, foreground and background | `@effectified/pi-subagent` | plugin | `Subagents`, `Subagent`, `ChildSetup`, `Child` | [subagent](../../subagent-effect/README.md) |
| Keyed forks of a primed conversation under a cap, typed fan-in | `@effectified/pi-swarm` | plugin | `make`, `start`, `status`, `result`, `cancel`, `ConversationForks`, `ForkSetup`; `/rivet`; `/driver` | [swarm](../../swarm-effect/README.md) |
| Web search and fetch tools that keep the raw evidence; an Exa adapter | `@effectified/pi-search` | plugin | `SearchTools`, `SearchProvider`, `Evidence`, `Limits`; `/exa`; `/provider` | [search](../../search-effect/README.md) |

Modules are namespaces: `import { Harness, Tool } from "@effectified/pi-durable"`, then `Harness.root`,
`Tool.make`. A few packages are imported whole: `import * as Approvals from "@effectified/pi-approvals"`,
`import * as Review from "@effectified/pi-review"`, `import * as Swarm from "@effectified/pi-swarm"`. Copy the
import lines of the README example you start from.

Not built: an MCP facade, code mode, the non-durable agent loop, remote environments, fixed-step workflows, a
sandbox. Reach what a facade does not wrap through Pi's own objects (each README ends with "Not wrapped yet").

## Installing in a product

- Every package names `effect` as a peer (`~4.1.5`): the application has one copy. The Rivet entries also need
  `rivetkit` (`~3.1.1`). Each README's "Install" section lists the Pi packages it needs beside it.
- In a product that vendors the packages, each sits beside `docs-effect/` (the package that holds this documentation) as
  `<package>-effect/`, with its `README.md` and its built output, so the links of these pages resolve there as here.
  The README is the reference; the `.d.ts` files are the signatures.
- The package cores import no `node:` or `bun:` module; platform code is behind a subpath of its own. Pick the
  entry for the runtime: the Rivet host's local engine is `/node` or `/bun`, an SQLite client is
  `@effect/sql-sqlite-node` or `@effect/sql-sqlite-bun`.

## Where to read more

- Each package's README is the source of truth; its examples run as tests. Its sections "Guarantees and their
  limits" (or "What holds" and "Limits") say what is promised and what is not.
- What a product inherits from all of them at once:
  [Limits the packages document, which a product inherits](../../thread-effect/README.md#limits-the-packages-document-which-a-product-inherits).
- What a hand-written agent loop maps to:
  [From the consumer's loop to the packages](../../thread-effect/README.md#from-the-consumers-loop-to-the-packages).
