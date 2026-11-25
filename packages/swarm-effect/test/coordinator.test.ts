// The coordinator against the fake driver (fake-driver.ts): the proof that the port fits a driver whose forks live
// elsewhere, whose calls fail and are retried, and whose jobs settle later.

import type { EntryId } from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { type Conversation, Extension, Harness, Signal, Task } from "@gunta/pi-durable-effect";
import { TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { destroyInARow, Input } from "../src/coordinator.ts";
import { MAX_ATTEMPTS } from "../src/fan-out.ts";
import * as Swarm from "../src/index.ts";
import { type Fake, fake, Settled } from "./fake-driver.ts";
import { jobsOf, Measure, measured, sleeping, words } from "./support.ts";

const Go = Signal.make("test.go", 1, Schema.Struct({}));

/** A task that keeps its conversation busy until it is signalled: ordinary work of the source. */
const Busy = Task.make({
	name: "test.busy",
	version: 1,
	input: Schema.Struct({}),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("hold") }),
		Schema.Struct({ phase: Schema.Literal("end") }),
	]),
	result: Schema.String,
	initial: () => ({ phase: "hold" as const }),
	phases: {
		hold: () => Effect.succeed(Task.sleep({ state: { phase: "end" as const }, signals: [Go.key("go")] })),
		end: () => Effect.succeed(Task.complete("done")),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

const extensions = [Swarm.extension([Measure]), Extension.make({ name: "test", tasks: [Busy] })] as const;

/** Runs `program` in a harness whose swarms use `driver`. */
function onFake<A, E>(driver: Fake, program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver>): Promise<A> {
	return Effect.runPromise(
		program.pipe(Effect.provide(TestHarness.layer({ extensions }).pipe(Layer.provideMerge(driver.layer)))),
	);
}

/** The root conversation with one entry to fork at. */
const source = Effect.gen(function* () {
	const root = yield* Harness.root;
	const entry = yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
	return { root, entry: entry.id };
});

type Plan = Swarm.Plan<{ readonly word: string }>;

/** A plan over `list` on `root`, with what a test changes. */
function planOf(root: Conversation.Conversation, list: ReadonlyArray<string>, change: Partial<Plan> = {}): Plan {
	return { id: "swarm-1", source: root.id, jobs: jobsOf(list), cap: 3, onFailure: "collect", ...change };
}

/**
 * Starts a swarm of `list` on `driver` and waits for its result, on the test clock: each time the coordinator sleeps
 * until a time, the clock is set to that time. So the swarm runs at its own pace and no faster, and what the fake
 * does after so many milliseconds happens at that point of the swarm, however busy the machine is. Only a swarm that
 * nothing but time wakes can be run so: one that waits for a signal of the test never ends here.
 */
function swarm(driver: Fake, list: ReadonlyArray<string>, change: Partial<Plan> = {}) {
	return runTest(
		Effect.gen(function* () {
			const { root } = yield* source;
			const started = yield* Swarm.start(Measure, planOf(root, list, change));
			const result = yield* Effect.forkChild(Swarm.result(Measure, started.swarmId), { startImmediately: true });
			// The task graph lists live tasks only: the coordinator leaves it when it ends.
			yield* Harness.taskGraph.pipe(
				Stream.map((change) => change.value.tasks[String(started.taskId)]?.state),
				Stream.takeWhile((state) => state !== undefined),
				Stream.runForEach((state) =>
					state?.status === "sleeping" && state.until !== undefined ? TestClock.setTime(state.until) : Effect.void,
				),
			);
			const task = Option.getOrThrow(yield* Harness.getTask(started.taskId));
			return {
				result: yield* Fiber.join(result),
				outcome: task.state.status === "terminal" ? task.state.outcome.status : "live",
			};
		}).pipe(Effect.provide(TestHarness.layer({ extensions }).pipe(Layer.provideMerge(driver.layer)))),
	);
}

const success = (word: string) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) });

const answers = (text: string, settlesAfterMillis = 0) => ({ answer: Option.some(text), settlesAfterMillis });

