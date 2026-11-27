// Chord's client runtime in Effect: a client host kept connected for the life of a scope, its connection loop on the
// `Clock`, and the active theme and language it follows as Streams.

import {
	type ClientError,
	type ClientOptions,
	type ConnectionState,
	followActiveLanguage,
	followActiveTheme,
	type Language,
	type Link,
	type LoopEnvironment,
	type LoopLink,
	type Principal,
	hostLanguage as piHostLanguage,
	keepConnected as piKeepConnected,
	type RegisteredScript,
	type ScriptEntry,
	type SocketEvents,
	startClient,
	type Theme,
} from "@earendil-works/chord";
import { Clock, Effect, FiberSet, PubSub, Queue, type Scope, Stream } from "effect";
import { dual } from "effect/Function";
import { chordCall } from "./call.ts";
import type { ChordCallError } from "./errors.ts";
import { type Host, of } from "./host.ts";

// Chord's client types: its options, errors, connection states, the loop's environment and links.
export type {
	Client as PiClient,
	ClientError,
	ClientOptions,
	ClientStyles,
	ConnectionState,
	LanguageFollower,
	LoopEnvironment,
	LoopLink,
	SocketEvents,
	ThemeFollower,
} from "@earendil-works/chord";

/**
 * The loop's environment on Effect: `now` and the timers are the `Clock`'s (so `TestClock` drives the connection
 * loop), the device counts as online and never reports a wake. Its timers are fibers of the scope.
 */
export const environment: Effect.Effect<LoopEnvironment, never, Scope.Scope> = Effect.gen(function* () {
	const clock = yield* Clock.Clock;
	const fork = yield* FiberSet.makeRuntime<never, void, never>();
	return {
		now: () => clock.currentTimeMillisUnsafe(),
		after: (ms, callback) => {
			const fiber = fork(Effect.andThen(Effect.sleep(ms), Effect.sync(callback)));
			return () => fiber.interruptUnsafe();
		},
		online: () => true,
		onWake: () => () => {},
	};
});

/**
 * What `start` takes: Chord's client options, its callbacks Effects, its reports this client's Streams. A callback
 * that may fail fails with `E`, which reaches Chord as the rejection it handles (a script left out, a retry).
 */
export type Options<P extends Principal, E = never, R = never> = Omit<
	ClientOptions<P>,
	"open" | "fetchScript" | "serverBase" | "outdated" | "canRetry" | "onConnection" | "environment" | "onError"
> & {
	/** Opens one socket to the server and its link; the socket reports to `events`. */
	readonly open: (events: SocketEvents) => Effect.Effect<Link, never, R>;
	/** Fetches a plugin's script of a set, which registers itself. */
	readonly fetchScript: (entry: ScriptEntry) => Effect.Effect<RegisteredScript, E, R>;
	/** The server's current base bundle hash, asked at each reconnect (`undefined`: unknown, try again). */
	readonly serverBase: Effect.Effect<string | undefined, E, R>;
	/** This client's code is outdated: the app starts it over. The loop has stopped. */
	readonly outdated: Effect.Effect<void, never, R>;
	/** Asked at each reconnect; `false` stops the loop. */
	readonly canRetry?: Effect.Effect<boolean, E, R>;
	/** The loop's clock, timers and wake events; `environment` (the `Clock`'s) by default. */
	readonly environment?: LoopEnvironment;
};

/** A running client: its host, its connection and its errors. */
export interface Client<P extends Principal> {
	/** Its host, loaded with the initial scripts. Its `errors` are the host errors among this client's. */
	readonly host: Host<P>;
	/** The connection as the app shows it: the state now, then each change. */
	readonly connection: Stream.Stream<ConnectionState>;
	/**
	 * What fails in the background (Chord's `onError`), from the moment the Stream runs; each is also logged at the
	 * error level on the Effect logger of the context `start` ran in.
	 */
	readonly errors: Stream.Stream<ClientError>;
}

