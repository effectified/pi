# Quickstart

Get the packages into a product, compose one agent thread, and work it to its outcome.

## Get the packages

The packages are not published to npm. A product keeps them as built workspace packages, written by a script of the pi-effect repository:

```sh
node effect/scripts/vendor.ts <a directory of your product>
```

Run it in a checkout of pi-effect in which upstream's `npm run build` has run once. It builds every package and writes each into the directory with its built output, its README and a manifest whose pi-effect dependencies are `workspace:*`. `SOURCE.json` beside them records the commit and the Pi version they were built on.

Then, in the product:

1. Add the directory to the product's workspaces.
2. Depend on `@effectified/pi-thread` as `workspace:*`, and on each plugin whose port the product implements.
3. Install `effect` in the range the packages name as their peer, and the Pi packages at the exact version `SOURCE.json` names.

The script refuses when the packages' Pi pins are not the Pi sources in the tree, since it makes what a product installs. [Packages](packages.md#installing-in-a-product) says what each package needs beside it.

## Compose a thread

A thread is built from one `Layer`. The product gives it data and ports:

- **Data**: its tools as extensions, the guard's policy, the approval policy, the providers and the route table with its prices, the review policy, its subagents and swarms.
- **Ports**: a lease, a record sink, an outcome sink and an inbox for approvals, as services of the product.
- **Storage**: an Effect SQLite client. Memory storage cannot be reopened, so a product keeps a file.

[Build an Agent Thread](threads.md#wiring-it) has the whole example and says what each port is called with.

## Work a thread

One call creates the conversation with its grant, its cap and its routing limits, admits the task, and gives the outcome:

```ts
const outcome = Threads.Threads.use((threads) =>
	threads.work({
		thread: "thread-42", // the product's key, and the idempotency key
		task: "What is record 42 called?",
		model: { provider: "router", modelId: "author" },
		grant: { tools: ["lookup"], classification: "internal" },
		cap: 1_000_000n, // micro units of the lease this thread may settle
		routing: { regions: ["eu"], requires: ["zero-data-retention"] }, // optional
		review: true, // optional; false ends an answered thread `Answered`, unreviewed
	}),
).pipe(Effect.provide(live));
```

`thread` is the product's key and the idempotency key: a second call with the same key finds the thread and starts nothing. Build the `Layer` once per process and run every call through it.

## Read the outcome

The outcome is one of `Reviewed`, `Answered`, `NotReviewed`, `Held`, `ReviewDeferred`, `BudgetStopped`, `Errored` and `Cancelled`. Treat only `Reviewed` as a reviewed answer. [Calling a thread](threads.md#calling-a-thread) says what a product does after each.

A product does not have to wait for the call. Its outcome sink is told that work started and every outcome the thread reaches, at least once and in order: [Outcomes are delivered](threads.md#outcomes-are-delivered).

## Test it without a network

Scripted models answer in place of a provider, and a test moves time itself, so a suite needs no key and no wait. [Test Without a Network](testing.md) shows the harness, the fakes of the ports, and a restart on a SQLite file.

## Next steps

- [Thread Recipes](thread-recipes.md): add a tool, ask a person for approval, continue a thread the budget stopped.
- [Host Threads in Rivet Actors](rivet.md): one actor per thread, and a local engine for development.
- [Write Tools, Hooks, and Plugins](extending.md): what a hook can and cannot do, and tools that are safe to run again.
- [How pi-effect Works](how-it-works.md): the kinds of package and the rules that hold in all of them.