describe("the cap on live forks", () => {
	it("never has more jobs live than the cap, reaches it, and starts one more when one settles", async () => {
		const list = words(20);
		const driver = fake({ job: (key) => answers(JSON.stringify(measured(key.slice(4))), 6) });
		const { result } = await swarm(driver, list, { cap: 3 });
		expect(driver.maxLive).toBe(3);
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual(list.map(success));
		expect([...driver.created.values()]).toEqual(list.map(() => 1));
	});

	it("runs one job at a time under a cap of 1", async () => {
		const driver = fake({ job: (key) => answers(JSON.stringify(measured(key.slice(4))), 3) });
		const { result } = await swarm(driver, words(5), { cap: 1 });
		expect(driver.maxLive).toBe(1);
		expect(result.jobs).toHaveLength(5);
	});
});

describe("a driver that says retry later", () => {
	it("makes a fork call that failed twice again, and one fork", async () => {
		const driver = fake({ forkFails: (key, call) => key === "job-b" && call <= 2 });
		const { result } = await swarm(driver, ["a", "b", "c"]);
		expect(driver.forkCalls.get("job-b")).toBe(3);
		expect(driver.created.get("job-b")).toBe(1);
		expect(driver.forkCalls.get("job-a")).toBe(1);
		expect(result.jobs).toEqual(["a", "b", "c"].map(success));
	});

	it("finds the fork of a key the driver answers duplicate for, and makes no second copy", async () => {
		// The first call created the fork remotely and its answer was lost: the retry meets a held key.
		const driver = fake({ forkAnswerLost: (key, call) => key === "job-a" && call === 1 });
		const { result } = await swarm(driver, ["a", "b"]);
		expect(driver.forkCalls.get("job-a")).toBe(2);
		expect(driver.created.get("job-a")).toBe(1);
		expect(driver.duplicates.get("job-a")).toBe(1);
		expect(result.jobs).toEqual(["a", "b"].map(success));
		expect(result.forks.map((fork) => fork.jobKey)).toEqual(["job-a", "job-b"]);
	});

	it("hands a job over again by its request id, and the fork starts it once", async () => {
		const driver = fake({ runFails: (key, call) => key === "job-a" && call === 1 });
		const { result } = await swarm(driver, ["a"]);
		expect(driver.runCalls.get("swarm-1/job-a/0")).toBe(2);
		expect(driver.accepted.get("swarm-1/job-a/0")).toBe(1);
		// The fork was made by the first attempt and kept: no second fork call.
		expect(driver.forkCalls.get("job-a")).toBe(1);
		expect(result.jobs).toEqual([success("a")]);
	});

	it("reads a job again after a failed read", async () => {
		const driver = fake({ jobFails: (_key, call) => call === 1 });
		const { result } = await swarm(driver, ["a"]);
		expect(driver.jobCalls.get("swarm-1/job-a/0")).toBe(2);
		expect(result.jobs).toEqual([success("a")]);
	});

	it("fails a job as driver-unavailable when the attempts run out, and goes on with the others", async () => {
		const driver = fake({ forkFails: (key) => key === "job-a" });
		const { result } = await swarm(driver, ["a", "b"]);
		expect(driver.forkCalls.get("job-a")).toBe(MAX_ATTEMPTS);
		expect(result.jobs).toEqual([
			{ _tag: "Failure", key: "job-a", reason: "driver-unavailable", message: "fork: timed out" },
			success("b"),
		]);
		expect(result.ending).toBe("completed");
	});

	it("goes on to the planned jobs when every job it starts fails at once, more of them than the cap", async () => {
		const driver = fake({ sourceGone: (key) => key !== "job-e" });
		const { result, outcome } = await swarm(driver, ["a", "b", "c", "d", "e"], { cap: 2 });
		expect(outcome).toBe("completed");
		expect(result.jobs.map((job) => (job._tag === "Failure" ? job.reason : "success"))).toEqual([
			"gone",
			"gone",
			"gone",
			"gone",
			"success",
		]);
		expect([...driver.forkCalls.values()]).toEqual([1, 1, 1, 1, 1]);
	});

	it("fails a job as gone when the source is gone", async () => {
		const driver = fake({ sourceGone: (key) => key === "job-a" });
		const { result } = await swarm(driver, ["a", "b"]);
		expect(result.jobs[0]).toEqual({
			_tag: "Failure",
			key: "job-a",
			reason: "gone",
			message: "The source of job job-a of swarm swarm-1 is gone: The source actor was destroyed",
		});
		expect(result.jobs[1]).toEqual(success("b"));
	});
});

