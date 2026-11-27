import { Conversation, Entry, Task } from "@effectified/pi-durable";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { fates, named, pass, plan } from "../src/cleanup.ts";
import { failed, planned } from "../src/job.ts";
import { ForkId, JobKey, SwarmId } from "../src/ids.ts";
import { fake } from "./fake-driver.ts";
import { keys, noSetup } from "./support.ts";

const swarmId = SwarmId.make("s");

const fork = (jobKey: string) => ({ swarmId, jobKey: JobKey.make(jobKey), forkId: ForkId.make(`id-${jobKey}`) });

describe("clean-up", () => {
	it("keeps the fork of a pinned job and marks every other one for destruction", () => {
		expect(plan([fork("a"), fork("b")], keys("b"))).toEqual([
			{ jobKey: "a", forkId: "id-a", fate: "pending", bytesWritten: null },
			{ jobKey: "b", forkId: "id-b", fate: "pinned", bytesWritten: null },
		]);
	});

	it("names the forks the jobs themselves know, for a driver that cannot list", () => {
		const jobs = [
			planned,
			{ status: "starting" as const, fork: null, attempts: 1, busy: 0, retryAt: 0 },
			{ status: "starting" as const, fork: ForkId.make("f2"), attempts: 1, busy: 0, retryAt: 0 },
			{ status: "succeeded" as const, fork: ForkId.make("f3"), value: 1, ran: null },
			failed(null, "gone", "x"),
			failed(ForkId.make("f5"), "unanswered", "x"),
		];
		expect(named(swarmId, keys("a", "b", "c", "d", "e", "f"), jobs)).toEqual([
			{ swarmId: "s", jobKey: "c", forkId: "f2" },
			{ swarmId: "s", jobKey: "d", forkId: "f3" },
			{ swarmId: "s", jobKey: "f", forkId: "f5" },
		]);
	});

	it("destroys the pending forks in one pass, records the bytes, and leaves a retry later pending", async () => {
		const driver = fake({
			destroyFails: (key) => key === "b",
			bytes: (key) => (key === "a" ? Option.some(7) : Option.none()),
		});
		const made = await Effect.runPromise(
			Effect.forEach(["a", "b", "c", "d"], (jobKey) =>
				driver.driver.fork({
					swarmId,
					jobKey: JobKey.make(jobKey),
					coordinatorTaskId: Task.Id.make(1),
					sourceConversationId: Conversation.Id.make(1),
					at: Entry.Id.make(1),
					agent: Option.none(),
					setup: noSetup,
				}),
			),
		);
		const passed = await Effect.runPromise(pass(driver.driver, swarmId, plan(made, keys("d")), 2));
		expect(passed.disposals.map((disposal) => [disposal.jobKey, disposal.fate, disposal.bytesWritten])).toEqual([
			["a", "destroyed", 7],
			["b", "pending", null],
			["c", "destroyed", null],
			["d", "pinned", null],
		]);
		expect(passed.retries.map((error) => error.operation)).toEqual(["destroy"]);
		expect(driver.destroyCalls.has("d")).toBe(false);
		expect([...driver.forks.keys()]).toEqual(["b", "d"]);
		// A second pass asks only for what is still pending.
		const other = fake();
		const again = await Effect.runPromise(pass(other.driver, swarmId, passed.disposals, 2));
		expect(again.retries).toEqual([]);
		expect(again.disposals.map((disposal) => disposal.fate)).toEqual([
			"destroyed",
			"destroyed",
			"destroyed",
			"pinned",
		]);
		expect([...other.destroyCalls.keys()]).toEqual(["b"]);
	});

	it("says left for what is still pending when the swarm ends", () => {
		expect(fates(plan([fork("a"), fork("b")], keys("b"))).map((fate) => fate.fate)).toEqual(["left", "pinned"]);
	});
});
