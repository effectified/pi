// The concurrency limiter: per key, a cap on requests in flight and a backoff after a rate limit, on Effect's Clock.

import { Clock, Context, Duration, Effect, Layer, MutableHashMap, Option, Ref, Schema, Semaphore } from "effect";
import type { ConcurrencyKey } from "./ids.ts";
import { Backoff, RouteTable } from "./route-table.ts";

/**
 * What a limiter is built from: the limit of each key, and how long a rate-limited key waits. `Limiter.make` takes
 * its encoded form, `typeof LimiterOptions.Encoded`, whose keys are plain strings, so options written in code need no
 * `ConcurrencyKey.make`.
 */
export const LimiterOptions = Schema.Struct({
	/** A key with no entry runs one request at a time. */
	limits: RouteTable.fields.limits,
	/** Default: one second, doubled for each rate limit in a row, at most one minute. */
	backoff: Schema.optional(Backoff),
});

/** What a limiter is built from. */
export type LimiterOptions = typeof LimiterOptions.Type;

/** The limiter of one router. Keys are independent of each other. */
export interface LimiterService {
	/**
	 * Runs `effect` in one of the key's slots: waits for a free slot, then for the key's backoff to pass, then runs.
	 * Both waits are interruptible and the slot is released however `effect` ends.
	 */
	readonly withPermit: <A, E, R>(key: ConcurrencyKey, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	/**
	 * A provider rate-limited the key: nothing starts on it until the wait has passed. The wait is
	 * `retryAfterMillis` when the provider gave one, else the base doubled for each rate limit in a row; never
	 * above the cap. A rate limit that arrives while the key is already waiting belongs to the same burst and does
	 * not double the next wait. Returns the wait in milliseconds.
	 */
	readonly backOff: (key: ConcurrencyKey, retryAfterMillis?: number) => Effect.Effect<number>;
	/** A request on the key was served: the next backoff starts from the base again. */
	readonly recover: (key: ConcurrencyKey) => Effect.Effect<void>;
}

const DEFAULT_BACKOFF: Backoff = { baseMillis: 1_000, maxMillis: 60_000 };

/** Where the backoff of one key stands. */
interface Blocked {
	/** Rate limits in a row, each after the wait of the one before had passed. */
	readonly rateLimits: number;
	/** The Clock time before which nothing starts on the key. */
	readonly blockedUntil: number;
}

/** The slots and the backoff of one key. */
interface KeyState {
	readonly slots: Semaphore.Semaphore;
	readonly backoff: Ref.Ref<Blocked>;
}

/** A concurrency limiter with backoff, in this process. Time comes from Effect's `Clock`. */
export class Limiter extends Context.Service<Limiter, LimiterService>()("@effectified/pi-router/limiter") {
	/** A fresh limiter: every key idle and not waiting. */
	static readonly make: (options: typeof LimiterOptions.Encoded) => Effect.Effect<LimiterService> = Effect.fn(
		"Limiter.make",
	)(function* (options) {
		const backoff = options.backoff ?? DEFAULT_BACKOFF;
		// Not a `Cache`: evicting a key would drop the permits in flight on it and its backoff. A key's state is made
		// on its first use, in one synchronous step, so two requests of one key never get two states.
		const states = MutableHashMap.empty<ConcurrencyKey, KeyState>();
		const stateOf = (key: ConcurrencyKey): KeyState =>
			Option.getOrElse(MutableHashMap.get(states, key), () => {
				const slots = Semaphore.makeUnsafe(options.limits[key]?.maxInFlight ?? 1);
				const state: KeyState = { slots, backoff: Ref.makeUnsafe({ rateLimits: 0, blockedUntil: 0 }) };
				MutableHashMap.set(states, key, state);
				return state;
			});
		const withPermit = Effect.fn("Limiter.withPermit")(function* <A, E, R>(
			key: ConcurrencyKey,
			effect: Effect.Effect<A, E, R>,
		) {
			const state = stateOf(key);
			return yield* state.slots.withPermit(Effect.andThen(untilUnblocked(state.backoff), effect));
		});
		const backOff = Effect.fn("Limiter.backOff")(function* (key: ConcurrencyKey, retryAfterMillis?: number) {
			const now = yield* Clock.currentTimeMillis;
			return yield* Ref.modify(stateOf(key).backoff, (blocked): [number, Blocked] => {
				const rateLimits = blocked.blockedUntil <= now ? blocked.rateLimits + 1 : blocked.rateLimits;
				const wait = Math.min(backoff.maxMillis, retryAfterMillis ?? backoff.baseMillis * 2 ** (rateLimits - 1));
				return [wait, { rateLimits, blockedUntil: Math.max(blocked.blockedUntil, now + wait) }];
			});
		});
		const recover = Effect.fn("Limiter.recover")(function* (key: ConcurrencyKey) {
			yield* Ref.update(stateOf(key).backoff, (blocked) => ({ ...blocked, rateLimits: 0 }));
		});
		return { withPermit, backOff, recover };
	});

	/** `make` as a Layer. */
	static layer(options: typeof LimiterOptions.Encoded): Layer.Layer<Limiter> {
		return Layer.effect(Limiter, Limiter.make(options));
	}
}

/**
 * Sleeps until the key's backoff has passed. Checked again after each sleep: a new rate limit may have extended it.
 * Untraced: a step of `Limiter.withPermit`'s span.
 */
const untilUnblocked: (backoff: Ref.Ref<Blocked>) => Effect.Effect<void> = Effect.fnUntraced(function* (backoff) {
	const now = yield* Clock.currentTimeMillis;
	const { blockedUntil } = yield* Ref.get(backoff);
	if (blockedUntil <= now) return;
	yield* Effect.sleep(Duration.millis(blockedUntil - now));
	return yield* untilUnblocked(backoff);
});