describe("a job whose result arrives late", () => {
	it("is asked for again and again at the driver's pace, started once, and read when it is there", async () => {
		const driver = fake({
			notice: { pollMillis: 5 },
			job: () => answers(JSON.stringify(measured("a")), 40),
		});
		const { result } = await swarm(driver, ["a"]);
		// Asked every 5 milliseconds after it was accepted, until it settled 40 milliseconds later.
		expect(driver.jobCalls.get("swarm-1/job-a/0")).toBe(8);
		expect(driver.accepted.get("swarm-1/job-a/0")).toBe(1);
		expect(driver.runCalls.get("swarm-1/job-a/0")).toBe(1);
		expect(result.jobs).toEqual([success("a")]);
	});

	it("sleeps on the driver's signal, holding no process, and reads a job once when its signal came", async () => {
		const driver = fake({
			notice: "signal",
			job: (key) => answers(JSON.stringify(measured(key.slice(4))), Infinity),
		});
		const seen = await onFake(
			driver,
			Effect.gen(function* () {
				const { root } = yield* source;
				const started = yield* Swarm.start(Measure, planOf(root, ["a", "b", "c"], { cap: 2 }));
				yield* driver.when(() => driver.accepted.size === 2);
				// Both forks work, the cap is reached: the coordinator is parked, and nothing was asked.
				yield* sleeping(started.taskId, "run");
				const before = { jobCalls: driver.jobCalls.size, forks: driver.created.size };
				for (const key of ["job-a", "job-b", "job-c"]) {
					yield* driver.when(() => (driver.forks.get(key)?.requests.size ?? 0) > 0);
					const notify = Option.getOrThrow(driver.settle(key));
					// What the fork's host does when the job settled: one signal to the coordinator's task.
					const delivered = yield* Harness.signal(started.taskId, Settled, notify.key, {});
					expect(delivered).toBe("delivered");
				}
				return { before, result: yield* Swarm.result(Measure, started.swarmId) };
			}),
		);
		expect(seen.before).toEqual({ jobCalls: 0, forks: 2 });
		expect([...driver.jobCalls.values()]).toEqual([1, 1, 1]);
		expect(driver.maxLive).toBe(2);
		expect(seen.result.jobs).toEqual(["a", "b", "c"].map(success));
	});

	it("asks by itself for a job whose signal came before it settled", async () => {
		const driver = fake({ notice: "signal", job: () => answers(JSON.stringify(measured("a")), Infinity) });
		const result = await onFake(
			driver,
			Effect.gen(function* () {
				const { root } = yield* source;
				const started = yield* Swarm.start(Measure, planOf(root, ["a"]));
				yield* driver.when(() => driver.accepted.size === 1);
				// A signal too early: the key is used up, so the coordinator polls from here on.
				yield* Harness.signal(started.taskId, Settled, "0.0", {});
				yield* driver.when(() => driver.jobCalls.get("swarm-1/job-a/0") === 1);
				driver.settle("job-a");
				return yield* Swarm.result(Measure, started.swarmId);
			}),
		);
		expect(driver.jobCalls.get("swarm-1/job-a/0")).toBe(2);
		expect(result.jobs).toEqual([success("a")]);
	});
});

