import { readFileSync } from "node:fs";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Port from "../src/driver.ts";
import { fake } from "./fake-driver.ts";

describe("the driver port", () => {
	it("imports nothing but effect, Pi's id types, the durable facade and the type of the fork setup", () => {
		const source = readFileSync(new URL("../src/driver.ts", import.meta.url), "utf8");
		const imports = [...source.matchAll(/^import (type )?.* from "([^"]+)";$/gm)].map((match) => [
			match[2],
			match[1] ?? "",
		]);
		expect(imports).toEqual([
			["@earendil-works/pi-durable", "type "],
			["@effectified/pi-durable", ""],
			["effect", ""],
			["./fork-setup.ts", "type "],
		]);
	});

	it("tells retry later from gone by the error's tag, each with a message that names what failed", () => {
		const later = new Port.ForkRetryLater({ operation: "run", reason: "the actor is waking", afterMillis: 50 });
		const gone = new Port.ForkGone({ what: "fork", swarmId: "s", jobKey: "k", reason: "It was destroyed" });
		expect([later._tag, later.message, later.afterMillis]).toEqual([
			"ForkRetryLater",
			"run: the actor is waking",
			50,
		]);
		expect([gone._tag, gone.message]).toEqual(["ForkGone", "The fork of job k of swarm s is gone: It was destroyed"]);
		expect(new Port.ForkRetryLater({ operation: "list", reason: "x" }).afterMillis).toBeUndefined();
		// A busy source is "retry later" too, marked: the coordinator waits it out and does not count it.
		expect(new Port.ForkRetryLater({ operation: "fork", reason: "busy", sourceBusy: true }).sourceBusy).toBe(true);
		expect(later.sourceBusy).toBeUndefined();
	});

	it("has its data as schemas, so a driver can send it across a process boundary", () => {
		const fork = Schema.decodeUnknownSync(Port.Fork);
		const notice = Schema.decodeUnknownSync(Port.Notice);
		const status = Schema.decodeUnknownSync(Port.JobStatus);
		expect(fork({ swarmId: "s", jobKey: "k", forkId: "actor-1" })).toEqual({
			swarmId: "s",
			jobKey: "k",
			forkId: "actor-1",
		});
		expect(notice({ _tag: "Signal", signal: "pi.submission-settled" })._tag).toBe("Signal");
		expect(notice({ _tag: "Poll", afterMillis: 500 })).toEqual({ _tag: "Poll", afterMillis: 500 });
		const statuses = [
			{ _tag: "Unknown" },
			{ _tag: "Running" },
			{ _tag: "Answered", text: "{}" },
			{ _tag: "Unanswered", reason: "aborted" },
		];
		expect(statuses.map((value) => status(value))).toEqual(statuses);
		expect(() => status({ _tag: "Answered" })).toThrow();
	});

	it("reads and writes a place as the JSON it had when its conversation id was a plain number", () => {
		// What a coordinator stored in a job's state, and a driver answered, before the id was typed as Pi's.
		const stored = { conversationId: 3, actorId: "actor-1" };
		const place = Schema.decodeUnknownSync(Port.Place)(stored);
		expect(Schema.encodeSync(Port.Place)(place)).toEqual(stored);
		const notice = { _tag: "Poll", afterMillis: 500, place: { conversationId: 4, actorId: null } };
		expect(Schema.encodeSync(Port.Notice)(Schema.decodeUnknownSync(Port.Notice)(notice))).toEqual(notice);
	});

	it("is a service a product provides with a Layer", async () => {
		const driver = fake();
		const listed = await Effect.runPromise(
			Port.ForkDriver.use((service) => service.list("s")).pipe(
				Effect.provide(Layer.succeed(Port.ForkDriver, driver.driver)),
			),
		);
		expect(listed).toEqual([]);
		expect(
			Option.isNone(
				(await Effect.runPromise(driver.driver.destroy({ swarmId: "s", jobKey: "k", forkId: "x" }))).bytesWritten,
			),
		).toBe(true);
	});
});
