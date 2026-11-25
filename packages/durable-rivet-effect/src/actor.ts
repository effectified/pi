// The Rivet actor that holds one Pi Durable harness: its storage is the actor's SQLite, it opens when the actor wakes
// and closes when the actor sleeps or is destroyed, its actions are Effects, and a fork starts clean.

import type { Models } from "@gunta/pi-ai-effect";
import { type DurableError, Harness, type Registry, UnexpectedError } from "@gunta/pi-durable-effect";
import { Cause, Clock, Effect, Exit, FiberSet, Layer, Option, Predicate, Schema } from "effect";
import {
	type ActorCron,
	type ActorFork,
	type ActorForkLink,
	type ActorOptionsInput,
	type ActorSchedule,
	type AnyActorDefinition,
	actor,
	type ScheduledFireInfo,
} from "rivetkit";
import type { ClientRaw } from "rivetkit/client";
import { db } from "rivetkit/db";
import type * as Action from "./action.ts";
import { ActorDatabase, ActorEngine, ActorInfo, storage } from "./actor-context.ts";
import { type Answer, defect } from "./answer.ts";
import type * as Fork from "./fork.ts";
import * as ForkRecord from "./fork-record.ts";
import * as Generation from "./generation.ts";
import * as Protocol from "./protocol.ts";
import * as SqliteDatabase from "./sqlite-database.ts";
import * as WakeKeeper from "./wake-keeper.ts";

/** What the product's Layers, actions and fork hygiene find in their context beside what `layer` provides. */
export type Provided = ActorInfo | ActorDatabase | ActorEngine;

/** What an action of the actor may need: the harness, what it was built from, and what `layer` and `services` give. */
export type InActor<P, S> = Harness.Harness | Registry.Registry | Models | Provided | P | S;

/** The options of the harness a product may set; the host owns the wake-ups and resumes when the actor wakes. */
export type HarnessOptions<R> = Omit<Harness.Options<R>, "hostWakes" | "resume" | "readOnly">;

/** The product's actions by name. `pi` and `destroy` are this host's own. */
export type Actions<R> = Readonly<Record<string, Action.Action<Action.Wire, Action.Wire, Action.Wire, R>>> & {
	readonly pi?: never;
	readonly destroy?: never;
};

/**
 * The harness options of an actor: the options themselves, or an Effect that gives them once `layer` is built, for
 * options that need a service of the product (Pi's telemetry adapter is one). `E` is what that Effect fails with.
 */
export type HarnessConfig<P, E = never> =
	| HarnessOptions<Provided | P>
	| Effect.Effect<HarnessOptions<Provided | P>, E, Registry.Registry | Models | Provided | P>;

/**
 * What an actor is made of. `P` is what `layer` provides beside the registry and the models, `S` what `services`
 * provides, `HE` what the Effect of `harness` fails with.
 */
export interface Config<A extends Actions<InActor<P, S>>, P, LE, S, SE, HE = never> {
	/**
	 * What the harness runs on beside its storage: the registry (tools, hooks, tasks, plugin extensions), the models,
	 * and whatever their handlers and the actions need. Built once per wake of the actor.
	 */
	readonly layer: Layer.Layer<Registry.Registry | Models | P, LE, Provided>;
	/**
	 * Services built on the open harness, for the actions: what needs `Harness` to exist, such as a recorder's pump.
	 * Built after the harness at each wake, and not at all while fork hygiene runs. `NoInfer`: what `layer` provides
	 * is read off `layer` alone, so services that need less of it do not narrow what `harness` may use.
	 */
	readonly services?: Layer.Layer<S, SE, Harness.Harness | Registry.Registry | Models | Provided | NoInfer<P>>;
	/**
	 * Options of `Harness.layer`; what its `conversationCreated` needs comes from `layer`. Also as an Effect on what
	 * `layer` provides, run at each wake after `layer` is built; its failure is a harness that did not open.
	 * `NoInfer`: what `layer` provides is read off `layer` alone.
	 */
	readonly harness?: HarnessConfig<NoInfer<P>, HE>;
	/** Namespaces Pi's tables and this host's own in the actor database, beside the product's. Default `pi_`. */
	readonly prefix?: string;
	/** The actions callers reach with `Client.call`. */
	readonly actions: A;
	/** Run in order inside a fork before its first call: see `Fork.Hygiene`. */
	readonly forkHygiene?: ReadonlyArray<Fork.Hygiene<Registry.Registry | Models | ActorDatabase | NoInfer<P>>>;
	/**
	 * Rivet's options of the actor, passed on unchanged: `sleepTimeout` (idle time before it sleeps, 30 seconds),
	 * `actionTimeout` (60 seconds), `sleepGracePeriod` and the rest.
	 */
	readonly options?: ActorOptionsInput;
}

