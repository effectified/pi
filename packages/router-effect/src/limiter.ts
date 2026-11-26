// The concurrency limiter: per key, a cap on requests in flight and a backoff after a rate limit, on Effect's Clock.

import { Clock, Context, Duration, Effect, Layer, Semaphore } from "effect";
import type { Backoff, Limit } from "./route-table.ts";

/** What a limiter is built from: the limit of each key, and how long a rate-limited key waits. */
export interface LimiterOptions {
	/** A key with no entry runs one request at a time. */
	readonly limits: Readonly<Record<string, Limit>>;
	/** Default: one second, doubled for each rate limit in a row, at most one minute. */
	readonly backoff?: Backoff;
}

/** The limiter of one router. Keys are independent of each other. */
export interface LimiterService {
	/**
	 * Runs `effect` in one of the key's slots: waits for a free slot, then for the key's backoff to pass, then runs.
	 * Both waits are interruptible and the slot is released however `effect` ends.
	 */
	readonly withPermit: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	/**
	 * A provider rate-limited the key: nothing starts on it until the wait has passed. The wait is
	 * `retryAfterMillis` when the provider gave one, else the base doubled for each rate limit in a row; never
	 * above the cap. A rate limit that arrives while the key is already waiting belongs to the same burst and does
	 * not double the next wait. Returns the wait in milliseconds.
	 */
	readonly backOff: (key: string, retryAfterMillis?: number) => Effect.Effect<number>;
	/** A request on the key was served: the next backoff starts from the base again. */
	readonly recover: (key: string) => Effect.Effect<void>;
}

const DEFAULT_BACKOFF: Backoff = { baseMillis: 1_000, maxMillis: 60_000 };

/** The slots and the backoff of one key. Mutated in place: every change is one synchronous step. */
interface KeyState {
	readonly slots: Semaphore.Semaphore;
	/** Rate limits in a row, each after the wait of the one before had passed. */
	rateLimits: number;
	/** The Clock time before which nothing starts on the key. */
	blockedUntil: number;
}

/** A concurrency limiter with backoff, in this process. Time comes from Effect's `Clock`. */
export class Limiter extends Context.Service<Limiter, LimiterService>()("@effectified/pi-router/Limiter") {
	/** A fresh limiter: every key idle and not waiting. */
	static make(options: LimiterOptions): Effect.Effect<LimiterService> {
		return Effect.sync(() => {
			const backoff = options.backoff ?? DEFAULT_BACKOFF;
			const states = new Map<string, KeyState>();
			const stateOf = (key: string): KeyState => {
				let state = states.get(key);
				if (state === undefined) {
					const slots = Semaphore.makeUnsafe(options.limits[key]?.maxInFlight ?? 1);
					state = { slots, rateLimits: 0, blockedUntil: 0 };
					states.set(key, state);
				}
				return state;
			};
			return {
				withPermit: (key, effect) =>
					Effect.suspend(() => {
						const state = stateOf(key);
						return state.slots.withPermit(Effect.andThen(untilUnblocked(state), effect));
					}),
				backOff: (key, retryAfterMillis) =>
					Effect.map(Clock.currentTimeMillis, (now) => {
						const state = stateOf(key);
						if (state.blockedUntil <= now) state.rateLimits += 1;
						const wait = Math.min(
							backoff.maxMillis,
							retryAfterMillis ?? backoff.baseMillis * 2 ** (state.rateLimits - 1),
						);
						state.blockedUntil = Math.max(state.blockedUntil, now + wait);
						return wait;
					}),
				recover: (key) =>
					Effect.sync(() => {
						stateOf(key).rateLimits = 0;
					}),
			};
		});
	}

	/** `make` as a Layer. */
	static layer(options: LimiterOptions): Layer.Layer<Limiter> {
		return Layer.effect(Limiter, Limiter.make(options));
	}
}

/** Sleeps until the key's backoff has passed. Checked again after each sleep: a new rate limit may have extended it. */
function untilUnblocked(state: KeyState): Effect.Effect<void> {
	return Effect.flatMap(Clock.currentTimeMillis, (now) =>
		state.blockedUntil > now
			? Effect.andThen(Effect.sleep(Duration.millis(state.blockedUntil - now)), untilUnblocked(state))
			: Effect.void,
	);
}
