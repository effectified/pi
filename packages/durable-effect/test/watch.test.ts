import type { Context } from "@earendil-works/chord/context";
import type {
	CommitObservation,
	CommitObserver,
	Observation,
	Observer,
	Seq,
	WatchCall,
	WatchEnd,
	WatchHandle,
} from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Cause, Effect, Exit, Fiber, Latch, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Watch from "../src/watch.ts";

/**
 * A Pi watch a test drives: it delivers on `emit`, one call at a time, and ends on `end` or `stop()`. `started`
 * succeeds once the stream started it, so an `emit` reaches the stream.
 */
function fakeWatch(initial: number) {
	const closed = Promise.withResolvers<WatchEnd>();
	const started = Latch.makeUnsafe();
	let listener: ((call: WatchCall<number>, context: Context) => Promise<void>) | undefined;
	let stops = 0;
	const handle: WatchHandle<number> = {
		value: initial,
		start: (given) => {
			listener = given;
			started.openUnsafe();
		},
		stop: () => {
			stops += 1;
			closed.resolve({ kind: "stopped" });
			return closed.promise;
		},
		closed: closed.promise,
	};
	return {
		handle,
		started: started.await,
		emit: (value: number) => listener?.({ kind: "value", value, ops: [["r", value]], retired: false }, {} as Context),
		end: (end: WatchEnd) => closed.resolve(end),
		stops: () => stops,
	};
}

describe("stream", () => {
	it("gives the value at attachment first, without operations, then each delivered change", async () => {
		const watch = fakeWatch(1);
		const changes = await runTest(
			Effect.gen(function* () {
				const collecting = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Watch.stream(async () => watch.handle),
							3,
						),
					),
				);
				yield* watch.started;
				yield* Effect.promise(async () => {
					await watch.emit(2);
					await watch.emit(3);
				});
				return yield* Fiber.join(collecting);
			}),
		);
		expect(changes).toEqual([
			{ value: 1, ops: [], retired: false },
			{ value: 2, ops: [["r", 2]], retired: false },
			{ value: 3, ops: [["r", 3]], retired: false },
		]);
	});

	it("stops Pi's watch when the stream's scope closes", async () => {
		const watch = fakeWatch(1);
		await Effect.runPromise(
			Stream.runCollect(
				Stream.take(
					Watch.stream(async () => watch.handle),
					1,
				),
			),
		);
		expect(watch.stops()).toBe(1);
		expect(await watch.handle.closed).toEqual({ kind: "stopped" });
	});

	it("holds Pi's listener until the consumer took the change before, so Pi folds what lands meanwhile", async () => {
		const watch = fakeWatch(1);
		const order: string[] = [];
		await runTest(
			Effect.gen(function* () {
				// A slow consumer: it holds the first change until the test releases it.
				const release = yield* Latch.make();
				const delivered = yield* Latch.make();
				const consuming = yield* Effect.forkChild(
					Stream.runForEach(
						Stream.take(
							Watch.stream(async () => watch.handle),
							3,
						),
						(change) =>
							Effect.andThen(
								Effect.sync(() => order.push(`took ${change.value}`)),
								release.await,
							),
					),
				);
				yield* watch.started;
				const delivering = yield* Effect.forkChild(
					Effect.promise(async () => {
						await watch.emit(2);
						order.push("delivered 2");
						delivered.openUnsafe();
						await watch.emit(3);
						order.push("delivered 3");
					}),
				);
				yield* delivered.await;
				// A turn of the event loop: a second delivery that did not wait for the consumer would have returned now.
				yield* Effect.yieldNow;
				yield* release.open;
				yield* Fiber.join(delivering);
				yield* Fiber.join(consuming);
			}),
		);
		// The second delivery returned only after the consumer was done with the first and took the change before it.
		expect(order.indexOf("delivered 3")).toBeGreaterThan(order.indexOf("took 2"));
		expect(order.filter((step) => step.startsWith("took"))).toEqual(["took 1", "took 2", "took 3"]);
	});

	it("ends when what it watches ends, and has no element when there was nothing to watch", async () => {
		const watch = fakeWatch(1);
		const ended = await runTest(
			Effect.gen(function* () {
				const collecting = yield* Effect.forkChild(Stream.runCollect(Watch.stream(async () => watch.handle)));
				yield* watch.started;
				watch.end({ kind: "ended" });
				return yield* Fiber.join(collecting);
			}),
		);
		expect(ended).toEqual([{ value: 1, ops: [], retired: false }]);
		expect(await Effect.runPromise(Stream.runCollect(Watch.stream(async () => undefined)))).toEqual([]);
	});

	it("fails with the tagged error of what failed the harness", async () => {
		const watch = fakeWatch(1);
		const cause = new Error("disk full");
		const exit = await runTest(
			Effect.gen(function* () {
				const collecting = yield* Effect.forkChild(Stream.runCollect(Watch.stream(async () => watch.handle)));
				yield* watch.started;
				watch.end({ kind: "failed", error: cause });
				return yield* Fiber.await(collecting);
			}),
		);
		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "UnexpectedError", cause });
	});

	it("fails when Pi rejects the acquisition", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(Stream.runCollect(Watch.stream<number>(() => Promise.reject(new Error("closed"))))),
		);
		expect(failure._tag).toBe("UnexpectedError");
	});
});

/**
 * A Pi observer attachment a test drives: `attach` resolves when the test says so. `attaching` succeeds once the stream
 * asked to attach, so `advance` reaches its observer.
 */