/** An actor made by `make`: what `Host.serve` registers and `Client` calls. */
export interface Definition<Name extends string, A> {
	/** The name the actor is registered under. */
	readonly name: Name;
	readonly actions: A;
	/** The rivetkit actor definition, for a registry a product sets up itself: `setup({ use: Host.use([...]) })`. */
	readonly rivet: AnyActorDefinition;
}

/** Any actor of this host. */
export type Any = Definition<string, Readonly<Record<string, Action.Any>>>;

/**
 * Defines the actor `name`: one actor is one harness storage.
 *
 * - **Wake.** When the actor wakes, `layer`, Pi's storage on the actor's SQLite, the harness and `services` are built
 *   in one scope, and work a sleep or a crash cut off continues. A harness that cannot open leaves the actor up: every
 *   call answers with that defect and tries to open again.
 * - **Calls.** An action runs with that scope's services. The actor stays awake while Pi has work that can run, and a
 *   scheduled wake action brings it back for a sleeping task or a parked call at its time.
 * - **Sleep and destroy.** Running handlers are interrupted and the scope is closed, harness included, before the
 *   hook returns. What a stop cut off stays stored and resumes at the next wake.
 * - **Fork.** In an actor made by `Client.fork`, before anything else: every schedule the copy inherited is
 *   cancelled, then `forkHygiene` runs on the copied storage, then a row records that it ran, for which fork.
 */
export function make<
	const Name extends string,
	A extends Actions<InActor<P, S>>,
	P = never,
	LE = never,
	S = never,
	SE = never,
	HE = never,