/**
 * Chord's `startClient`: a client host loaded with its initial scripts, kept connected and current until the scope
 * closes, which stops it (its loop, its updates, its host). It starts offline: it gives the client before the server
 * answers. Its callbacks run with the services of the context this Effect runs in. Untraced, as every function of
 * this module: the client and its callbacks outlive a span of this Effect.
 */
export const start: <P extends Principal, E = never, R = never>(
	options: Options<P, E, R>,
) => Effect.Effect<Client<P>, ChordCallError, Scope.Scope | R> = Effect.fnUntraced(function* <
	P extends Principal,
	E,
	R,
>(options: Options<P, E, R>) {
	const services = yield* Effect.context<R>();
	const runSync = Effect.runSyncWith(services);
	const runPromise = Effect.runPromiseWith(services);
	// Replayed once: a Stream that runs later starts with the state now.
	const connection = yield* Effect.acquireRelease(PubSub.unbounded<ConnectionState>({ replay: 1 }), PubSub.shutdown);
	const errors = yield* Effect.acquireRelease(PubSub.unbounded<ClientError>(), PubSub.shutdown);
	const loop = options.environment ?? (yield* environment);
	const { canRetry, ...rest } = options;
	const client = yield* Effect.acquireRelease(
		chordCall(() =>
			startClient<P>({
				...rest,
				open: (events) => runSync(options.open(events)),
				fetchScript: (entry) => runPromise(options.fetchScript(entry)),
				serverBase: () => runPromise(options.serverBase),
				outdated: () => runSync(options.outdated),
				...(canRetry === undefined ? {} : { canRetry: () => runPromise(canRetry) }),
				onConnection: (state) => {
					PubSub.publishUnsafe(connection, state);
				},
				environment: loop,
				onError: (error) => {
					PubSub.publishUnsafe(errors, error);
					// Logging is synchronous: no fiber outlives Chord's call.
					runSync(Effect.logError("Chord client error", error));
				},
			}),
		),
		// A stop that fails leaves nothing to recover in a finalizer: the host closes whatever it says.
		(started) => Effect.ignore(chordCall((context) => started.stop(context))),
	);
	const clientErrors = Stream.fromPubSub(errors);
	const hostErrors = Stream.map(
		Stream.filter(
			clientErrors,
			(error): error is Extract<ClientError, { readonly kind: "host" }> => error.kind === "host",
		),
		(error) => error.error,
	);
	return { host: of(client.host, hostErrors), connection: Stream.fromPubSub(connection), errors: clientErrors };
});

/** What `keepConnected` takes: Chord's loop options, its callbacks Effects; `canRetry` fails with `E`. */
export interface LoopOptions<E = never, R = never> {
	/** Opens one socket and its link; the socket reports to `events`. */
	readonly open: (events: SocketEvents) => Effect.Effect<LoopLink, never, R>;
	/** Asked after a close, while the next attempt goes ahead; `false` stops the loop. A failure counts as `true`. */
	readonly canRetry: Effect.Effect<boolean, E, R>;
	/** The loop's clock, timers and wake events; `environment` (the `Clock`'s) by default. */
	readonly environment?: LoopEnvironment;
}

/**
 * Chord's `keepConnected`: keeps a connection open, retrying with backoff, until the scope closes, which stops it.
 * Gives the connection's states as a Stream: the state now, then each change.
 */
export const keepConnected: <E = never, R = never>(
	options: LoopOptions<E, R>,
) => Effect.Effect<Stream.Stream<ConnectionState>, never, Scope.Scope | R> = Effect.fnUntraced(function* <E, R>(
	options: LoopOptions<E, R>,
) {
	const services = yield* Effect.context<R>();
	// Replayed once: a Stream that runs later starts with the state now.
	const states = yield* Effect.acquireRelease(PubSub.unbounded<ConnectionState>({ replay: 1 }), PubSub.shutdown);
	const loop = options.environment ?? (yield* environment);
	yield* Effect.acquireRelease(
		Effect.sync(() =>
			piKeepConnected({
				open: (events) => Effect.runSyncWith(services)(options.open(events)),
				canRetry: () => Effect.runPromiseWith(services)(options.canRetry),
				onState: (state) => {
					PubSub.publishUnsafe(states, state);
				},
				environment: loop,
			}),
		),
		(running) => Effect.sync(() => running.stop()),
	);
	return Stream.fromPubSub(states);
});

