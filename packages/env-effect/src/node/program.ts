// A program a pi-env daemon runs (a process or a terminal) as a scoped resource: its output as Streams that end
// when it exits, and its kill when the scope closes.

import { Array as Arr, type Cause, Effect, Queue, type Scope, Stream } from "effect";
import type { RemoteFailed } from "../errors.ts";
import { remote } from "./rejection.ts";

/** What pi-env's `RemoteProcess` and `RemoteTerminal` share: an exit to wait for, and a kill. */
export interface PiProgram {
	readonly pid: number;
	readonly exited: Promise<number>;
	close(): void;
}

/** An opened program: Pi's handle, a Stream of each output channel, and its exit code. */
export interface Opened<P, Channel> {
	readonly pi: P;
	readonly output: (channel: Channel) => Stream.Stream<Uint8Array>;
	readonly exited: Effect.Effect<number, RemoteFailed>;
}

/**
 * Opens a program with `open`, which passes Pi a callback per output channel. Output is kept until it is read, so
 * nothing is lost before a stream runs; each channel's stream ends when the program exits. Closing the scope kills
 * the program (and its process group or session), waits for its exit and ends the streams. Untraced: the function
 * that opens it (`Process.open`, `Terminal.open`) is the span.
 */
export const acquire = Effect.fnUntraced(function* <P extends PiProgram, Channel extends string>(
	channels: ReadonlyArray<Channel>,
	open: (write: (channel: Channel, bytes: Uint8Array) => void) => Promise<P>,
): Effect.fn.Return<Opened<P, Channel>, RemoteFailed, Scope.Scope> {
	// Unbounded: Pi's callbacks cannot wait.
	const entries = yield* Effect.forEach(
		channels,
		(channel) => Effect.map(Queue.unbounded<Uint8Array, Cause.Done>(), (queue) => [channel, queue] as const),
		{ concurrency: "unbounded" },
	);
	const queues = new Map(entries);
	// Every channel a callback or a caller names is one of `channels`, which all have a queue.
	const queue = (channel: Channel) => queues.get(channel)!;
	// An array, not the map's iterator: both the release and the exit's fiber may run `ended`.
	const ended = Effect.forEach(Arr.fromIterable(queues.values()), Queue.end, {
		concurrency: "unbounded",
		discard: true,
	});
	const pi = yield* Effect.acquireRelease(
		remote(() => open((channel, bytes) => Queue.offerUnsafe(queue(channel), bytes))),
		(program) => Effect.sync(() => program.close()).pipe(Effect.andThen(settled(program)), Effect.andThen(ended)),
	);
	// A program that exits on its own ends its streams; one still running when the scope closes ends them above.
	yield* Effect.forkScoped(Effect.andThen(settled(pi), ended));
	return { pi, output: (channel) => Stream.fromQueue(queue(channel)), exited: remote(() => pi.exited) };
});

/** Completes when the program's exit settled: `exited` rejects with `aborted` after `close()`, which is no failure here. */
function settled(program: PiProgram): Effect.Effect<void> {
	return Effect.promise(() => program.exited.then(ignore, ignore));
}

function ignore(): void {}
