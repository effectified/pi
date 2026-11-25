import { Conversation } from "@gunta/pi-durable-effect";
import { describe, expect, it } from "vitest";
import { cancelled, failed, isLive, isSettled, type Job, planned, ranOf } from "../src/job.ts";

const starting: Job = { status: "starting", fork: null, attempts: 1, busy: 0, retryAt: 5 };
const place = { conversationId: Conversation.Id.make(9), actorId: "actor-9" };
const running: Job = {
	status: "running",
	fork: "f1",
	correction: 0,
	wait: { _tag: "Signal", signal: "s" },
	attempts: 0,
	ran: place,
};
const succeeded: Job = { status: "succeeded", fork: "f2", value: { n: 1 }, ran: place };
const gone: Job = failed("f3", "gone", "lost");

describe("a job's state", () => {
	it("is live while its fork may exist and its work has not settled", () => {
		expect([planned, starting, running, succeeded, gone].map(isLive)).toEqual([false, true, true, false, false]);
	});

	it("is settled with a result or a failure", () => {
		expect([planned, starting, running, succeeded, gone].map(isSettled)).toEqual([false, false, false, true, true]);
	});

	it("says where it ran once its fork had accepted a request", () => {
		expect([planned, starting, running, succeeded, gone].map(ranOf)).toEqual([null, null, place, place, null]);
	});

	it("becomes cancelled when it was open, keeping its fork and where it ran, and stays as it is when it had settled", () => {
		const open = { status: "failed", reason: "cancelled", message: "why" };
		expect(cancelled(planned, "why")).toEqual({ ...open, fork: null, ran: null });
		expect(cancelled(starting, "why")).toEqual({ ...open, fork: null, ran: null });
		expect(cancelled(running, "why")).toEqual({ ...open, fork: "f1", ran: place });
		expect(cancelled(succeeded, "why")).toBe(succeeded);
		expect(cancelled(gone, "why")).toBe(gone);
	});
});