>(name: Name, config: Config<A, P, LE, S, SE, HE>): Definition<Name, A> {
	type R = InActor<P, S> | WakeKeeper.WakeKeeper;
	const prefix = config.prefix ?? "pi_";
	const given = config.harness ?? {};
	// The one runtime check of a typed value here: the option is the options or an Effect of them, by its type.
	const harnessOptions = Effect.isEffect(given) ? given : Effect.succeed(given);

	/**
	 * The harness of an actor on its own database, with the product's `layer`. `host` is what the host decides of the
	 * harness options: the wake-ups are its own, and whether work resumes as the harness opens.
	 */
	const harness = <DR>(
		c: Cell<R>,
		database: Layer.Layer<ActorDatabase, never, DR>,
		forkInput: Effect.Effect<Option.Option<Schema.Json>, DurableError, ActorDatabase>,
		host: { readonly resume: boolean },
	) =>
		Layer.unwrap(
			Effect.map(harnessOptions, (options) => Harness.layer({ ...options, hostWakes: true, resume: host.resume })),
		).pipe(
			Layer.provide(storage({ prefix })),
			Layer.provideMerge(config.layer),
			Layer.provideMerge(
				Layer.effect(
					ActorInfo,
					Effect.map(forkInput, (input) => identity(c, input)),
				),
			),
			Layer.provideMerge(database),
			// Rivet's untyped boundary: the context gives rivetkit's client typed by a registry, which this host has not.
			Layer.provideMerge(Layer.succeed(ActorEngine, { connect: Effect.sync(() => c.client() as ClientRaw) })),
		);

	/** What a fork's hygiene recorded as the fork's input; none for an actor that is not a fork. */
	const recordedForkInput = (c: Cell<R>) =>
		Option.match(Option.fromUndefinedOr(c.forkChain.at(-1)), {
			onNone: () => Effect.succeed(Option.none<Schema.Json>()),
			onSome: (link) =>
				ActorDatabase.use((database) =>
					Effect.map(
						Effect.flatMap(ForkRecord.record(database, prefix), (forks) => forks.find(link)),
						Option.flatten,
					),
				),
		});

	/**
	 * This wake's runtime, opened on first use. A failed open is tried again by the next call. The actor's database
	 * runs its operations on the wake's `Work`: on the wake's clock, and what is left of them once the harness has
	 * closed ends with the wake.
	 */
	const generation = (c: Cell<R>): Promise<Exit.Exit<Generation.Generation<R>, unknown>> => {
		const wake = c.vars.wake;
		const database = Layer.effect(
			ActorDatabase,
			Generation.Work.use((work) =>
				Effect.map(FiberSet.runtimePromise(work)(), (run) => SqliteDatabase.make(c.db, run)),
			),
		);
		wake.opening ??= Effect.runPromiseExit(
			Generation.open(
				Layer.mergeAll(config.services ?? Layer.empty, WakeKeeper.layer(alarm(c))).pipe(
					Layer.provideMerge(harness(c, database, recordedForkInput(c), { resume: true })),
				),
			),
		).then((opened) => {
			if (Exit.isFailure(opened)) wake.opening = undefined;
			return opened;
		});
		return wake.opening;
	};

	/** Runs `effect` in this wake and answers as an action must: with data, whatever happened. */
	const call = async (c: Cell<R>, effect: Effect.Effect<Answer, never, R>): Promise<Answer> => {
		if (c.vars.wake.stopped) return STOPPING;
		const opened = await generation(c);
		if (Exit.isFailure(opened)) return defect(opened.cause);
		const answered = await opened.value.run(effect);
		return Exit.isSuccess(answered) ? answered.value : defect(answered.cause);
	};

	const close = async (c: Cell<R>): Promise<void> => {
		const wake = c.vars.wake;
		wake.stopped = true;
		const opened = await wake.opening;
		if (opened !== undefined && Exit.isSuccess(opened)) await Effect.runPromise(opened.value.close);
	};

	/**
	 * What a fork does before its first call. A failure fails the actor's start, and Rivet runs the hook again. Its
	 * database operations are fibers of its scope, so an abort of the actor ends them with it.
	 */
	const startFork = (c: Cell<R>, fork: ActorFork): Effect.Effect<void, unknown> =>
		Effect.gen(function* () {
			// Whatever the source had scheduled is the source's work: the copy starts with nothing scheduled.
			for (const inherited of yield* rivetRequest(() => c.schedule.list())) {
				yield* rivetRequest(() => c.schedule.cancel(inherited.id));
			}
			for (const job of yield* rivetRequest(() => c.cron.list())) {
				yield* rivetRequest(() => c.cron.delete(job.name));
			}
			const database = SqliteDatabase.make(c.db, yield* FiberSet.makeRuntimePromise());
			const forks = yield* ForkRecord.record(database, prefix);
			const link = { actorId: fork.actorId, key: fork.key, forkedAt: fork.forkedAt };
			// Recorded already: a start that failed after the hygiene was stored. Running it again would be harmless too.
			if (Option.isSome(yield* forks.find(link))) return;
			// A trust boundary: the input comes from whoever forked the actor. Anything but JSON is dropped.
			const input = Schema.decodeUnknownOption(Schema.Json)(fork.input);
			const steps = config.forkHygiene ?? [];
			if (steps.length > 0) {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(
							harness(c, Layer.succeed(ActorDatabase, database), Effect.succeed(input), { resume: false }),
						);
						for (const step of steps) yield* Effect.provideContext(step, context);
					}),
				);
			}
			yield* forks.mark(link, input, yield* Clock.currentTimeMillis);
		}).pipe(Effect.scoped);

	const actions = Object.fromEntries(
		Object.entries(config.actions).map(([action, definition]) => [
			action,
			(c: Cell<R>, encoded: unknown) =>
				call(
					c,
					Effect.gen(function* () {
						const keeper = yield* WakeKeeper.WakeKeeper;
						yield* keeper.guard;
						const answer = yield* definition.run(encoded);
						yield* keeper.settle;
						return answer;
					}),
				),
		]),
	);

	const rivet = actor({
		db: db(),
		createVars: (): Vars<R> => ({ wake: { opening: undefined, stopped: false } }),
		onFork: (c: Cell<R>, fork) => Effect.runPromise(startFork(c, fork), { signal: c.abortSignal }),
		onWake: async (c: Cell<R>) => {
			const opened = await generation(c);
			if (Exit.isSuccess(opened)) return;
			// The actor stays up, so a call can answer with the cause. The cause may quote content: only its name is logged.
			c.log.warn({
				msg: "the Pi Durable harness did not open; the next call tries again",
				error: errorName(opened),
			});
		},
		onSleep: close,
		onDestroy: close,
		actions: {
			...actions,
			[Protocol.DESTROY]: (c: Cell<R>) => Effect.runPromise(destroy(c), { signal: c.abortSignal }),
			pi: {
				wake: (c: Cell<R>) =>
					call(
						c,
						Effect.as(
							Effect.orDie(
								WakeKeeper.WakeKeeper.use((keeper) =>
									keeper.fired(Option.fromUndefinedOr(c.scheduledFire?.id)),
								),
							),
							{ _tag: "success", value: null },
						),
					),
				status: (c: Cell<R>) => call(c, Protocol.status.run(null)),
				lineage: (c: Cell<R>) => call(c, Protocol.lineage.run(null)),
			},
		},
		options: config.options,
	});
	return { name, actions: config.actions, rivet };
}