/**
 * Chord's `followActiveTheme`: the active theme on `host` for `mode`, at once (the fallback or the first of its mode)
 * and at every change of the registry, the user's pick or the mode. Each element of `modes` changes the mode. Following
 * stops when the Stream's scope closes.
 */
export function activeTheme<P extends Principal>(
	host: Host<P>,
	mode: Theme["mode"],
	modes: Stream.Stream<Theme["mode"]> = Stream.empty,
): Stream.Stream<Theme, ChordCallError> {
	return Stream.callback<Theme, ChordCallError>((queue) =>
		Effect.gen(function* () {
			const follower = yield* Effect.acquireRelease(
				chordCall((context) =>
					followActiveTheme(host.host, mode, (theme) => void Queue.offerUnsafe(queue, theme), context),
				),
				(running) => Effect.sync(() => running.stop()),
			);
			yield* Effect.forkScoped(Stream.runForEach(modes, (next) => Effect.sync(() => follower.setMode(next))));
		}),
	);
}

/**
 * Chord's `followActiveLanguage`: the active language on `host` for the device's `preferred` languages, set as the
 * host's language and given at once and at every change of the registry, the user's pick or the device's languages
 * that changes the locale or the catalogs. Each element of `devices` is the device's new languages. A report of the
 * messages (a fallback rendered, a contributed message that threw) is logged once at the warning level. Following stops
 * when the Stream's scope closes.
 */
export function activeLanguage<P extends Principal>(
	host: Host<P>,
	preferred: readonly string[],
	devices: Stream.Stream<readonly string[]> = Stream.empty,
): Stream.Stream<Language, ChordCallError> {
	return Stream.callback<Language, ChordCallError>((queue) =>
		Effect.gen(function* () {
			const services = yield* Effect.context<never>();
			const follower = yield* Effect.acquireRelease(
				chordCall((context) =>
					followActiveLanguage(
						host.host,
						preferred,
						(language) => void Queue.offerUnsafe(queue, language),
						// Logging is synchronous: no fiber outlives Chord's call.
						(report) => Effect.runSyncWith(services)(Effect.logWarning("Chord messages report", report)),
						context,
					),
				),
				(running) => Effect.sync(() => running.stop()),
			);
			yield* Effect.forkScoped(Stream.runForEach(devices, (next) => Effect.sync(() => follower.setDevice(next))));
		}),
	);
}

/** Chord's `hostLanguage`: the language set on `host` (by `activeLanguage`), now and at each change. */
export function hostLanguage<P extends Principal>(host: Host<P>): Stream.Stream<Language | undefined> {
	return Stream.callback<Language | undefined>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state = piHostLanguage(host.host);
				Queue.offerUnsafe(queue, state.read());
				return state.subscribe(() => void Queue.offerUnsafe(queue, state.read()));
			}),
			(unsubscribe) => Effect.sync(unsubscribe),
		),
	);
}

/**
 * Sets the language of `host`, as `activeLanguage` does: what its pages and terminals render with. Data-first or
 * data-last (`pipe(host, Client.setHostLanguage(language))`).
 */
export const setHostLanguage: {
	(language: Language | undefined): <P extends Principal>(host: Host<P>) => Effect.Effect<void>;
	<P extends Principal>(host: Host<P>, language: Language | undefined): Effect.Effect<void>;
} = dual(2, <P extends Principal>(host: Host<P>, language: Language | undefined): Effect.Effect<void> =>
	Effect.sync(() => piHostLanguage(host.host).set(language)),
);
