---
name: pi-effect-testing
description: Tests code built on the pi-effect packages with no network and no provider key, on Node and on Bun. Covers the scripted models and helpers of @effectified/pi-ai/testing (ScriptedModels, ScriptedLanguageModel, runTest, runLive, conditions) and the test harness of @effectified/pi-durable/testing (TestHarness.layer, TestHarness.layerWith, TestHarness.sqlStorage, answer, toolCall, held), TestClock instead of real waits, fakes of product ports (Lease, RecordSink, OutcomeSink, Approvals.Inbox), close-and-reopen and crash tests on a SQLite file with @effect/sql-sqlite-node and @effect/sql-sqlite-bun, a hook or a tool that must be asked again after a restart, engine tests of Rivet actors with @effectified/pi-durable-rivet/testing (observed, hosted, sleep, seen, schedules), why @effect/vitest is not used, and what no test here proves. Use it when writing or fixing a test of a tool, hook, task, plugin, thread composition or actor built on these packages.
---

# Tests without a network

Read [Test Without a Network](../../docs/testing.md) in full before you write or change code. It says which scripted model, harness and runner to use, and how to test a restart and an actor.

Follow it as written: the page is the one place these rules are kept, for people and for agents, and it is
checked against the packages. Its code is code a package's test runs, and its links lead into the READMEs, which are
the reference.

Every other page of the documentation is listed in [the overview](../../docs/index.md).
