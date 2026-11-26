import { Conversation } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidValue } from "../src/errors.ts";
import { failed } from "../src/job.ts";
import { of, typed } from "../src/outcome.ts";
import { compile } from "../src/work.ts";

const work = compile({
	name: "dates",
	input: Schema.String,
	result: Schema.Struct({ at: Schema.DateTimeUtcFromString }),
	prompt: String,
});

describe("a swarm's result", () => {
	const stored = of(
		"s",
		"completed",
		["k1", "k2"],
		[
			{
				status: "succeeded",
				fork: "f1",
				value: { at: "2026-01-02T00:00:00.000Z" },
				ran: { conversationId: Conversation.Id.make(11), actorId: "actor-1" },
			},
			failed("f2", "unanswered", "model_error"),
		],
		[
			{ jobKey: "k1", forkId: "f1", fate: "destroyed", bytesWritten: 12 },
			{ jobKey: "k2", forkId: "f2", fate: "left", bytesWritten: null },
		],
	);

	it("is stored per job in the order of the keys: a success with its value, or a failure with its reason", () => {
		expect(stored.jobs).toEqual([
			{ _tag: "Success", key: "k1", value: { at: "2026-01-02T00:00:00.000Z" } },
			{ _tag: "Failure", key: "k2", reason: "unanswered", message: "model_error" },
		]);
	});

	it("is typed by the definition's result schema, with bytes as an Option", async () => {
		const outcome = await Effect.runPromise(typed(work, stored));
		expect(outcome.swarmId).toBe("s");
		expect(outcome.ending).toBe("completed");
		const first = outcome.jobs[0];
		expect(first._tag === "Success" ? first.value.at.pipe(String) : "").toContain("2026-01-02");
		expect(outcome.jobs[1]).toEqual({ _tag: "Failure", key: "k2", reason: "unanswered", message: "model_error" });
		expect(outcome.forks.map((fork) => fork.bytesWritten)).toEqual([Option.some(12), Option.none()]);
		// Each fork says where its job ran, from the job of its key: the first job's driver said so, the second's not.
		expect(outcome.forks.map((fork) => fork.ran)).toEqual([
			Option.some({ conversationId: 11, actorId: "actor-1" }),
			Option.none(),
		]);
	});

	it("fails with InvalidValue when a stored value is not the schema's any more", async () => {
		const broken = of(
			"s",
			"completed",
			["k1"],
			[{ status: "succeeded", fork: "f1", value: { at: 5 }, ran: null }],
			[],
		);
		const error = await Effect.runPromise(Effect.flip(typed(work, broken)));
		expect(error).toBeInstanceOf(InvalidValue);
		expect(error.what).toBe("result");
	});
});