describe("typed fan-in", () => {
	it("sends an answer that is no JSON back to its fork, and takes the corrected one", async () => {
		const driver = fake({
			job: (_key, requestId) =>
				answers(requestId.endsWith("/0") ? "It has one letter." : `Here: ${JSON.stringify(measured("a"))}`),
		});
		const { result } = await swarm(driver, ["a"]);
		expect(result.jobs).toEqual([success("a")]);
		const prompts = driver.prompts.get("job-a") ?? [];
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("Measure the word a.");
		expect(prompts[0]).toContain("Answer with one JSON value and nothing else");
		expect(prompts[1]).toBe(
			"Your last answer was not accepted:\nThe answer holds no JSON value\nAnswer again with one corrected JSON value and nothing else.",
		);
		expect([...driver.accepted.keys()]).toEqual(["swarm-1/job-a/0", "swarm-1/job-a/1"]);
	});

	it("tells the fork what its JSON lacks", async () => {
		const driver = fake({
			job: (_key, requestId) => answers(requestId.endsWith("/0") ? '{"word":"a"}' : JSON.stringify(measured("a"))),
		});
		const { result } = await swarm(driver, ["a"]);
		expect(result.jobs).toEqual([success("a")]);
		expect((driver.prompts.get("job-a") ?? [])[1]).toContain('["length"]');
	});

	it("fails a job as invalid-result after the corrections, two by default", async () => {
		const driver = fake({ job: () => answers("no") });
		const { result } = await swarm(driver, ["a", "b"], { cap: 1 });
		expect(driver.prompts.get("job-a") ?? []).toHaveLength(3);
		expect(result.jobs).toEqual([
			{ _tag: "Failure", key: "job-a", reason: "invalid-result", message: "The answer holds no JSON value" },
			{ _tag: "Failure", key: "job-b", reason: "invalid-result", message: "The answer holds no JSON value" },
		]);
	});

	it("fails a job as unanswered when its fork settled without an answer", async () => {
		const driver = fake({ job: () => ({ answer: Option.none(), settlesAfterMillis: 0 }) });
		const { result } = await swarm(driver, ["a"]);
		expect(result.jobs).toEqual([{ _tag: "Failure", key: "job-a", reason: "unanswered", message: "model_error" }]);
	});
});

describe("a failed job", () => {
	const failing = (key: string) =>
		key === "job-b"
			? { answer: Option.none(), settlesAfterMillis: 0 }
			: answers(JSON.stringify(measured("x")), Infinity);

	it("fails the swarm under onFailure fail: live forks are cancelled, nothing new starts, cleanup runs", async () => {
		const driver = fake({ job: failing });
		const { result, outcome } = await swarm(driver, ["a", "b", "c", "d", "e"], { cap: 3, onFailure: "fail" });
		expect(outcome).toBe("failed");
		expect(result.ending).toBe("failed");
		expect(result.jobs.map((job) => (job._tag === "Failure" ? job.reason : "success"))).toEqual([
			"cancelled",
			"unanswered",
			"cancelled",
			"cancelled",
			"cancelled",
		]);
		expect([...driver.cancelled].sort()).toEqual(["job-a", "job-c"]);
		// The two jobs that were never started have no fork.
		expect([...driver.created.keys()]).toEqual(["job-a", "job-b", "job-c"]);
		expect([...driver.destroyed].sort()).toEqual(["job-a", "job-b", "job-c"]);
		expect(driver.forks.size).toBe(0);
	});

	it("is one failure in the result under onFailure collect, and every other job is run", async () => {
		const driver = fake({
			job: (key) =>
				key === "job-b"
					? { answer: Option.none(), settlesAfterMillis: 0 }
					: answers(JSON.stringify(measured(key.slice(4)))),
		});
		const { result, outcome } = await swarm(driver, ["a", "b", "c"], { onFailure: "collect" });
		expect(outcome).toBe("completed");
		expect(result.ending).toBe("completed");
		expect(result.jobs).toEqual([
			success("a"),
			{ _tag: "Failure", key: "job-b", reason: "unanswered", message: "model_error" },
			success("c"),
		]);
		expect(driver.cancelled).toEqual([]);
	});
});

