// Test helper: the composition hosted in Rivet actors, against a real Rivet engine, registered once per runtime by
// rivet.node.test.ts and rivet.bun.test.ts. The engine is the one of the host's local-engine entry: the binary of
// rivetkit's platform package, on a free port, with its data in a temporary directory, removed afterwards. Skipped
// when the binary is not installed. Models are scripted: nothing leaves the machine. One suite for every engine
// test, because one process hosts one local engine at a time.
//
// Not testable here, since the actors run in the test's process, and tested by hosts-suite.ts: an actor process that
// dies, a call nobody answers, several host processes, and ports across a process boundary. Not testable in either,
// and not tested: an engine that refuses.

import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import * as Approvals from "@effectified/pi-approvals";
import { LeaseFenced } from "@effectified/pi-budget";
import { ToolName } from "@effectified/pi-durable";
import { answer, held, toolCall } from "@effectified/pi-durable/testing";
import { Client, NotIdle } from "@effectified/pi-durable-rivet";
import type * as LocalEngine from "@effectified/pi-durable-rivet/node";
import * as Testing from "@effectified/pi-durable-rivet/testing";
import * as Swarm from "@effectified/pi-swarm";
import * as Rivet from "@effectified/pi-swarm/rivet";
import { Context, Effect, Exit, Layer, Option, Queue, Schedule, Scope } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RequestKey, ReviewerSharesFamily, ThreadKey, ThreadNotFound } from "../src/index.ts";
import { OperationFailed, Remote, SwarmId } from "../src/rivet.ts";
import {
	Cloned,
	configured,
	Desk,
	deliveries,
	deskOf,
	labs,
	load,
	OUTCOME_RETRY_MILLIS,
	opened,
	reset,
	scripted,
	shown,
	state,
	streams,
	Thread,
} from "./rivet-world.ts";
import {
	advisory,
	BACKUP,
	Covers,
	committed,
	conflicts,
	ESTIMATE,
	expectedCost,
	FORK,
	JUDGE,
	REVIEWER,
	reached,
	reservations,
	said,
	shape,
	told as toldEvents,
	WRITER,
	work,
} from "./world.ts";

const CLEAN = answer('{"findings":[]}');

const JOBS = [
	{ key: Swarm.JobKey.make("rust"), input: { topic: "Rust" } },
	{ key: Swarm.JobKey.make("go"), input: { topic: "Go" } },
	{ key: Swarm.JobKey.make("zig"), input: { topic: "Zig" } },
];

/**
 * How long the 50-fork swarm may take, priming included. Through the composition it took 4.8 to 6.3 seconds for the
 * swarm and 5.9 to 8.2 with priming on this engine, on Node and on Bun, as the swarm package's bare driver does: the
 * engine's cost per fork is most of it (the README has the runs). The bound is about three times what was measured.
 */
const FIFTY_LIMIT_MILLIS = 20_000;

/** How often a test asks a thread or a swarm whether it has ended. */
const POLL = Schedule.spaced("50 millis");

/** Registers the suite on the local engine of one runtime: the host's `node` or `bun` entry. */
export function registerRivetSuite(runtime: string, engines: typeof LocalEngine): void {
	const available = Effect.runSync(engines.available);
	if (!available) {
		console.warn(
			`Skipping the Rivet suite of pi-thread-effect: no Rivet engine binary. Install @rivetkit/engine-cli-${process.platform}-${process.arch} or set RIVET_ENGINE_BINARY_PATH.`,
		);
	}
	describe.skipIf(!available)(`threads and swarms in Rivet actors, on a local engine (${runtime})`, () =>
		suite(runtime, engines),
	);
}

type Handle = Client.Handle<typeof Thread>;

