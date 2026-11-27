# Work in the Repository

This is the order to do things in. The rules themselves are `effect/AGENTS.md`: read it in full before the first
edit. Where the two differ, that file is right.

## Before you edit

- **The boundary.** The fork owns `packages/*-effect/`, `effect/` and `.github/workflows/effect-*.yml`. Every other
  file is upstream Pi's and is never edited. If Pi lacks something, do without it and write down what is missing.
- **The lockfile** changes only through `npm install --ignore-scripts`. Never edit it, never merge it.
- **Other agents may share the checkout.** Stage explicit paths. Never `git add -A`, `git stash`,
  `git reset --hard` or `git checkout .`: each destroys another agent's work.
- **Effect is 4.1.x.** Its API differs from Effect 3. Read the declaration in `node_modules/effect/dist/*.d.ts`
  before you use a function.

## The loop

1. Make the change, in one package if you can.
2. Run the gate for what you changed:
   ```sh
   node effect/scripts/gate.ts --changed
   ```
   It runs every check, then the tests of the changed packages and of those that depend on them, on Node and on Bun.
   It changes no file. It prints one line per step, the end of a failed step's output, and the directory that holds
   the whole output.
3. Fix what is yours. A failure in a file you did not touch is another agent's: name it in one line and go on.
4. Before a commit others build on, run the whole gate: `node effect/scripts/gate.ts`.

Do not run `npm run check` in a shared checkout. It rewrites every file its formatter would change, another agent's
half-written ones included.

## What a failed step means

| Step | It failed because | Do |
|---|---|---|
| format and lint | Formatting, a lint rule, or an idiom rule of `effect/AGENTS.md` ("Effect-native design") | `node effect/scripts/style.ts --write <your paths>` formats, your paths only; a lint finding is fixed in the code, or carries `// idiom-allow <rule>: <why>` above it |
| types and Effect rules | A type error (`error TS1234`), or an Effect rule (`<rule>:`): a dropped Effect, `Date` or a timer where `Clock` belongs, a `node:` import in a package core, an unstable Effect module nobody allowed. Tests are held back only for the packages a type error can reach | Fix it; `node effect/scripts/types.ts --package <dir>` lists one package's. A Pi type that moved shows here first. A new unstable module is one line of `allowedUnstableApis` in `effect/tsconfig.json`, with its reason |
| Pi pins, release and surface record | The names a package imports from Pi changed, or a README opens with another Pi version than the pins | `node effect/scripts/pi-surface.ts`, read what it prints, commit `effect/pi-surface/` with the change |
| fork boundary | A changed file outside the boundary | Move the change into a package or `effect/` |
| dependency rules | A plugin imports a plugin, a facade imports a plugin, a platform import sits outside a `node` or `bun` file, or a package's `src` imports a Pi package that is not its own to wrap | Move the code. Plugins meet only in a product's composition. Import a Pi name from its package's facade; if the facade lacks it, offer it there |
| docs-effect tests | A page quotes a README example that changed, a page names something that is gone, a page is missing from `docs.json`, or a package has no role on the landing page | Update the page in `packages/docs-effect/docs/`, or add the role in `packages/docs-effect/src/content.ts` |

## Rules that are easy to break

- **What Pi defines is not written a second time.** Take a type from Pi's (`Pick`, `Extract`, indexed access, a
  mapped type). Make a choice over a Pi union exhaustive where it is written (`satisfies Record<Union, ...>`, a
  `switch` with a declared return type). What must stay hand-written is asserted in the package's
  `test/pi-conformance.ts` with the helper `effect/conformance.ts`, our side first.
- **A facade adds no behaviour.** Behaviour goes into a plugin. A plugin never imports another plugin.
- **What a product supplies is a service**, a `Context.Service` port of the plugin, never a callback option. No
  product rule, name or constant in the code.
- **Every public function returns `Effect`, `Stream` or `Layer`.** Errors are `Schema.TaggedError` classes. Library
  code does not throw.
- **No test waits on the real clock.** A test runs its Effect with `runTest` of `@effectified/pi-ai/testing` and
  moves time with `TestClock.adjust`. See [Test Without a Network](testing.md).
- **A README example is tested.** Each package's `test/readme.test.ts` runs its README's code. Change the two
  together.

## Adding a package

1. `node effect/scripts/new-package.ts <name>-effect <facade|plugin|host> "<description>" [name@version ...]`, then
   `npm install --ignore-scripts`.
2. Write its `README.md`, its tests, and a row in the package table of `effect/COMPAT.md`.
3. Give it a role in `packages/docs-effect/src/content.ts` and a row in `packages/docs-effect/docs/packages.md`.
   The documentation's test fails without them.

## Commits and CI

- Commit only when the user asks. Stage explicit paths, check `git status` first.
- Message: `feat(effect): ...`, `fix(effect): ...` or `docs(effect): ...`. No emojis.
- Work lands on the branch `effect`. `main` mirrors upstream and only fast-forwards.
- A lockfile change is committed with `PI_ALLOW_LOCKFILE_CHANGE=1`, and only when the user wants it committed.
- The Linux runner is slower than a laptop, and engine tests that pass locally have failed there. Read the CI run
  after every push of package code. A new push cancels the run in progress.

## Releasing

The packages share one version and are published on npm by CI, with no token and nobody signed in.

1. `node effect/scripts/version.ts <major|minor|patch>` writes the new version into every manifest, each
   dependency of one package on another, `effect/COMPAT.md`, `effect/release.json` and the lockfile.
2. Run the gate, complete the new row's prose in `effect/COMPAT.md`, commit, and push.
3. Once Effect CI passed on that commit, `.github/workflows/effect-release.yml` publishes every package npm lacks
   at that version, in dependency order, and makes the GitHub release `v<version>` with the notes.

- A push that changes no version publishes nothing. `node effect/scripts/release.ts plan` says which it is.
- A run that stopped half way is finished by running the workflow again: what is on npm is left as it is.
- `node effect/scripts/release.ts publish --dry-run` packs every package and lets npm check each tarball.
- npm trusts the workflow only for a package it knows. A new package is made known once, by a person signed in to
  npm: `node effect/scripts/npm-bootstrap.ts`. Until then the release says which package is missing and publishes
  nothing.
- When upstream's `main` is past the pinned Pi version with no export changed, `version.ts --unreleased-pi` lets
  that one version be built against it; the release notes then say so.

## Into a product

`node effect/scripts/vendor.ts <directory>` builds every package and writes it there as a workspace package, with
the documentation and the skills of `docs-effect`. It refuses when the packages' Pi pins are not the Pi sources in the tree.
