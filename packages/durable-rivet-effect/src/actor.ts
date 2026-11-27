// The Rivet actor that holds one Pi Durable harness: its storage is the actor's SQLite, it opens when the actor wakes
// and closes when the actor sleeps or is destroyed, its actions are Effects, and a fork starts clean.

import type { Models, StrictOmit } from "@effectified/pi-ai";
import { type DurableError, Harness, type Registry, UnexpectedError } from "@effectified/pi-durable";
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Option,
	Predicate,
	Record as Rec,
	Schema,
	Semaphore,
} from "effect";
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
import {
	ActorDatabase,
	ActorEngine,
	ActorInfo,
	ActorSql,
	type ForkLink,
	type Identity,
	storage,
} from "./actor-context.ts";
import * as Sql from "./actor-sql.ts";
import { type Answer, defect } from "./answer.ts";
import type * as Fork from "./fork.ts";
import * as ForkRecord from "./fork-record.ts";
import * as Generation from "./generation.ts";
import { ActorId } from "./ids.ts";
import * as Protocol from "./protocol.ts";
import * as SqliteDatabase from "./sqlite-database.ts";
import * as WakeKeeper from "./wake-keeper.ts";

/** What the product's Layers, actions and fork hygiene find in their context beside what `layer` provides. */
export type Provided = ActorInfo | ActorSql | ActorDatabase | ActorEngine;

/** What an action of the actor may need: the harness, what it was built from, and what `layer` and `services` give. */
export type InActor<P, S> = Harness.Harness | Registry.Registry | Models | Provided | P | S;

