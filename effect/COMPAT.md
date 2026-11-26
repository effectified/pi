# Compatibility

Which pi-effect release works with which upstream versions. The pi-effect packages share one version. A row is added
only after the whole suite ran on those versions (`npm run check`, each package's tests on Node, the Bun lane).

| pi-effect | Pi packages (`@earendil-works/*`) | `effect` | Node | Bun | Tested at upstream commit |
|---|---|---|---|---|---|
| 0.1.0 (unreleased) | 1.6.1 | 4.1.5 (peer `~4.1.5`) | 26.13.1 (22.19.0 and 24.22.0 ran earlier states, on Pi 1.6.0) | 1.4.5 | `745338811` |

Also installed and run outside this repository beside the published `@earendil-works/*` 1.6.0 (the quick start of
`durable-effect`, from packed tarballs, on Node and on Bun with its isolated linker). `rivetkit` 3.1.1 is the peer of
`durable-rivet-effect`; its engine tests run on macOS and, since 2026-11-26, on Linux in CI (x64) on Node and on Bun. Node 22.19.0 is the lowest version the packages declare:
all fifteen suites passed on it on Pi 1.6.0 (1,747 tests, 2026-11-25). On Pi 1.6.1 they pass on Node 26.13.1 (1,950
tests, 2026-11-26, by `node effect/scripts/gate.ts`) and on Bun (2026-11-26); between the two versions Pi Durable changed only its Node environment (shell lookup,
line reader). Not yet run against a real model provider. Under the names `@effectified/pi-<x>` (2026-11-26), the
fifteen tarballs of `effect/scripts/pack.ts` installed into an empty project beside the published `@earendil-works/*`
1.6.1 and `effect` 4.1.5, and every package and `@effectified/pi-ai/testing` imported on Node 26. From the GitHub
release `v0.1.0`, the one URL of `pi-thread` installed it with the pi-effect packages it depends on into an empty
project with npm 12.2.3 (`--allow-remote=all`), pnpm 12.21.0 (`blockExoticSubdeps` off) and Bun 1.4.5, and it
imported on Node 26.

CI (`effect-ci.yml`, Node 22, Linux) first ran on 2026-11-25 and was red in upstream's own check and tests, not in
these packages: upstream's build fetches the model catalogs of the day, and the tests at `f8149d1ab` named models
that had left them. A `main` behind upstream goes red that way; the cure is to sync it. After the sync the same
jobs were red once more on one upstream test of a Qwen catalog, which was red on upstream's own `main` that hour.

The first run of the package tests on Linux (after the sync) passed the Bun lane whole and fourteen packages on
Node, and found two faults of the local engine start of `durable-rivet-effect` there: the engine's Linux binary
says "Address in use" where macOS says "Address already in use", and an engine that ended at once has no command
line in the process list. A start on a taken port then waited rivetkit's whole minute. Both are fixed and were
reproduced and checked in a Linux container (Node 22, arm64). The next run found one test of `thread-effect` that
depended on the machine's speed (the failing outcome sink); it no longer does. On `135b6a18a` the `check` job passed
whole on Linux: upstream's check, and every package's tests on Node 22 and on Bun.

A day later upstream's check was red again on another model that had left a catalog (`kimi-k2.6`), while every
package's tests passed on Linux (`0341cb51c`, with the local engine in a kept directory, the watcher and the
start of several engines). So the run's result is now that of these packages alone: upstream's check and
upstream's test jobs still run and show, and do not fail the run; a step of its own runs the parts of upstream's
check that read these packages (format and lint, pinned versions, declared dependencies, import style). Upstream's
own workflows are disabled in the fork (`gh workflow enable <name>` brings one back).

`./test.sh` exits 1 on this machine: three tests of upstream's `packages/coding-agent` fail (`exec`, `mcp-command`,
`output-file-failures`), and the same three fail on an untouched copy of `main` at `f8149d1ab` in the same
environment. Every other upstream suite and every pi-effect suite passes in it.

## Packages in 0.1.0

Tests are counted per lane: the same files run under Vitest on Node and under `bun test`.

