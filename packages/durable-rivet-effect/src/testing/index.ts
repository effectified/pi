// For engine tests of a product: an actor that can be watched and put to sleep from the test, and a local engine
// with its client in one step. The test and its actors share a process, as they do on `LocalEngine.serve`.

import { Array as Arr, type Context, Effect, Layer, Schedule, Schema, type Scope } from "effect";
import { type ActorContext, type AnyActorDefinition, actor } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import type * as Actor from "../actor.ts";
import * as Client from "../client.ts";
import type { EngineUnavailable } from "../errors.ts";
import * as Protocol from "../protocol.ts";

/** What a hook of an observed actor did: it woke, slept, was destroyed, or a scheduled wake action fired. */
export const Lifecycle = Schema.Literals(["wake", "sleep", "destroy", "fired"]);

/** What a hook of an observed actor did. */
export type Lifecycle = typeof Lifecycle.Type;

/** One action Rivet has scheduled for an actor. */
export const Scheduled = Schema.Struct({
	action: Schema.String,
	/** Epoch milliseconds. */
	runAt: Schema.Finite,
});

/** One action Rivet has scheduled for an actor. */
export type Scheduled = typeof Scheduled.Type;

/**
 * `definition` as a test hosts it: the same actor, with its lifecycle recorded in this process (`lifecycle`,
 * `seen`) and three actions of the test's own beside the product's, under the host's `pi` name: Rivet's forced sleep
 * (`sleep`), what Rivet has scheduled (`schedules`), and one more wake action (`scheduleWake`). Host the observed
 * definition instead of the product's; handles and calls are typed as before.
 */
export function observed<D extends Actor.Any>(definition: D): D {
	// Rivet's untyped boundary: a definition's config is the object `actor()` was given, hooks and actions included.
	const config = definition.rivet.config as {
		readonly onWake: (c: Cell) => Promise<void>;
		readonly onSleep: (c: Cell) => Promise<void>;
		readonly onDestroy: (c: Cell) => Promise<void>;
		readonly actions: { readonly pi: { readonly wake: (c: Cell) => Promise<unknown> } };
	};
	// Each hook is the host's own, then the record of what it did: Rivet awaits the promise both make.
	const rivet: AnyActorDefinition = actor({
		...config,
		onWake: (c: Cell) => config.onWake(c).then(() => record(c, "wake")),
		onSleep: (c: Cell) => config.onSleep(c).then(() => record(c, "sleep")),
		onDestroy: (c: Cell) => config.onDestroy(c).then(() => record(c, "destroy")),
		actions: {
			...config.actions,
			pi: {
				...config.actions.pi,
				wake: (c: Cell) => {
					record(c, "fired");
					return config.actions.pi.wake(c);
				},
				testSleep: (c: Cell) => {
					c.sleep();
					return null;
				},
				testSchedules: (c: Cell) => c.schedule.list(),
				testScheduleWake: (c: Cell, afterMillis: number) =>
					c.schedule.after(afterMillis, Protocol.WAKE).then(() => null),
			},
		},
	});
	return { ...definition, rivet };
}

/**
 * Puts the actor to sleep now, with Rivet's own forced sleep (`c.sleep()`): its harness and its scope close in
 * `onSleep`, as on an idle sleep. It succeeds once Rivet took the request; wait for the sleep with `seen`. The next
 * call, or a scheduled wake action, wakes the actor again.
 */
export const sleep: (handle: Client.Handle) => Effect.Effect<void, never, Client.RivetClient> = Effect.fn(
	"Testing.sleep",
)(function* (handle: Client.Handle) {
	yield* test(handle, "pi.testSleep", []);
});

/** Everything Rivet has scheduled for the actor; the host's own wake actions are those of the action `pi.wake`. */
export const schedules: (handle: Client.Handle) => Effect.Effect<ReadonlyArray<Scheduled>, never, Client.RivetClient> =
	Effect.fn("Testing.schedules")(function* (handle: Client.Handle) {
		const listed = yield* test(handle, "pi.testSchedules", []);
		// A decode boundary: the list is Rivet's, through an action no schema describes. A mismatch is the test's defect.
		return yield* Effect.orDie(decodeSchedules(listed));
	});