/** The options of the harness a product may set; the host owns the wake-ups and resumes when the actor wakes. */
export type HarnessOptions<R> = StrictOmit<Harness.Options<R>, "hostWakes" | "resume" | "readOnly">;

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
 *
 * Rivet calls the actor's hooks and actions and awaits promises: each one runs its Effect with `Effect.runPromise`,
 * the only place this module leaves Effect.
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
	// What opening a wake's harness can fail with: the product's Layers and options, and Pi's storage and harness.
	type OpenError = DurableError | LE | SE | HE;
	type C = Cell<R, OpenError>;
	const prefix = config.prefix ?? "pi_";
	const given = config.harness ?? {};
	// The one runtime check of a typed value here: the option is the options or an Effect of them, by its type.
	const harnessOptions = Effect.isEffect(given) ? given : Effect.succeed(given);

	/**
	 * The harness of an actor on its own database, with the product's `layer`. `host` is what the host decides of the
	 * harness options: the wake-ups are its own, and whether work resumes as the harness opens.
	 */
	const harness = <DR>(
		c: C,
		database: Layer.Layer<ActorSql | ActorDatabase, never, DR>,
		forkInput: Effect.Effect<Option.Option<Schema.Json>, DurableError, ActorSql>,
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
					Effect.map(forkInput, (input) => identityOf(c, input)),
				),
			),
			Layer.provideMerge(database),
			// Rivet's untyped boundary: the context gives rivetkit's client typed by a registry, which this host has not.
			Layer.provideMerge(Layer.succeed(ActorEngine, { connect: Effect.sync(() => c.client() as ClientRaw) })),
		);

	/** What a fork's hygiene recorded as the fork's input; none for an actor that is not a fork. */
	const recordedForkInput = (c: C): Effect.Effect<Option.Option<Schema.Json>, DurableError, ActorSql> =>
		Option.match(Arr.last(c.forkChain), {
			onNone: () => Effect.succeedNone,
			onSome: (link) =>
				ActorSql.use((sql) =>
					Effect.flatMap(ForkRecord.record(sql, prefix), (forks) =>
						Effect.map(forks.find(forkLinkOf(link)), Option.flatten),
					),
				),
		});

	/**
	 * This wake's runtime, opened on first use: a call that comes while it opens waits for that open. A failed open is
	 * tried again by the next call. The actor's database runs its operations on the wake's `Work`: on the wake's clock,
	 * and what is left of them once the harness has closed ends with the wake.
	 */
	const generation = (c: C): Effect.Effect<Generation.Generation<R>, OpenError> =>
		Effect.suspend(() => {
			const wake = c.vars.wake;
			if (wake.opening !== undefined) return Deferred.await(wake.opening);
			const opening = Deferred.makeUnsafe<Generation.Generation<R>, OpenError>();
			wake.opening = opening;
			const database = Layer.effectContext(Generation.Work.use((work) => databaseOf(c.db, work)));
			const layer = Layer.mergeAll(config.services ?? Layer.empty, WakeKeeper.layer(alarm(c))).pipe(
				Layer.provideMerge(harness(c, database, recordedForkInput(c), { resume: true })),
			);
			return Effect.onExit(Generation.open(layer), (opened) =>
				Effect.andThen(
					Effect.sync(() => {
						if (Exit.isFailure(opened)) wake.opening = undefined;
					}),
					Deferred.done(opening, opened),
				),
			);
		});

	/** Runs `effect` in this wake as the action `action`, and answers as an action must: with data, whatever happened. */
	const call = Effect.fn("Actor.call")(
		function* (c: C, action: string, effect: Effect.Effect<Answer, never, R>) {
			yield* Effect.annotateCurrentSpan({ actor: name, actorId: c.actorId, action });
			if (c.vars.wake.stopped) return STOPPING;
			const opened = yield* generation(c);
			const handler = yield* opened.run(effect);
			return yield* Fiber.join(handler);
		},
		Effect.catchCause((cause) => Effect.succeed(defect(cause))),
	);

	/** A product's action between the wake keeper's guard, before it, and its settle, after it. */
	const kept = Effect.fnUntraced(function* (answer: Effect.Effect<Answer, never, R>) {
		const keeper = yield* WakeKeeper.WakeKeeper;
		yield* keeper.guard;
		const answered = yield* answer;
		yield* keeper.settle;
		return answered;
	});

	/** The actor woke: its harness opens and resumes. One that does not open leaves the actor up, for calls to retry. */
	const awaken = Effect.fn("Actor.wake")(function* (c: C) {
		const opened = yield* Effect.exit(generation(c));
		if (Exit.isSuccess(opened)) return;
		// The actor stays up, so a call can answer with the cause. The cause may quote content: only its name is logged.
		yield* Effect.sync(() =>
			c.log.warn({
				msg: "the Pi Durable harness did not open; the next call tries again",
				error: errorName(opened.cause),
			}),
		);
	});

	/** The actor sleeps or is destroyed: nothing opens in this wake any more, and an open runtime closes. */
	const close = Effect.fn("Actor.close")(function* (c: C) {
		const wake = c.vars.wake;
		wake.stopped = true;
		if (wake.opening === undefined) return;
		const opened = yield* Effect.exit(Deferred.await(wake.opening));
		if (Exit.isSuccess(opened)) yield* opened.value.close;
	});

	/** A scheduled wake action ran: Pi's due work resumes and the next wake is scheduled. */
	const fired = (c: C): Effect.Effect<Answer, never, R> =>
		WakeKeeper.WakeKeeper.use((keeper) => keeper.fired(Option.fromUndefinedOr(c.scheduledFire?.id))).pipe(
			Effect.orDie,
			Effect.as(WOKEN),
		);

	/**
	 * What a fork does before its first call. A failure fails the actor's start, and Rivet runs the hook again. Its
	 * database operations are fibers of its scope, so an abort of the actor ends them with it.
	 */
	const startFork = Effect.fn("Actor.fork")(function* (c: C, fork: ActorFork) {
		// Whatever the source had scheduled is the source's work: the copy starts with nothing scheduled.
		const inherited = yield* rivetRequest(() => c.schedule.list());
		yield* Effect.forEach(inherited, (event) => rivetRequest(() => c.schedule.cancel(event.id)), {
			concurrency: 1,
			discard: true,
		});
		const jobs = yield* rivetRequest(() => c.cron.list());
		yield* Effect.forEach(jobs, (job) => rivetRequest(() => c.cron.delete(job.name)), {
			concurrency: 1,
			discard: true,
		});
		const work = yield* FiberSet.make();
		const database = yield* databaseOf(c.db, work);
		const forks = yield* ForkRecord.record(Context.get(database, ActorSql), prefix);
		const link = forkLinkOf(fork);
		// Recorded already: a start that failed after the hygiene was stored. Running it again would be harmless too.
		const recorded = yield* forks.find(link);
		if (Option.isSome(recorded)) return;
		// A trust boundary: the input comes from whoever forked the actor. Anything but JSON is dropped.
		const input = Schema.decodeUnknownOption(Schema.Json)(fork.input);
		const steps = Arr.map(config.forkHygiene ?? [], hygieneStep);
		if (steps.length > 0) {
			// The harness of the hygiene closes before the record is written.
			const hygiene = harness(c, Layer.succeedContext(database), Effect.succeed(input), { resume: false });
			yield* Effect.scoped(
				Effect.flatMap(Layer.build(hygiene), (context) =>
					Effect.forEach(steps, (step) => Effect.provideContext(step, context), { concurrency: 1, discard: true }),
				),
			);
		}
		const at = yield* Clock.currentTimeMillis;
		yield* forks.mark(link, input, at);
	}, Effect.scoped);

	// The product's actions alone: `pi` and `destroy` are never among them.
	const product: Readonly<Record<string, Action.Action<Action.Wire, Action.Wire, Action.Wire, R>>> = config.actions;
	const actions = Rec.map(
		product,
		(definition, action) => (c: C, encoded: unknown) =>
			Effect.runPromise(call(c, action, kept(definition.run(encoded)))),
	);

	const rivet = actor({
		db: db(),
		createVars: (): Vars<R, OpenError> => ({ wake: { opening: undefined, stopped: false } }),
		onFork: (c: C, fork) => Effect.runPromise(startFork(c, fork), { signal: c.abortSignal }),
		onWake: (c: C) => Effect.runPromise(awaken(c)),
		onSleep: (c: C) => Effect.runPromise(close(c)),
		onDestroy: (c: C) => Effect.runPromise(close(c)),
		actions: {
			...actions,
			[Protocol.DESTROY]: (c: C) => Effect.runPromise(destroy(c), { signal: c.abortSignal }),
			pi: {
				wake: (c: C) => Effect.runPromise(call(c, Protocol.WAKE, fired(c))),
				status: (c: C) => Effect.runPromise(call(c, Protocol.STATUS, Protocol.status.run(null))),
				lineage: (c: C) => Effect.runPromise(call(c, Protocol.LINEAGE, Protocol.lineage.run(null))),
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
interface Cell<R, E> {
	readonly actorId: string;
	readonly name: string;
	readonly key: string[];
	readonly namespace: string;
	readonly forkChain: ActorForkLink[];
	readonly db: SqliteDatabase.RawDatabase;
	readonly schedule: ActorSchedule;
	readonly cron: ActorCron;
	readonly abortSignal: AbortSignal;
	readonly vars: Vars<R, E>;
	readonly log: { warn(fields: Readonly<Record<string, unknown>>): void };
	/** Present only when a schedule invokes the action. */
	readonly scheduledFire?: ScheduledFireInfo;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	destroy(): void;
	/** Rivet's client of the engine the actor runs on, made from the registry's own configuration. */
	client(): unknown;
}

/** The in-memory state Rivet keeps for one wake of an actor (`createVars`): this wake's runtime, opened or not. */
interface Vars<R, E> {
	readonly wake: {
		/** The open of this wake's runtime under way or done; none before the first, and after one that failed. */
		opening: Deferred.Deferred<Generation.Generation<R>, E> | undefined;
		/** Set when the actor began to sleep or to be destroyed: nothing opens the harness again in this wake. */
		stopped: boolean;
	};
}

const STOPPING: Answer = { _tag: "defect", message: "The actor is stopping" };

const WOKEN: Answer = { _tag: "success", value: null };

/** A step of the product's fork hygiene, whose failure fails the fork's start, as an `UnexpectedError`. */
// @effect-diagnostics-next-line anyUnknownInErrorContext:off A hygiene step may fail with anything (`Fork.Hygiene`): this line makes that an `UnexpectedError`.
const hygieneStep = <R>(step: Fork.Hygiene<R>) => Effect.mapError(step, (cause) => UnexpectedError.make({ cause }));

/** The actor's identity, its ids branded where they enter from Rivet's context. */
function identityOf<R, E>(c: Cell<R, E>, forkInput: Option.Option<Schema.Json>): Identity {
	return {
		actorId: ActorId.make(c.actorId),
		name: c.name,
		key: c.key,
		namespace: c.namespace,
		forkChain: Arr.map(c.forkChain, forkLinkOf),
		forkInput,
	};
}

/** One fork behind an actor, as Rivet's context gives it, with the source's id branded. */
function forkLinkOf(link: ActorForkLink): ForkLink {
	return { actorId: ActorId.make(link.actorId), key: link.key, forkedAt: link.forkedAt };
}

/** The actor's schedule of wake actions and its keep-awake, as the wake keeper asks for them. */
function alarm<R, E>(c: Cell<R, E>): WakeKeeper.Alarm {
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
				Arr.map(
					Arr.filter(events, (event) => event.action === Protocol.WAKE),
					(event): WakeKeeper.Armed => ({ id: event.id, at: event.runAt }),
				),
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
	return Effect.tryPromise({ try: request, catch: (cause) => UnexpectedError.make({ cause }) });
}

/**
 * The actor's database as both services, on one queue: `ActorSql`, and the `ActorDatabase` adapter Pi's storage and
 * older code use. Their requests to Rivet are fibers of `work`.
 */
const databaseOf = Effect.fn("Actor.database")(function* (raw: SqliteDatabase.RawDatabase, work: FiberSet.FiberSet) {
	const queue = yield* Semaphore.make(1);
	const sql = yield* Sql.make(raw, queue, work);
	const run = yield* FiberSet.runtimePromise(work)();
	const database = SqliteDatabase.make(raw, run, queue);
	return Context.make(ActorSql, sql).pipe(Context.add(ActorDatabase, database));
});

/** Reads the size of the database, destroys the actor, and answers with the size. */
const destroy = Effect.fn("Actor.destroy")(
	function* <R, E>(c: Cell<R, E>) {
		const databaseBytes = yield* Effect.option(databaseSize(c.db));
		yield* Effect.sync(() => c.destroy());
		const value = yield* Effect.orDie(encodeDestroyed({ databaseBytes }));
		return { _tag: "success", value } satisfies Answer;
	},
	Effect.catchCause((cause) => Effect.succeed(defect(cause))),
);

const encodeDestroyed = Schema.encodeUnknownEffect(Schema.toCodecJson(Protocol.Destroyed));

/**
 * Rivet reports no bytes written per actor; the size of the SQLite database is what an actor can read of itself. A
 * decode boundary: the rows are what SQLite answered.
 */
const databaseSize = Effect.fnUntraced(function* (raw: SqliteDatabase.RawDatabase) {
	const [pages] = yield* Effect.flatMap(
		rivetRequest(() => raw.execute("PRAGMA page_count")),
		decodePageCount,
	);
	const [size] = yield* Effect.flatMap(
		rivetRequest(() => raw.execute("PRAGMA page_size")),
		decodePageSize,
	);
	return pages.page_count * size.page_size;
});

const decodePageCount = Schema.decodeUnknownEffect(Schema.NonEmptyArray(Schema.Struct({ page_count: Schema.Int })));

const decodePageSize = Schema.decodeUnknownEffect(Schema.NonEmptyArray(Schema.Struct({ page_size: Schema.Int })));

/** The class of what a failed open failed with, for a log line without content. */
function errorName(cause: Cause.Cause<unknown>): string {
	const error = Cause.squash(cause);
	return Predicate.isError(error) ? error.name : typeof error;
}
