// A program a pi-env daemon runs (a process or a terminal) as a scoped resource: its output as Streams that end
// when it exits, and its kill when the scope closes.

import { type Cause, Effect, Queue, type Scope, Stream } from "effect";
import type { RemoteFailed } from "../errors.ts";
import { remote } from "./rejection.ts";

/** What pi-env's `RemoteProcess` and `RemoteTerminal` share: an exit to wait for, and a kill. */
export interface PiProgram {
	readonly pid: number;
	readonly exited: Promise<number>;
	close(): void;
}

/** An opened program: Pi's handle, a Stream of each output channel, and its exit. */
export interface Opened<P, Channel> {
	readonly pi: P;
	readonly output: (channel: Channel) => Stream.Stream<Uint8Array>;
	readonly exited: Effect.Effect<number, RemoteFailed>;
}

/**
 * Opens a program with `open`, which passes Pi a callback per output channel. Output is kept until it is read, so
 * nothing is lost before a stream runs; each channel's stream ends when the program exits. Closing the scope kills
 * the program (and its process group or session) and waits for its exit.
 */
export function acquire<P extends PiProgram, Channel>(
	channels: ReadonlyArray<Channel>,
	open: (write: (channel: Channel, bytes: Uint8Array) => void) => Promise<P>,
): Effect.Effect<Opened<P, Channel>, RemoteFailed, Scope.Scope> {
	return Effect.gen(function* () {
		const queues = new Map<Channel, Queue.Queue<Uint8Array, Cause.Done>>();
		// Unbounded: Pi's callbacks cannot wait.
		for (const channel of channels) queues.set(channel, yield* Queue.unbounded<Uint8Array, Cause.Done>());
		// Every channel a callback names is one of `channels`, which all have a queue.
		const queue = (channel: Channel) => queues.get(channel)!;
		const pi = yield* Effect.acquireRelease(
			remote(() => open((channel, bytes) => Queue.offerUnsafe(queue(channel), bytes))),
			(program) =>
				Effect.sync(() => program.close()).pipe(
					// `exited` rejects with `aborted` after `close()`; only its settling matters here.
					Effect.andThen(Effect.promise(() => program.exited.then(ignore, ignore))),
				),
		);
		const end = () => {
			for (const each of queues.values()) Queue.endUnsafe(each);
		};
		pi.exited.then(end, end);
		return { pi, output: (channel) => Stream.fromQueue(queue(channel)), exited: remote(() => pi.exited) };
	});
}

function ignore(): void {}
