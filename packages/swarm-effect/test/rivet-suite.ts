// Test helper: swarms on Rivet actor forks, against a real Rivet engine, registered once per runtime by
// rivet.node.test.ts and rivet.bun.test.ts. The engine is the one of the host's local-engine entry: the binary of
// rivetkit's platform package, on a free port, with its data in a temporary directory, removed afterwards. Skipped
// when the binary is not installed. Models are scripted: nothing leaves the machine. One suite for every engine
// test, because one process hosts one local engine at a time.
//
// Not testable here, and not tested: an engine that refuses a fork for now or cannot be reached, a call that times out,
// and a fork whose hygiene ran twice.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@effectified/pi-durable-rivet";
import type * as LocalEngine from "@effectified/pi-durable-rivet/node";
import * as Testing from "@effectified/pi-durable-rivet/testing";
import { type Context, Effect, Exit, Option, Schedule, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import * as Rivet from "../src/rivet.ts";
import { Careless, counts, delays, forked, hold, holdSource, Swarmer, setups } from "./rivet-agent.ts";
import { measured, words } from "./support.ts";

// The host's testing entry: the actor with Rivet's forced sleep as an action, and its lifecycle recorded.
const Source = Testing.observed(Swarmer);

/**
 * How long the 50-fork swarm may take, priming included. PRD section 8 asks for 5 seconds of a swarm with scripted
 * models in process; on the local engine it took 6.1 to 6.7 seconds on Node and on Bun, of which the engine's cost
 * per fork is most (the README's "Limits" of the Rivet driver). The bound is three times what was measured.
 */
const FIFTY_LIMIT_MILLIS = 20_000;

/** Registers the suite on the local engine of one runtime: the host's `node` or `bun` entry. */
export function registerRivetSuite(runtime: string, engines: typeof LocalEngine): void {
	const available = Effect.runSync(engines.available);
	if (!available) {
		console.warn(
			`Skipping the Rivet swarm suite: no Rivet engine binary. Install @rivetkit/engine-cli-${process.platform}-${process.arch} or set RIVET_ENGINE_BINARY_PATH.`,
		);
	}
	describe.skipIf(!available)(`a swarm on Rivet actor forks, on a local engine (${runtime})`, () => suite(engines));
}

type Handle = Client.Handle<typeof Source>;

function suite(engines: typeof LocalEngine): void {
	const scope = Scope.makeUnsafe();
	let context: Context.Context<Client.RivetClient>;

	beforeAll(async () => {
		const hosted = await Effect.runPromise(
			Testing.hosted(engines.serve, { actors: [Source, Careless], logging: { level: "error" } }).pipe(
				Effect.provideService(Scope.Scope, scope),
			),
		);
		context = hosted.context;
	}, 60_000);

	afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)), 60_000);

	const run = <A, E>(effect: Effect.Effect<A, E, Client.RivetClient>): Promise<A> =>
		Effect.runPromise(Effect.provideContext(effect, context));

	/** A new source actor of `definition` under `key`, its root conversation primed with `turns` turns. */
	const primed = (key: string, turns: number, definition: typeof Source = Source) =>
		Effect.gen(function* () {
			const source = yield* Client.getOrCreate(definition, [key]);
			return { source, root: yield* Client.call(source, "prime", { turns }) };
		});

	/** The plan the `start` action takes, for a swarm on the root conversation. */
	const plan = (id: string, list: ReadonlyArray<string>, cap: number, pins: ReadonlyArray<string> = []) =>
		({ id, words: list, cap, onFailure: "collect", pins, from: "root" }) as const;

	/** Asks for the swarm's status until `ready` holds. */
	const statusWhen = (
		handle: Handle,
		id: string,
		ready: (status: {
			readonly running: boolean;
			readonly jobs: ReadonlyArray<{ readonly status: string }>;
		}) => boolean,
	) => Effect.repeat(Client.call(handle, "status", { id }), { until: ready, schedule: Schedule.spaced("50 millis") });

	/** The swarm's result, once its status says that the coordinator ended. */
	const ended = (handle: Handle, id: string) =>
		Effect.andThen(
			statusWhen(handle, id, (status) => !status.running),
			Client.call(handle, "result", { id }),
		);

	/** The actor that is the fork of a job, if the engine has one. */
	const forkOf = (source: Handle, swarmId: string, jobKey: string) =>
		Client.find(source.definition, Rivet.forkKey(source.key, Swarm.SwarmId.make(swarmId), Swarm.JobKey.make(jobKey)));

	/** How many of these jobs have a fork actor now. */
	const existing = (source: Handle, swarmId: string, jobKeys: ReadonlyArray<string>) =>
		Effect.map(
			Effect.forEach(jobKeys, (jobKey) => forkOf(source, swarmId, jobKey)),
			(found) => found.filter(Option.isSome).length,
		);

	/** How often the fork hygiene ran in the fork of each of these jobs: once per fork that was made. */
	const forkedTimes = (source: Handle, swarmId: string, jobKeys: ReadonlyArray<string>): Array<number> =>
		jobKeys.map((jobKey) => {
			const key = JSON.stringify(Rivet.forkKey(source.key, Swarm.SwarmId.make(swarmId), Swarm.JobKey.make(jobKey)));
			return forked.filter((made) => made === key).length;
		});

	const eventsOf = (handle: Handle): ReadonlyArray<Testing.Lifecycle> => Effect.runSync(Testing.lifecycle(handle));

	/** Waits, without calling the actor, until its hooks recorded `event`. */
	const seen = (handle: Handle, event: Testing.Lifecycle): Promise<void> =>
		Effect.runPromise(Testing.seen(handle, event));

	const named = (prefix: string, count: number): Array<string> =>
		Array.from({ length: count }, (_, index) => `${prefix}${index}`);

	const keysOf = (list: ReadonlyArray<string>): Array<string> => list.map((word) => `job-${word}`);

	const successes = (list: ReadonlyArray<string>) =>
		list.map((word) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) }));

	/** What became of each fork, by job key, in the order of the job keys. */
	const fates = (forks: ReadonlyArray<{ readonly jobKey: string; readonly fate: string }>) =>
		[...forks].sort((a, b) => a.jobKey.localeCompare(b.jobKey)).map((fork) => [fork.jobKey, fork.fate]);

	it("keeps the engine's data in its own temporary directory", () => {
		// The host's local engine: without the variable the data of every project is in one directory under the home.
		const directory = process.env.RIVETKIT_STORAGE_PATH ?? "";
		expect(directory).toContain("pi-durable-rivet-");
		expect(existsSync(join(directory, ".rivetkit"))).toBe(true);
	});

	it("runs a swarm from start to typed results in job order, every fork on the primed transcript", async () => {
		const { source, root } = await run(primed("basic", 3));
		const list = named("basic", 3);
		const keys = keysOf(list);
		const started = await run(Client.call(source, "start", plan("basic-1", list, 2)));
		// Starting the same swarm twice is one swarm.
		const again = await run(Client.call(source, "start", plan("basic-1", list, 2)));
		expect(started.created).toBe(true);
		expect(again).toEqual({ taskId: started.taskId, created: false });

		const result = await run(ended(source, "basic-1"));
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual(successes(list));
		// Every fork saw the three priming turns, and each job was asked of the model once.
		expect(list.map((word) => [counts.primed.get(word), counts.requests.get(word)])).toEqual(list.map(() => [3, 1]));
		expect(forkedTimes(source, "basic-1", keys)).toEqual([1, 1, 1]);

		// No fork was pinned: every one is destroyed, with the bytes its database grew by, and the engine has none.
		expect(fates(result.forks)).toEqual(keys.map((key) => [key, "destroyed"]));
		expect(result.forks.map((fork) => Option.getOrThrow(fork.bytesWritten) >= 0)).toEqual([true, true, true]);
		expect(await run(existing(source, "basic-1", keys))).toBe(0);
		expect(await run(Client.call(source, "forks", { id: "basic-1" }))).toEqual([]);

		// The product's fork setup ran once per fork, inside the fork actor, in the commit that created the job's
		// conversation there, and again before the job was handed over.
		const setUp = (phase: string) =>
			setups
				.filter((call) => call.swarmId === "basic-1" && call.phase === phase)
				.sort((a, b) => a.jobKey.localeCompare(b.jobKey));
		const created = setUp("created");
		expect(created.map((call) => [call.jobKey, call.sourceConversationId])).toEqual(
			keys.map((key) => [key, root.conversationId]),
		);
		expect(setUp("beforeStart").map((call) => [call.jobKey, call.actorId, call.conversationId])).toEqual(
			created.map((call) => [call.jobKey, call.actorId, call.conversationId]),
		);
		// The coordinator's state says where each job ran: that conversation, in that actor, which is the job's fork.
		const places = created.map((call) => ({
			key: call.jobKey,
			ran: Option.some({ conversationId: call.conversationId, actorId: call.actorId }),
		}));
		expect(await run(Client.call(source, "places", { id: "basic-1" }))).toEqual(places);
		const forks = [...result.forks].sort((a, b) => a.jobKey.localeCompare(b.jobKey));
		expect(forks.map((fork) => ({ key: fork.jobKey, ran: fork.ran }))).toEqual(places);
		expect(forks.map((fork) => fork.forkId)).toEqual(created.map((call) => call.actorId));
		expect(created.map((call) => call.actorId)).not.toContain(source.actorId);

		// The other host operations, inside the source actor.
		expect(await run(Client.call(source, "status", { id: "basic-1" }))).toEqual({
			running: false,
			phase: "ended",
			jobs: keys.map((key) => ({ key, status: "succeeded" })),
		});
		expect(await run(Client.call(source, "events", { id: "basic-1" }))).toEqual(
			keys.flatMap((key) => [`Started:${key}`, `Settled:${key}`]),
		);
	}, 60_000);

	it("finds the fork a key holds again, also one whose fork call never returned, and never after its destroy", async () => {
		const { source, root } = await run(primed("keyed", 1));
		const job = (jobKey: string) => ({ swarmId: "keyed-1", jobKey });
		const first = await run(Client.call(source, "fork", job("a")));
		const second = await run(Client.call(source, "fork", job("a")));
		expect(first).toMatch(/^fork:.+/);
		expect(second).toBe(first);
		const actorId = first.slice("fork:".length);
		const held = Option.getOrThrow(await run(forkOf(source, "keyed-1", "a")));
		expect(held.actorId).toBe(actorId);
		// The fork is an actor fork of the source, made for that job at the source's newest entry.
		const assignment = (jobKey: string): Rivet.Assignment => ({
			_tag: "swarm.rivet.job",
			swarmId: Swarm.SwarmId.make("keyed-1"),
			jobKey: Swarm.JobKey.make(jobKey),
			sourceConversationId: root.conversationId,
			at: root.at,
			agent: null,
		});
		const lineage = await run(Client.lineage(held));
		expect(lineage.chain.map((link) => link.actorId)).toEqual([source.actorId]);
		expect(lineage.input).toEqual(Option.some(assignment("a")));
		expect(forkedTimes(source, "keyed-1", ["a"])).toEqual([1]);

		// A fork call that never returned: the intent is recorded, the engine made the fork, the driver has no actor id.
		await run(Client.call(source, "intend", job("b")));
		const lost = await run(
			Client.fork(source, {
				key: Rivet.forkKey(source.key, Swarm.SwarmId.make("keyed-1"), Swarm.JobKey.make("b")),
				input: assignment("b"),
			}),
		);
		// An intent the engine never saw is no fork.
		await run(Client.call(source, "intend", job("c")));
		expect(await run(Client.call(source, "forks", { id: "keyed-1" }))).toEqual([
			{ swarmId: "keyed-1", jobKey: "a", forkId: actorId },
			{ swarmId: "keyed-1", jobKey: "b", forkId: lost.actorId },
		]);
		expect(await run(Client.call(source, "fork", job("b")))).toBe(`fork:${lost.actorId}`);
		expect(forkedTimes(source, "keyed-1", ["a", "b"])).toEqual([1, 1]);

		// Destroyed for good: the same answer twice, no actor, and the key never gives a fork again.
		const destroyed = await run(Client.call(source, "drop", { ...job("a"), forkId: actorId }));
		expect(Option.getOrThrow(destroyed.bytesWritten)).toBeGreaterThanOrEqual(0);
		expect(await run(Client.call(source, "drop", { ...job("a"), forkId: actorId }))).toEqual(destroyed);
		expect(Option.isNone(await run(forkOf(source, "keyed-1", "a")))).toBe(true);
		expect(await run(Client.call(source, "fork", job("a")))).toBe("gone:fork");
		expect(await run(Client.call(source, "forks", { id: "keyed-1" }))).toEqual([
			{ swarmId: "keyed-1", jobKey: "b", forkId: lost.actorId },
		]);
		await run(Client.call(source, "drop", { ...job("b"), forkId: lost.actorId }));
		expect(await run(existing(source, "keyed-1", ["a", "b", "c"]))).toBe(0);
	}, 60_000);

	it("never has more jobs live than the cap, keeps a pinned fork whose copied coordinator does nothing, and destroys it later", async () => {
		const { source } = await run(primed("capped", 2));
		const list = named("capped", 6);
		const keys = keysOf(list);
		const pin = "job-capped1";
		// Slow enough that the jobs of one round overlap in the model.
		for (const word of list) delays.set(word, 300);
		counts.maxLive = 0;
		await run(Client.call(source, "start", plan("capped-1", list, 2, [pin])));
		const result = await run(ended(source, "capped-1"));
		expect(counts.maxLive).toBe(2);
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual(successes(list));
		expect(fates(result.forks)).toEqual(keys.map((key) => [key, key === pin ? "pinned" : "destroyed"]));

		// The unpinned forks are gone from the engine; the pinned one is an actor, and the driver lists it.
		const kept = Option.getOrThrow(await run(forkOf(source, "capped-1", pin)));
		expect(await run(existing(source, "capped-1", keys))).toBe(1);
		expect(await run(Client.call(source, "forks", { id: "capped-1" }))).toEqual([
			{ swarmId: "capped-1", jobKey: pin, forkId: kept.actorId },
		]);
		// What the fork setup wrote in the commit that created the job's conversation is in the fork actor's storage.
		const granted = Option.getOrThrow(await run(Client.call(kept, "granted", null)));
		expect(granted.jobKey).toBe(pin);
		expect(result.forks.find((fork) => fork.jobKey === pin)?.ran).toEqual(
			Option.some({ conversationId: granted.conversationId, actorId: kept.actorId }),
		);
		// Its job ran in a conversation forked at the primed entry: the two priming turns, then the job.
		const transcript = await run(Client.call(kept, "jobTranscript", null));
		expect(transcript.slice(0, 4)).toEqual([
			"user: Prime 1",
			"assistant: Noted: Prime 1",
			"user: Prime 2",
			"assistant: Noted: Prime 2",
		]);
		expect(transcript[4]).toMatch(/^user: Measure the word capped1\./);
		expect(transcript.slice(5)).toEqual([`assistant: ${JSON.stringify(measured("capped1"))}`]);

		// The coordinator the fork copied ended as copied: it ran no job again, forked nothing, and lists no fork.
		expect(await run(Client.call(kept, "status", { id: "capped-1" }))).toMatchObject({
			running: false,
			phase: "ended",
		});
		const copied = await run(Effect.flip(Client.call(kept, "result", { id: "capped-1" })));
		expect(copied).toMatchObject({
			_tag: "ActionFailed",
			error: new Swarm.SwarmFaulted({ swarmId: Swarm.SwarmId.make("capped-1"), reason: "copied" }),
		});
		expect(await run(Client.call(kept, "forks", { id: "capped-1" }))).toEqual([]);
		expect(await run(existing(kept, "capped-1", keys))).toBe(0);
		expect(list.map((word) => counts.requests.get(word))).toEqual(list.map(() => 1));

		// A fork of a fork: the pinned fork runs a swarm of its own on its job conversation.
		const inner = named("inner", 2);
		await run(Client.call(kept, "start", { ...plan("inner-1", inner, 2), from: "job" }));
		const nested = await run(ended(kept, "inner-1"));
		expect(nested.ending).toBe("completed");
		expect(nested.jobs).toEqual(successes(inner));
		expect(inner.map((word) => [counts.primed.get(word), counts.requests.get(word)])).toEqual(
			inner.map(() => [2, 1]),
		);
		expect(forkedTimes(kept, "inner-1", keysOf(inner))).toEqual([1, 1]);
		expect(await run(existing(kept, "inner-1", keysOf(inner)))).toBe(0);

		// A janitor releases the pinned fork later: once, with the same answer the second time.
		const released = await run(Client.call(source, "destroyFork", { id: "capped-1", jobKey: pin }));
		expect(Option.getOrThrow(released.bytesWritten)).toBeGreaterThanOrEqual(0);
		expect(await run(Client.call(source, "destroyFork", { id: "capped-1", jobKey: pin }))).toEqual(released);
		expect(await run(existing(source, "capped-1", keys))).toBe(0);
		expect(await run(Client.call(source, "forks", { id: "capped-1" }))).toEqual([]);
	}, 120_000);

	it("refuses a job in a fork whose fork hygiene did not run, which then drives no swarm of its own", async () => {
		// The same actor without the driver's hygiene: a fork of it holds the source's coordinator, live and unmarked.
		const { source } = await run(primed("careless", 1, Careless));
		const pin = "job-careless0";
		await run(Client.call(source, "start", plan("careless-1", ["careless0"], 1, [pin])));
		const result = await run(ended(source, "careless-1"));
		expect(result.jobs).toMatchObject([{ _tag: "Failure", key: pin, reason: "gone" }]);
		expect(result.jobs.map((job) => (job._tag === "Failure" ? job.message : ""))).toEqual([
			expect.stringContaining("is a fork whose swarm fork hygiene did not run"),
		]);
		expect(counts.requests.has("careless0")).toBe(false);

		// The fork exists, and the coordinator it copied runs in it: it gets no fork from its driver either.
		const kept = Option.getOrThrow(await run(forkOf(source, "careless-1", pin)));
		const copied = await run(statusWhen(kept, "careless-1", (status) => status.jobs[0]?.status === "failed"));
		expect(copied.jobs).toEqual([{ key: pin, status: "failed" }]);
		expect(await run(existing(kept, "careless-1", [pin]))).toBe(0);
		// It could not list or destroy the forks of its source: the pinned fork is still there, and the source lists it.
		expect(await run(Client.call(source, "forks", { id: "careless-1" }))).toEqual([
			{ swarmId: "careless-1", jobKey: pin, forkId: kept.actorId },
		]);
		await run(Client.call(source, "destroyFork", { id: "careless-1", jobKey: pin }));
		expect(await run(existing(source, "careless-1", [pin]))).toBe(0);
	}, 60_000);

	it("lists the planned jobs in its status, and cancels in the middle", async () => {
		const { source } = await run(primed("cancelled", 1));
		const list = named("cancelled", 4);
		const keys = keysOf(list);
		const release = hold();
		try {
			await run(Client.call(source, "start", plan("cancelled-1", list, 2)));
			const running = (status: { readonly jobs: ReadonlyArray<{ readonly status: string }> }) =>
				status.jobs.filter((job) => job.status === "running").length === 2;
			// Two forks hold their jobs, which the model does not answer; the cap keeps the other two planned.
			expect(await run(statusWhen(source, "cancelled-1", running))).toEqual({
				running: true,
				phase: "run",
				jobs: keys.map((key, index) => ({ key, status: index < 2 ? "running" : "planned" })),
			});
			expect(await run(existing(source, "cancelled-1", keys))).toBe(2);

			expect(await run(Client.call(source, "cancel", { id: "cancelled-1" }))).toBe("cancelling");
			const result = await run(ended(source, "cancelled-1"));
			expect(result.ending).toBe("cancelled");
			expect(result.jobs).toEqual(
				keys.map((key) => ({
					_tag: "Failure",
					key,
					reason: "cancelled",
					message: "The swarm was cancelled",
				})),
			);
			// The two forks that existed are destroyed; the two planned jobs never had one.
			expect(fates(result.forks)).toEqual(keys.slice(0, 2).map((key) => [key, "destroyed"]));
			expect(await run(existing(source, "cancelled-1", keys))).toBe(0);
			expect(forkedTimes(source, "cancelled-1", keys)).toEqual([1, 1, 0, 0]);
			expect(await run(Client.call(source, "cancel", { id: "cancelled-1" }))).toBe("ended");
		} finally {
			release();
		}
	}, 60_000);

	it("waits for a source that is busy when a fork is asked for, and forks it once it has nothing in flight", async () => {
		const { source } = await run(primed("busy", 1));
		const list = named("busy", 2);
		const keys = keysOf(list);
		// The first job takes a while, so the source can be made busy before the second fork is asked for.
		delays.set(list[0], 600);
		const release = holdSource();
		try {
			await run(Client.call(source, "start", plan("busy-1", list, 1)));
			await run(statusWhen(source, "busy-1", (status) => status.jobs[0]?.status === "running"));
			// An input the model holds: the source has a model request in flight from here on.
			await run(Client.call(source, "holdOn", { requestId: "held" }));
			// The driver says so, marked as the source's doing and not its own.
			expect(await run(Client.call(source, "fork", { swarmId: "busy-other", jobKey: "x" }))).toBe("busy");
			// The first job settles, and the second one's fork is refused: the job keeps its place and waits.
			const waiting = (status: { readonly jobs: ReadonlyArray<{ readonly status: string }> }) =>
				status.jobs[0]?.status === "succeeded" && status.jobs[1]?.status === "starting";
			await run(statusWhen(source, "busy-1", waiting));
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(await run(Client.call(source, "status", { id: "busy-1" }))).toEqual({
				running: true,
				phase: "run",
				jobs: [
					{ key: keys[0], status: "succeeded" },
					{ key: keys[1], status: "starting" },
				],
			});
			expect(forkedTimes(source, "busy-1", keys)).toEqual([1, 0]);
		} finally {
			release();
		}
		const result = await run(ended(source, "busy-1"));
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual(successes(list));
		expect(forkedTimes(source, "busy-1", keys)).toEqual([1, 1]);
		expect(await run(existing(source, "busy-1", keys))).toBe(0);
	}, 60_000);

	it("completes a swarm whose source actor was put to sleep in the middle, with no job forked twice", async () => {
		const { source } = await run(primed("sleeper", 2));
		const list = named("sleeper", 4);
		const keys = keysOf(list);
		const release = hold();
		try {
			await run(Client.call(source, "start", plan("sleeper-1", list, 2)));
			await run(
				statusWhen(
					source,
					"sleeper-1",
					(status) => status.jobs.filter((job) => job.status === "running").length === 2,
				),
			);
			// Rivet's own forced sleep: the harness of the source closes with the coordinator in the middle of its swarm.
			await run(Testing.sleep(source));
			await seen(source, "sleep");
		} finally {
			release();
		}
		// No call reaches the source: only the wake action its keeper scheduled for the coordinator brings it back.
		// The wake is what is promised, not `fired`. On a slow machine a wake action fires before the forced sleep
		// too, while the jobs start, and after the sleep the keeper of the wake the open harness causes may replace
		// the due one before Rivet runs its action.
		await Effect.runPromise(Testing.seen(source, "wake", 2));
		const slept = eventsOf(source).indexOf("sleep");
		expect(eventsOf(source)[0]).toBe("wake");
		expect(eventsOf(source).slice(slept, slept + 2)).toEqual(["sleep", "wake"]);

		const result = await run(ended(source, "sleeper-1"));
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual(successes(list));
		// One fork per job, and each job asked of the model once: the forks worked on while their source slept.
		expect(forkedTimes(source, "sleeper-1", keys)).toEqual([1, 1, 1, 1]);
		expect(list.map((word) => [counts.primed.get(word), counts.requests.get(word)])).toEqual(list.map(() => [2, 1]));
		expect(fates(result.forks)).toEqual(keys.map((key) => [key, "destroyed"]));
		expect(await run(existing(source, "sleeper-1", keys))).toBe(0);
	}, 120_000);

	it("fails every job as too deep, at once, when its source is as deep as the engine forks", async () => {
		const { source } = await run(primed("deep", 2));
		let deepest = source;
		for (let depth = 1; depth <= 16; depth++) {
			await run(Client.waitForIdle(deepest));
			deepest = await run(Client.fork(deepest, { key: ["deep", String(depth)] }));
		}
		const list = words(2);
		await run(Client.call(deepest, "start", plan("deep-1", list, 2, [])));
		const result = await run(ended(deepest, "deep-1"));
		expect(result.ending).toBe("completed");
		expect(result.jobs.map((job) => (job._tag === "Failure" ? job.reason : job._tag))).toEqual([
			"too-deep",
			"too-deep",
		]);
		expect(result.jobs[0]).toMatchObject({ message: expect.stringContaining("already 16 forks deep") });
		expect(result.forks).toEqual([]);
		expect(await run(existing(deepest, "deep-1", keysOf(list)))).toBe(0);
		expect(list.map((word) => counts.requests.get(word) ?? 0)).toEqual([0, 0]);
	}, 120_000);

	// The PRD's fork and swarm test (sections 8 and 10), on Rivet: 50 forks of a 30-turn conversation, cap 8.
	it("runs 50 jobs on forks of a primed conversation of 30 turns under a cap of 8", async () => {
		const list = words(50);
		const keys = keysOf(list);
		const pins = ["job-w0", `job-${list[49]}`];
		const begun = performance.now();
		const { source } = await run(primed("fifty", 30));
		const primedAt = performance.now();
		counts.maxLive = 0;
		await run(Client.call(source, "start", { ...plan("fifty", list, 8, pins), onFailure: "fail" }));
		const result = await run(ended(source, "fifty"));
		const swarmMillis = performance.now() - primedAt;
		const totalMillis = performance.now() - begun;
		// The numbers the report gives: on this runtime, on the local engine, with scripted models.
		console.log(
			`50-fork swarm on Rivet: ${swarmMillis.toFixed(0)} ms for the swarm, ${totalMillis.toFixed(0)} ms with priming, at most ${counts.maxLive} model requests at once`,
		);

		// Every fork saw the 30 turns, and each job was asked of the model once, in a fork of its own.
		expect(list.map((word) => [counts.primed.get(word), counts.requests.get(word)])).toEqual(list.map(() => [30, 1]));
		expect(forkedTimes(source, "fifty", keys)).toEqual(keys.map(() => 1));
		// The cap was never exceeded.
		expect(counts.maxLive).toBeLessThanOrEqual(8);
		// 50 typed results, in job order.
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual(successes(list));
		// Unpinned forks are destroyed, pinned ones are kept.
		expect(result.forks).toHaveLength(50);
		expect(fates(result.forks).filter(([, fate]) => fate === "destroyed")).toHaveLength(48);
		expect(result.forks.filter((fork) => fork.fate === "pinned").map((fork) => fork.jobKey)).toEqual(pins);
		expect((await run(Client.call(source, "forks", { id: "fifty" }))).map((fork) => fork.jobKey)).toEqual(pins);
		expect(await run(existing(source, "fifty", keys))).toBe(2);
		expect(totalMillis).toBeLessThan(FIFTY_LIMIT_MILLIS);
	}, 180_000);
}