function fakeObservation(initial: number) {
	const attached = Promise.withResolvers<Observation<number>>();
	const attaching = Latch.makeUnsafe();
	let observer: Observer<number> | undefined;
	let detached = 0;
	return {
		attach: (given: Observer<number>) => {
			observer = given;
			attaching.openUnsafe();
			return attached.promise;
		},
		attaching: attaching.await,
		resolve: () =>
			attached.resolve({
				value: initial,
				detach: () => {
					detached += 1;
				},
			}),
		advance: (value: number) =>
			observer?.advance({ kind: "value", value, ops: [["r", value]], retired: false }, {} as Context),
		end: (end: WatchEnd) => observer?.end(end),
		detached: () => detached,
	};
}

describe("observed", () => {
	it("gives every change in order, also one Pi delivered before the attachment resolved", async () => {
		const observation = fakeObservation(1);
		const changes = await runTest(
			Effect.gen(function* () {
				const first = yield* Latch.make();
				const collecting = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(Watch.observed(observation.attach), () => first.open),
							4,
						),
					),
				);
				yield* observation.attaching;
				observation.advance(2);
				observation.resolve();
				// The first element is in once the attachment resolved: later changes go to the stream directly.
				yield* first.await;
				observation.advance(3);
				observation.advance(4);
				return yield* Fiber.join(collecting);
			}),
		);
		expect(changes.map((change) => change.value)).toEqual([1, 2, 3, 4]);
		expect(changes[0]).toEqual({ value: 1, ops: [], retired: false });
		expect(observation.detached()).toBe(1);
	});

	it("fails as Pi ends its observers when the harness closes", async () => {
		const observation = fakeObservation(1);
		const exit = await runTest(
			Effect.gen(function* () {
				const first = yield* Latch.make();
				const collecting = yield* Effect.forkChild(
					Stream.runCollect(Stream.tap(Watch.observed(observation.attach), () => first.open)),
				);
				observation.resolve();
				yield* first.await;
				observation.end({ kind: "failed", error: new Error("session closed") });
				return yield* Fiber.await(collecting);
			}),
		);
		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
			_tag: "UnexpectedError",
			message: "session closed",
		});
	});

	it("has no element when the observed address is absent", async () => {
		expect(await Effect.runPromise(Stream.runCollect(Watch.observed<number>(async () => undefined)))).toEqual([]);
	});
});

/**
 * A Pi commit source a test drives: it publishes on `publish` and ends on `end`. `attached` succeeds once the stream
 * attached its observer, so a publication reaches the stream.
 */
function fakeCommits() {
	const attached = Latch.makeUnsafe();
	let observer: CommitObserver | undefined;
	let detached = 0;
	return {
		attached: attached.await,
		attach: (given: CommitObserver): CommitObservation => {
			observer = given;
			attached.openUnsafe();
			return {
				detach: () => {
					detached += 1;
					observer = undefined;
				},
			};
		},
		// Pi brands sequence numbers in the type system only.
		publish: (seq: number) => observer?.advance({ seq: seq as Seq, changes: [] }, {} as Context),
		end: (end: WatchEnd) => observer?.end(end),
		detached: () => detached,
	};
}

describe("commits", () => {
	it("gives each publication as Pi handed it, in order, and detaches when the stream's scope closes", async () => {
		const source = fakeCommits();
		const elements = await runTest(
			Effect.gen(function* () {
				const collecting = yield* Effect.forkChild(Stream.runCollect(Stream.take(Watch.commits(source.attach), 3)));
				yield* source.attached;
				source.publish(1);
				source.publish(2);
				source.publish(3);
				return yield* Fiber.join(collecting);
			}),
		);
		expect(elements).toEqual([
			{ seq: 1, changes: [] },
			{ seq: 2, changes: [] },
			{ seq: 3, changes: [] },
		]);
		expect(source.detached()).toBe(1);
	});

	it("never holds Pi up: what a consumer has not taken waits in memory, however much it is", async () => {
		const source = fakeCommits();
		const seen = await runTest(
			Effect.gen(function* () {
				const first = yield* Effect.forkChild(Stream.runCollect(Stream.take(Watch.commits(source.attach), 5_000)));
				yield* source.attached;
				// Every call returns at once, with nothing to await: no consumer ran between them.
				const returned = Array.from({ length: 5_000 }, (_, index) => source.publish(index));
				return { returned: returned.every((value) => value === undefined), elements: yield* Fiber.join(first) };
			}),
		);
		expect(seen.returned).toBe(true);
		expect(seen.elements.map((element) => element.seq)).toEqual(Array.from({ length: 5_000 }, (_, index) => index));
	});

	it("fails as Pi ends its commit observers when the harness closes, after what was published before", async () => {
		const source = fakeCommits();
		const seen = await runTest(
			Effect.gen(function* () {
				const elements: number[] = [];
				const collecting = yield* Effect.forkChild(
					Stream.runForEach(Watch.commits(source.attach), (element) =>
						Effect.sync(() => elements.push(element.seq)),
					),
				);
				yield* source.attached;
				source.publish(1);
				source.end({ kind: "failed", error: new Error("session closed") });
				return { exit: yield* Fiber.await(collecting), elements };
			}),
		);
		expect(seen.elements).toEqual([1]);
		expect(Exit.isFailure(seen.exit) && Cause.squash(seen.exit.cause)).toMatchObject({
			_tag: "UnexpectedError",
			message: "session closed",
		});
	});

	it("fails when Pi refuses the attachment, as a closed harness does", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(
				Stream.runCollect(
					Watch.commits(() => {
						throw new Error("session closed");
					}),
				),
			),
		);
		expect(failure).toMatchObject({ _tag: "UnexpectedError", message: "session closed" });
	});
});