describe("clean-up", () => {
	it("destroys every fork that is not pinned, and records the bytes each wrote", async () => {
		const driver = fake({ bytes: (key) => (key === "job-c" ? Option.none() : Option.some(key.length * 100)) });
		const { result } = await swarm(driver, ["a", "b", "c"], { pins: ["job-b"] });
		expect(result.forks).toEqual([
			{
				jobKey: "job-a",
				forkId: "fake-1-job-a",
				fate: "destroyed",
				bytesWritten: Option.some(500),
				ran: Option.none(),
			},
			{ jobKey: "job-b", forkId: "fake-2-job-b", fate: "pinned", bytesWritten: Option.none(), ran: Option.none() },
			{
				jobKey: "job-c",
				forkId: "fake-3-job-c",
				fate: "destroyed",
				bytesWritten: Option.none(),
				ran: Option.none(),
			},
		]);
		expect([...driver.forks.keys()]).toEqual(["job-b"]);
		expect(driver.destroyCalls.has("job-b")).toBe(false);
	});

	it("destroys again a fork whose destroy said retry later, and lists again", async () => {
		const driver = fake({
			listFails: (call) => call === 1,
			destroyFails: (key, call) => key === "job-a" && call <= 2,
		});
		const { result } = await swarm(driver, ["a", "b"]);
		expect(driver.listCalls).toBe(2);
		expect(driver.destroyCalls.get("job-a")).toBe(3);
		expect(driver.destroyCalls.get("job-b")).toBe(1);
		expect(result.forks.map((fork) => fork.fate)).toEqual(["destroyed", "destroyed"]);
		expect(driver.forks.size).toBe(0);
	});

	it("destroys a fork the coordinator never saw created", async () => {
		// Every fork call of the job creates the fork and loses the answer, so the job fails without a fork id.
		const driver = fake({ forkAnswerLost: (key) => key === "job-a" });
		const { result } = await swarm(driver, ["a", "b"]);
		expect(result.jobs[0]).toMatchObject({ _tag: "Failure", reason: "driver-unavailable" });
		expect(driver.created.get("job-a")).toBe(1);
		expect(result.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual([
			["job-a", "destroyed"],
			["job-b", "destroyed"],
		]);
		expect(driver.forks.size).toBe(0);
	});

	it("leaves a fork the driver cannot destroy, and says so", async () => {
		const driver = fake({ destroyFails: (key) => key === "job-a" });
		const { result, outcome } = await swarm(driver, ["a", "b"]);
		expect(outcome).toBe("completed");
		expect(result.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual([
			["job-a", "left"],
			["job-b", "destroyed"],
		]);
		expect(driver.destroyCalls.get("job-a")).toBe(MAX_ATTEMPTS);
		expect([...driver.forks.keys()]).toEqual(["job-a"]);
	});
});

describe("the source", () => {
	it("is forked only once it is idle: a busy source keeps the coordinator in its first phase", async () => {
		const driver = fake();
		const seen = await onFake(
			driver,
			Effect.gen(function* () {
				const { root } = yield* source;
				const busy = yield* root.commit((tx) => tx.createTask(Busy, {}, { ownership: { kind: "conversation" } }));
				yield* Harness.resume;
				const started = yield* Swarm.start(Measure, planOf(root, ["a"]));
				// Past the time the coordinator holds its process for a source about to be idle, it sleeps.
				yield* sleeping(started.taskId, "idle");
				const waiting = yield* Swarm.status(started.swarmId);
				const task = Option.getOrThrow(yield* Harness.getTask(started.taskId));
				const forksWhileBusy = driver.forkCalls.size;
				yield* Harness.signal(busy, Go, "go", {});
				const result = yield* Swarm.result(Measure, started.swarmId);
				return { waiting, parked: task.state.status, forksWhileBusy, result };
			}),
		);
		expect(seen.waiting).toMatchObject({ running: true, phase: "idle" });
		expect(seen.waiting.jobs).toEqual([
			{ key: "job-a", status: "planned", reason: Option.none(), ran: Option.none() },
		]);
		expect(seen.parked).toBe("sleeping");
		expect(seen.forksWhileBusy).toBe(0);
		expect(seen.result.jobs).toEqual([success("a")]);
	});

	it("that never gets idle keeps the swarm waiting until it is cancelled, with no fork made", async () => {
		const driver = fake();
		const seen = await onFake(
			driver,
			Effect.gen(function* () {
				const { root } = yield* source;
				yield* root.commit((tx) => tx.createTask(Busy, {}, { ownership: { kind: "conversation" } }));
				yield* Harness.resume;
				const started = yield* Swarm.start(Measure, planOf(root, ["a", "b"]));
				yield* sleeping(started.taskId, "idle");
				const cancelled = yield* Swarm.cancel(started.swarmId);
				const result = yield* Swarm.result(Measure, started.swarmId);
				return { cancelled, result, status: yield* Swarm.status(started.swarmId) };
			}),
		);
		expect(seen.cancelled).toBe("cancelling");
		expect(seen.result.ending).toBe("cancelled");
		expect(seen.result.jobs).toEqual(
			["a", "b"].map((word) => ({
				_tag: "Failure",
				key: `job-${word}`,
				reason: "cancelled",
				message: "The swarm was cancelled",
			})),
		);
		expect(driver.forkCalls.size).toBe(0);
		expect(seen.status).toMatchObject({ running: false, phase: "ended" });
	});

	it("that is busy when a fork is asked for is waited out, for more answers than fail a job, and the job says where it stands", async () => {
		// A driver that forks only a source with nothing in flight: busy until the test says otherwise.
		let busy = true;
		const driver = fake({ forkBusy: () => busy, place: () => ({ conversationId: 3, actorId: "actor-b" }) });
		const seen = await onFake(
			driver,
			Effect.gen(function* () {
				const { root } = yield* source;
				const started = yield* Swarm.start(Measure, planOf(root, ["a", "b"], { cap: 1 }));
				// More busy answers in a row than "retry later" answers that fail a job as driver-unavailable.
				yield* driver.when(() => (driver.forkCalls.get("job-a") ?? 0) > MAX_ATTEMPTS * 2);
				const waiting = yield* Swarm.status(started.swarmId);
				busy = false;
				const result = yield* Swarm.result(Measure, started.swarmId);
				return { waiting, result, after: yield* Swarm.status(started.swarmId) };
			}),
		);
		// The swarm is in its fan-out, the job holds its place under the cap, and nothing was created.
		expect(seen.waiting).toMatchObject({ running: true, phase: "run" });
		expect(seen.waiting.jobs.map((job) => job.status)).toEqual(["starting", "planned"]);
		expect(driver.created.size).toBe(2);
		expect(seen.result.ending).toBe("completed");
		expect(seen.result.jobs).toEqual([success("a"), success("b")]);
		// Where each job ran, as the driver said it: readable from the status and from the result.
		const ran = Option.some({ conversationId: 3, actorId: "actor-b" });
		expect(seen.after.jobs.map((job) => job.ran)).toEqual([ran, ran]);
		expect(seen.result.forks.map((fork) => fork.ran)).toEqual([ran, ran]);
	});

	it("that stays busy in the fan-out is ended by a cancel, as a source that never gets idle is", async () => {
		const driver = fake({ forkBusy: () => true });
		const seen = await onFake(
			driver,
			Effect.gen(function* () {
				const { root } = yield* source;
				const started = yield* Swarm.start(Measure, planOf(root, ["a"]));
				yield* driver.when(() => (driver.forkCalls.get("job-a") ?? 0) > MAX_ATTEMPTS);
				const cancelling = yield* Swarm.cancel(started.swarmId);
				return { cancelling, result: yield* Swarm.result(Measure, started.swarmId) };
			}),
		);
		expect(seen.cancelling).toBe("cancelling");
		expect(seen.result.ending).toBe("cancelled");
		expect(seen.result.jobs).toMatchObject([{ _tag: "Failure", key: "job-a", reason: "cancelled" }]);
		expect(driver.created.size).toBe(0);
	});

	it("is forked at its newest entry by default, and at the plan's entry when it names one", async () => {
		const driver = fake();
		const ats = await onFake(
			driver,
			Effect.gen(function* () {
				const { root, entry: first } = yield* source;
				const second = (yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.later" }))).id;
				yield* Swarm.start(Measure, planOf(root, ["a"], { id: "newest" }));
				yield* Swarm.result(Measure, "newest");
				const newest = driver.ats.get("job-a");
				yield* Swarm.start(Measure, planOf(root, ["b"], { id: "named", at: first }));
				yield* Swarm.result(Measure, "named");
				return { first, second, newest, named: driver.ats.get("job-b") };
			}),
		);
		expect(ats.newest).toBe(ats.second);
		expect(ats.named).toBe(ats.first);
	});

	it("that is empty, or an entry that is not visible from it, fails the swarm with no fork made", async () => {
		const driver = fake();
		const seen = await onFake(
			driver,
			Effect.gen(function* () {
				const root = yield* Harness.root;
				yield* Swarm.start(Measure, planOf(root, ["a"], { id: "empty" }));
				const empty = yield* Swarm.result(Measure, "empty");
				yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
				// Pi brands ids in the type system only.
				yield* Swarm.start(Measure, planOf(root, ["a"], { id: "blind", at: 999_999 as EntryId }));
				return { empty, blind: yield* Swarm.result(Measure, "blind") };
			}),
		);
		expect(seen.empty.ending).toBe("failed");
		expect(seen.empty.jobs).toEqual([
			{ _tag: "Failure", key: "job-a", reason: "gone", message: "The source conversation is empty" },
		]);
		expect(seen.blind.jobs).toEqual([
			{ _tag: "Failure", key: "job-a", reason: "gone", message: "Entry 999999 is not visible from it" },
		]);
		expect(driver.forkCalls.size).toBe(0);
	});
});

describe("the fork's agent", () => {
	it("reaches the driver with tools and extensions by name, as plain JSON", async () => {
		const driver = fake();
		await swarm(driver, ["a"], {
			agent: {
				model: { provider: "cheap", modelId: "small" },
				tools: [{ name: "read" }, "search"],
				modelTools: { remove: [{ name: "search" }] },
				maxTurns: 3,
			},
		});
		expect(driver.forks.size).toBe(0);
		expect(driver.agents.get("job-a")).toEqual(
			Option.some({
				model: { provider: "cheap", modelId: "small" },
				tools: ["read", "search"],
				modelTools: { remove: ["search"] },
				maxTurns: 3,
			}),
		);
	});

	it("is none when the plan names none", async () => {
		const driver = fake();
		await swarm(driver, ["a"]);
		expect(driver.agents.get("job-a")).toEqual(Option.none());
	});

	it("decodes as stored by a coordinator of the earlier version, which kept it as any JSON", () =>
		runTest(
			Effect.gen(function* () {
				const stored = {
					swarmId: "s",
					jobs: [{ key: "a", input: { word: "a" } }],
					at: 12,
					cap: 1,
					onFailure: "collect",
					pins: [],
					agent: {
						model: { provider: "cheap", modelId: "small" },
						thinkingLevel: null,
						extensions: { add: ["search"], remove: ["write"] },
						tools: { remove: ["bash"] },
						modelTools: ["read"],
						instructions: "Be brief.",
						maxTurns: 3,
						compaction: { enabled: false, modelOverrides: { "cheap/small": { reserveTokens: 0 } } },
					},
				};
				expect(yield* Schema.decodeUnknownEffect(Input)(stored)).toEqual(stored);
				// A change no fork could take, as Pi's `configure` would refuse it, is refused when it is read.
				const refused = yield* Effect.flip(
					Schema.decodeUnknownEffect(Input)({ ...stored, agent: { maxTurns: 0 } }),
				);
				expect(refused._tag).toBe("SchemaError");
			}),
		));
});

describe("the destroys of a cancel", () => {
	const pending = (jobKey: string) => ({
		jobKey,
		forkId: `id-${jobKey}`,
		fate: "pending" as const,
		bytesWritten: null,
	});

	/** The destroy calls of `job-a` after each step of the test clock, while `destroyInARow` runs on `driver`. */
	const callsOver = (driver: Fake, steps: ReadonlyArray<number>) =>
		runTest(
			Effect.gen(function* () {
				const running = yield* Effect.forkChild(destroyInARow(driver.driver, "s", [pending("job-a")], 1), {
					startImmediately: true,
				});
				const calls = [driver.destroyCalls.get("job-a") ?? 0];
				for (const millis of steps) {
					yield* TestClock.adjust(millis);
					calls.push(driver.destroyCalls.get("job-a") ?? 0);
				}
				return { calls, disposals: yield* Fiber.join(running) };
			}),
		);

	it("asks four times in a row, 100, 200 and 400 milliseconds apart, and leaves a fork that stays pending", async () => {
		const { calls, disposals } = await callsOver(fake({ destroyFails: () => true }), [99, 1, 199, 1, 399, 1, 10_000]);
		expect(calls).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
		expect(disposals).toEqual([pending("job-a")]);
	});

	it("stops asking once every fork is destroyed", async () => {
		const driver = fake({ destroyFails: (_key, call) => call <= 2 });
		const { calls, disposals } = await callsOver(driver, [100, 200, 10_000]);
		expect(calls).toEqual([1, 2, 3, 3]);
		expect(disposals).toMatchObject([{ jobKey: "job-a", fate: "destroyed" }]);
	});
});
