# Rules for the pi-effect packages

The root `AGENTS.md` binds every agent in this repository. This file adds the rules of the fork: `packages/*-effect`,
`effect/` and `.github/workflows/effect-*.yml`. The plan is `effect/PRD.md`; what milestone 0 found is `effect/M0.md`;
the packages and their state are in `effect/COMPAT.md`; the first consumer's binding and what is left of it is
`effect/PATENTOS.md`.

## The boundary

- Never edit an upstream file: anything outside `packages/*-effect/`, `effect/` and
  `.github/workflows/effect-*.yml`. If Pi lacks something, do without it or note it for a person to raise upstream.
- `package-lock.json` changes only through `npm install --package-lock-only --ignore-scripts` (or
  `npm install --ignore-scripts`). Never edit it by hand, never merge it: regenerate it.
- A line added to an upstream root file must be listed in `effect/boundary.json` with its reason. It must be a pure
  addition (no changed or removed upstream line), so a sync never conflicts on it.
- `node effect/scripts/check-boundary.ts` enforces all of this against `main`. Run it before you report.
- Work lands on the `effect` branch. `main` mirrors upstream and only fast-forwards; nobody commits to it.
- Never open an issue, a pull request or a comment on `earendil-works/pi` or `rivet-dev/*`. A person does that.

## Packages

- One facade per Pi package, named `<pi package>-effect`; plugins and hosts are separate packages (PRD section 5).
  `package.json` says which in `piEffect.kind`: `facade`, `plugin` or `host`.
  `packages/thread-effect` is the one `composition`: an agent thread made of all of them as a product composes
  them, in one process and as a Rivet actor. Nothing depends on it. A change to a plugin is done when its tests and
  the composition's pass.
- A facade adds no behaviour: it gives Pi's capability in Effect terms. Behaviour of ours goes into a plugin.
- Every package stands alone: it depends on the Pi package it wraps, on `effect` as a peer (`~4.1.5`, one range for
  all), and on the pi-effect packages PRD section 5.4 names. A plugin never depends on another plugin.
- Every package pins the same upstream Pi version. Bump them together and record it in `effect/COMPAT.md`.
- No `node:` or `bun:` import in a package core. Platform code lives in a file named `node.ts` or `bun.ts`, or
  under a `node/` or `bun/` directory, behind its own subpath export.
- `node effect/scripts/check-deps.ts` enforces these rules.
- Each package has a `README.md`, tests, and a `source` export condition so tests and type checks read its
  TypeScript directly.

## Effect idioms

- Effect 4.1.x only. Its API differs from Effect 3: read the declaration in `node_modules/effect/dist/*.d.ts`
  before using a function. Do not write Effect code from memory.
- Every public function returns `Effect`, `Stream` or `Layer`. No promise, callback or `any` in a public signature.
- Errors are `Schema.TaggedError` classes. No `throw` in library code.
- Interruption is cancellation in both directions: interrupting a fiber cancels the Pi call, and a Pi abort
  interrupts the Effect it runs.
- Time and ids come from services (`Clock`), so `TestClock` drives a test.
- Casts only where TypeScript cannot express a decided invariant or at a decode boundary, each with a short why.
- `@effect/vitest` needs Vitest 5 (upstream pins Vitest 4) and does not load under `bun test`. A test runs its Effect
  with `runTest` of `@gunta/pi-ai-effect/testing`: a scope, the test clock and the test console, on both lanes.
  `runLive` is for a test of real processes or files. `schema-effect` and `telemetry-effect`, which do not depend
  on it, keep `Effect.runPromise`.
- No test waits on the real clock. Time passes with `TestClock.adjust`; a forked fiber is started with
  `Effect.forkChild(effect, { startImmediately: true })` or awaited with a `Latch` or a `Deferred`, never with a
  short sleep.
- The style model is `packages/schema-effect`: one concept per file, a first-line comment saying what the file is
  for, one doc comment per export, a test file per source file.

## Commands

