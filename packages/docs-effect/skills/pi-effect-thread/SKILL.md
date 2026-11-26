---
name: pi-effect-thread
description: Builds, extends or debugs an agent thread in one process with @gunta/pi-thread-effect, the composition of every pi-effect plugin. Covers Composition.open and its Config (extensions, guard policy, approvals, providers and route table, review policy and checks, subagents, swarms), the ports a product must provide (Lease, Estimator, Prices from priceRows, RecordSink, OutcomeSink, Approvals.Inbox, PiTelemetry, HarnessStorage) and what each is called with, Threads.work, admit, takeOn, resume, decide, release, cancel and the Outcome union, OutcomeEvent delivery, records, money (cap, lease, prices written once), review and held answers, tools that need a person's approval, subagents, swarms on a thread, the order of extensions and model layers, idempotency by the thread key, what is stored and the limits a product inherits. Use it when wiring a product's agent thread, adding a tool, port, subagent or swarm to it, or replacing a hand-written agent loop.
---

# An agent thread in a product

Read [Build an Agent Thread](../../docs/threads.md) and [Thread Recipes](../../docs/thread-recipes.md) in full before you write or change code. The first says how a thread is wired, what each port is called with, and what each outcome means. The second is the changes a product makes to a thread, step by step.

Follow them as written: these pages are the one place these rules are kept, for people and for agents, and they
are checked against the packages. Their code is code a package's test runs, and their links lead into the READMEs,
which are the reference.

Every other page of the documentation is listed in [the overview](../../docs/index.md).