/**
 * What this host uses of the context Rivet gives an actor's hooks and actions, typed structurally: Rivet's own context
 * types carry eight parameters this host does not use.
 */
interface Cell<R> {
	readonly actorId: string;
	readonly name: string;
	readonly key: string[];
	readonly namespace: string;
	readonly forkChain: ActorForkLink[];
	readonly db: SqliteDatabase.RawDatabase;
	readonly schedule: ActorSchedule;
	readonly cron: ActorCron;
	readonly abortSignal: AbortSignal;
	readonly vars: Vars<R>;
	readonly log: { warn(fields: Readonly<Record<string, unknown>>): void };
	/** Present only when a schedule invokes the action. */
	readonly scheduledFire?: ScheduledFireInfo;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	destroy(): void;
	/** Rivet's client of the engine the actor runs on, made from the registry's own configuration. */
	client(): unknown;
}

/** The in-memory state Rivet keeps for one wake of an actor (`createVars`): this wake's runtime, opened or not. */
interface Vars<R> {
	readonly wake: {
		opening: Promise<Exit.Exit<Generation.Generation<R>, unknown>> | undefined;
		/** Set when the actor began to sleep or to be destroyed: nothing opens the harness again in this wake. */
		stopped: boolean;
	};
}

const STOPPING: Answer = { _tag: "defect", message: "The actor is stopping" };

function identity<R>(c: Cell<R>, forkInput: Option.Option<Schema.Json>) {
	return {
		actorId: c.actorId,
		name: c.name,
		key: c.key,
		namespace: c.namespace,
		forkChain: c.forkChain,
		forkInput,
	};
}

/** The actor's schedule of wake actions and its keep-awake, as the wake keeper asks for them. */
function alarm<R>(c: Cell<R>): WakeKeeper.Alarm {
	let release: (() => void) | undefined;
	const letSleep = (): void => {
		release?.();
		release = undefined;
	};
	// Holding the actor awake blocks an idle sleep. Once a stop has begun it would only delay the stop.
	c.abortSignal.addEventListener("abort", letSleep, { once: true });
	return {
		schedule: (at) => rivetRequest(() => c.schedule.at(at, Protocol.WAKE)),
		cancel: (id) => Effect.ignore(rivetRequest(() => c.schedule.cancel(id))),
		// A list Rivet refuses counts as empty: a wake left unadopted fires once more, and that is harmless.
		scheduled: Effect.map(
			Effect.orElseSucceed(
				rivetRequest(() => c.schedule.list()),
				() => [],
			),
			(events) =>
				events
					.filter((event) => event.action === Protocol.WAKE)
					.map((event) => ({ id: event.id, at: event.runAt })),
		),
		stayAwake: Effect.sync(() => {
			if (release !== undefined || c.abortSignal.aborted) return;
			const held = Promise.withResolvers<void>();
			release = held.resolve;
			void c.keepAwake(held.promise);
		}),
		letSleep: Effect.sync(letSleep),
	};
}

/** A request to Rivet from inside the actor: its schedule, its database. A rejection is an `UnexpectedError`. */
function rivetRequest<A>(request: () => Promise<A>): Effect.Effect<A, UnexpectedError> {
	return Effect.tryPromise({ try: request, catch: (cause) => new UnexpectedError({ cause }) });
}

/** Reads the size of the database, destroys the actor, and answers with the size. */
function destroy<R>(c: Cell<R>): Effect.Effect<Answer> {
	return Effect.gen(function* () {
		const databaseBytes = yield* Effect.option(rivetRequest(() => databaseSize(c.db)));
		yield* Effect.sync(() => c.destroy());
		const value = yield* Effect.orDie(encodeDestroyed({ databaseBytes }));
		return { _tag: "success" as const, value };
	}).pipe(Effect.catchCause((cause) => Effect.succeed(defect(cause))));
}

const encodeDestroyed = Schema.encodeUnknownEffect(Schema.toCodecJson(Protocol.Destroyed));

/** Rivet reports no bytes written per actor; the size of the SQLite database is what an actor can read of itself. */
async function databaseSize(raw: SqliteDatabase.RawDatabase): Promise<number> {
	const [pages] = await raw.execute("PRAGMA page_count");
	const [size] = await raw.execute("PRAGMA page_size");
	return Number(pages?.page_count) * Number(size?.page_size);
}

/** The class of what a failed open failed with, for a log line without content. */
function errorName(opened: Exit.Failure<unknown, unknown>): string {
	const error = Cause.squash(opened.cause);
	return Predicate.isError(error) ? error.name : typeof error;
}