Run from the repository root. One heavy command at a time: `npm run check`, `npm run build` and `./test.sh` each use
every core.

| What | Command |
|---|---|
| Install | `npm ci --ignore-scripts` |
| Model data the type check needs (gitignored, fetched) | `npm run hydrate:model-data` |
| Upstream's check: Biome, dependency checks, `tsc` | `npm run check` |
| Upstream's build (pi-effect packages resolve Pi's `dist`) | `npm run build` |
| Build the pi-effect packages in dependency order | `node effect/scripts/build.ts` |
| Fast type check of the pi-effect packages only | `node_modules/.bin/tsc --noEmit -p effect/tsconfig.json` |
| One package's tests on Node | `cd packages/<name> && node ../../node_modules/vitest/dist/cli.js --run` |
| Every package's tests on Bun | `node effect/scripts/test-bun.ts` |
| Boundary and dependency rules | `node effect/scripts/check-boundary.ts && node effect/scripts/check-deps.ts` |
| Every upstream and pi-effect test, offline | `./test.sh` |

- After code changes: `npm run check`, the changed package's tests on Node, the Bun lane, and both rule checks.
- A new package: `node effect/scripts/new-package.ts <name>-effect <facade|plugin|host> "<description>" [name@version
  ...]`, then `npm install --ignore-scripts`. A subpath another package imports needs its own `paths` line in the root
  `tsconfig.json`, listed in `effect/boundary.json`.
- A test file that needs one runtime is named for it (`*.node.test.ts`, `*.bun.test.ts`) and skipped on the other.

## Writing a plugin

A plugin is a package of `piEffect.kind: "plugin"`: behaviour of ours on the facades. Read `effect/PRD.md` sections
5.2, 5.4 and 7 for what it must hold, and `packages/durable-effect/README.md` for what it can use.

- A plugin never imports another plugin. Plugins meet only in a product's composition: each gives `Extension`s
  (tools, hooks), `Layer`s and services, and the product installs them in one `Registry.layer([...])`, in order.
  Hooks are asked in extension order, so the README says where the plugin's extension belongs (guards first).
- What the product must supply is a `Context.Service` port of the plugin (a sink, a lease, a decider), never a
  callback option. No product rule, name or constant in the code (PRD principle 6).
- Everything a plugin stores lives in the harness storage through `Doc`, `Entry`, memos and commits, with kinds
  prefixed by the plugin (`recorder.cursor`), so a fork copies it and the Rivet host's `onFork` can drop it.

What Pi Durable 1.6.0 gives and withholds (found by the durable-effect suites; `effect/M0.md` has the evidence):

- A hook answers; it cannot commit. Its only write is a memo, which is its own commit, not the step's. What is
  atomic with a step is the step's own entry. A tool's `api.commit`, a host `commit` and a task's commit are atomic.
- Pi asks a hook again after a crash, a close or a wake. What a hook does outside must be idempotent; a decision
  that must not change is a memo with a candidate (first writer wins).
- A failing hook is reported and skipped, so the run continues: it fails open. Only `beforeTool` fails closed (the
  call is blocked). Nothing in a generation hook can stop a provider request.
- A model request stopped by a close is sent again on reopen. A `replay: "unsafe"` tool never runs again (the call
  gets an `interrupted` error result); a `replay: "safe"` tool does.
- Interrupting a caller never stops a run. `Conversation.abort` and `Harness.abortTask` do.
- Memory storage cannot be reopened. A test that closes and reopens a harness uses a SQLite file, on both drivers:
  copy the pattern of `packages/durable-effect/test/sqlite-suites.ts` with its `sqlite.node.test.ts` and
  `sqlite.bun.test.ts`.

When several agents work in one checkout, the shared type check (`tsc -p effect/tsconfig.json`) can be blocked by
another package's half-written file. Then check your package alone with a temporary `tsconfig.json` in your `test/`
directory that extends `../../../effect/tsconfig.json` and includes only your `src` and `test`; delete it afterwards.
