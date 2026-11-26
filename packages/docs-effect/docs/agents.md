# Give Agents the Skills

A coding agent needs different things from a person: which package and which export, the order that must not change, and what is not guaranteed. This documentation is written to serve both, and a skill is how an agent finds the right page.

Each skill is a name, a description that says when it applies, and a pointer to one page of this documentation. An agent's harness shows the agent every description, and the agent reads the page when its task matches. The page is the single place the rules are written, so a person and an agent read the same text.

| Skill | Leads to |
|---|---|
| `pi-effect` | [How pi-effect Works](how-it-works.md) and [Packages](packages.md) |
| `pi-effect-thread` | [Build an Agent Thread](threads.md) and [Thread Recipes](thread-recipes.md) |
| `pi-effect-rivet` | [Host Threads in Rivet Actors](rivet.md) |
| `pi-effect-extending` | [Write Tools, Hooks, and Plugins](extending.md) |
| `pi-effect-testing` | [Test Without a Network](testing.md) |
| `pi-effect-contributing` | [Work in the Repository](contributing.md) |
| `pi-effect-upstream-sync` | [Keep Up with Pi](upstream-sync.md) |

The skills follow the [Agent Skills specification](https://agentskills.io/specification): a directory with a `SKILL.md` whose frontmatter holds `name` and `description`.

## Link the skills into a project

A harness finds a skill only where it looks. This links every skill into a project's `.claude/skills` and `.agents/skills`:

```sh
node vendor/pi-effect/docs-effect/bin/link-skills.mjs .              # in a product that vendors the packages
node packages/docs-effect/bin/link-skills.mjs . .claude/skills       # in the pi-effect repository
```

- A product gets the five skills for building on the packages. The two for work inside the pi-effect repository are linked only into that repository.
- The links are relative, so they hold in every checkout. Run the script again after the packages move: a link that points elsewhere is replaced.
- A directory of the same name that is no link is the project's own. The script leaves it alone and exits with code 1.

## Use the skills from Pi

Pi's coding agent reads a project's `.agents/skills`, so the links above are enough for Pi too.

The package also declares its skills under the `pi` key of its manifest, as a Pi package does. `pi install <path to docs-effect>` adds them for one user without linking, and `pi install -l <path to docs-effect>` writes the declaration into the project's `.pi/settings.json`.

## Start from the index

An agent that reads a site before anything else can start from `llms.txt`, which the build writes beside the pages: every page, every package and every skill, one line each, with a link to its Markdown.

## How a page stays true

A page that is wrong is worse than none, since an agent acts on it without checking. The test of `docs-effect` holds every page and every skill to a contract, and the gate fails when one breaks it:

- Every page is listed in `docs.json`, and every relative link leads to a page, a package's README or a skill that exists, with an anchor that is a heading there.
- Every package and entry point named is one of the library's.
- Every TypeScript example is a contiguous excerpt of an example in a package's README, which that package's test runs. An example written only here would be run by nothing.

So a README example that changes fails the test until the page that quotes it follows.
