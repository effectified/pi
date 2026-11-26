# pi-effect

pi-effect puts Pi's durable agent harness into Effect 4.1. It adds what a product otherwise writes by hand around an agent loop: what a thread may call, what it may spend, which model serves it, what is recorded, and who reads the answer before it stands.

One call works an agent thread to its end. A process that is killed on the way picks the thread up where it stopped. Nothing in the packages knows a product: tools, policies and prices come from the product as data, and its lease, its sinks and its inbox as services.

## Start using pi-effect

New to the packages? Follow the [Quickstart](quickstart.md) to get them into a product and work a first thread.

If the packages are already in your product, choose what you want to do:

- [Build an agent thread](threads.md) that is guarded, budgeted, routed, recorded and reviewed, and follow the [thread recipes](thread-recipes.md) to change one.
- [Host threads in Rivet actors](rivet.md), one actor per thread, with a local engine for development.
- [Write tools, hooks, and plugins](extending.md) on the durable harness.
- [Test without a network](testing.md), on scripted models, on Node and on Bun.
- [Understand how pi-effect works](how-it-works.md): the kinds of package, what a product supplies, and what Pi Durable gives and withholds.

## Find a package

[Packages](packages.md) lists every package with what each is for and its entry points. Each package's README is its reference, and the examples in it are run by the package's own tests.

## Work with coding agents

[Give Agents the Skills](agents.md) links the skills of this documentation into a project, so a coding agent's harness offers the right page for the task at hand.

## Maintain the library

- [Work in the repository](contributing.md): the fork's boundary, the one gate command, and what each of its failures means.
- [Keep up with Pi](upstream-sync.md): move the packages to a new Pi version, and read what changed under them.

## Know the limits

Every test runs on scripted models, and for the Rivet host on a real local engine. No real model provider has been run yet. What the composition does not do, and what needs a change in Pi itself, is listed under [Gaps](../../thread-effect/README.md#gaps). What a product inherits from all the packages at once is under [Limits the packages document, which a product inherits](../../thread-effect/README.md#limits-the-packages-document-which-a-product-inherits).
