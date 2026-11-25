// The wake keeper of one actor wake: it holds the actor awake while Pi has work that can run, and keeps one wake
// action scheduled at the earliest time Pi asks for, as Pi's host contract says (specification section 5.6).

import type { Wake } from "@earendil-works/pi-durable";
import { type DurableError, Harness } from "@gunta/pi-durable-effect";
import { Clock, Context, Effect, Layer, Option, Semaphore, Stream } from "effect";

/** The actor's side of the keeper: its schedule of wake actions, and whether it may sleep. */
export interface Alarm {
	/** Schedules one wake action at `at`, epoch milliseconds, and gives the schedule's id. */
	readonly schedule: (at: number) => Effect.Effect<string, unknown>;
	/** Cancels a scheduled wake action; one that already ran or was cancelled is not an error. */
	readonly cancel: (id: string) => Effect.Effect<void>;
	/** The wake actions scheduled now, such as those an earlier wake of the actor left. */
	readonly scheduled: Effect.Effect<ReadonlyArray<Armed>>;
	/** Holds the actor awake until `letSleep`. Idempotent. */
	readonly stayAwake: Effect.Effect<void>;
	/** Lets the actor sleep once it is idle. Idempotent. */
	readonly letSleep: Effect.Effect<void>;
}

/** One scheduled wake action. */
export interface Armed {
	readonly id: string;
	readonly at: number;
}

/**
 * What the actor's hooks ask of the keeper. Each Effect ends once the schedule it decided on is written, so what a
 * caller observes afterwards is settled.
 */
export class WakeKeeper extends Context.Service<
	WakeKeeper,
	{
		/**
		 * Before a call that can start work: makes sure a recovery wake is scheduled, so a crash cannot strand it. Work
		 * whose wake is past is resumed first.
		 */
		readonly guard: Effect.Effect<void>;
		/** After a call: resumes work whose wake is past, reads when Pi next needs the actor, and schedules for it. */
		readonly settle: Effect.Effect<void>;
		/** A scheduled wake action fired, `id` when Rivet says which: resumes Pi's due work and schedules the next. */
		readonly fired: (id: Option.Option<string>) => Effect.Effect<void, DurableError>;
	}
>()("@gunta/pi-durable-rivet-effect/WakeKeeper") {}

/**
 * How far ahead the recovery wake is while Pi has work that can run. Keeping the actor awake lasts only as long as
 * its process, so this wake is what resumes work a crash cut off: within about this long.
 */
export const RECOVERY_WAKE_MILLIS = 15_000;

/**
 * The keeper for the harness of the context, which must be opened with `hostWakes`. It adopts the earliest wake action
 * an earlier wake of the actor left and cancels the others, then follows every change Pi reports until the scope
 * closes. Closing lets the actor sleep and leaves the schedule: work a stop cut off resumes at the next wake.
 *
 * - While Pi is `active`, the actor is held awake and a wake is kept no later than the recovery time ahead.
 * - While only sleeps are left, the wake is at the earliest one, and the actor may sleep once it is written.
 * - With nothing left, no wake is kept.
 *
 * A replacement is written before the one it replaces is cancelled, so work is never without a wake: two exist for
 * that moment, one otherwise.
 *
 * A wake whose time has come is acted on by whoever sees it first: Rivet running its action (`fired`), or the next
 * call to the actor (`guard`, `settle`). Rivet runs an action some time after its time, and a caller that asks the
 * actor more often than that would otherwise find the wake past each time, replace it by the recovery wake and
 * cancel it before it ran: the work would never resume.
 */
export function layer(alarm: Alarm): Layer.Layer<WakeKeeper, never, Harness.Harness> {
	return Layer.effect(
		WakeKeeper,
		Effect.gen(function* () {
			const harness = yield* Harness.Harness;
			const scope = yield* Effect.scope;
			const lock = yield* Semaphore.make(1);
			const [earliest, ...others] = [...(yield* alarm.scheduled)].sort((a, b) => a.at - b.at);
			yield* Effect.forEach(others, (other) => alarm.cancel(other.id), { discard: true });
			let armed: Armed | undefined = earliest;
			let retrying = false;

			/** Replaces the kept wake by one at `at`; false when it could not be written, and then the actor stays awake. */
			const rearm = (at: number): Effect.Effect<boolean> =>
				Effect.gen(function* () {
					// The actor may sleep only once its wake is written.
					yield* alarm.stayAwake;
					const written = yield* Effect.option(alarm.schedule(at));
					if (Option.isNone(written)) {
						yield* retryLater;
						return false;
					}
					const previous = armed;
					armed = { id: written.value, at };
					if (previous !== undefined) yield* alarm.cancel(previous.id);
					return true;
				});

			const apply = (wake: Wake): Effect.Effect<void> =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					if (wake.active) yield* alarm.stayAwake;
					const target = wake.active ? Math.min(now + RECOVERY_WAKE_MILLIS, wake.at ?? Infinity) : wake.at;
					if (target === undefined) {
						if (armed !== undefined) yield* alarm.cancel(armed.id);
						armed = undefined;
						return yield* alarm.letSleep;
					}
					// While work runs, an earlier wake still ahead is enough: it fires, and `fired` arms the next one.
					const kept = wake.active
						? armed !== undefined && armed.at <= target && armed.at > now
						: armed?.at === target;
					if (!kept && !(yield* rearm(target))) return;
					if (!wake.active) yield* alarm.letSleep;
				});

			const read = Effect.provideService(Harness.wake, Harness.Harness, harness);
			const resume = Effect.provideService(Harness.resume, Harness.Harness, harness);

			/**
			 * Resumes Pi's due work when the kept wake's time has come and its action has not run. The wake is cancelled
			 * after: an action that runs all the same resumes once more, which changes nothing. A resume that fails leaves
			 * the wake to its action and to the next call.
			 */
			const overdue = Effect.gen(function* () {
				const late = armed;
				if (late === undefined || late.at > (yield* Clock.currentTimeMillis)) return;
				if (Option.isNone(yield* Effect.option(resume))) return;
				armed = undefined;
				yield* alarm.cancel(late.id);
			});

			const settle = Semaphore.withPermit(lock, Effect.andThen(overdue, Effect.flatMap(read, apply)));

			// A schedule Rivet refused is tried again while the actor, held awake, still runs.
			const retryLater = Effect.suspend(() => {
				if (retrying) return Effect.void;
				retrying = true;
				const again = Effect.andThen(
					Effect.sleep(RECOVERY_WAKE_MILLIS),
					Effect.suspend(() => {
						retrying = false;
						return settle;
					}),
				);
				return Effect.asVoid(Effect.forkIn(again, scope));
			});

			// Each element says only that the value changed: the keeper reads the newest one itself.
			yield* Effect.forkScoped(Stream.runForEach(Harness.wakes, () => settle));
			yield* Effect.addFinalizer(() => alarm.letSleep);

			return {
				guard: Semaphore.withPermit(
					lock,
					Effect.gen(function* () {
						yield* overdue;
						const until = (yield* Clock.currentTimeMillis) + RECOVERY_WAKE_MILLIS;
						if (armed === undefined || armed.at > until) yield* rearm(until);
					}),
				),
				settle,
				fired: (id) =>
					Semaphore.withPermit(
						lock,
						Effect.gen(function* () {
							// Rivet removes a schedule before it runs its action, so the one that fired is gone.
							if (armed !== undefined && Option.contains(id, armed.id)) armed = undefined;
							yield* resume;
							yield* apply(yield* read);
						}),
					),
			};
		}),
	);
}
