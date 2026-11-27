import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { InlineSandbox, Run, Wasm } from "../src/index.ts";

const sandbox = Effect.flatMap(Wasm.load(), (wasm) => InlineSandbox.make({ wasm }));

/** Answers every call of `run` with `answer(call)`, numbering the results 1, 2, ..., and records the events' tags. */
function answering(run: Run.Run, answer: (args: unknown) => unknown) {
	return Effect.gen(function* () {
		const seq = yield* Ref.make(0);
		const tags = yield* Ref.make<ReadonlyArray<Run.Event["_tag"]>>([]);
		yield* Stream.runForEach(run.events, (event) =>
			Effect.gen(function* () {
				yield* Ref.update(tags, (all) => [...all, event._tag]);
				if (!Run.Event.guards.Call(event)) return;
				const next = yield* Ref.updateAndGet(seq, (n) => n + 1);
				yield* run.deliver({ seq: next, id: event.call.id, outcome: { ok: true, value: answer(event.call.args) } });
			}),
		);
		return yield* Ref.get(tags);
	});
}

/** The first call `run` reports. */
function firstCall(run: Run.Run) {
	return run.events.pipe(
		Stream.filter(Run.Event.guards.Call),
		Stream.runHead,
		Effect.map((head) => Option.getOrThrow(head).call),
	);
}

describe("start", () => {
	it("reports the run's events as a Stream that ends with the run, and the caller answers its calls", async () => {
		const [result, tags] = await runTest(
			Effect.gen(function* () {
				const run = yield* (yield* sandbox).start(
					`const a = await tools.double({ n: 2 }); const b = await tools.double({ n: a }); return b;`,
					{ seed: 7, tools: [{ name: "double" }] },
				);
				const events = yield* Effect.forkChild(
					answering(run, (args) => (args as { n: number }).n * 2),
					{ startImmediately: true },
				);
				return [yield* run.result, yield* Fiber.join(events)] as const;
			}),
		);
		expect(result).toMatchObject({ ok: true, value: 8, during: { seq: 2, issued: 2 } });
		expect(tags).toEqual(["Started", "Call", "Idle", "Call", "Idle"]);
	});

	it("takes the start time and each result's clock from the Clock, or as given", async () => {
		const [startedAt, result, given] = await runTest(
			Effect.gen(function* () {
				const box = yield* sandbox;
				yield* TestClock.adjust("1 second");
				const run = yield* box.start(
					`const before = Date.now(); await tools.tick({}); return [before, Date.now()];`,
					{
						seed: 1,
						tools: [{ name: "tick" }],
					},
				);
				const call = yield* firstCall(run);
				yield* TestClock.adjust("4 seconds");
				yield* run.deliver({ seq: 1, id: call.id, outcome: { ok: true, value: null } });
				const result = yield* run.result;
				const replayed = yield* box.start(`return Date.now();`, { seed: 1, startedAt: 42 });
				return [run.startedAt, result, yield* replayed.result] as const;
			}),
		);
		expect(startedAt).toBe(1000);
		expect(result).toMatchObject({ ok: true, value: [1000, 5000] });
		expect(given).toMatchObject({ ok: true, value: 42 });
	});

	it("fails with RunRejected when Pi refuses the options", async () => {
		const failure = await runTest(
			Effect.flip(Effect.flatMap(sandbox, (box) => box.start("return 1;", { seed: -1 }))),
		);
		expect(failure).toMatchObject({ _tag: "RunRejected", message: "seed must be a 32-bit unsigned integer" });
	});

	it("fails with DeliveryRejected for an answer to a call that does not wait, and the run goes on", async () => {
		const [failure, result] = await runTest(
			Effect.gen(function* () {
				const run = yield* (yield* sandbox).start(`return await tools.echo("x");`, {
					seed: 1,
					tools: [{ name: "echo" }],
				});
				const { id } = yield* firstCall(run);
				const failure = yield* Effect.flip(
					run.deliver({ seq: 1, id: Run.CallId.make(id + 1), outcome: { ok: true, value: 1 } }),
				);
				yield* run.deliver({ seq: 1, id, outcome: { ok: true, value: "echoed" } });
				return [failure, yield* run.result] as const;
			}),
		);
		expect(failure).toMatchObject({ _tag: "DeliveryRejected", message: "Call 2 is not waiting for a result" });
		expect(result).toMatchObject({ ok: true, value: "echoed" });
	});

	it("aborts the run when its scope closes, and waits for its result", async () => {
		const [finished, result] = await runTest(
			Effect.gen(function* () {
				const box = yield* sandbox;
				const run = yield* Effect.scoped(
					box.start(`await tools.never({});`, { seed: 1, tools: [{ name: "never" }] }),
				);
				return [yield* run.finished, yield* run.result] as const;
			}),
		);
		expect(finished).toBe(true);
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted" } });
	});
});
