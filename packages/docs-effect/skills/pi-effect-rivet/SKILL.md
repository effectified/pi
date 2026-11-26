---
name: pi-effect-rivet
description: Hosts agent threads or a bare Pi Durable harness in Rivet actors with @effectified/pi-thread/rivet (ThreadActor.make, Remote, product actions, SwarmId) and @effectified/pi-durable-rivet (Actor.make, Action.make, Client, Host.serve, Self, ActorSql, ActorInfo). Covers the fixed actions and the client's three error kinds, a local engine from the /node or /bun entry (LocalEngine.serve with a temporary or a kept directory, several engines, Host.holdBackExit), host processes that are killed and come back, wake-ups and what is promised about them, actor forks and fork hygiene (onStorageFork, forkHygiene, NotIdle, ForkTooDeep), the actor's database (ActorSql, and ActorDatabase as the deprecated promise form), what runs locally and what needs a Rivet deployment, and the limits. Use it when putting threads or a harness into actors, calling them from a product, running a local engine on Node or Bun, surviving a process kill, or forking an actor.
---

# Threads and harnesses in Rivet actors

Read [Host Threads in Rivet Actors](../../docs/rivet.md) in full before you write or change code. It says what changes when a thread runs in an actor: the client, a local engine, wake-ups, forks, the actor's database, and the limits.

Follow it as written: the page is the one place these rules are kept, for people and for agents, and it is
checked against the packages. Its code is code a package's test runs, and its links lead into the READMEs, which are
the reference.

Every other page of the documentation is listed in [the overview](../../docs/index.md).
