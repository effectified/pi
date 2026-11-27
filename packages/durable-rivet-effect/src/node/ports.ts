// The ports of a local engine: which ones it listens on for the port it is given, and how a free set is found.

import { createServer, type Server } from "node:net";
import { Array as Arr, Effect, Option, Random } from "effect";
import { EngineUnavailable } from "../errors.ts";

/**
 * What the engine of rivetkit 3.1.1 listens on, as offsets from its `enginePort`: the port itself (its guard, where
 * clients and the registry connect), the next one (its API peer, the `peer_url` of its config) and the tenth after it
 * (its metrics). Read off a running engine with `lsof`; an engine that cannot bind one of them exits at once with
 * that its address is in use, and rivetkit goes on asking for its health for a minute.
 */
export const OFFSETS: ReadonlyArray<number> = [0, 1, 10];

/**
 * A port whose whole set nothing listens on now, on the loopback interface. It is drawn from below the ranges
 * systems hand out to outgoing connections and to `listen(0)` (from 32768 on Linux, from 49152 on macOS): a port
 * the system picked has neighbours it may hand to anyone the next moment, which is how a loaded machine took an
 * engine's second port. The set is free when this ends, not reserved: `serve` tries another port when the engine
 * still finds one taken.
 */
export const free: Effect.Effect<number, EngineUnavailable> = Effect.gen(function* () {
	for (let attempt = 0; attempt < CANDIDATES; attempt++) {
		const port = yield* Random.nextIntBetween(FIRST_PORT, LAST_PORT);
		if (yield* isFree(port)) return port;
	}
	return yield* EngineUnavailable.make({
		code: "port",
		message: `No free set of ports for a local engine in ${CANDIDATES} tries between ${FIRST_PORT} and ${LAST_PORT}`,
		retryable: true,
	});
});

/**
 * `port`, when nothing listens on any port of its set now: a port its caller chose. Something that listens there may
 * be another engine, and rivetkit would use an engine that answers on the port in place of starting its own.
 */
export const only: (port: number) => Effect.Effect<number, EngineUnavailable> = Effect.fn("Ports.only")(function* (
	port: number,
) {
	if (yield* isFree(port)) return port;
	return yield* EngineUnavailable.make({
		code: "port",
		message: `A port of the set of ${port} is in use: ${Arr.join(Arr.map(setOf(port), String), ", ")}`,
		retryable: true,
	});
});

/** The ports the engine listens on for `port`. */
export function setOf(port: number): ReadonlyArray<number> {
	return Arr.map(OFFSETS, (offset) => port + offset);
}

const FIRST_PORT = 20_000;

const LAST_PORT = 32_000;

const CANDIDATES = 50;

const LOOPBACK = "127.0.0.1";

/** Whether nothing listens on any port of the set of `port`: all of them are bound at once, then released. */
export function isFree(port: number): Effect.Effect<boolean> {
	return Effect.acquireUseRelease(
		Effect.forEach(setOf(port), (each) => Effect.option(listen(each)), { concurrency: 1 }),
		(bound) => Effect.succeed(Arr.every(bound, Option.isSome)),
		(bound) => Effect.forEach(Arr.getSomes(bound), close, { concurrency: "unbounded", discard: true }),
	);
}

/** A server that listens on the port of the loopback interface, or the failure to bind it. */
function listen(port: number): Effect.Effect<Server, Error> {
	return Effect.callback<Server, Error>((resume) => {
		const server = createServer();
		server.once("error", (cause) => resume(Effect.fail(cause)));
		server.listen(port, LOOPBACK, () => resume(Effect.succeed(server)));
	});
}

function close(server: Server): Effect.Effect<void> {
	return Effect.callback<void>((resume) => {
		server.close(() => resume(Effect.void));
	});
}