function suite(runtime: string, engines: typeof LocalEngine): void {
	const scope = Scope.makeUnsafe();
	let client: Context.Context<Client.RivetClient>;
	let remote: Remote.Service;
	let cloned: Remote.Service;
	let desks: Remote.Service;
	const begun = performance.now();

	beforeAll(async () => {
		const built = await Effect.runPromise(
			Effect.gen(function* () {
				const hosted = yield* Testing.hosted(engines.serve, {
					actors: [Thread, Cloned, Desk],
					logging: { level: "error" },
				});
				const services = (definition: typeof Thread | typeof Cloned | typeof Desk, options?: Remote.Options) =>
					Effect.map(
						Effect.provideContext(Layer.build(Remote.layer(definition, options)), hosted.context),
						Context.get(Remote.Remote),
					);
				return {
					client: hosted.context,
					remote: yield* services(Thread),
					cloned: yield* services(Cloned),
					// A desk holds several threads: the client finds a thread's actor by the desk its key names.
					desks: yield* services(Desk, { actorKey: deskOf }),
				};
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		);
		client = built.client;
		remote = built.remote;
		cloned = built.cloned;
		desks = built.desks;
	}, 90_000);

	afterAll(async () => {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		// The number the report gives: on this runtime, on the local engine, with scripted models.
		console.log(`Rivet suite of pi-thread-effect (${runtime}): ${((performance.now() - begun) / 1000).toFixed(1)} s`);
	}, 60_000);

	beforeEach(reset);

	const run = <A, E>(effect: Effect.Effect<A, E, Client.RivetClient>): Promise<A> =>
		Effect.runPromise(Effect.provideContext(effect, client));

	/** The actor of a thread that was started. */
	const actorOf = (thread: string): Promise<Handle> =>
		run(Effect.map(Client.find(Thread, [thread]), Option.getOrThrow));

	/** The thread's outcome, once it has one. */
	const ended = (thread: string) => run(remote.threads.ended(ThreadKey.make(thread), POLL));

	/** The swarm's typed result, once its coordinator ended: found by the swarm id alone, which names its thread. */
	const fannedIn = (swarmId: Swarm.SwarmId) =>
		run(
			Effect.map(
				Effect.repeat(remote.swarms.result(Covers, swarmId), { until: Option.isSome, schedule: POLL }),
				Option.getOrThrow,
			),
		);

	/** The actor that is the fork of a job, if the engine has one. */
	const forkOf = (thread: string, swarmId: string, jobKey: string) =>
		run(Client.find(Thread, Rivet.forkKey([thread], Swarm.SwarmId.make(swarmId), Swarm.JobKey.make(jobKey))));

	const eventsOf = (handle: Handle): ReadonlyArray<Testing.Lifecycle> => Effect.runSync(Testing.lifecycle(handle));

	/** Waits, without calling the actor, until its hooks recorded `event` `times` times. */
	const seen = (handle: Handle, event: Testing.Lifecycle, times = 1): Promise<void> =>
		Effect.runPromise(Testing.seen(handle, event, times));

	/** Waits until the harness of the actor has live work that cannot run now: a parked call, a held answer. */
	const parked = (handle: Handle) =>
		run(
			Effect.repeat(Client.status(handle), {
				until: (status) => !status.active && status.tasks > 0,
				schedule: POLL,
			}),
		);

	/** What the lease was told in all, in micro units. */
	const told = () => reservations(state).reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);

	/** The eight records of a thread that calls `lookup` once, answers and is reviewed, as world.ts shapes them. */
	const LOOKUP_RECORDS = [
		{ _tag: "Message", role: "user", entryKind: "pi.user", text: "What is record 42 called?" },
		{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "toolUse", error: null },
		{ _tag: "ToolCallRequested", name: "lookup", callId: "call-1", arguments: { id: "42" } },
		{
			_tag: "ToolCallResult",
			name: "lookup",
			callId: "call-1",
			isError: false,
			codes: [],
			text: "Record 42 is titled Answer.",
		},
		{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "stop", error: null },
		{ _tag: "Message", role: "assistant", entryKind: "pi.assistant", text: "Record 42 is titled Answer." },
		{ _tag: "Entry", kind: "review.verdict" },
		{ _tag: "ModelCall", provider: "reviewer-lab", model: "judge", stopReason: "stop", error: null },
	];

	it("works a thread started through the client to its reviewed outcome, and one key twice is one piece of work", async () => {
		labs.author.setResponses([
			toolCall("lookup", { id: "42" }, { id: "call-1" }),
			answer("Record 42 is titled Answer."),
		]);
		labs.reviewer.setResponses([CLEAN]);
		const input = work("basic", "What is record 42 called?");
		const before = await run(remote.threads.probe(ThreadKey.make("basic")));
		const started = await run(remote.threads.start(input, RequestKey.make("job-1")));
		// The same key again is the same work, and so is any key once the thread exists: the first one stands.
		const again = await run(remote.threads.start(input, RequestKey.make("job-1")));
		const other = await run(remote.threads.start({ ...input, task: "Something else." }, RequestKey.make("job-2")));
		const outcome = await ended("basic");
		const handle = await actorOf("basic");
		expect(before).toEqual({ alive: false });
		expect(started).toEqual({ created: true, key: "job-1" });
		expect(again).toEqual({ created: false, key: "job-1" });
		expect(other).toEqual({ created: false, key: "job-1" });
		expect(outcome).toMatchObject({
			_tag: "Reviewed",
			accepted: false,
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: told() },
			verdict: { pass: 1, corrections: 0, findings: [], outcome: { _tag: "Passed" } },
		});
		// The outcome is read from the actor's storage: a second read says the same, to the last field.
		expect(await run(remote.threads.outcome(ThreadKey.make("basic")))).toEqual(Option.some(outcome));
		expect(await run(remote.threads.probe(ThreadKey.make("basic")))).toEqual({ alive: false });
		// One piece of work: two author requests, one review, the tool once.
		expect([labs.author.state.callCount, labs.backup.state.callCount, labs.reviewer.state.callCount]).toEqual([
			2, 0, 1,
		]);
		expect(state.ran).toEqual({ lookup: 1 });
		// The sink holds exactly the thread's records, each id once, all delivered by the thread's actor.
		expect(committed(state).map(shape)).toEqual(LOOKUP_RECORDS);
		expect(advisory(state)).toHaveLength(2);
		const delivered = deliveries();
		expect(new Set(delivered.map(({ record }) => record.id)).size).toBe(delivered.length);
		expect(new Set(delivered.map(({ actor }) => actor))).toEqual(new Set([handle.actorId]));
		expect(conflicts(state)).toEqual([]);
		// The lease reserved and settled once per provider request, at the exact cost of the price table.
		const reserved = reservations(state);
		expect(state.lease.steps.map((step) => step.step)).toEqual([
			"reserve",
			"settle",
			"reserve",
			"settle",
			"reserve",
			"settle",
		]);
		expect(reserved.map(({ estimate, request, actor }) => [estimate, request.model, actor])).toEqual([
			[ESTIMATE, "author", handle.actorId],
			[ESTIMATE, "author", handle.actorId],
			[ESTIMATE, "reviewer", handle.actorId],
		]);
		expect(reserved.map(({ settlements }) => settlements.length)).toEqual([1, 1, 1]);
		// Every request settles what its recorded response used, at the price of the route that served: the reviewer's
		// too, whose model call record the composition makes of its verdict.
		const calls = committed(state).flatMap((record) => (record._tag === "ModelCall" ? [record] : []));
		expect(calls.map((call) => ({ provider: call.provider, modelId: call.model }))).toEqual([WRITER, WRITER, JUDGE]);
		expect(reserved.map(({ settlements }) => settlements[0])).toEqual(
			calls.map(({ provider, model, usage: { input, output, cacheRead, cacheWrite } }) => ({
				usage: { input, output, cacheRead, cacheWrite },
				cost: expectedCost({ provider, modelId: model }, { input, output, cacheRead, cacheWrite }),
				outcome: "returned",
			})),
		);
		// The thread's actor told the product's outcome sink itself, with nobody asking for it: that work started,
		// under the key of the start, and then the outcome the client read, after the records it rests on.
		const events = await Effect.runPromise(toldEvents(state, reached("Reviewed")));
		expect(events.map((event) => [said(event), event.thread, event.key, event.attempt])).toEqual([
			["Started", "basic", "job-1", 0],
			["Reviewed", "basic", "job-1", 0],
		]);
		expect(events[1]).toMatchObject({ _tag: "Reached", outcome });
		expect(new Set(state.told.by)).toEqual(new Set([handle.actorId]));
		const recorded: ReadonlyArray<string> = committed(state).map((record) => record.id);
		expect(state.told.recorded[1]?.filter((id) => recorded.includes(id))).toEqual(recorded);
		expect(state.told.calls).toBe(2);
	}, 60_000);

	it("delivers an outcome its sink refused once after a forced sleep, woken by the wake of its courier's next attempt", async () => {
		const turn = held(answer("It is 42."));
		labs.author.setResponses([turn.response]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("refused", "What is six times seven?"), RequestKey.make("job-1")));
		await Effect.runPromise(turn.requested);
		// `Started` is in the sink. The sink refuses its next call, which is the outcome's.
		await Effect.runPromise(toldEvents(state, (events) => events.length === 1));
		state.told.failing = 1;
		const refusedAt = Date.now();
		await Effect.runPromise(turn.release);
		const handle = await actorOf("refused");
		await Effect.runPromise(
			Effect.repeat(
				Effect.sync(() => state.told.calls),
				{ until: (calls) => calls === 2, schedule: POLL },
			),
		);
		// The thread has ended and is not told: its courier sleeps until its next attempt, so Pi has a sleep that is
		// due, and the host's wake keeper holds one wake action for that time. Nothing else is live.
		const waiting = await run(
			Effect.repeat(Client.status(handle), {
				until: (status) => !status.active && status.at !== null,
				schedule: POLL,
			}),
		);
		expect(waiting).toMatchObject({ tasks: 1, background: 1, submissions: 0, active: false });
		expect(waiting.at).toBeGreaterThanOrEqual(refusedAt + OUTCOME_RETRY_MILLIS);
		const scheduled = (await run(Testing.schedules(handle))).filter((event) => event.action === "pi.wake");
		expect(scheduled.map((event) => event.runAt)).toEqual([waiting.at]);
		expect(state.told.events.map(said)).toEqual(["Started"]);
		// Rivet's own forced sleep: the harness closes with the event undelivered.
		await run(Testing.sleep(handle));
		await seen(handle, "sleep");
		expect(state.told.events.map(said)).toEqual(["Started"]);
		// No call reaches the actor: only that wake brings it back, at its time, and the event comes.
		const events = await Effect.runPromise(toldEvents(state, reached("Reviewed")));
		expect(Date.now()).toBeGreaterThanOrEqual(scheduled[0]?.runAt ?? Number.POSITIVE_INFINITY);
		expect(eventsOf(handle).slice(0, 3)).toEqual(["wake", "sleep", "wake"]);
		expect(events.map(said)).toEqual(["Started", "Reviewed"]);
		// The sink was offered the outcome twice, the same value both times, and took it once.
		const offered = state.told.offered.filter((event) => event.id === events[1]?.id);
		expect(offered).toEqual([events[1], events[1]]);
		expect(state.told.calls).toBe(3);
		// It is the outcome the client reads, and once it is delivered nothing is live: the actor may sleep for good.
		expect(await run(remote.threads.outcome(ThreadKey.make("refused")))).toEqual(
			Option.some(offered[0]?._tag === "Reached" ? offered[0].outcome : undefined),
		);
		const idle = await run(
			Effect.repeat(Client.status(handle), {
				until: (status) => status.tasks === 0 && !status.active,
				schedule: POLL,
			}),
		);
		expect(idle).toMatchObject({ tasks: 0, submissions: 0, active: false, at: null });
		expect((await run(Testing.schedules(handle))).filter((event) => event.action === "pi.wake")).toEqual([]);
	}, 120_000);

	it("tells a thread that does not exist from a failed operation, and creates no actor to say so", async () => {
		const result = await run(
			Effect.gen(function* () {
				return {
					probe: yield* remote.threads.probe(ThreadKey.make("nobody")),
					outcome: yield* Effect.flip(remote.threads.outcome(ThreadKey.make("nobody"))),
					resume: yield* Effect.flip(remote.threads.resume(ThreadKey.make("nobody"), RequestKey.make("job-1"))),
					cancel: yield* Effect.flip(remote.threads.cancel(ThreadKey.make("nobody"))),
					// With the thread given, a swarm id is taken as it is.
					swarm: yield* Effect.flip(remote.swarms.probe(ThreadKey.make("nobody"), Swarm.SwarmId.make("covers-0"))),
					named: yield* Effect.flip(remote.swarms.probe(Swarm.SwarmId.make("nobody/covers-0"))),
					fork: yield* Effect.flip(
						remote.forks.destroy({
							thread: ThreadKey.make("nobody"),
							swarmId: Swarm.SwarmId.make("covers-0"),
							jobKey: Swarm.JobKey.make("rust"),
						}),
					),
					actor: yield* Client.find(Thread, ["nobody"]),
				};
			}),
		);
		const missing = new ThreadNotFound({ thread: ThreadKey.make("nobody") });
		expect(result).toEqual({
			probe: { alive: false },
			outcome: missing,
			resume: missing,
			cancel: missing,
			swarm: missing,
			named: missing,
			fork: missing,
			actor: Option.none(),
		});
		// An actor that exists and holds no such swarm fails the operation, with the swarm's own word for it.
		labs.author.setResponses([answer("Hi.")]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("lonely", "Say hi.", []), RequestKey.make("job-1")));
		await ended("lonely");
		const failed = await run(
			Effect.flip(remote.swarms.probe(ThreadKey.make("lonely"), Swarm.SwarmId.make("covers-0"))),
		);
		expect(failed).toEqual(
			new OperationFailed({ operation: "probeSwarm", reason: "SwarmNotFound", message: "No swarm covers-0" }),
		);
	}, 60_000);

	it("does not start a thread whose reviewer is of its author's family: the refusal crosses with its routes", async () => {
		labs.author.setResponses([answer("It is 42.")]);
		const refused = await run(
			Effect.flip(cloned.threads.start(work("family", "What is six times seven?"), RequestKey.make("job-1"))),
		);
		expect(refused).toEqual(
			new ReviewerSharesFamily({
				thread: ThreadKey.make("family"),
				conflicts: [
					{ family: "alpha", author: WRITER, reviewer: WRITER },
					{ family: "alpha", author: BACKUP, reviewer: WRITER },
				],
			}),
		);
		expect(await run(cloned.threads.probe(ThreadKey.make("family")))).toEqual({ alive: false });
		expect(labs.author.state.callCount).toBe(0);
		expect(state.lease.steps).toEqual([]);
	}, 60_000);

	it("parks a call that needs approval, sleeps, lists the request, and wakes for a decision through the client", async () => {
		labs.author.setResponses([toolCall("transfer", { to: "bob", amount: 250 }, { id: "call-1" }), answer("Sent.")]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("approval", "Send bob 250.", ["transfer"]), RequestKey.make("job-1")));
		const request = await Effect.runPromise(Queue.take(state.inbox));
		const handle = await actorOf("approval");
		// Parked: live work that cannot run, so the host's wake keeper lets the actor sleep. Rivet's forced sleep
		// does not wait for its idle timeout.
		await parked(handle);
		await run(Testing.sleep(handle));
		await seen(handle, "sleep");
		expect(eventsOf(handle)).toEqual(["wake", "sleep"]);
		// The request is listed from the actor's storage, by an actor that just woke, and the thread has no outcome.
		const pending = await run(remote.threads.pending(ThreadKey.make("approval")));
		expect(pending).toEqual([request]);
		expect(request).toMatchObject({ tool: "transfer", callId: "call-1", arguments: { amount: 250, to: "bob" } });
		expect(await run(remote.threads.probe(ThreadKey.make("approval")))).toEqual({ alive: true });
		expect(await run(remote.threads.outcome(ThreadKey.make("approval")))).toEqual(Option.none());
		expect(state.ran).toEqual({});
		// Asleep again, with no caller: the decision is what wakes the actor.
		await parked(handle);
		await run(Testing.sleep(handle));
		await seen(handle, "sleep", 2);
		const decision = await Effect.runPromise(Approvals.approve(request, "user:ada"));
		expect(await run(remote.threads.decide(ThreadKey.make("approval"), request, decision))).toBe("delivered");
		const outcome = await ended("approval");
		expect(eventsOf(handle)).toEqual(["wake", "sleep", "wake", "sleep", "wake"]);
		expect(outcome).toMatchObject({ _tag: "Reviewed", counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0 } });
		expect(state.ran).toEqual({ transfer: 1 });
		// A second decision reaches nothing, and nothing is pending any more.
		expect(await run(remote.threads.decide(ThreadKey.make("approval"), request, decision))).toBe("gone");
		expect(await run(remote.threads.pending(ThreadKey.make("approval")))).toEqual([]);
		// No model request was repeated; the request was published again at each wake, under the same id.
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([2, 1]);
		expect(reservations(state).map(({ settlements }) => settlements.map((settled) => settled.outcome))).toEqual([
			["returned"],
			["returned"],
			["returned"],
		]);
		expect(new Set(state.shown.map((shownRequest) => shownRequest.id))).toEqual(new Set([request.id]));
		expect(state.shown.length).toBeGreaterThanOrEqual(2);
		const [called] = committed(state).flatMap((record) => (record._tag === "ToolCallResult" ? [record] : []));
		expect(called?.details).toMatchObject({ approvals: { outcome: { _tag: "Approved", by: "user:ada" } } });
	}, 120_000);

	it("reaches the same outcome when its actor is put to sleep in the middle of a model request", async () => {
		const reached = Promise.withResolvers<void>();
		let holding = true;
		// The author answers from what it is shown, so a request that is sent again gets the same turn. Its first
		// request is held until the closing harness aborts it.
		const author: FauxResponseFactory = (context, options) => {
			if (context.messages.some((message) => message.role === "toolResult"))
				return answer("Record 42 is titled Answer.");
			const call = toolCall("lookup", { id: "42" }, { id: "call-1" });
			if (!holding) return call;
			holding = false;
			reached.resolve();
			return new Promise((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(call), { once: true }),
			);
		};
		labs.author.setResponses(Array.from({ length: 4 }, () => author));
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("sleeper", "What is record 42 called?"), RequestKey.make("job-1")));
		await reached.promise;
		const handle = await actorOf("sleeper");
		// While the thread works, the host's wake keeper holds the actor awake and keeps one recovery wake scheduled.
		const scheduled = (await run(Testing.schedules(handle))).filter((event) => event.action === "pi.wake");
		expect(scheduled).toHaveLength(1);
		// Rivet's own forced sleep: the harness closes with the request in flight, which is aborted.
		await run(Testing.sleep(handle));
		await seen(handle, "sleep");
		// No call reaches the actor: only that recovery wake brings it back, at its time. (The keeper of the new wake
		// replaces the due wake action before Rivet runs it, so the lifecycle shows the wake and no `fired`.)
		await seen(handle, "wake", 2);
		expect(Date.now()).toBeGreaterThanOrEqual(scheduled[0]?.runAt ?? Number.POSITIVE_INFINITY);
		expect(eventsOf(handle).slice(0, 3)).toEqual(["wake", "sleep", "wake"]);
		const outcome = await ended("sleeper");
		expect(outcome).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: told() },
			verdict: { pass: 1, outcome: { _tag: "Passed" } },
		});
		// What the packages document for a request a close cut off: it is sent again, so one more provider request
		// and one more reservation, the cut one settled as aborted at no cost. Every reservation is settled once.
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([3, 1]);
		expect(
			reservations(state).map(({ settlements }) => settlements.map(({ outcome: how, cost }) => [how, cost > 0n])),
		).toEqual([[["aborted", false]], [["returned", true]], [["returned", true]], [["returned", true]]]);
		expect(state.ran).toEqual({ lookup: 1 });
		// The same records as an uninterrupted thread, and no id with two contents.
		expect(committed(state).map(shape)).toEqual(LOOKUP_RECORDS);
		expect(conflicts(state)).toEqual([]);
	}, 120_000);

	it("stops with the lease's reason when the lease is fenced, and finishes after a resume under a new lease", async () => {
		labs.author.setResponses([
			// The product loses its lease while the first request is out: the next one finds it fenced.
			() => {
				state.lease.fenced = "expired";
				return toolCall("lookup", { id: "42" }, { id: "call-1" });
			},
			answer("Record 42 is titled Answer."),
		]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("fenced", "What is record 42 called?"), RequestKey.make("job-1")));
		const stopped = await ended("fenced");
		const first = reservations(state)[0]?.settlements[0]?.cost ?? 0n;
		// The refusal crosses the actor boundary typed, with the product's own reason.
		expect(stopped).toEqual({
			_tag: "BudgetStopped",
			refusal: new LeaseFenced({ reason: "expired" }),
			counts: { turns: 1, toolCalls: 1, refusedToolCalls: 0, settledMicros: first },
		});
		expect(await run(remote.threads.probe(ThreadKey.make("fenced")))).toEqual({ alive: false });
		expect(state.lease.steps.map((step) => step.step)).toEqual(["reserve", "settle", "fenced"]);
		// A resume while the lease is still fenced continues, and stops again without a request.
		expect(await run(remote.threads.resume(ThreadKey.make("fenced"), RequestKey.make("job-2")))).toBe("continued");
		expect(await ended("fenced")).toEqual(stopped);
		expect(labs.author.state.callCount).toBe(1);
		state.lease.fenced = undefined;
		// The key that was used continues nothing: the same key is the same work. A new one does.
		expect(await run(remote.threads.resume(ThreadKey.make("fenced"), RequestKey.make("job-2")))).toBe("unchanged");
		expect(await run(remote.threads.resume(ThreadKey.make("fenced"), RequestKey.make("job-3")))).toBe("continued");
		const finished = await run(
			Effect.repeat(remote.threads.ended(ThreadKey.make("fenced"), POLL), {
				until: (outcome) => outcome._tag !== "BudgetStopped",
				schedule: POLL,
			}),
		);
		expect(finished).toMatchObject({
			_tag: "Reviewed",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: told() },
			verdict: { outcome: { _tag: "Passed" } },
		});
		expect(await run(remote.threads.resume(ThreadKey.make("fenced"), RequestKey.make("job-4")))).toBe("unchanged");
		expect(state.ran).toEqual({ lookup: 1 });
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([2, 1]);
		expect(state.lease.steps.map((step) => step.step)).toEqual([
			"reserve",
			"settle",
			"fenced",
			"fenced",
			"reserve",
			"settle",
			"reserve",
			"settle",
		]);
	}, 60_000);

	it("is cancelled in the middle of a model request, and its probe says so before, during and after", async () => {
		const turn = held(answer("Never said."));
		labs.author.setResponses([turn.response]);
		const before = await run(remote.threads.probe(ThreadKey.make("cancelled")));
		await run(remote.threads.start(work("cancelled", "Say hi."), RequestKey.make("job-1")));
		await Effect.runPromise(turn.requested);
		const during = {
			probe: await run(remote.threads.probe(ThreadKey.make("cancelled"))),
			outcome: await run(remote.threads.outcome(ThreadKey.make("cancelled"))),
		};
		await run(remote.threads.cancel(ThreadKey.make("cancelled")));
		const outcome = await ended("cancelled");
		const after = await run(remote.threads.probe(ThreadKey.make("cancelled")));
		// A second cancel, and a resume, change nothing: a cancelled thread is not continued.
		await run(remote.threads.cancel(ThreadKey.make("cancelled")));
		expect(await run(remote.threads.resume(ThreadKey.make("cancelled"), RequestKey.make("job-2")))).toBe("unchanged");
		expect(before).toEqual({ alive: false });
		expect(during).toEqual({ probe: { alive: true }, outcome: Option.none() });
		expect(outcome).toEqual({
			_tag: "Cancelled",
			counts: { turns: 0, toolCalls: 0, refusedToolCalls: 0, settledMicros: 0n },
		});
		expect(after).toEqual({ alive: false });
		expect(await ended("cancelled")).toEqual(outcome);
		// The request was sent once and aborted; its reservation is settled, with nothing used.
		expect(labs.author.state.callCount).toBe(1);
		expect(reservations(state).map(({ settlements }) => settlements)).toEqual([
			[{ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0n, outcome: "aborted" }],
		]);
	}, 60_000);

	it("runs a swarm of a thread on actor forks: typed results, forks set up in their own actors, records and money per job", async () => {
		labs.author.setResponses(Array.from({ length: 4 }, () => scripted));
		labs.reviewer.setResponses([CLEAN]);
		// The thread holds two tools; the swarm's allowance names one of them and one the thread does not hold.
		await run(
			remote.threads.start(work("swarm", "Read this record: ...", ["lookup", "transfer"]), RequestKey.make("job-1")),
		);
		const primed = await ended("swarm");
		const source = await actorOf("swarm");
		const sourceRecords = deliveries().map(({ record }) => record.id);
		// A swarm's id begins with its thread's key, so the id alone finds the actor its coordinator lives in.
		const id = SwarmId.of(ThreadKey.make("swarm"), "covers-1");
		expect(id).toBe("swarm/covers-1");
		const plan = {
			id,
			thread: ThreadKey.make("swarm"),
			jobs: JOBS,
			cap: 2,
			onFailure: "collect",
			pins: [Swarm.JobKey.make("rust")],
			fork: { tools: [ToolName.make("lookup"), ToolName.make("write_note")], cap: FORK.cap },
		} as const;
		// An id that names no thread, or another one, starts nothing: the refusal is the client's, before any call.
		expect(
			await run(Effect.flip(remote.swarms.run(Covers, { ...plan, id: Swarm.SwarmId.make("covers-1") }))),
		).toEqual(
			new SwarmId.SwarmIdNotOfThread({ swarmId: Swarm.SwarmId.make("covers-1"), thread: ThreadKey.make("swarm") }),
		);
		expect(
			await run(Effect.flip(remote.swarms.run(Covers, { ...plan, id: Swarm.SwarmId.make("other/covers-1") }))),
		).toEqual(
			new SwarmId.SwarmIdNotOfThread({
				swarmId: Swarm.SwarmId.make("other/covers-1"),
				thread: ThreadKey.make("swarm"),
			}),
		);
		expect(await run(Effect.flip(remote.swarms.probe(Swarm.SwarmId.make("covers-1"))))).toEqual(
			new SwarmId.SwarmIdNotOfThread({ swarmId: Swarm.SwarmId.make("covers-1") }),
		);
		// The actor checks the same, whoever calls it.
		expect(
			await run(
				Effect.flip(
					Client.call(source, "runSwarm", {
						...plan,
						swarm: Covers.name,
						id: Swarm.SwarmId.make("covers-1"),
						pins: [Swarm.JobKey.make("rust")],
					}),
				),
			),
		).toMatchObject({ _tag: "ActionFailed", error: { _tag: "OperationFailed", reason: "SwarmIdNotOfThread" } });
		const started = await run(remote.swarms.run(Covers, plan));
		// A second start is the same swarm: its plan and the allowance of its forks stand.
		const again = await run(remote.swarms.run(Covers, { ...plan, fork: { tools: [], cap: 1n } }));
		const during = await run(remote.swarms.probe(id));
		const outcome = await fannedIn(id);
		expect(started).toEqual({ created: true });
		expect(again).toEqual({ created: false });
		expect(during).toEqual({ alive: true, jobKeys: ["rust", "go", "zig"] });
		// With the thread given, an operation says the same: the two-argument form stands.
		expect(await run(remote.swarms.probe(ThreadKey.make("swarm"), id))).toEqual({
			alive: false,
			jobKeys: ["rust", "go", "zig"],
		});
		expect(await run(remote.swarms.result(Covers, ThreadKey.make("swarm"), id))).toEqual(Option.some(outcome));
		expect(outcome.ending).toBe("completed");
		expect(outcome.jobs).toEqual([
			{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } },
			{ _tag: "Success", key: "go", value: { topic: "Go", covered: true } },
			{ _tag: "Success", key: "zig", value: { topic: "Zig", covered: false } },
		]);
		// Every fork is an actor of its own, where its job ran in a conversation of that actor's storage.
		const forks = JOBS.map(({ key }) => {
			const fork = outcome.forks.find((made) => made.jobKey === key);
			const ran = Option.getOrThrow(Option.fromUndefinedOr(fork).pipe(Option.flatMap((made) => made.ran)));
			return { key, fate: fork?.fate, actor: fork?.forkId ?? "", ran, bytes: fork?.bytesWritten };
		});
		expect(forks.map(({ key, fate }) => [key, fate])).toEqual([
			["rust", "pinned"],
			["go", "destroyed"],
			["zig", "destroyed"],
		]);
		expect(forks.map(({ actor, ran }) => ran.actorId === actor && actor !== source.actorId)).toEqual([
			true,
			true,
			true,
		]);
		expect(new Set(forks.map(({ actor }) => actor)).size).toBe(3);
		// Each fork saw the primed transcript and then its job, was offered exactly what its thread holds of the
		// allowance (`lookup`: not `transfer`, which the allowance leaves out, nor `write_note`, which the thread does
		// not hold), and was not reviewed: the reviewer was asked for the thread alone.
		for (const topic of ["Rust", "Go", "Zig"]) {
			const job = shown.get(topic);
			expect(job?.transcript.slice(0, 2)).toEqual(["user: Read this record: ...", "assistant: I have read it."]);
			expect(job?.transcript).toHaveLength(3);
			expect(job?.transcript[2]).toMatch(new RegExp(`^user: Does the record you read cover ${topic}\\?`));
			expect(job?.tools).toEqual(["lookup"]);
		}
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([4, 1]);
		// The product's own hygiene ran once in each fork, after the composition's: a stream anchored to the source.
		expect(new Set(streams.map((stream) => `${stream.actor} of ${stream.source}`))).toEqual(
			new Set(forks.map(({ actor }) => `${actor} of ${source.actorId}`)),
		);
		expect(streams).toHaveLength(3);
		// Each fork drew on the lease under a share of its own: one request, reserved and settled once by the fork's
		// actor, for the conversation its job ran in.
		const reserved = reservations(state);
		const byFork = forks.map(({ actor }) => reserved.filter((reservation) => reservation.actor === actor));
		expect(
			byFork.map((own) =>
				own.map(({ request, settlements }) => [request.model, request.conversation, settlements.length]),
			),
		).toEqual(forks.map(({ ran }) => [["author", ran.conversationId, 1]]));
		const costs = byFork.map((own) => own[0]?.settlements[0]?.cost ?? 0n);
		expect(costs.every((cost) => cost > 0n && cost < FORK.cap)).toBe(true);
		// The money per job, in plan order and to the micro unit: kept in the thread's actor for the two forks that
		// are gone, and asked of the pinned one.
		const spent = [
			{ key: "rust", settledMicros: Option.some(costs[0]) },
			{ key: "go", settledMicros: Option.some(costs[1]) },
			{ key: "zig", settledMicros: Option.some(costs[2]) },
		];
		expect(await run(remote.swarms.spent(id))).toEqual(spent);
		// The thread's money is all it caused, wherever it was settled: its own requests and its review, and what
		// each job's fork settled in its own actor. The same sum as with forks that are conversations (swarm.test.ts),
		// and all of it is what the lease was told.
		const whole = primed.counts.settledMicros + costs[0] + costs[1] + costs[2];
		const thread = Option.some({ ...primed, counts: { ...primed.counts, settledMicros: whole } });
		expect(await run(remote.threads.outcome(ThreadKey.make("swarm")))).toEqual(thread);
		expect(told()).toBe(whole);
		// The records of each fork's work are in the sink, each once, delivered by the fork's own actor, also those
		// of the forks that were destroyed. A fork delivered nothing of what its source delivered.
		const delivered = deliveries();
		const pairs = delivered.map(({ actor, record }) => `${actor} ${record.id}`);
		expect(new Set(pairs).size).toBe(pairs.length);
		for (const { actor, ran } of forks) {
			const own = delivered.filter((delivery) => delivery.actor === actor).map(({ record }) => record);
			expect(own.map((record) => record.conversation)).toEqual(own.map(() => ran.conversationId));
			expect(
				own.filter((record) => record._tag !== "ModelCallRequested").map((record) => shape(record)._tag),
			).toEqual(["Message", "ModelCall", "Message"]);
		}
		const bySource = delivered.filter((delivery) => delivery.actor === source.actorId).map(({ record }) => record.id);
		expect(bySource).toEqual(sourceRecords);
		expect(delivered).toHaveLength(sourceRecords.length + 3 * 4);
		// Unpinned forks are destroyed, with the bytes their databases grew by; the pinned one is an actor still.
		expect(forks.map(({ bytes }) => Option.isSome(Option.fromUndefinedOr(bytes).pipe(Option.flatten)))).toEqual([
			false,
			true,
			true,
		]);
		expect(Option.isSome(await forkOf("swarm", id, "rust"))).toBe(true);
		expect(Option.isNone(await forkOf("swarm", id, "go"))).toBe(true);
		expect(Option.isNone(await forkOf("swarm", id, "zig"))).toBe(true);
		// What the pinned fork inherited, read from its own actor: the thread under its key with its outcome, but
		// none of its source's money as its own. The source had settled the thread's two requests; the copy of the
		// thread settled nothing in the fork, and neither the source's swarm nor its forks are added to it. What the
		// fork did settle is its job's, in a conversation of its own, which is the account it gives its source.
		const pinned = Option.getOrThrow(await forkOf("swarm", id, "rust"));
		expect(primed.counts.settledMicros).toBe(
			reservations(state)
				.filter(({ actor }) => actor === source.actorId)
				.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n),
		);
		expect(primed.counts.settledMicros > 0n).toBe(true);
		expect(await run(Client.call(pinned, "outcome", { thread: ThreadKey.make("swarm") }))).toEqual(
			Option.some({ ...primed, counts: { ...primed.counts, settledMicros: 0n } }),
		);
		expect(await run(Client.call(pinned, "forkAccount", null))).toEqual(Option.some(costs[0]));
		// The swarm's coordinator ended in the fork as copied, and runs no job there.
		expect(await run(Client.call(pinned, "probeSwarm", { swarmId: id }))).toEqual({
			alive: false,
			jobKeys: ["rust", "go", "zig"],
		});
		expect(await run(Effect.flip(Client.call(pinned, "swarmResult", { swarmId: id })))).toMatchObject({
			_tag: "ActionFailed",
			error: { _tag: "OperationFailed", operation: "swarmResult", reason: "SwarmFaulted" },
		});
		expect(labs.author.state.callCount).toBe(4);
		// A janitor destroys the pinned fork later, through the fork operation, by its swarm and its job alone: once,
		// with the same answer twice.
		const fork = { swarmId: id, jobKey: Swarm.JobKey.make("rust") };
		const destroyed = await run(remote.forks.destroy(fork));
		expect(Option.getOrThrow(destroyed.bytesWritten)).toBeGreaterThanOrEqual(0);
		expect(await run(remote.forks.destroy({ ...fork, thread: ThreadKey.make("swarm") }))).toEqual(destroyed);
		expect(Option.isNone(await forkOf("swarm", id, "rust"))).toBe(true);
		// Its money outlives it too: per job, and in the thread's own amount, which no longer asks the fork for it.
		expect(await run(remote.swarms.spent(ThreadKey.make("swarm"), id))).toEqual(spent);
		expect(await run(remote.threads.outcome(ThreadKey.make("swarm")))).toEqual(thread);
		// The outcome sink was told of the thread, by the thread's own actor, and of nothing else. A fork is no
		// thread: no event for a job's conversation. And no fork told again of the thread it was copied with, the
		// pinned one included, which was woken and asked for the thread's outcome above.
		const events = await Effect.runPromise(toldEvents(state, reached("Reviewed")));
		expect(events.map((event) => [event.thread, said(event)])).toEqual([
			["swarm", "Started"],
			["swarm", "Reviewed"],
		]);
		expect(new Set(state.told.by)).toEqual(new Set([source.actorId]));
		expect(state.told.calls).toBe(2);
	}, 120_000);

	it("runs a swarm's forks with the agent change of its plan: on the model it names, with those of its tools a fork may have, in its directory and with its compaction settings", async () => {
		// The author primes the thread. The reviewer's lab reviews it and then answers the jobs: the plan names the
		// reviewer's alias as the model of the forks.
		labs.author.setResponses([scripted]);
		labs.reviewer.setResponses([CLEAN, scripted, scripted]);
		await run(
			remote.threads.start(
				work("agents", "Read this record: ...", ["lookup", "write_note"]),
				RequestKey.make("job-1"),
			),
		);
		await ended("agents");
		const id = SwarmId.of(ThreadKey.make("agents"), "covers-1");
		const plan = {
			id,
			thread: ThreadKey.make("agents"),
			jobs: JOBS.slice(0, 2),
			cap: 2,
			onFailure: "collect",
			// A fork may have all its thread holds.
			fork: { tools: [ToolName.make("lookup"), ToolName.make("write_note")], cap: FORK.cap },
		} as const;
		// A change that is no data does not cross: nothing is sent.
		expect(await run(Effect.flip(remote.swarms.run(Covers, { ...plan, agent: { maxTurns: 0 } })))).toMatchObject({
			_tag: "InvalidPlan",
			swarmId: id,
		});
		expect(await run(Effect.flip(remote.swarms.probe(id)))).toMatchObject({ reason: "SwarmNotFound" });
		// Data that names a tool nothing is installed under crosses, and the actor refuses it: nothing is stored.
		expect(
			await run(Effect.flip(remote.swarms.run(Covers, { ...plan, agent: { tools: [ToolName.make("lokup")] } }))),
		).toEqual(
			new OperationFailed({
				operation: "runSwarm",
				reason: "InvalidPlan",
				message: "Swarm agents/covers-1 cannot start: Nothing is installed under: tool lokup",
			}),
		);
		expect(await run(Effect.flip(remote.swarms.probe(id)))).toMatchObject({ reason: "SwarmNotFound" });
		// Settings that change nothing a short job does: no compaction, and a directory without an environment.
		const compaction = {
			enabled: false,
			modelOverrides: { [`${REVIEWER.provider}/${REVIEWER.modelId}`]: { backgroundTokens: 0 } },
		};
		const started = await run(
			remote.swarms.run(Covers, {
				...plan,
				agent: {
					model: REVIEWER,
					thinkingLevel: "low",
					instructions: "Answer with the JSON object alone.",
					cwd: "/covers",
					maxTurns: 3,
					compaction,
					// One tool a fork may have, by its name, and one it may not, by an object that carries its name:
					// neither the thread's grant nor the allowance has `transfer`.
					tools: [ToolName.make("lookup"), { name: ToolName.make("transfer") }],
				},
			}),
		);
		const outcome = await fannedIn(id);
		expect(started).toEqual({ created: true });
		expect(outcome.jobs).toEqual([
			{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } },
			{ _tag: "Success", key: "go", value: { topic: "Go", covered: true } },
		]);
		// Each fork was offered what the plan names of what it may have: `lookup`, and neither `write_note`, which the
		// plan leaves out, nor `transfer`, which the fork setup takes away.
		expect(["Rust", "Go"].map((topic) => shown.get(topic)?.tools)).toEqual([["lookup"], ["lookup"]]);
		// Each fork's conversation, in its own actor, had the plan's directory and compaction settings stored when it
		// asked.
		expect(["Rust", "Go"].map((topic) => configured.get(topic))).toEqual([
			{ cwd: "/covers", compaction },
			{ cwd: "/covers", compaction },
		]);
		// The jobs ran on the model the plan names: the author's lab served the priming alone, and each fork's actor
		// reserved and settled one request to the reviewer's alias, which its route served.
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([1, 3]);
		const actors: ReadonlyArray<string> = outcome.forks.map((fork) => fork.forkId);
		expect(new Set(actors).size).toBe(2);
		expect(
			reservations(state)
				.filter(({ actor }) => actor !== undefined && actors.includes(actor))
				.map(({ request, settlements }) => [request.provider, request.model, settlements.length]),
		).toEqual([
			[REVIEWER.provider, REVIEWER.modelId, 1],
			[REVIEWER.provider, REVIEWER.modelId, 1],
		]);
		expect(
			deliveries()
				.filter(({ actor }) => actor !== undefined && actors.includes(actor))
				.flatMap(({ record }) => (record._tag === "ModelCall" ? [[record.provider, record.model]] : [])),
		).toEqual([
			[JUDGE.provider, JUDGE.modelId],
			[JUDGE.provider, JUDGE.modelId],
		]);
	}, 120_000);

	it("stops a fork at the cap its setup gave it: its job fails, and what it settled is its own", async () => {
		labs.author.setResponses([
			scripted,
			// The job's first answer is no JSON: the correction the swarm asks for would be the fork's second request.
			answer("It covers Rust, I think."),
		]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("capped", "Read this record: ...", []), RequestKey.make("job-1")));
		await ended("capped");
		const source = await actorOf("capped");
		const [job] = JOBS;
		await run(
			remote.swarms.run(Covers, {
				id: Swarm.SwarmId.make("capped/covers-2"),
				thread: ThreadKey.make("capped"),
				jobs: [job],
				cap: 1,
				onFailure: "collect",
				fork: { tools: [], cap: 1n },
			}),
		);
		const outcome = await fannedIn(Swarm.SwarmId.make("capped/covers-2"));
		// The check is against settled amounts: the request that crosses the cap is served, the next one is refused,
		// inside the fork's actor, by the share the fork setup wrote there.
		expect(outcome.jobs).toMatchObject([{ _tag: "Failure", key: "rust", reason: "unanswered" }]);
		expect(labs.author.state.callCount).toBe(2);
		const [fork] = reservations(state).filter(({ actor }) => actor !== source.actorId);
		const cost = fork?.settlements[0]?.cost ?? 0n;
		expect(cost > 1n).toBe(true);
		expect(await run(remote.swarms.spent(Swarm.SwarmId.make("capped/covers-2")))).toEqual([
			{ key: "rust", settledMicros: Option.some(cost) },
		]);
		expect(reservations(state).filter(({ actor }) => actor !== source.actorId)).toHaveLength(1);
		// The refused request is an error entry of the fork, delivered by the fork with the budget's own sentence.
		const [refused] = deliveries().filter(
			({ record }) => record._tag === "ModelCall" && record.stopReason === "error" && record.provider === "router",
		);
		expect(refused?.actor).toBe(fork?.actor);
		expect(refused?.record).toMatchObject({
			error: expect.stringContaining("the conversation has used up its share"),
		});
	}, 120_000);

	it("cancels a swarm while its jobs work: nothing new starts, every job says so, and its forks are destroyed", async () => {
		const stuck = [held(answer("never")), held(answer("never"))];
		labs.author.setResponses([scripted, ...stuck.map((turn) => turn.response)]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("stopped", "Read this record: ...", []), RequestKey.make("job-1")));
		await ended("stopped");
		await run(
			remote.swarms.run(Covers, {
				id: Swarm.SwarmId.make("stopped/covers-3"),
				thread: ThreadKey.make("stopped"),
				jobs: JOBS,
				cap: 2,
				onFailure: "collect",
				fork: FORK,
			}),
		);
		// Two forks work, under the cap; the third job has not started.
		await Effect.runPromise(Effect.forEach(stuck, (turn) => turn.requested));
		expect(await run(remote.swarms.cancel(Swarm.SwarmId.make("stopped/covers-3")))).toBe("cancelling");
		const outcome = await fannedIn(Swarm.SwarmId.make("stopped/covers-3"));
		expect(outcome.ending).toBe("cancelled");
		expect(outcome.jobs.map((job) => [job.key, job._tag, job._tag === "Failure" ? job.reason : ""])).toEqual([
			["rust", "Failure", "cancelled"],
			["go", "Failure", "cancelled"],
			["zig", "Failure", "cancelled"],
		]);
		expect(outcome.forks.map((fork) => fork.fate)).toEqual(["destroyed", "destroyed"]);
		expect(await run(remote.swarms.probe(Swarm.SwarmId.make("stopped/covers-3")))).toEqual({
			alive: false,
			jobKeys: ["rust", "go", "zig"],
		});
		expect(await run(remote.swarms.cancel(ThreadKey.make("stopped"), Swarm.SwarmId.make("stopped/covers-3")))).toBe(
			"ended",
		);
		for (const { key } of JOBS) expect(Option.isNone(await forkOf("stopped", "stopped/covers-3", key))).toBe(true);
		// The third job never reached a provider; the two requests in flight were aborted and settled.
		expect(labs.author.state.callCount).toBe(3);
		expect(reservations(state).map(({ settlements }) => settlements.map((settled) => settled.outcome))).toEqual([
			["returned"],
			["returned"],
			["aborted"],
			["aborted"],
		]);
		// The two forks that worked had a share with nothing settled; the job that never started had no fork.
		expect(await run(remote.swarms.spent(Swarm.SwarmId.make("stopped/covers-3")))).toEqual([
			{ key: "rust", settledMicros: Option.some(0n) },
			{ key: "go", settledMicros: Option.some(0n) },
			{ key: "zig", settledMicros: Option.none() },
		]);
	}, 120_000);

	it("keeps the threads its product's key function names in one actor, given its work by a product action before any of them starts", async () => {
		labs.author.setResponses(Array.from({ length: 3 }, () => scripted));
		labs.reviewer.setResponses([CLEAN, CLEAN]);
		const product = await run(Remote.product(Desk, { actorKey: deskOf }));
		// No actor yet: a product action creates none unless it is asked to, and a probe creates none either.
		expect(await run(Effect.flip(product.call(ThreadKey.make("front/a"), "desk", { threads: [] })))).toEqual(
			new ThreadNotFound({ thread: ThreadKey.make("front/a") }),
		);
		expect(await run(desks.threads.probe(ThreadKey.make("front/a")))).toEqual({ alive: false });
		expect(await run(Client.find(Desk, ["front"]))).toEqual(Option.none());
		// The product gives the actor what it works from before `start`: the actor is created by that call.
		expect(
			await run(product.callOrCreate(ThreadKey.make("front/a"), "brief", { text: "Read this record: ..." })),
		).toBeNull();
		const desk = Option.getOrThrow(await run(Client.find(Desk, ["front"])));
		// The product's own Layer was built on the actor's open harness, on the composition's services, at its wake.
		expect(opened).toEqual([{ actor: desk.actorId, alive: false }]);
		expect(await run(product.call(ThreadKey.make("front/b"), "desk", { threads: ["front/a", "front/b"] }))).toEqual({
			key: ["front"],
			brief: "Read this record: ...",
			alive: [false, false],
		});
		// Two threads of the desk: each has its own key, conversation and outcome, in the one actor.
		const first = await run(
			desks.threads.start(work("front/a", "Read this record: ...", []), RequestKey.make("job-a")),
		);
		const second = await run(
			desks.threads.start(work("front/b", "Read that record: ...", []), RequestKey.make("job-b")),
		);
		expect([first, second]).toEqual([
			{ created: true, key: "job-a" },
			{ created: true, key: "job-b" },
		]);
		const outcomes = [
			await run(desks.threads.ended(ThreadKey.make("front/a"), POLL)),
			await run(desks.threads.ended(ThreadKey.make("front/b"), POLL)),
		];
		expect(outcomes.map((outcome) => [outcome._tag, outcome.counts.turns])).toEqual([
			["Reviewed", 1],
			["Reviewed", 1],
		]);
		expect(await run(Client.find(Desk, ["front/a"]))).toEqual(Option.none());
		expect(await run(Client.find(Desk, ["front/b"]))).toEqual(Option.none());
		expect(new Set(deliveries().map(({ actor }) => actor))).toEqual(new Set([desk.actorId]));
		const events = await Effect.runPromise(toldEvents(state, (told) => told.length === 4));
		expect(new Set(state.told.by)).toEqual(new Set([desk.actorId]));
		expect(events.map((event) => [said(event), event.thread, event.key]).sort()).toEqual([
			["Reviewed", "front/a", "job-a"],
			["Reviewed", "front/b", "job-b"],
			["Started", "front/a", "job-a"],
			["Started", "front/b", "job-b"],
		]);
		// A product action runs on the composition's own services: it reads both threads from the actor's storage.
		expect(
			await run(product.call(ThreadKey.make("front/a"), "desk", { threads: ["front/a", "front/b", "front/c"] })),
		).toEqual({
			key: ["front"],
			brief: "Read this record: ...",
			alive: [false, false, false],
		});
		// A swarm of one of the threads: its id names the thread, the thread names the desk, and its fork is an actor
		// fork of the desk's actor, under the actor's own key. So every operation finds it by the swarm id alone.
		const id = SwarmId.of(ThreadKey.make("front/a"), "covers-1");
		expect(id).toBe("front/a/covers-1");
		const started = await run(
			desks.swarms.run(Covers, {
				id,
				thread: ThreadKey.make("front/a"),
				jobs: [{ key: Swarm.JobKey.make("rust"), input: { topic: "Rust" } }],
				cap: 1,
				onFailure: "collect",
				pins: [Swarm.JobKey.make("rust")],
				fork: FORK,
			}),
		);
		expect(started).toEqual({ created: true });
		const result = Option.getOrThrow(
			await run(Effect.repeat(desks.swarms.result(Covers, id), { until: Option.isSome, schedule: POLL })),
		);
		expect(result.jobs).toEqual([{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } }]);
		expect(await run(desks.swarms.probe(id))).toEqual({ alive: false, jobKeys: ["rust"] });
		const fork = Option.getOrThrow(
			await run(Client.find(Desk, Rivet.forkKey(["front"], id, Swarm.JobKey.make("rust")))),
		);
		expect(result.forks.map((made) => [made.jobKey, made.fate, made.forkId])).toEqual([
			["rust", "pinned", fork.actorId],
		]);
		expect(streams).toEqual([{ actor: fork.actorId, source: desk.actorId }]);
		// In the fork too, once, at its wake: not while its hygiene ran on the copied storage.
		expect(opened.map((wake) => wake.actor)).toEqual([desk.actorId, fork.actorId]);
		// The fork holds what the product kept in the desk's database when it was copied.
		expect(await run(Client.call(fork, "desk", { threads: [] }))).toMatchObject({
			key: ["front", "swarm", id, "rust"],
			brief: "Read this record: ...",
		});
		const destroyed = await run(desks.forks.destroy({ swarmId: id, jobKey: Swarm.JobKey.make("rust") }));
		expect(Option.isSome(destroyed.bytesWritten)).toBe(true);
		expect(await run(Client.find(Desk, Rivet.forkKey(["front"], id, Swarm.JobKey.make("rust"))))).toEqual(
			Option.none(),
		);
		expect(await run(desks.forks.destroy({ swarmId: id, jobKey: Swarm.JobKey.make("rust") }))).toEqual(destroyed);
	}, 120_000);

	it("never forks a thread's actor while the thread has a request in flight, a parked call or a held answer", async () => {
		const turn = held(answer("I have read it."));
		labs.author.setResponses([turn.response, scripted]);
		labs.reviewer.setResponses([CLEAN]);
		await run(remote.threads.start(work("busy", "Read this record: ...", []), RequestKey.make("job-1")));
		await Effect.runPromise(turn.requested);
		const handle = await actorOf("busy");
		// The host's idle rule: an unsettled submission and a live generation refuse a fork, so no request is copied
		// in flight. `Client.fork` says how much is live.
		const refused = await run(Effect.flip(Client.fork(handle, { key: ["busy", "copy"] })));
		expect(refused).toBeInstanceOf(NotIdle);
		expect(refused).toMatchObject({ actorId: handle.actorId, submissions: 1 });
		expect(refused._tag === "NotIdle" && refused.tasks > 0).toBe(true);
		expect(Option.isNone(await run(Client.find(Thread, ["busy", "copy"])))).toBe(true);
		// A swarm started on the working thread waits for it: its coordinator runs, and no fork is made.
		const [job] = JOBS;
		await run(
			remote.swarms.run(Covers, {
				id: Swarm.SwarmId.make("busy/covers-4"),
				thread: ThreadKey.make("busy"),
				jobs: [job],
				cap: 1,
				onFailure: "collect",
				fork: FORK,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(await run(remote.swarms.probe(Swarm.SwarmId.make("busy/covers-4")))).toEqual({
			alive: true,
			jobKeys: ["rust"],
		});
		expect(Option.isNone(await forkOf("busy", "busy/covers-4", "rust"))).toBe(true);
		expect(streams).toEqual([]);
		// Once the thread has ended, the fork is made, of a transcript that holds the thread's whole answer.
		await Effect.runPromise(turn.release);
		const outcome = await fannedIn(Swarm.SwarmId.make("busy/covers-4"));
		expect(outcome.jobs).toEqual([{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } }]);
		expect(shown.get("Rust")?.transcript.slice(0, 2)).toEqual([
			"user: Read this record: ...",
			"assistant: I have read it.",
		]);
		// The request that was in flight was sent once, by the thread's actor alone.
		expect(labs.author.state.callCount).toBe(2);
		expect(await ended("busy")).toMatchObject({ _tag: "Reviewed", counts: { turns: 1 } });

		// A parked call is live work too: an actor that waits for a person is not forked.
		labs.author.setResponses([toolCall("transfer", { to: "bob", amount: 250 }, { id: "call-1" })]);
		await run(remote.threads.start(work("waiting", "Send bob 250.", ["transfer"]), RequestKey.make("job-1")));
		await Effect.runPromise(Queue.take(state.inbox));
		const waiting = await actorOf("waiting");
		await parked(waiting);
		expect(await run(Effect.flip(Client.fork(waiting, { key: ["waiting", "copy"] })))).toMatchObject({
			_tag: "NotIdle",
			submissions: 1,
		});
		await run(remote.threads.cancel(ThreadKey.make("waiting")));
		expect(await ended("waiting")).toMatchObject({ _tag: "Cancelled" });
		// Idle again, it is forked: the rule is about work in flight, not about the actor.
		const copy = await run(Client.fork(waiting, { key: ["waiting", "copy"] }));
		expect(copy.actorId).not.toBe(waiting.actorId);
		await run(Client.destroy(copy));
	}, 120_000);

	// The PRD's fork and swarm test (sections 8, 10 and 11), through the composition: 50 forks of a thread of 30
	// entries, cap 8.
	it("runs 50 jobs on actor forks of a primed thread of 30 entries under a cap of 8", async () => {
		const ROUNDS = 14;
		// The thread reads its record in fourteen tool rounds, then answers: 1 input, 15 responses, 14 tool results.
		const author: FauxResponseFactory = (context, options, counts, model) => {
			const last = context.messages.findLast((message) => message.role === "user");
			if (last !== undefined && /cover \w+\?/.test(JSON.stringify(last.content))) {
				return scripted(context, options, counts, model);
			}
			const results = context.messages.filter((message) => message.role === "toolResult").length;
			return results < ROUNDS
				? toolCall("lookup", { id: String(results) }, { id: `call-${results}` })
				: answer("I have read it.");
		};
		labs.author.setResponses(Array.from({ length: 80 }, () => author));
		labs.reviewer.setResponses([CLEAN]);
		const topics = Array.from({ length: 50 }, (_, index) => `T${index}`);
		const jobs = topics.map((topic) => ({ key: Swarm.JobKey.make(topic.toLowerCase()), input: { topic } }));
		const pins = [Swarm.JobKey.make("t0"), Swarm.JobKey.make("t49")];
		const started = performance.now();
		await run(
			remote.threads.start({ ...work("fifty", "Read this record: ..."), maxTurns: 20 }, RequestKey.make("job-1")),
		);
		const primed = await ended("fifty");
		const primedAt = performance.now();
		await run(
			remote.swarms.run(Covers, {
				id: Swarm.SwarmId.make("fifty/all"),
				thread: ThreadKey.make("fifty"),
				jobs,
				cap: 8,
				onFailure: "fail",
				pins,
				fork: { tools: [ToolName.make("lookup")], cap: FORK.cap },
			}),
		);
		const outcome = await fannedIn(Swarm.SwarmId.make("fifty/all"));
		const swarmMillis = performance.now() - primedAt;
		const totalMillis = performance.now() - started;
		console.log(
			`50-fork swarm through the composition (${runtime}): ${swarmMillis.toFixed(0)} ms for the swarm, ${totalMillis.toFixed(0)} ms with priming, at most ${load.most} job requests at once`,
		);
		expect(primed).toMatchObject({ _tag: "Reviewed", counts: { turns: ROUNDS + 1, toolCalls: ROUNDS } });
		// 50 typed results, in job order.
		expect(outcome.ending).toBe("completed");
		expect(outcome.jobs).toEqual(
			topics.map((topic) => ({ _tag: "Success", key: topic.toLowerCase(), value: { topic, covered: true } })),
		);
		// Every fork saw the thread's 30 entries and then its job, each job was asked once, and the cap held.
		expect(topics.map((topic) => shown.get(topic)?.transcript.length)).toEqual(topics.map(() => 2 * ROUNDS + 3));
		expect(labs.author.state.callCount).toBe(ROUNDS + 1 + 50);
		expect(load.most).toBeLessThanOrEqual(8);
		expect(streams).toHaveLength(50);
		// Unpinned forks are destroyed, pinned ones are kept; the money of every job is known, to the micro unit.
		expect(outcome.forks.filter((fork) => fork.fate === "destroyed")).toHaveLength(48);
		expect(outcome.forks.filter((fork) => fork.fate === "pinned").map((fork) => fork.jobKey)).toEqual(pins);
		const source = await actorOf("fifty");
		const spent = await run(remote.swarms.spent(Swarm.SwarmId.make("fifty/all")));
		const byForks = reservations(state)
			.filter(({ actor }) => actor !== source.actorId)
			.reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(spent.map((job) => job.key)).toEqual(jobs.map((job) => job.key));
		expect(spent.every((job) => Option.isSome(job.settledMicros))).toBe(true);
		expect(spent.reduce((sum, job) => sum + Option.getOrThrow(job.settledMicros), 0n)).toBe(byForks);
		// Each fork delivered the three records of its job, and the advisory one, once.
		const byFork = deliveries().filter(({ actor }) => actor !== source.actorId);
		expect(byFork).toHaveLength(50 * 4);
		expect(new Set(byFork.map(({ actor, record }) => `${actor} ${record.id}`)).size).toBe(50 * 4);
		// The thread's money is its own and that of all 50 forks, 48 of them from accounts kept before they were
		// destroyed and two asked of the pinned forks: what the lease was told in all.
		expect((await ended("fifty")).counts.settledMicros).toBe(primed.counts.settledMicros + byForks);
		expect(told()).toBe(primed.counts.settledMicros + byForks);
		for (const jobKey of pins) await run(remote.forks.destroy({ swarmId: Swarm.SwarmId.make("fifty/all"), jobKey }));
		expect(totalMillis).toBeLessThan(FIFTY_LIMIT_MILLIS);
	}, 180_000);
}
