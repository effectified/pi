import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ForkRetryLater } from "../src/driver.ts";
import { check, MAX_ATTEMPTS, notifyKey, retryDelay, type Site, start } from "../src/fan-out.ts";
import { type Job, planned } from "../src/job.ts";
import { type Fake, type FakeOptions, fake } from "./fake-driver.ts";
import { Measure, measured, noSetup } from "./support.ts";

const NOW = 10_000;
const job = { index: 4, key: "job-a", input: { word: "a" } };

function site(driver: Fake): Site {
	return {
		work: Measure.work,
		driver: driver.driver,
		swarmId: "s",
		coordinatorTaskId: 7,
		sourceConversationId: 1,
		at: 3,
		agent: Option.none(),
		setup: noSetup,
		now: NOW,
	};
}

const started = (options: FakeOptions, from: Extract<Job, { status: "planned" | "starting" }> = planned) => {
	const driver = fake(options);
	return Effect.runPromise(start(site(driver), job, from)).then((moved) => ({ moved, driver }));
};

describe("keys and delays", () => {
	it("gives each request of each job a signal key of its own", () => {
		expect([notifyKey(0, 0), notifyKey(0, 1), notifyKey(12, 0)]).toEqual(["0.0", "0.1", "12.0"]);
	});

	it("waits as long as the driver says, else twice as long each time, up to half a minute", () => {
		const hinted = new ForkRetryLater({ operation: "fork", reason: "busy", afterMillis: 75 });
		const plain = new ForkRetryLater({ operation: "fork", reason: "busy" });
		expect(retryDelay(hinted, 5)).toBe(75);
		expect([0, 1, 2, 3].map((attempts) => retryDelay(plain, attempts))).toEqual([200, 400, 800, 1600]);
		expect(retryDelay(plain, 20)).toBe(30_000);
	});
});

describe("start", () => {
	it("forks by key, hands the job over under the request id of the job, and runs at the driver's pace", async () => {
		const { moved, driver } = await started({ notice: { pollMillis: 40 } });
		expect(moved).toEqual({
			status: "running",
			fork: "fake-1-job-a",
			correction: 0,
			wait: { _tag: "Poll", at: NOW + 40, everyMillis: 40 },
			attempts: 0,
			ran: null,
		});
		expect([...driver.accepted.keys()]).toEqual(["s/job-a/0"]);
		expect(driver.prompts.get("job-a")?.[0]).toContain("Measure the word a.");
		expect(driver.ats.get("job-a")).toBe(3);
	});

	it("sleeps on the signal a driver names", async () => {
		const { moved } = await started({ notice: "signal" });
		expect(moved).toMatchObject({ status: "running", wait: { _tag: "Signal", signal: "fake.job-settled" } });
	});

	it("keeps a place and asks again later after a retry later, with the fork once it is known", async () => {
		const noFork = await started({ forkFails: () => true });
		expect(noFork.moved).toEqual({ status: "starting", fork: null, attempts: 1, busy: 0, retryAt: NOW + 1 });
		const noRun = await started({ runFails: () => true });
		expect(noRun.moved).toEqual({
			status: "starting",
			fork: "fake-1-job-a",
			attempts: 1,
			busy: 0,
			retryAt: NOW + 1,
		});
		// The next attempt does not ask for the fork again.
		const next = await Effect.runPromise(
			start(site(noRun.driver), job, { status: "starting", fork: "fake-1-job-a", attempts: 1, busy: 0, retryAt: 0 }),
		);
		expect(next).toMatchObject({ status: "starting", attempts: 2 });
		expect(noRun.driver.forkCalls.get("job-a")).toBe(1);
	});

	it("waits out a source that is busy: the answer is not counted, and no number of them fails the job", async () => {
		const busy = await started({ forkBusy: () => true });
		expect(busy.moved).toEqual({ status: "starting", fork: null, attempts: 0, busy: 1, retryAt: NOW + 1 });
		// One counted answer short of failing, and busy for the hundredth time: still waiting, with the same count.
		const long = { status: "starting" as const, fork: null, attempts: MAX_ATTEMPTS - 1, busy: 99, retryAt: 0 };
		expect((await started({ forkBusy: () => true }, long)).moved).toEqual({ ...long, busy: 100, retryAt: NOW + 1 });
		// A counted answer after busy ones starts the pace of the busy wait again.
		expect((await started({ forkFails: () => true }, { ...long, attempts: 2 })).moved).toMatchObject({
			status: "starting",
			attempts: 3,
			busy: 0,
		});
	});

	it("says where the job runs when the driver does, and keeps it for the job's later requests", async () => {
		const place = { conversationId: 12, actorId: "actor-a" };
		const { moved } = await started({ place: () => place });
		expect(moved).toMatchObject({ status: "running", ran: place });
		expect((await started({})).moved).toMatchObject({ status: "running", ran: null });
	});

	it("fails the job when the attempts run out, when the source is gone, and when its input is not the schema's", async () => {
		const last = { status: "starting" as const, fork: null, attempts: MAX_ATTEMPTS - 1, busy: 0, retryAt: 0 };
		expect((await started({ forkFails: () => true }, last)).moved).toEqual({
			status: "failed",
			fork: null,
			reason: "driver-unavailable",
			message: "fork: timed out",
			ran: null,
		});
		expect((await started({ sourceGone: () => true })).moved).toMatchObject({ status: "failed", reason: "gone" });
		const driver = fake();
		const invalid = await Effect.runPromise(start(site(driver), { ...job, input: { word: 5 } }, planned));
		expect(invalid).toMatchObject({ status: "failed", fork: null, reason: "invalid-input" });
		expect(driver.forkCalls.size).toBe(0);
	});
});

