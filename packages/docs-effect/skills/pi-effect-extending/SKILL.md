---
name: pi-effect-extending
description: Writes tools, hooks, gates, signals, durable tasks, stored documents and entries, or a whole plugin on @gunta/pi-durable-effect, the Effect 4.1 facade of Pi Durable. Covers Tool.make (handler, api, replay safe or unsafe, Tool.result, Tool.error, Tool.sleep, Tool.wait), Hook constructors and what a hook can and cannot do, Gate.allow, block, rewrite and park, Signal.make and Harness.signal, Task.make with phases and steps, Doc.make, Doc.family, Entry.make, commits (Harness.commit, api.commit, tx) and the rule that table reads come before the first table write, memos with a candidate, Extension.make and Registry.layer and the order of extensions, ports as Context.Service, kinds prefixed by the plugin, what a conversation fork and a storage copy carry (onStorageFork), and deriving types from Pi instead of restating them. Use it when adding a tool or hook to an agent, making a tool safe to run again after a crash, storing plugin state, or writing a new pi-effect plugin.
---

# Tools, hooks and plugins

Read [Write Tools, Hooks, and Plugins](../../docs/extending.md) in full before you write or change code. It says which part of the durable harness to use, what a hook can and cannot do, and how a tool stays safe to run again.

Follow it as written: the page is the one place these rules are kept, for people and for agents, and it is
checked against the packages. Its code is code a package's test runs, and its links lead into the READMEs, which are
the reference.

Every other page of the documentation is listed in [the overview](../../docs/index.md).
