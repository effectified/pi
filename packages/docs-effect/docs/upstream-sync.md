# Keep Up with Pi

The fork's branch `main` mirrors upstream Pi. The packages live on `effect` and pin one exact Pi version. A sync
moves `main` forward, merges it into `effect`, and moves every pin. The procedure of record is the section "Bumping
upstream" of `effect/COMPAT.md`.

## What tells you a sync is due

- CI's `upstream tests` jobs, or its step "Upstream check", are red while the `check` job's own steps are green.
  Upstream's build fetches the model catalogs of the day, and upstream's tests name models of them. A `main` behind
  upstream goes red that way. Those jobs do not fail the run: the run's result is the packages'.
- `node effect/scripts/sync.ts check` reports that the wrapped Pi sources are beyond the pinned release.
- A product needs a Pi fix.

A red upstream job on a fresh sync is upstream's own: the same test is then red on upstream's `main`.

## The steps

1. **Move `main`.** Fast-forward `main` to upstream with upstream's tags, and push it with the release tag:
   `git push origin main v<version>`. Nobody commits to `main`. Ask the user before this push: it is outward-facing.
2. **Merge, without committing.** On `effect`: `git merge --no-commit --no-ff main`. Resolve a conflict only in a
   file of the boundary. Never merge `package-lock.json` by hand: the next step takes it from `main`.
3. **Bump.**
   ```sh
   node effect/scripts/sync.ts bump
   ```
   It pins every package to the workspace's Pi version, moves the Pi version each README opens with, takes the
   lockfile from `main` and installs, rewrites `effect/pi-surface/` and prints which Pi declarations the packages
   use have changed, then runs the gate one command at a time and stops at the first failure. Upstream's whole
   `npm run check` only shows. It ends with the new row for the version table of `effect/COMPAT.md`.
4. **Read what changed under the packages.** See the next section. Fix, and run `bump` again until it passes.
5. **Record it.** Put the row into `effect/COMPAT.md`, with a sentence on what the sync changed. Then:
   ```sh
   node effect/scripts/sync.ts check
   ```
6. **Commit**, when the user asked for the sync: `PI_ALLOW_LOCKFILE_CHANGE=1 git commit`, message
   `feat(effect): sync with upstream at <commit> and move the packages to Pi <version>`.
7. **The product.** A product's own Pi pins move in the same commit as its vendored packages, or the exact peers
   do not resolve.

## Reading what changed

`bump` and `node effect/scripts/pi-surface.ts --check` print each changed Pi declaration with its old and new text
and the packages that use it. Three things can follow:

| What you see | What it means | Do |
|---|---|---|
| A type error in a package's `src` | A type derived from Pi moved, or a union gained a member that a map over it must decide | Decide it where the error is: forward it, wrap it, refuse it. Never widen the type to make the error go away |
| A type error in `test/pi-conformance.ts`, naming a difference such as `{ onlyPi: "refused" }` | Pi changed something the package mirrors by hand, or added a method a facade does not wrap | Update the mirror, or wrap the method, or add it to the skip list with its reason |
| A changed entry of `effect/pi-surface.watch.json` | Private Pi code the packages restate on purpose has moved | Read the sites the entry names and bring them in line |
| A failing behaviour test (`pi-*.test.ts`, the parity tests of durable-effect) | Pi behaves differently where no type shows it | This is the costly kind. Read the test's comment for what rests on the behaviour before you change anything |

A comment-only change in a Pi declaration is listed and fails nothing.

## What must hold afterwards

- `node effect/scripts/sync.ts check` passes: one Pi version in every pin, equal to the workspace's; the wrapped Pi
  sources equal to that version's tag; the first row of `effect/COMPAT.md`; the README openings; the surface record.
- `node effect/scripts/gate.ts` passes on Node and on Bun.
- `node effect/scripts/vendor.ts <directory>` no longer refuses. It refuses while the pins are not the Pi sources
  in the tree, because it makes what a product installs. `--unreleased-pi` overrides it for a deliberate build, and
  `SOURCE.json` beside the output then says so.

## What not to do

- Do not edit an upstream file to make a sync pass.
- Do not open an issue, a pull request or a comment on upstream Pi or on Rivet. A person does that.
- Do not pin the packages to a Pi version the tree does not hold. The type check and the tests read Pi's workspace
  source, so a wrong pin goes unnoticed until a product installs the published version.