const decodeSchedules = Schema.decodeUnknownEffect(Schema.Array(Scheduled));

/** Schedules one more wake action `afterMillis` ahead, as an earlier wake of the actor could have left one. */
export const scheduleWake: (
	handle: Client.Handle,
	afterMillis: number,
) => Effect.Effect<void, never, Client.RivetClient> = Effect.fn("Testing.scheduleWake")(function* (
	handle: Client.Handle,
	afterMillis: number,
) {
	yield* test(handle, "pi.testScheduleWake", [afterMillis]);
});

/** What the hooks of the observed actor did so far in this process, in order. */
export function lifecycle(handle: Client.Handle): Effect.Effect<ReadonlyArray<Lifecycle>> {
	return Effect.sync(() => [...(recorded.get(handle.actorId) ?? [])]);
}

/**
 * Succeeds once the hooks of the observed actor recorded `event` `times` times, without calling the actor, which
 * would wake it. It dies when that takes longer than half a minute: a test that waits for a sleep that never comes.
 */
export function seen(handle: Client.Handle, event: Lifecycle, times = 1): Effect.Effect<void> {
	const count = Effect.map(lifecycle(handle), (events) => Arr.countBy(events, (happened) => happened === event));
	return Effect.repeat(count, { until: (found) => found >= times, schedule: Schedule.spaced("20 millis") }).pipe(
		Effect.timeout(SEEN_TIMEOUT_MILLIS),
		Effect.catch(() =>
			Effect.flatMap(lifecycle(handle), (events) =>
				Effect.die(new Error(`No ${event} of actor ${handle.actorId}, ${times} times: ${Arr.join(events, ", ")}`)),
			),
		),
		Effect.asVoid,
	);
}

const SEEN_TIMEOUT_MILLIS = 30_000;

/** A local engine that hosts a test's actors, and the client of it. */
export interface Hosted {
	readonly endpoint: string;
	/** Provide it to the Effects of the test: `Effect.provideContext(effect, hosted.context)`. */
	readonly context: Context.Context<Client.RivetClient>;
}

/**
 * Starts a local engine with `options` and builds a client of it, for the scope: what an engine test does once
 * before its tests. `serve` is the `serve` of the runtime's entry, `@effectified/pi-durable-rivet/node` or `/bun`,
 * which this entry does not import: it has no platform code.
 */
export const hosted: <Options>(
	serve: (options: Options) => Effect.Effect<{ readonly endpoint: string }, EngineUnavailable, Scope.Scope>,
	options: Options,
) => Effect.Effect<Hosted, EngineUnavailable, Scope.Scope> = Effect.fn("Testing.hosted")(function* <Options>(
	serve: (options: Options) => Effect.Effect<{ readonly endpoint: string }, EngineUnavailable, Scope.Scope>,
	options: Options,
) {
	const engine = yield* serve(options);
	const context = yield* Layer.build(Client.layer({ endpoint: engine.endpoint }));
	return { endpoint: engine.endpoint, context };
});

/** The context Rivet gives the hooks and actions of an observed actor. */
type Cell = ActorContext<unknown, unknown, unknown, unknown, unknown, DatabaseProvider<RawAccess>>;

// By actor id and for the life of the process: a test reads what its own actors did, and nothing removes an entry.
// Process-wide because Rivet runs the hooks that write it, where no Effect context reaches.
const recorded = new Map<string, Array<Lifecycle>>();

function record(c: Cell, event: Lifecycle): void {
	recorded.set(c.actorId, [...(recorded.get(c.actorId) ?? []), event]);
}

/** One test action of an observed actor, which no schema describes. A failure is a defect of the test. */
function test(
	handle: Client.Handle,
	name: string,
	args: Array<unknown>,
): Effect.Effect<unknown, never, Client.RivetClient> {
	return Client.RivetClient.use((client) =>
		Effect.promise(() => client.getForId(handle.definition.name, handle.actorId).action({ name, args })),
	);
}
