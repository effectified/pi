# Compatibility

Which pi-effect release works with which upstream versions. The pi-effect packages share one version. A row is added
only after the whole suite ran on those versions (`npm run check`, each package's tests on Node, the Bun lane).

| pi-effect | Pi packages (`@earendil-works/*`) | `effect` | Node | Bun | Tested at upstream commit |
|---|---|---|---|---|---|
| 0.1.0 (unreleased) | 1.6.0 | 4.1.5 (peer `~4.1.5`) | 26.13.1 and 22.19.0 (24.22.0 ran an earlier state) | 1.4.5 | `f8149d1ab` |

Also installed and run outside this repository beside the published `@earendil-works/*` 1.6.0 (the quick start of
`durable-effect`, from packed tarballs, on Node and on Bun with its isolated linker). `rivetkit` 3.1.1 is the peer of
`durable-rivet-effect`; its engine tests ran on macOS only. Node 22.19.0 is the lowest version the packages declare:
all fifteen suites pass on it (1,747 tests, 2026-11-25). Not yet run against a real model provider, and CI
(`effect-ci.yml`, Node 22) has never run: the branch is not pushed.

`./test.sh` exits 1 on this machine: three tests of upstream's `packages/coding-agent` fail (`exec`, `mcp-command`,
`output-file-failures`), and the same three fail on an untouched copy of `main` at `f8149d1ab` in the same
environment. Every other upstream suite and every pi-effect suite passes in it.

## Packages in 0.1.0

Tests are counted per lane: the same files run under Vitest on Node and under `bun test`.

| Package | Kind | Wraps or does | Tests | Not covered |
|---|---|---|---|---|
| `@gunta/pi-schema-effect` | facade | `@earendil-works/pi-schema` | 17 | |
| `@gunta/pi-ai-effect` | facade | `@earendil-works/pi-ai`, both `effect/ai` bridges | 44 | Images, classifiers, OAuth login, deferred responses |
| `@gunta/pi-telemetry-effect` | facade | `@earendil-works/pi-telemetry` | 59 | `TelemetryStore`; histogram exemplars |
| `@gunta/pi-durable-effect` | facade | `@earendil-works/pi-durable` | 426 | A task's own hooks, `setTimer`, prompt sections and wrappers, synchronous observers |
| `@gunta/pi-durable-rivet-effect` | host | A harness in a Rivet actor: storage, wake-ups, forks | 165 | Linux engine runs; several machines; an engine that dies |
| `@gunta/pi-router-effect` | plugin | Routes, fallback, limiter, prices, constraints | 169 | A real provider; image and classifier routing |
| `@gunta/pi-budget-effect` | plugin | Lease at the model boundary, shares | 86 | |
| `@gunta/pi-guard-effect` | plugin | Denied verbs, grants, argument rules, ceilings | 111 | |
| `@gunta/pi-approvals-effect` | plugin | Approval as a parking gate | 66 | |
| `@gunta/pi-recorder-effect` | plugin | Records from committed entries to a sink | 57 | A real crash (closes were tested) |
| `@gunta/pi-review-effect` | plugin | Second-family review, checks, corrections, holds | 147 | |
| `@gunta/pi-subagent-effect` | plugin | Foreground and background children | 66 | |
| `@gunta/pi-swarm-effect` | plugin | Keyed forks under a cap, in storage and as actor forks | 143 | |
| `@gunta/pi-search-effect` | plugin | Search and fetch tools, Exa adapter | 60 | A real Exa call |
| `@gunta/pi-thread-effect` | composition | An agent thread made of all of them, in process and as a Rivet actor | 131 | See its README, "Gaps" |

Not built: `mcp-effect`, `codemode-effect`, `agent-effect`, `env-effect`, `workflow-effect`, `sandbox-effect`
(PRD priorities P2 and P3).

## Bumping upstream

1. Fast-forward `main`, merge it into `effect`, regenerate the lockfile.
2. Change the pinned Pi version in every `packages/*-effect/package.json` together
   (`node effect/scripts/check-deps.ts` rejects mixed versions).
3. Run everything. The parity tests of `durable-effect` show what moved in Pi Durable.
4. Add a row here.
