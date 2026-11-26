# @gunta/pi-docs-effect

The pi-effect packages explained, twice: as pages for people, and as skills for agents. It holds no library code,
is private, and is never published.

| For | What | Where |
|---|---|---|
| People | A landing page: what the library is, the packages as the stack they form, what the composition rules out, the way of one piece of work through it | `dist/index.html` |
| People | Every package's README as a page, with a rail of all of them | `dist/packages/<package>.html` |
| Agents | Skills: which package and export to use, the order that must not change, what is not guaranteed | `skills/<name>/SKILL.md` |
| Agents | An index of every package and skill, one line each (`llms.txt`) | `dist/llms.txt` |

## Build and open

```sh
npm run build --workspace packages/docs-effect
open packages/docs-effect/dist/index.html
```

`dist` is not committed. It is made from the tree, so a page cannot name a version, a count or a package the tree
does not have: the packages, their kinds and descriptions come from the manifests, the test counts and runtimes from
`effect/COMPAT.md`, the documentation from each README, and the example on the landing page from the composition's
README, where a test runs it. A page opens from a file: its stylesheet is written into it, and it loads nothing.

What is written by hand is in `src/content.ts`: each package's role in one sentence, and what the composition rules
out. A package without a role fails the build, so a new package cannot be left off the pages.

## The skills

| Skill | For |
|---|---|
| `pi-effect` | The map: which package answers which need, how the kinds layer, what a product supplies |
| `pi-effect-thread` | An agent thread in a product, in one process |
| `pi-effect-rivet` | A harness or a thread in Rivet actors, and a local engine |
| `pi-effect-extending` | A tool, a hook, a task, a stored document or a whole plugin |
| `pi-effect-testing` | Tests without a network or a key, on Node and on Bun |
| `pi-effect-contributing` | Work inside the pi-effect repository: the boundary, the gate, commits |
| `pi-effect-upstream-sync` | Moving the packages to a new Pi version |

An agent finds a skill only where its harness looks. This links every skill into a project's `.claude/skills` and
`.agents/skills`:

```sh
node vendor/pi-effect/docs-effect/bin/link-skills.mjs .              # in a product that vendors the packages
node packages/docs-effect/bin/link-skills.mjs . .claude/skills       # in this repository
```

A product gets the five skills for building on the packages. The two for work inside the pi-effect repository are
linked only into that repository. There, name `.claude/skills` alone, as above: it is ignored by git, while
`.agents/skills` would be a new path outside the fork's boundary. Agents that do not read `.claude/skills` find the
skills here through `effect/AGENTS.md`, which lists them.

A link that exists and points elsewhere is replaced. A directory of that name that is no link is the project's own
and is left alone, with exit code 1.

### The contract of a skill

A skill that is wrong is worse than none, since an agent acts on it without checking. So the test of this package
holds every skill to a contract (`src/node/skills.ts`), and the gate fails when one breaks it:

- Its frontmatter is `name`, equal to its directory, and `description`, one line of at most 1,024 characters.
- Its body has at most 300 lines.
- Every relative link leads to a package's README or to a file of the skills, the file exists, and the anchor is a
  heading there. So a skill reads the same in a product, where the packages are built and have no `src`.
- Every package and entry point it names is one of the library's.
- Every `ts` code block is a contiguous excerpt of a code block of a package's README. Those examples are run by
  each package's `test/readme.test.ts`; code written into a skill would be run by nothing.
- Every path of this repository it names in backticks exists.

So a README example that changes fails this package's test until the skills that quote it follow.

## In a product

`node effect/scripts/vendor.ts <directory>` writes this package beside the others: its `dist`, its `skills`, its
`bin` and this README. The links of the skills and of `llms.txt` are relative and hold there.

## Tests

```sh
node ../../node_modules/vitest/dist/cli.js --run
bun test --conditions=source
```

They build the site in memory and check that every package has a page and a place on the landing page, that every
link between pages leads to a page and to a heading that exists, that `llms.txt` names every package and skill with
links that resolve, that every skill keeps its contract, and that the linking script makes and repairs its links.

## License

MIT
