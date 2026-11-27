import type { AgentEvent } from "@effectified/pi-agent";
import { runTest } from "@effectified/pi-ai/testing";
import { type Cause, Deferred, Effect, Queue } from "effect";
import { describe, expect, it } from "vitest";
import { buffered } from "../src/event-buffer.ts";

const start: AgentEvent = { type: "agent_start" };
const turn: AgentEvent = { type: "turn_start" };

describe("buffered", () => {
	it("takes an event at once while the buffer has room, and holds Pi back with a promise when it is full", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const queue = yield* Queue.bounded<AgentEvent, Cause.Done>(1);
				const consumer = new AbortController();
				const emit = buffered(queue, consumer.signal, Effect.never);
				const first = emit(start);
				const second = emit(turn);
				let handed = false;
				const handedOver = second?.then(() => {
					handed = true;
				});
				yield* Effect.yieldNow;
				const waitedWhileFull = !handed;
				const taken = [yield* Queue.take(queue)];
				yield* Effect.promise(() => handedOver ?? Promise.resolve());
				taken.push(yield* Queue.take(queue));
				return { first, waitedWhileFull, taken };
			}),
		);
		expect(seen.first).toBeUndefined();
		expect(seen.waitedWhileFull).toBe(true);
		expect(seen.taken).toEqual([start, turn]);
	});

	it("drops a waiting event once the consumer left, so Pi's run can settle", async () => {
		const size = await runTest(
			Effect.gen(function* () {
				const queue = yield* Queue.bounded<AgentEvent, Cause.Done>(1);
				const consumer = new AbortController();
				const emit = buffered(queue, consumer.signal, Effect.never);
				emit(start);
				const waiting = emit(turn);
				consumer.abort();
				yield* Effect.promise(() => waiting ?? Promise.resolve());
				return yield* Queue.size(queue);
			}),
		);
		expect(size).toBe(1);
	});

	it("drops a waiting event once what runs Pi closes, though the consumer is still there", async () => {
		const size = await runTest(
			Effect.gen(function* () {
				const queue = yield* Queue.bounded<AgentEvent, Cause.Done>(1);
				const consumer = new AbortController();
				const closing = yield* Deferred.make<void>();
				const emit = buffered(queue, consumer.signal, Deferred.await(closing));
				emit(start);
				const waiting = emit(turn);
				yield* Deferred.succeed(closing, undefined);
				yield* Effect.promise(() => waiting ?? Promise.resolve());
				return { size: yield* Queue.size(queue), left: consumer.signal.aborted };
			}),
		);
		expect(size).toEqual({ size: 1, left: false });
	});
});
