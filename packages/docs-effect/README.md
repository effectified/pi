# @gunta/pi-docs-effect

The documentation of the pi-effect packages, kept the way Pi keeps its own: a directory of Markdown pages and a catalog, `docs/docs.json`, whose navigation names every page. It holds no library code, is private, and is never published.

| For | What | Where |
|---|---|---|
| People and agents | The pages: an overview, a quickstart, how the library works, guides by task, and the packages | `docs/*.md`, listed in `docs/docs.json` |
| People | The pages as a site, with a landing page and every package's README as a page | `dist/index.html`, built |
| Agents | Skills, each a pointer from a task to a page | `skills/<name>/SKILL.md` |
| Agents | An index of every page, package and skill, one line each (`llms.txt`) | `dist/llms.txt`, built |

## The same system as Pi's documentation

Upstream keeps its documentation in `packages/coding-agent/docs`: Markdown pages, and `docs.json` with a `navigation` of groups, each entry a `title` with a `path`, further `items`, or both. Its test `packages/coding-agent/test/documentation.test.ts` holds the catalog to rules. This package keeps the same files and the same rules (`src/node/catalog.ts`), so these pages could be put beside Pi's without a change:

- The catalog has no field upstream's does not have, and a page's path is relative, normalized, inside the directory and ends in `.md`.
- No page is named twice, every page named exists, and no two pages have one public address.
- Every local Markdown link of a page leads to a file.
- No page is orphaned: each is named by the navigation or linked from a page that is.

The navigation has upstream's three groups: Get Started, Guides and Reference. As in upstream, a library's reference is its README: the page [Packages](docs/packages.md) lists all fifteen and links each one's.

The skills follow the [Agent Skills specification](https://agentskills.io/specification), which Pi reads, and the manifest declares them under its `pi` key, as a Pi package does.

## Read it

Start at [docs/index.md](docs/index.md). Every page is plain Markdown and reads on a repository host as it is.

For the site:

```sh
npm run build --workspace packages/docs-effect
open packages/docs-effect/dist/index.html
```

`dist` is not committed. The site's navigation is the catalog's, and its landing page is made from the tree: the packages, their kinds and descriptions come from the manifests, the test counts and runtimes from `effect/COMPAT.md`, and the example from the composition's README, where a test runs it. A page opens from a file: its stylesheet is written into it, and it loads nothing.

What is written by hand for the landing page is in `src/content.ts`: each package's role in one sentence, and what the composition rules out. A package without a role fails the build, so a new package cannot be left off.

## One text for people and agents

A page is the single place a rule is written. A skill does not repeat it: it is a name, a description that says when it applies, and a pointer to the page.

| Skill | Leads to |
|---|---|
| `pi-effect` | How pi-effect Works, Packages |
| `pi-effect-thread` | Build an Agent Thread, Thread Recipes |
| `pi-effect-rivet` | Host Threads in Rivet Actors |
| `pi-effect-extending` | Write Tools, Hooks, and Plugins |
| `pi-effect-testing` | Test Without a Network |
| `pi-effect-contributing` | Work in the Repository |
| `pi-effect-upstream-sync` | Keep Up with Pi |

[Give Agents the Skills](docs/agents.md) says how a project links them, and how Pi finds them.

## The contract

A page that is wrong is worse than none, since an agent acts on it without checking. So the test of this package holds every page and every skill to a contract (`src/node/contract.ts`), and the gate fails when one breaks it:

- Every relative link leads to a page, to a package's README or to a file of the skills, the file exists, and the anchor is a heading there. So a page reads the same in a product, where the packages are built and have no `src`.
- Every package and entry point named is one of the library's.
- Every `ts` code block is a contiguous excerpt of a code block of a package's README. Those examples are run by each package's `test/readme.test.ts`; code written into a page would be run by nothing.
- Every path of this repository named in backticks exists.
- A skill's frontmatter is `name`, equal to its directory, and `description`, one line of at most 1,024 characters.

So a README example that changes fails this package's test until the page that quotes it follows.

## In a product

`node effect/scripts/vendor.ts <directory>` writes this package beside the others: its `docs`, its `skills`, its `bin`, its built `dist` and this README. Every link of a page and of a skill is relative and holds there.

## Tests

```sh
node ../../node_modules/vitest/dist/cli.js --run
bun test --conditions=source
```

They check the catalog against upstream's rules and show each rule a catalog that breaks it, hold every page and skill to the contract, build the site in memory and follow every link of it, and run the script that links the skills.

## License

MIT
