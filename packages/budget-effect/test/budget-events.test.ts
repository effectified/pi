import { Effect, Fiber, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { BudgetEvent, BudgetEvents, BudgetRequest, LeaseFenced, Reservation } from "../src/index.ts";

const REQUEST = Schema.decodeSync(BudgetRequest)({
	kind: "chat",
	provider: "acme",
	model: "large",
	session: "s-1",
	conversation: 3,
});

const R1 = Reservation.make("r1");

const EVENTS: ReadonlyArray<BudgetEvent> = [
	{ _tag: "Reserved", request: REQUEST, reservation: R1, estimate: 50_000n, currency: "USD", at: 1 },
	{
		_tag: "Settled",
		request: REQUEST,
		reservation: R1,
		estimate: 50_000n,
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
		cost: 60n,
		outcome: "returned",
		currency: "USD",
		at: 2,
	},
	{ _tag: "Refused", request: REQUEST, refusal: new LeaseFenced({ reason: "expired" }), at: 3 },
];

describe("BudgetEvents", () => {
	it("hands every event to every subscriber, in order, from the moment each subscribed", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const hub = yield* BudgetEvents;
					const early = yield* hub.subscribe;
					yield* hub.publish(EVENTS[0] as BudgetEvent);
					const late = yield* hub.subscribe;
					yield* hub.publish(EVENTS[1] as BudgetEvent);
					yield* hub.publish(EVENTS[2] as BudgetEvent);
					expect(yield* Stream.runCollect(Stream.take(early, 3))).toEqual(EVENTS);
					expect(yield* Stream.runCollect(Stream.take(late, 2))).toEqual(EVENTS.slice(1));
				}),
			).pipe(Effect.provide(BudgetEvents.layer)),
		));

	it("gives the events as a Stream that starts when it runs", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const hub = yield* BudgetEvents;
				// Started at once, the reader subscribes before the fork returns.
				const reader = yield* Effect.forkChild(Stream.runCollect(Stream.take(hub.stream, 1)), {
					startImmediately: true,
				});
				yield* hub.publish(EVENTS[2] as BudgetEvent);
				expect(yield* Fiber.join(reader)).toEqual([EVENTS[2]]);
			}).pipe(Effect.provide(BudgetEvents.layer)),
		));

	it("is data: every event encodes to JSON and decodes back", () => {
		const codec = Schema.toCodecJson(BudgetEvent);
		for (const event of EVENTS) {
			const json = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(event)));
			expect(Schema.decodeUnknownSync(codec)(json)).toEqual(event);
		}
		expect(Schema.encodeSync(codec)(EVENTS[0] as BudgetEvent)).toMatchObject({ _tag: "Reserved", estimate: "50000" });
	});
});
