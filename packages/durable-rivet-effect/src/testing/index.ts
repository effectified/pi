// For engine tests of a product: an actor that can be watched and put to sleep from the test, and a local engine
// with its client in one step. The test and its actors share a process, as they do on `LocalEngine.serve`.

import { type Context, Effect, Layer, Schedule, type Scope } from "effect";
import { type ActorContext, type AnyActorDefinition, actor } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import type * as Actor from "../actor.ts";
import * as Client from "../client.ts";
import type { EngineUnavailable } from "../errors.ts";
import * as Protocol from "../protocol.ts";

/** What a hook of an observed actor did: it woke, slept, was destroyed, or a scheduled wake action fired. */
export type Lifecycle = "wake" | "sleep" | "destroy" | "fired";

/** One action Rivet has scheduled for an actor. */
export interface Scheduled {
	readonly action: string;
	/** Epoch milliseconds. */
	readonly runAt: number;
}

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
	const rivet: AnyActorDefinition = actor({
		...config,
		onWake: async (c: Cell) => {
			await config.onWake(c);
			record(c, "wake");
		},
		onSleep: async (c: Cell) => {
			await config.onSleep(c);
			record(c, "sleep");
		},
		onDestroy: async (c: Cell) => {
			await config.onDestroy(c);
			record(c, "destroy");
		},
		actions: {
			...config.actions,
			pi: {
				...config.actions.pi,
				wake: async (c: Cell) => {
					record(c, "fired");
					return config.actions.pi.wake(c);
				},
				testSleep: (c: Cell) => {
					c.sleep();
					return null;
				},
				testSchedules: (c: Cell) => c.schedule.list(),
				testScheduleWake: async (c: Cell, afterMillis: number) => {
					await c.schedule.after(afterMillis, Protocol.WAKE);
					return null;
				},
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
export function sleep(handle: Client.Handle): Effect.Effect<void, never, Client.RivetClient> {
	return Effect.asVoid(test<null>(handle, "pi.testSleep", []));
}

/** Everything Rivet has scheduled for the actor; the host's own wake actions are those of the action `pi.wake`. */
export function schedules(handle: Client.Handle): Effect.Effect<ReadonlyArray<Scheduled>, never, Client.RivetClient> {
	return test<ReadonlyArray<Scheduled>>(handle, "pi.testSchedules", []);
}

/** Schedules one more wake action `afterMillis` ahead, as an earlier wake of the actor could have left one. */
export function scheduleWake(
	handle: Client.Handle,
	afterMillis: number,
): Effect.Effect<void, never, Client.RivetClient> {
	return Effect.asVoid(test<null>(handle, "pi.testScheduleWake", [afterMillis]));
}

/** What the hooks of the observed actor did so far in this process, in order. */
export function lifecycle(handle: Client.Handle): Effect.Effect<ReadonlyArray<Lifecycle>> {
	return Effect.sync(() => [...(recorded.get(handle.actorId) ?? [])]);
}

/**
 * Succeeds once the hooks of the observed actor recorded `event` `times` times, without calling the actor, which
 * would wake it. It dies when that takes longer than half a minute: a test that waits for a sleep that never comes.
 */
export function seen(handle: Client.Handle, event: Lifecycle, times = 1): Effect.Effect<void> {
	const count = Effect.map(lifecycle(handle), (events) => events.filter((happened) => happened === event).length);
	return Effect.repeat(count, { until: (found) => found >= times, schedule: Schedule.spaced("20 millis") }).pipe(
		Effect.timeout(SEEN_TIMEOUT_MILLIS),
		Effect.catch(() =>
			Effect.flatMap(lifecycle(handle), (events) =>
				Effect.die(new Error(`No ${event} of actor ${handle.actorId}, ${times} times: ${events.join(", ")}`)),
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
 * before its tests. `serve` is the `serve` of the runtime's entry, `@gunta/pi-durable-rivet-effect/node` or `/bun`,
 * which this entry does not import: it has no platform code.
 */
export function hosted<Options>(
	serve: (options: Options) => Effect.Effect<{ readonly endpoint: string }, EngineUnavailable, Scope.Scope>,
	options: Options,
): Effect.Effect<Hosted, EngineUnavailable, Scope.Scope> {
	return Effect.gen(function* () {
		const engine = yield* serve(options);
		const context = yield* Layer.build(Client.layer({ endpoint: engine.endpoint }));
		return { endpoint: engine.endpoint, context };
	});
}

/** The context Rivet gives the hooks and actions of an observed actor. */
type Cell = ActorContext<unknown, unknown, unknown, unknown, unknown, DatabaseProvider<RawAccess>>;

// By actor id and for the life of the process: a test reads what its own actors did, and nothing removes an entry.
const recorded = new Map<string, Array<Lifecycle>>();

function record(c: Cell, event: Lifecycle): void {
	recorded.set(c.actorId, [...(recorded.get(c.actorId) ?? []), event]);
}

/** One test action of an observed actor, which no schema describes. A failure is a defect of the test. */
function test<A>(
	handle: Client.Handle,
	name: string,
	args: Array<unknown>,
): Effect.Effect<A, never, Client.RivetClient> {
	return Client.RivetClient.use((client) =>
		Effect.promise(() =>
			client.getForId(handle.definition.name, handle.actorId).action<Array<unknown>, A>({ name, args }),
		),
	);
}
