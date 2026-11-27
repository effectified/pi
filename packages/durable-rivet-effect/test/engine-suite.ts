// Test helper: the host against a real Rivet engine, registered once per runtime by engine.node.test.ts and
// engine.bun.test.ts. It starts the engine binary of rivetkit's platform package on a free port with a temporary data
// directory (the runtime's local-engine entry), hosts the actors of agent.ts in the test's process, and stops and
// removes all of it afterwards. Skipped when the binary is not installed. Models are scripted: nothing leaves the
// machine. One suite for every engine test, because one process hosts one local engine at a time.
//
// Not testable here: an actor process that dies, whose actors must not share the test's process (thread-effect's
// hosts-suite.ts kills one). Not testable, and not tested: an
// engine that refuses forks (`actor.fork_unavailable`), a schedule write Rivet refuses, and remote (wasm) SQLite, where `onFork` is not atomic.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createExpectAssertions, createStorageConformance } from "@earendil-works/pi-durable/testing";
import { type Context, Effect, Exit, Option, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "../src/index.ts";
import type * as LocalEngine from "../src/node.ts";
import * as Testing from "../src/testing/index.ts";
import { Agent, configured, gate, Napper, PARK_MILLIS, Refused, raw } from "./agent.ts";

const TestAgent = Testing.observed(Agent);
const TestNapper = Testing.observed(Napper);
const Raw = { name: "raw", actions: {}, rivet: raw(expect) };

/** How many forks may lie behind an actor: the engine's `max_depth` in rivetkit 3.1.1. */
const ENGINE_FORK_DEPTH = 16;

/** Registers the suite on the local engine of one runtime: `src/node.ts` or `src/bun.ts`. */
export function registerEngineSuite(runtime: string, engines: typeof LocalEngine): void {
	const available = Effect.runSync(engines.available);
	if (!available) {
		console.warn(
			`Skipping the engine suite: no Rivet engine binary. Install @rivetkit/engine-cli-${process.platform}-${process.arch} or set RIVET_ENGINE_BINARY_PATH.`,
		);
	}
	describe.skipIf(!available)(`a harness in a Rivet actor, on a local engine (${runtime})`, () => suite(engines));
}

function suite(engines: typeof LocalEngine): void {
	const scope = Scope.makeUnsafe();
	let context: Context.Context<Client.RivetClient>;

	beforeAll(async () => {
		const hosted = await Effect.runPromise(
			Testing.hosted(engines.serve, {
				actors: [TestAgent, TestNapper, Raw],
				logging: { level: "error" },
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		);
		context = hosted.context;
	}, 60_000);

	afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)), 60_000);

	const run = <A, E>(effect: Effect.Effect<A, E, Client.RivetClient>): Promise<A> =>
		Effect.runPromise(Effect.provideContext(effect, context));

	/** A test-only action of agent.ts, which no schema describes. */
	const rawAction = <A>(handle: Client.Handle, name: string): Effect.Effect<A, never, Client.RivetClient> =>
		Client.RivetClient.use((client) =>
			Effect.promise(() =>
				client.getForId(handle.definition.name, handle.actorId).action<[], A>({ name, args: [] }),
			),
		);

	/** The wake actions Rivet has scheduled for the actor. */
	const wakes = (handle: Client.Handle) =>
		Effect.map(Testing.schedules(handle), (scheduled) =>
			scheduled.filter((event) => event.action === "pi.wake").map((event) => event.runAt),
		);

	const eventsOf = (handle: Client.Handle): ReadonlyArray<Testing.Lifecycle> =>
		Effect.runSync(Testing.lifecycle(handle));

	/** Waits, without calling the actor, until its hooks recorded `event` `times` times. */
	const seen = (handle: Client.Handle, event: Testing.Lifecycle, times = 1): Promise<void> =>
		Effect.runPromise(Testing.seen(handle, event, times));

	it("keeps the engine's data in its own temporary directory", () => {
		// rivetkit's native core read the variable: without it the data is in a directory under the user's home.
		const directory = process.env.RIVETKIT_STORAGE_PATH ?? "";
		expect(directory).toContain("pi-durable-rivet-");
		expect(existsSync(join(directory, ".rivetkit"))).toBe(true);
	});

	it("prompts the root conversation in an action and returns the scripted answer", async () => {
		const transcript = await run(
			Effect.gen(function* () {
				const agent = yield* Client.getOrCreate(TestAgent, ["prompt"]);
				return yield* Client.call(agent, "ask", { text: "hello", requestId: "first" });
			}),
		);
		expect(transcript).toEqual(["user: hello", "assistant: answer 1: hello"]);
	}, 30_000);

	it("keeps the transcript across a sleep and a wake of the actor", async () => {
		const agent = await run(Client.getOrCreate(TestAgent, ["sleeper"]));
		const before = await run(Client.call(agent, "ask", { text: "remember", requestId: "first" }));
		// Rivet's own forced sleep (`c.sleep()`): the harness and its scope close in `onSleep`.
		await run(Testing.sleep(agent));
		await seen(agent, "sleep");
		expect(eventsOf(agent)).toEqual(["wake", "sleep"]);
		// The next call wakes the actor, which opens the harness again on the same SQLite.
		const after = await run(Client.call(agent, "transcript", null));
		expect(after).toEqual(before);
		expect(eventsOf(agent)).toEqual(["wake", "sleep", "wake"]);
		const more = await run(Client.call(agent, "ask", { text: "again", requestId: "second" }));
		expect(more).toEqual([...before, "user: again", "assistant: answer 2: again"]);
		expect(await run(Client.isIdle(agent))).toBe(true);
		expect(await run(wakes(agent))).toEqual([]);
	}, 30_000);

	it(
		"wakes a sleeping actor for a parked call through the one scheduled wake action",
		async () => {
			const agent = await run(Client.getOrCreate(TestAgent, ["parked"]));
			await run(Client.call(agent, "submit", { text: "slow one", requestId: "first" }));
			// While the run is active a recovery wake is kept; once the call parks, the wake is at the park's time.
			expect(await run(wakes(agent))).toHaveLength(1);
			const parked = await run(
				Effect.repeat(Client.status(agent), { until: (status) => !status.active && status.at !== null }),
			);
			expect({ tasks: parked.tasks > 0, active: parked.active }).toEqual({ tasks: true, active: false });
			expect(await run(wakes(agent))).toEqual([parked.at]);
			expect(await run(Client.isIdle(agent))).toBe(false);

			// Asleep, with no caller: only the scheduled action can bring the actor back, PARK_MILLIS after the park.
			await run(Testing.sleep(agent));
			await seen(agent, "sleep");
			// The wake is what is promised, not `fired`: the open harness resumes the work whose time has come, and the
			// keeper of the wake that causes may replace the due one before Rivet runs its action (on a slow machine).
			await Effect.runPromise(Testing.seen(agent, "wake", 2));
			expect(Date.now()).toBeGreaterThanOrEqual(parked.at ?? Number.POSITIVE_INFINITY);
			expect(eventsOf(agent).slice(0, 3)).toEqual(["wake", "sleep", "wake"]);

			await run(Client.waitForIdle(agent));
			expect(await run(Client.call(agent, "transcript", null))).toEqual([
				"user: slow one",
				"assistant: ",
				"toolResult: done slow one",
				"assistant: the tool said: done slow one",
			]);
			expect(await run(wakes(agent))).toEqual([]);
		},
		PARK_MILLIS + 40_000,
	);

	it("stays awake under a running model request, and sleeps by itself once nothing is active", async () => {
		const napper = await run(Client.getOrCreate(TestNapper, ["awake"]));
		const model = gate("awake");
		await run(Client.call(napper, "submit", { text: "hold awake", requestId: "first" }));
		await model.requested;
		// No call reaches the actor for more than twice its idle time of one second: only the keeper holds it awake.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(eventsOf(napper)).toEqual(["wake"]);
		model.release();
		await run(Client.waitForIdle(napper));
		// Nothing is active and nothing is scheduled: Rivet puts the actor to sleep after its idle time.
		await seen(napper, "sleep");
		expect(eventsOf(napper)).toEqual(["wake", "sleep"]);
		expect(await run(Client.call(napper, "transcript", null))).toEqual([
			"user: hold awake",
			"assistant: answer 1: hold awake",
		]);
	}, 60_000);

	it("refuses to fork a busy actor, and forks it once it is idle", async () => {
		const agent = await run(Client.getOrCreate(TestAgent, ["busy"]));
		const model = gate("on");
		await run(Client.call(agent, "submit", { text: "hold on", requestId: "first" }));
		await model.requested;
		const refused = await run(Effect.flip(Client.fork(agent, { key: ["busy-fork"] })));
		expect(refused._tag).toBe("NotIdle");
		expect(refused).toMatchObject({ actorId: agent.actorId, tasks: 1, submissions: 1 });
		expect(Option.isNone(await run(Client.find(TestAgent, ["busy-fork"])))).toBe(true);

		model.release();
		await run(Client.waitForIdle(agent));
		const fork = await run(Client.fork(agent, { key: ["busy-fork"] }));
		expect(await run(Client.call(fork, "transcript", null))).toEqual([
			"user: hold on",
			"assistant: answer 1: hold on",
		]);
	}, 60_000);

	it("forks an actor whose only live work is a background task of the product, and refuses another live task", async () => {
		const agent = await run(Client.getOrCreate(TestAgent, ["lingering"]));
		const primed = await run(Client.call(agent, "ask", { text: "one", requestId: "first" }));
		await run(Client.call(agent, "linger", { background: true }));
		const asleep = await run(Effect.repeat(Client.status(agent), { until: (status) => !status.active }));
		expect(asleep).toMatchObject({ tasks: 1, background: 1, submissions: 0 });
		// Live work, so the harness is not idle; nothing in flight, so it is forked.
		expect(await run(Client.isIdle(agent))).toBe(false);
		const fork = await run(Client.fork(agent, { key: ["lingering-fork"] }));
		expect(await run(Client.call(fork, "transcript", null))).toEqual(primed);
		// The copy holds the task live: ending or adopting it is the product's fork hygiene.
		expect(await run(Client.status(fork))).toMatchObject({ tasks: 1, background: 1, submissions: 0 });

		// The same task, not background, is work in flight.
		await run(Client.call(agent, "linger", { background: false }));
		const refused = await run(Effect.flip(Client.fork(agent, { key: ["lingering-refused"] })));
		expect(refused).toMatchObject({ _tag: "NotIdle", actorId: agent.actorId, tasks: 2, submissions: 0 });
		expect(Option.isNone(await run(Client.find(TestAgent, ["lingering-refused"])))).toBe(true);
	}, 60_000);

	it("forks an idle actor into one that sees the transcript, continues alone and starts clean", async () => {
		const parent = await run(Client.getOrCreate(TestAgent, ["parent"]));
		const primed = await run(Client.call(parent, "ask", { text: "one", requestId: "first" }));
		expect(primed).toEqual(["user: one", "assistant: answer 1: one"]);
		// A schedule in the source when it is forked: the copy must not keep it.
		await run(Testing.scheduleWake(parent, 60_000));
		expect(await run(wakes(parent))).toHaveLength(1);

		const fork = await run(Client.fork(parent, { key: ["child"], input: { job: 7 } }));
		expect(fork.actorId).not.toBe(parent.actorId);
		// The fork's first call: each hygiene step ran once, in order, with the fork's input, before it.
		expect(await run(Client.call(fork, "hygiene", null))).toEqual(['first {"job":7}', 'second {"job":7}']);
		expect(await run(wakes(fork))).toEqual([]);
		expect(await run(Client.call(fork, "transcript", null))).toEqual(primed);
		expect(await run(Client.call(fork, "ask", { text: "two", requestId: "second" }))).toEqual([
			...primed,
			"user: two",
			"assistant: answer 2: two",
		]);

		// The source is as it was: its transcript, its schedule, and no hygiene.
		expect(await run(Client.call(parent, "transcript", null))).toEqual(primed);
		expect(await run(Client.call(parent, "hygiene", null))).toEqual([]);
		expect(await run(wakes(parent))).toHaveLength(1);

		const lineage = await run(Client.lineage(fork));
		expect(lineage.chain.map((link) => [link.actorId, link.key])).toEqual([[parent.actorId, ["parent"]]]);
		expect(lineage.input).toEqual(Option.some({ job: 7 }));
		expect(await run(Client.call(fork, "lineage", null))).toEqual({
			sources: [parent.actorId],
			input: Option.some({ job: 7 }),
		});
		expect(await run(Client.lineage(parent))).toEqual({ chain: [], input: Option.none() });
	}, 60_000);

	it("gives the same actor for the same fork key, and refuses a key another actor holds", async () => {
		const parent = await run(Client.getOrCreate(TestAgent, ["parent"]));
		const first = await run(Client.fork(parent, { key: ["twice"], input: "a" }));
		const second = await run(Client.fork(parent, { key: ["twice"], input: "b" }));
		expect(second.actorId).toBe(first.actorId);
		expect(await run(Client.call(second, "hygiene", null))).toEqual(['first "a"', 'second "a"']);

		// A fork of a fork inherits the record of its source's hygiene, and still runs its own.
		const grandchild = await run(Client.fork(first, { key: ["grandchild"] }));
		expect(await run(Client.call(grandchild, "hygiene", null))).toEqual([
			'first "a"',
			'second "a"',
			"first null",
			"second null",
		]);
		expect((await run(Client.lineage(grandchild))).chain.map((link) => link.actorId)).toEqual([
			parent.actorId,
			first.actorId,
		]);

		const plain = await run(Client.getOrCreate(TestAgent, ["plain"]));
		const held = await run(Effect.flip(Client.fork(parent, { key: ["plain"] })));
		expect(held).toMatchObject({ _tag: "ForkKeyHeld", key: ["plain"], heldBy: plain.actorId });
	}, 60_000);

	it("destroys an actor once, and answers the same for one that is gone", async () => {
		const agent = await run(Client.getOrCreate(TestAgent, ["doomed"]));
		await run(Client.call(agent, "ask", { text: "bye", requestId: "first" }));
		const destroyed = await run(Client.destroy(agent));
		expect(destroyed.existed).toBe(true);
		expect(Option.getOrThrow(destroyed.databaseBytes)).toBeGreaterThan(0);
		await seen(agent, "destroy");
		expect(await run(Client.destroy(agent))).toEqual({ existed: false, databaseBytes: Option.none() });
		expect(await run(Effect.flip(Client.call(agent, "transcript", null)))).toMatchObject({
			_tag: "ActorGone",
			actor: "agent",
			actorId: agent.actorId,
		});
		expect(Option.isNone(await run(Client.find(TestAgent, ["doomed"])))).toBe(true);
	}, 30_000);

	it("makes the harness options from a service of the layer, at each wake", async () => {
		const agent = await run(Client.getOrCreate(TestAgent, ["configured"]));
		const of = () =>
			configured.filter((entry) => entry.startsWith(`${agent.actorId}:`)).map((entry) => entry.split(":")[1]);
		await run(Client.call(agent, "ask", { text: "hello", requestId: "first" }));
		// The options were made once `layer` was built, and are the ones the harness runs with.
		expect(of()).toEqual(["options from the test product", "conversation"]);
		await run(Testing.sleep(agent));
		await seen(agent, "sleep");
		await run(Client.call(agent, "transcript", null));
		expect(of()).toEqual(["options from the test product", "conversation", "options from the test product"]);
	}, 30_000);

	it("works with actors from inside an actor: its own handle and a sibling by key, on its own client", async () => {
		const other = await run(Client.getOrCreate(TestAgent, ["inside-other"]));
		const agent = await run(Client.getOrCreate(TestAgent, ["inside"]));
		expect(await run(Client.call(agent, "inside", { sibling: ["inside-other"] }))).toEqual({
			own: agent.actorId,
			key: ["inside"],
			sources: 0,
			sibling: Option.some(other.actorId),
		});
		expect((await run(Client.call(agent, "inside", { sibling: ["nobody"] }))).sibling).toEqual(Option.none());
		// A fork finds itself, and its source behind it.
		await run(Client.waitForIdle(agent));
		const fork = await run(Client.fork(agent, { key: ["inside-fork"] }));
		expect(await run(Client.call(fork, "inside", { sibling: ["inside"] }))).toEqual({
			own: fork.actorId,
			key: ["inside-fork"],
			sources: 1,
			sibling: Option.some(agent.actorId),
		});
	}, 60_000);

	it("forks of forks go 16 deep, and the next fork fails with the host's own error, at once and leaving nothing", async () => {
		const root = await run(Client.getOrCreate(TestAgent, ["deep"]));
		let deepest = root;
		const primed = await run(Client.call(root, "ask", { text: "one", requestId: "first" }));
		for (let depth = 1; depth <= ENGINE_FORK_DEPTH; depth++) {
			await run(Client.waitForIdle(deepest));
			deepest = await run(Client.fork(deepest, { key: ["deep", String(depth)] }));
		}
		// The deepest fork is a whole actor: it has every fork behind it, sees the transcript and works.
		expect((await run(Client.lineage(deepest))).chain).toHaveLength(ENGINE_FORK_DEPTH);
		expect(await run(Client.call(deepest, "transcript", null))).toEqual(primed);
		const key = ["deep", "over"];
		const refused = await run(Effect.flip(Effect.timeout(Client.fork(deepest, { key }), "10 seconds")));
		expect(refused).toMatchObject({
			_tag: "ForkTooDeep",
			actor: "agent",
			actorId: deepest.actorId,
			reason: "The actor's database is already 16 forks deep.",
		});
		expect(Option.isNone(await run(Client.find(TestAgent, key)))).toBe(true);
		// Asked again it says the same, and the actor goes on working.
		expect(await run(Effect.flip(Client.fork(deepest, { key })))).toEqual(refused);
		expect(await run(Client.call(deepest, "ask", { text: "two", requestId: "second" }))).toEqual([
			...primed,
			"user: two",
			"assistant: answer 2: two",
		]);
		// The limit is the copy's depth, not the source's count: the root is forked as often as before.
		const sibling = await run(Client.fork(root, { key: ["deep", "sibling"] }));
		expect((await run(Client.lineage(sibling))).chain).toHaveLength(1);
	}, 90_000);

	it("carries an action's own failure and a defect across as typed errors", async () => {
		const agent = await run(Client.getOrCreate(TestAgent, ["errors"]));
		const failed = await run(Effect.flip(Client.call(agent, "refuse", { reason: "not today" })));
		expect(failed._tag).toBe("ActionFailed");
		expect(failed).toMatchObject({ action: "refuse", error: new Refused({ reason: "not today" }) });
		expect(await run(Effect.flip(Client.call(agent, "crash", null)))).toMatchObject({
			_tag: "ActorDefect",
			action: "crash",
			message: "the handler broke",
		});
	}, 30_000);

	it("passes Pi's storage conformance suite on a real actor database", async () => {
		const handle = await run(Client.getOrCreate(Raw, ["conformance"]));
		const result = await run(
			rawAction<{ readonly cases: number; readonly failures: ReadonlyArray<string> }>(handle, "conformance"),
		);
		// Every case of the suite ran in the actor: as many as the suite has here.
		const suite = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: () => Promise.resolve(),
		});
		expect(result).toEqual({ cases: suite.length, failures: [] });
		expect(suite.length).toBeGreaterThan(0);
	}, 120_000);

	it("passes Pi's storage conformance suite through Storage.sql over ActorSql, on a real actor database", async () => {
		const handle = await run(Client.getOrCreate(Raw, ["conformance-sql"]));
		const result = await run(
			rawAction<{ readonly cases: number; readonly failures: ReadonlyArray<string> }>(handle, "conformanceSql"),
		);
		const suite = createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: () => Promise.resolve(),
		});
		expect(result).toEqual({ cases: suite.length, failures: [] });
	}, 120_000);

	it("commits, rolls back, nests and rolls back an interrupted transaction of ActorSql, on a real actor database", async () => {
		const handle = await run(Client.getOrCreate(Raw, ["sql-transactions"]));
		expect(await run(rawAction(handle, "sqlTransactions"))).toEqual({
			failed: "the body failed",
			rows: ["committed", "outer", "adapter"],
		});
	}, 30_000);

	it("holds other statements while a transaction runs, counts rows and rolls back, on a real actor database", async () => {
		const handle = await run(Client.getOrCreate(Raw, ["transactions"]));
		expect(await run(rawAction(handle, "transactions"))).toEqual({
			whileOpen: [],
			found: ["inside", "outside"],
			counted: 2,
			countedOnDatabase: 1,
			sameError: true,
			late: "rejected",
			rows: ["inside!"],
		});
	}, 30_000);
}