| Package | Kind | Wraps or does | Tests | Not covered |
|---|---|---|---|---|
| `@effectified/pi-schema` | facade | `@earendil-works/pi-schema` | 28 | |
| `@effectified/pi-ai` | facade | `@earendil-works/pi-ai`, both `effect/ai` bridges, the key of a request, `runTest`, the forms the plugins share | 62 | Images, classifiers, OAuth login, deferred responses |
| `@effectified/pi-telemetry` | facade | `@earendil-works/pi-telemetry` | 59 | `TelemetryStore`; histogram exemplars |
| `@effectified/pi-agent` | facade | `@earendil-works/pi-agent-core` | 54 | Changing the agent's settings and hooks after `make`; `Clock` for the timestamps Pi stamps itself |
| `@effectified/pi-durable` | facade | `@earendil-works/pi-durable` | 442 | A task's own hooks, `setTimer`, prompt sections and wrappers, synchronous observers |
| `@effectified/pi-durable-rivet` | host | A harness in a Rivet actor: storage, wake-ups, forks; a local engine in a kept directory; `ActorSql` | 239 | Several machines; an engine that dies |
| `@effectified/pi-router` | plugin | Routes, fallback, limiter, prices, constraints | 181 | A real provider; image and classifier routing |
| `@effectified/pi-budget` | plugin | Lease at the model boundary, shares | 92 | |
| `@effectified/pi-guard` | plugin | Denied verbs, grants, argument rules, ceilings | 112 | |
| `@effectified/pi-approvals` | plugin | Approval as a parking gate | 65 | |
| `@effectified/pi-recorder` | plugin | Records from committed entries to a sink | 57 | A real crash (closes were tested) |
| `@effectified/pi-review` | plugin | Second-family review, checks, corrections, holds | 153 | |
| `@effectified/pi-subagent` | plugin | Foreground and background children | 67 | |
| `@effectified/pi-swarm` | plugin | Keyed forks under a cap, in storage and as actor forks | 154 | |
| `@effectified/pi-search` | plugin | Search and fetch tools, Exa adapter | 60 | A real Exa call |
| `@effectified/pi-thread` | composition | An agent thread made of all of them, in process and as a Rivet actor | 141 | See its README, "Gaps" |
| `@effectified/pi-docs` | docs | The documentation of all of them, as Pi keeps its own (`docs/`, `docs.json`), a site built from it, and skills that lead agents to its pages | 38 | |

Not built: `mcp-effect`, `codemode-effect`, `agent-effect`, `env-effect`, `workflow-effect`, `sandbox-effect`
(PRD priorities P2 and P3).

## What an application imports

An application imports `@effectified/pi-*` and `effect`, never `@earendil-works/*`:

- Each facade re-exports every type of its Pi package (`export type *`). Where a facade has a name of its own, its
  own wins. Pi's type of that name is re-exported as `Pi<Name>` when a plugin needs it, for example `PiModels`.
- `@effectified/pi-ai/providers/<name>` exists for each of pi-ai's 43 providers, and offers its constructor
  (`anthropicProvider`). `node effect/scripts/providers.ts` writes these modules, and the gate's `providers` step
  fails when they differ from pi-ai's list.
- `@effectified/pi-ai/testing` offers pi-ai's faux provider and its helpers.
- Each facade's `test/index.test.ts` records what it does with every value its Pi package exports:
  - `offered`: exported as it is, a pure value;
  - `replaced`: exported as an Effect form of ours, named in the entry;
  - `open`: not in Effect terms yet, with the reason.

  The record is a `satisfies Record<keyof typeof Pi, Coverage>`, so a value Pi adds fails `npm run check` until it
  is decided. The `open` entries are the work left. On 2026-11-26 they number:

  | Facade | Open entries |
  |---|---|
  | pi-ai | 70 |
  | pi-durable | 12 |
  | pi-telemetry | 3 |
  | pi-schema | 0 |

- `check-deps.ts` enforces this rule. Plugins and the composition are written the way an application is, so they
  import no `@earendil-works/*`. Every README and documentation page shows only effectified imports, except those
  listed in its `DOCUMENTED_PI_IMPORTS`: two Chord contexts, until Chord has a facade.

## Bumping upstream

1. Fast-forward `main` to upstream, with upstream's tags, and push it with the release tag
   (`git push origin main v<version>`): the sync check compares the wrapped Pi sources with that tag.
2. On `effect`: `git merge --no-commit --no-ff main`, then `node effect/scripts/sync.ts bump`. It pins every
   `packages/*-effect/package.json` to the workspace's Pi version, takes the lockfile from `main` and installs,
   rewrites `effect/pi-surface/` and prints which Pi declarations the packages use changed (old and new text, and
   which packages use each), then runs the gate one command at a time and stops at the first failure. Upstream's own
   `npm run check` only shows, as in CI. It ends with the new row for the table above, from measured values.
3. Run `node effect/scripts/providers.ts` for pi-ai's provider list. Decide each new Pi export in its facade's
   `test/index.test.ts`; `npm run check` names them.
4. Read the surface changes; the parity tests of `durable-effect` show what moved in Pi Durable. Add the row, run
   `node effect/scripts/sync.ts check`, and commit with `PI_ALLOW_LOCKFILE_CHANGE=1`. PatentOS's own Pi pins move
   with its vendored packages (`effect/PATENTOS.md`).

`sync.ts check` runs in CI too: one Pi version across all pins, the workspace's; the wrapped Pi sources equal to what
that version released (a warning in CI, since upstream's `main` changes them between releases); this row; and
`pi-surface.ts --check`. `pack.ts` and `vendor.ts` refuse to build when the tree is not the pinned release, unless
given `--unreleased-pi`, which `SOURCE.json` beside their output then records.
