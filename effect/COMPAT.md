# Compatibility

Which pi-effect release works with which upstream versions. The pi-effect packages share one version. A row is added
only after the whole suite ran on those versions (`npm run check`, each package's tests on Node, the Bun lane).

| pi-effect | Pi packages (`@earendil-works/*`) | `effect` | Node | Bun | Tested at upstream commit |
|---|---|---|---|---|---|
| 0.1.0 (unreleased) | 1.6.1 | 4.1.5 (peer `~4.1.5`) | 26.13.1 (22.19.0 and 24.22.0 ran earlier states, on Pi 1.6.0) | 1.4.5 | `745338811` |

Also installed and run outside this repository beside the published `@earendil-works/*` 1.6.0 (the quick start of
`durable-effect`, from packed tarballs, on Node and on Bun with its isolated linker). `rivetkit` 3.1.1 is the peer of
`durable-rivet-effect`; its engine tests run on macOS and, since 2026-11-26, on Linux in CI (x64) on Node and on Bun. Node 22.19.0 is the lowest version the packages declare:
all fifteen suites passed on it on Pi 1.6.0 (1,747 tests, 2026-11-25). On Pi 1.6.1 they pass on Node 26.13.1 (1,800
tests, 2026-11-26, after the tests left the real clock) and on Bun (2026-11-26); between the two versions Pi Durable changed only its Node environment (shell lookup,
line reader). Not yet run against a real model provider.

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
| `@gunta/pi-schema-effect` | facade | `@earendil-works/pi-schema` | 17 | |
| `@gunta/pi-ai-effect` | facade | `@earendil-works/pi-ai`, both `effect/ai` bridges, the key of a request, `runTest` | 51 | Images, classifiers, OAuth login, deferred responses |
| `@gunta/pi-telemetry-effect` | facade | `@earendil-works/pi-telemetry` | 59 | `TelemetryStore`; histogram exemplars |
| `@gunta/pi-durable-effect` | facade | `@earendil-works/pi-durable` | 429 | A task's own hooks, `setTimer`, prompt sections and wrappers, synchronous observers |
| `@gunta/pi-durable-rivet-effect` | host | A harness in a Rivet actor: storage, wake-ups, forks; a local engine in a kept directory | 191 | Several machines; an engine that dies |
| `@gunta/pi-router-effect` | plugin | Routes, fallback, limiter, prices, constraints | 170 | A real provider; image and classifier routing |
| `@gunta/pi-budget-effect` | plugin | Lease at the model boundary, shares | 88 | |
| `@gunta/pi-guard-effect` | plugin | Denied verbs, grants, argument rules, ceilings | 111 | |
| `@gunta/pi-approvals-effect` | plugin | Approval as a parking gate | 66 | |
| `@gunta/pi-recorder-effect` | plugin | Records from committed entries to a sink | 57 | A real crash (closes were tested) |
| `@gunta/pi-review-effect` | plugin | Second-family review, checks, corrections, holds | 153 | |
| `@gunta/pi-subagent-effect` | plugin | Foreground and background children | 66 | |
| `@gunta/pi-swarm-effect` | plugin | Keyed forks under a cap, in storage and as actor forks | 145 | |
| `@gunta/pi-search-effect` | plugin | Search and fetch tools, Exa adapter | 60 | A real Exa call |
| `@gunta/pi-thread-effect` | composition | An agent thread made of all of them, in process and as a Rivet actor | 137 | See its README, "Gaps" |

Not built: `mcp-effect`, `codemode-effect`, `agent-effect`, `env-effect`, `workflow-effect`, `sandbox-effect`
(PRD priorities P2 and P3).

## Bumping upstream

1. Fast-forward `main` to upstream, with upstream's tags, and push it with the release tag
   (`git push origin main v<version>`): the sync check compares the wrapped Pi sources with that tag.
2. On `effect`: `git merge --no-commit --no-ff main`, then `node effect/scripts/sync.ts bump`. It pins every
   `packages/*-effect/package.json` to the workspace's Pi version, takes the lockfile from `main` and installs,
   rewrites `effect/pi-surface/` and prints which Pi declarations the packages use changed (old and new text, and
   which packages use each), then runs the gate one command at a time and stops at the first failure. Upstream's own
   `npm run check` only shows, as in CI. It ends with the new row for the table above, from measured values.
3. Read the surface changes; the parity tests of `durable-effect` show what moved in Pi Durable. Add the row, run
   `node effect/scripts/sync.ts check`, and commit with `PI_ALLOW_LOCKFILE_CHANGE=1`. PatentOS's own Pi pins move
   with its vendored packages (`effect/PATENTOS.md`).

`sync.ts check` runs in CI too: one Pi version across all pins, the workspace's; the wrapped Pi sources equal to what
that version released (a warning in CI, since upstream's `main` changes them between releases); this row; and
`pi-surface.ts --check`. `pack.ts` and `vendor.ts` refuse to build when the tree is not the pinned release, unless
given `--unreleased-pi`, which `SOURCE.json` beside their output then records.