describe("check", () => {
	const running = (
		wait: Extract<Job, { status: "running" }>["wait"],
		correction = 0,
	): Extract<Job, { status: "running" }> => ({
		status: "running",
		fork: "fake-1-job-a",
		correction,
		wait,
		attempts: 0,
		ran: null,
	});
	const checked = async (options: FakeOptions, wait: Extract<Job, { status: "running" }>["wait"]) => {
		const driver = fake(options);
		const here = site(driver);
		await Effect.runPromise(start(here, job, planned));
		return { moved: await Effect.runPromise(check(here, job, running(wait))), driver, here };
	};

	it("takes the decoded result of a job that answered", async () => {
		const { moved } = await checked({}, { _tag: "Signal", signal: "x" });
		expect(moved).toEqual({ status: "succeeded", fork: "fake-1-job-a", value: measured("a"), ran: null });
	});

	it("asks again at the job's own pace while it runs, and once a second after a signal that was used up", async () => {
		const still = { job: () => ({ answer: Option.some("{}"), settlesAfterMillis: Infinity }) };
		expect((await checked(still, { _tag: "Poll", at: 0, everyMillis: 30 })).moved).toMatchObject({
			status: "running",
			wait: { _tag: "Poll", at: NOW + 30, everyMillis: 30 },
		});
		expect((await checked(still, { _tag: "Signal", signal: "x" })).moved).toMatchObject({
			status: "running",
			wait: { _tag: "Poll", at: NOW + 1000, everyMillis: 1000 },
		});
	});

	it("keeps its pace through a failed read, and counts it", async () => {
		const { moved } = await checked({ jobFails: () => true }, { _tag: "Poll", at: 0, everyMillis: 30 });
		expect(moved).toMatchObject({
			status: "running",
			attempts: 1,
			wait: { _tag: "Poll", at: NOW + 1, everyMillis: 30 },
		});
	});

	it("asks for a correction under the next request id, and gives up when none is left", async () => {
		const wrong = { job: () => ({ answer: Option.some("no"), settlesAfterMillis: 0 }) };
		const first = await checked(wrong, { _tag: "Signal", signal: "x" });
		expect(first.moved).toMatchObject({ status: "running", correction: 1 });
		expect([...first.driver.accepted.keys()]).toEqual(["s/job-a/0", "s/job-a/1"]);
		const last = await Effect.runPromise(
			check(first.here, job, running({ _tag: "Signal", signal: "x" }, Measure.work.corrections)),
		);
		// The request of the last correction was never handed over, so the fork has no job under it.
		expect(last).toMatchObject({ status: "failed", reason: "gone" });
		const none = { ...first.here, work: { ...Measure.work, corrections: 0 } };
		expect(await Effect.runPromise(check(none, job, running({ _tag: "Signal", signal: "x" })))).toEqual({
			status: "failed",
			fork: "fake-1-job-a",
			reason: "invalid-result",
			message: "The answer holds no JSON value",
			ran: null,
		});
	});

	it("fails a job whose fork settled without an answer, or is gone", async () => {
		const silent = await checked(
			{ job: () => ({ answer: Option.none(), settlesAfterMillis: 0 }) },
			{ _tag: "Signal", signal: "x" },
		);
		expect(silent.moved).toMatchObject({ status: "failed", reason: "unanswered", message: "model_error" });
		const driver = fake();
		const lost = await Effect.runPromise(check(site(driver), job, running({ _tag: "Signal", signal: "x" })));
		expect(lost).toMatchObject({ status: "failed", reason: "gone" });
	});
});
