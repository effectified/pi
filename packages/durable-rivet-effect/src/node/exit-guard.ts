// Holds back the exit of the process that rivetkit makes for a local engine start that failed: the start has failed
// as an Effect already, and the process is its caller's to end.

import { Effect } from "effect";

/** One local engine start, from before it begins until it is ready or its failure has been dealt with. */
export interface Hold {
	/** The start became ready: from here on rivetkit's exit means that a running engine was lost, and is let through. */
	readonly ready: Effect.Effect<void>;
	/**
	 * The start failed or was interrupted. rivetkit's exit for it is held back when it comes, which is at once for a
	 * binary that is no engine and about a minute later for an engine that never became healthy; the hold ends then,
	 * or after `DOOM_MILLIS`.
	 */
	readonly failed: Effect.Effect<void>;
}

/**
 * Begins to hold back rivetkit's exit for one start. rivetkit calls `process.exit(1)` when a registry's serve call
 * fails, and has no option against it. While a hold is open, `process.exit` is replaced by a function that drops a
 * call made from rivetkit's own code and passes every other call on; it is put back when the last hold ends.
 *
 * Why it is needed: without it one failed start ends the process a minute later, in the middle of whatever runs
 * then. In a test run that is a later file's engine, which is left behind without a parent, with its directory.
 */
export const hold: Effect.Effect<Hold> = Effect.sync(() => {
	const start: Start = { state: "starting", exited: false, timer: undefined };
	starts.add(start);
	install();
	return {
		ready: Effect.sync(() => end(start)),
		failed: Effect.sync(() => {
			// The exit came before the failure reached its caller, and was dropped then: nothing is left to wait for.
			if (start.exited) return end(start);
			start.state = "doomed";
			start.timer = setTimeout(() => end(start), DOOM_MILLIS);
			// The wait for rivetkit's exit must not keep a process alive that has nothing else to do.
			start.timer.unref();
		}),
	};
});

/**
 * How long a failed start waits for rivetkit's exit: rivetkit asks an engine for its health 64 times, which took 61
 * seconds, and gives up on a registry that does not register after 60.
 */
export const DOOM_MILLIS = 120_000;

/** How many failed starts still wait for rivetkit's exit. */
export const waiting: Effect.Effect<number> = Effect.sync(
	() => [...starts].filter((start) => start.state === "doomed").length,
);

/** Whether a stack trace has a frame of rivetkit's own code: its built files, or its sources. */
export function fromRivetkit(stack: string): boolean {
	return /[\\/]rivetkit[\\/](dist|src)[\\/]/.test(stack);
}

interface Start {
	state: "starting" | "doomed";
	/** rivetkit's exit for this start was dropped. */
	exited: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const starts = new Set<Start>();

/** The `process.exit` that was there when the guard was installed; undefined while it is not installed. */
let original: typeof process.exit | undefined;

function install(): void {
	if (original !== undefined) return;
	original = process.exit;
	process.exit = guarded;
}

function end(start: Start): void {
	clearTimeout(start.timer);
	starts.delete(start);
	// Someone replaced the function meanwhile: theirs stays, and the guard stays behind it, passing every call on.
	if (starts.size > 0 || original === undefined || process.exit !== guarded) return;
	process.exit = original;
	original = undefined;
}

/** Drops rivetkit's exit for a start that failed or is still starting; every other call exits as it would. */
const guarded = ((code?: number | string | null): void => {
	const start = fromRivetkit(new Error().stack ?? "") ? oldest() : undefined;
	if (start === undefined) (original ?? process.exit)(code);
	else if (start.state === "doomed") end(start);
	else start.exited = true;
	// A cast: `process.exit` never returns by its type. rivetkit's caller does nothing after it but end its handler.
}) as typeof process.exit;

/** The start rivetkit's exit is for: the one that failed first, else the one that is starting. */
function oldest(): Start | undefined {
	const waiting = [...starts].filter((start) => !start.exited);
	return waiting.find((start) => start.state === "doomed") ?? waiting[0];
}
