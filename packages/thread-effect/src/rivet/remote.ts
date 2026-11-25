// The caller's side of the thread actors: the thread, swarm and fork operations of a product's ports as Effects on a
// client of the Rivet host, one actor per thread, with errors that say whether to try again.

import type * as Approvals from "@gunta/pi-approvals-effect";
import { type Action, type CallError, Client } from "@gunta/pi-durable-rivet-effect";
import type * as Review from "@gunta/pi-review-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Context, Duration, Effect, Layer, Option, type Schedule } from "effect";
import { type ReviewerSharesFamily, ThreadNotFound } from "../errors.ts";
import type { Outcome } from "../outcome.ts";
import type * as Swarms from "../swarms.ts";
import type * as Threads from "../threads.ts";
import * as ForkAgent from "./fork-agent.ts";
import * as SwarmId from "./swarm-id.ts";
import type * as ThreadActor from "./thread-actor.ts";
import { HostUnavailable, OperationFailed, StillWorking } from "./wire.ts";

/** What every operation can fail with: the host cannot be reached now, or the operation failed in the actor. */
export type Failure = HostUnavailable | OperationFailed;

/**
 * One fork of a swarm: the swarm, and the job the fork was made for. `thread` is the thread the swarm runs on; left
 * out, the swarm id names it (`SwarmId`).
 */
export interface ForkRef {
	readonly thread?: string;
	readonly swarmId: string;
	readonly jobKey: string;
}

/**
 * One operation on a swarm, found in the actor of its thread. With the swarm id alone, the id names the thread, as
 * every id `run` accepts does; with the thread given first, the id is taken as it is.
 */
export interface OnSwarm<A> {
	(swarmId: string): Effect.Effect<A, Failure | ThreadNotFound | SwarmId.SwarmIdNotOfThread>;
	(thread: string, swarmId: string): Effect.Effect<A, Failure | ThreadNotFound>;
}

/**
 * A swarm as a caller plans it: `Swarms.Plan`, with the agent change of the forks as what crosses to the actor
 * (`ForkAgent.ForkAgent`): the model, the thinking level, the instructions, the turns, and tools and extensions by
 * name.
 */
export interface Plan<I> extends Omit<Swarms.Plan<I>, "agent"> {
	/** What every fork runs with, over what the thread has: a cheaper model, fewer tools. */
	readonly agent?: ForkAgent.ForkAgent;
}

/** The operations, in the shape of a product's ports to its agent runtime, its swarm runtime and its fork storage. */
export interface Service {
	/** Threads by key: one actor per thread, found by the thread's key. */
	readonly threads: {
		/**
		 * Starts a thread: finds or creates its actor and admits its task under the request key `key`. It returns once
		 * the task is durably admitted, never at the answer. The same call again is the same work; `created` is false
		 * for a thread that existed, and `key` is the key its task stands under.
		 */
		readonly start: (
			work: Threads.Work,
			key: string,
		) => Effect.Effect<Threads.Admitted, Failure | ReviewerSharesFamily>;
		/**
		 * Takes a stopped thread on, under the request key `key` (`Threads.takeOn`): a run that ended without an answer
		 * is continued, a deferred review is asked for again. It returns once that is admitted.
		 */
		readonly resume: (thread: string, key: string) => Effect.Effect<Threads.TakenOn, Failure | ThreadNotFound>;
		/** Cancels a thread's run; succeeds once nothing of it runs. Idempotent. */
		readonly cancel: (thread: string) => Effect.Effect<void, Failure | ThreadNotFound>;
		/** Whether the thread has unfinished work. False for a thread nothing started: no actor is created to ask. */
		readonly probe: (thread: string) => Effect.Effect<{ readonly alive: boolean }, Failure>;
		/** The thread's durable outcome so far; none while it works. */
		readonly outcome: (thread: string) => Effect.Effect<Option.Option<Outcome>, Failure | ThreadNotFound>;
		/**
		 * The thread's outcome once it has one, asking again on `schedule`. A schedule that ends fails the wait with
		 * `StillWorking`. Every question wakes the thread's actor, so a schedule that asks a thread parked for a person
		 * every few seconds keeps its actor awake: space it by what the wait is worth. A product that wants to be told
		 * asks nothing: the thread's actor calls its `OutcomeSink` for every outcome the thread reaches.
		 */
		readonly ended: (
			thread: string,
			schedule: Schedule.Schedule<unknown>,
		) => Effect.Effect<Outcome, Failure | ThreadNotFound | StillWorking>;
		/** Delivers a person's decision to a held thread; succeeds once it is stored. */
		readonly release: (
			thread: string,
			decision: Review.Decision,
		) => Effect.Effect<Review.Delivery, Failure | ThreadNotFound>;
		/** The approval requests of the thread's parked calls that a decision can still reach. */
		readonly pending: (thread: string) => Effect.Effect<ReadonlyArray<Approvals.Request>, Failure | ThreadNotFound>;
		/** Delivers a person's decision about one pending approval request of the thread. */
		readonly decide: (
			thread: string,
			request: Approvals.Address,
			decision: Approvals.Decision,
		) => Effect.Effect<Approvals.Delivery, Failure | ThreadNotFound>;
	};
	/**
	 * Swarms by their id: the coordinator lives in the actor of the swarm's thread, and a swarm id begins with that
	 * thread's key (`SwarmId.of`), so the id alone finds it.
	 */
	readonly swarms: {
		/**
		 * Starts a swarm on a primed thread; idempotent by `plan.id`. It returns once the coordinator is stored. Fails
		 * with `SwarmIdNotOfThread`, before anything is sent, for a `plan.id` that does not name `plan.thread`, and with
		 * `InvalidPlan` for an agent change that is no data. A change that names a tool or an extension the actor has not
		 * installed is refused there: `OperationFailed` with the reason `InvalidPlan`.
		 */
		readonly run: <I>(
			swarm: Swarm.Swarm<I, unknown>,
			plan: Plan<I>,
		) => Effect.Effect<
			{ readonly created: boolean },
			Failure | ThreadNotFound | Swarm.InvalidValue | Swarm.InvalidPlan | SwarmId.SwarmIdNotOfThread
		>;
		/** Cancels a swarm: `cancelling` once the abort is durably marked, `ended` for one that had ended. Idempotent. */
		readonly cancel: OnSwarm<"cancelling" | "ended">;
		/** Whether the coordinator still runs, and the keys of the jobs it planned, in plan order. */
		readonly probe: OnSwarm<Swarms.Probe>;
		/** The swarm's typed result; none while it runs. The thread, between the two, is optional as in `OnSwarm`. */
		readonly result: {
			<A>(
				swarm: Swarm.Swarm<never, A>,
				swarmId: string,
			): Effect.Effect<
				Option.Option<Swarm.Outcome<A>>,
				Failure | ThreadNotFound | Swarm.InvalidValue | SwarmId.SwarmIdNotOfThread
			>;
			<A>(
				swarm: Swarm.Swarm<never, A>,
				thread: string,
				swarmId: string,
			): Effect.Effect<Option.Option<Swarm.Outcome<A>>, Failure | ThreadNotFound | Swarm.InvalidValue>;
		};
		/** What each job's fork settled so far, in plan order. */
		readonly spent: OnSwarm<ReadonlyArray<Swarms.JobSpend>>;
	};
	/** The forks of swarms, which are actors. */
	readonly forks: {
		/**
		 * Destroys the fork of one job through the actor of its thread, a pinned one included. `bytesWritten` is what
		 * the swarm's Rivet driver measured: the growth of the fork's database over its source's, in whole pages. Idempotent:
		 * a second call answers what the first one learnt. Fails with `SwarmIdNotOfThread` only for a fork given
		 * without its thread whose swarm id names none.
		 */
		readonly destroy: (
			fork: ForkRef,
		) => Effect.Effect<
			{ readonly bytesWritten: Option.Option<number> },
			Failure | ThreadNotFound | SwarmId.SwarmIdNotOfThread
		>;
	};
}

/** The operations on the thread actors of one definition. */
export class Remote extends Context.Service<Remote, Service>()("@gunta/pi-thread-effect/Rivet/Remote") {}

/** Options of `layer` and of `product`. */
export interface Options {
	/**
	 * How long one operation may take before it fails with `HostUnavailable`. rivetkit's client waits without end for
	 * an engine it cannot reach. Default: 30 seconds.
	 */
	readonly timeout?: Duration.Input;
	/**
	 * The key of the actor that holds a thread, from the thread's key. Default: the thread's key alone, so one actor
	 * per thread. A product whose actor holds several threads (one conversation per session of the same piece of
	 * work) gives the part of the thread's key that names the actor. Every operation finds its actor through it: a
	 * swarm's by the thread its id names, a fork's by its swarm. A fork's own key is made from its source's, inside
	 * the actor, so it follows. Give `layer` and `product` the same function.
	 */
	readonly actorKey?: (thread: string) => Client.Key;
}

/** The operations on the actors of `definition`, on the `RivetClient` of the context (`Client.layer`). */
export function layer(
	definition: ThreadActor.Definition,
	options: Options = {},
): Layer.Layer<Remote, never, Client.RivetClient> {
	return Layer.effect(
		Remote,
		Effect.map(Effect.context<Client.RivetClient>(), (context) => make(reach(definition, options, context))),
	);
}

/**
 * The product actions of a thread actor (`ThreadActor.Options.actions`) as a caller reaches them for a thread: each
 * typed by its action's schemas, bounded in time, and failing with the action's own error or as every operation of
 * `Remote` does.
 */
export interface Product<P extends Readonly<Record<string, Action.Any>>> {
	/** One product action of the actor of a thread that has one. It never creates an actor: `ThreadNotFound` then. */
	readonly call: <Name extends keyof P & string>(
		thread: string,
		action: Name,
		input: Action.Input<P[Name]>,
	) => Effect.Effect<Action.Output<P[Name]>, Action.Failure<P[Name]> | Failure | ThreadNotFound>;
	/**
	 * One product action of the actor of a thread, created empty when there is none: how a product gives an actor
	 * what it needs before `threads.start`, which is the first thing the actor's own Layers and services read.
	 */
	readonly callOrCreate: <Name extends keyof P & string>(
		thread: string,
		action: Name,
		input: Action.Input<P[Name]>,
	) => Effect.Effect<Action.Output<P[Name]>, Action.Failure<P[Name]> | Failure>;
}

/**
 * The product actions of the actors of `definition`, on the `RivetClient` of the context. `options` are those of
 * `layer`: with the same `actorKey`, a product action reaches the actor the thread operations reach.
 */
export function product<P extends Readonly<Record<string, Action.Any>>>(
	definition: ThreadActor.Definition<string, P>,
	options: Options = {},
): Effect.Effect<Product<P>, never, Client.RivetClient> {
	return Effect.map(Effect.context<Client.RivetClient>(), (context) => {
		// The product's actions alone: a caller of a fixed action uses the operations of `Remote`.
		const own: Client.Target<string, P> = definition;
		const { on, creating } = reach(own, options, context);
		return {
			call: (thread, action, input) => on(action, thread, (handle) => Client.call(handle, action, input)),
			callOrCreate: (thread, action, input) =>
				creating(action, thread, (handle) => Client.call(handle, action, input)),
		};
	});
}

const DEFAULT_TIMEOUT: Duration.Input = "30 seconds";

/** What a call to a thread's actor fails with: the host's failures, with the action's own error `E`, or no actor. */
type CallFailure<E> = Client.ActionFailure<E> | CallError | ThreadNotFound;

/** How the operations reach the actor of a thread: `reach`. */
type Reach = ReturnType<typeof reach<ThreadActor.Definition>>;

/**
 * The two ways to the actor of a thread, for the actions of `definition`: `on`, to the actor of a thread that was
 * started, and `creating`, to that actor or a new, empty one. The actor's key is `options.actorKey` of the thread's.
 */
function reach<D extends Client.Target>(definition: D, options: Options, context: Context.Context<Client.RivetClient>) {
	const timeout = Duration.fromInputUnsafe(options.timeout ?? DEFAULT_TIMEOUT);
	const keyOf = options.actorKey ?? ((thread: string): Client.Key => [thread]);
	/**
	 * One operation: on the client, bounded in time, and failing as a caller tells failures apart. The action's own
	 * error crosses as it is; a thread without an actor, or whose actor is gone, does not exist; an engine that cannot
	 * be reached, refuses with a hint or does not answer is `HostUnavailable`; anything else failed in the actor.
	 */
	const bounded = <A, E>(
		operation: string,
		thread: string,
		effect: Effect.Effect<A, CallFailure<E>, Client.RivetClient>,
	): Effect.Effect<A, E | Failure | ThreadNotFound> =>
		effect.pipe(
			Effect.mapError((error): E | Failure | ThreadNotFound => {
				switch (error._tag) {
					case "ActionFailed":
						return error.error;
					case "ThreadNotFound":
						return error;
					case "ActorGone":
						return new ThreadNotFound({ thread });
					case "ActorDefect":
						return new OperationFailed({ operation, reason: error._tag, message: error.message });
					case "EngineUnavailable": {
						const { code, message, retryAfterMillis } = error;
						return error.retryable
							? new HostUnavailable({
									operation,
									message,
									...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
								})
							: new OperationFailed({ operation, reason: code, message });
					}
				}
			}),
			Effect.timeoutOption(timeout),
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.fail(
							new HostUnavailable({ operation, message: `No answer in ${Duration.toMillis(timeout)} ms` }),
						),
					onSome: (value) => Effect.succeed(value),
				}),
			),
			Effect.provideContext(context),
		);
	/** The actor of a thread that was started; `ThreadNotFound` when there is none. It never creates one. */
	const actorOf = (thread: string): Effect.Effect<Client.Handle<D>, CallError | ThreadNotFound, Client.RivetClient> =>
		Effect.flatMap(
			Client.find(definition, keyOf(thread)),
			Option.match({
				onNone: () => Effect.fail(new ThreadNotFound({ thread })),
				onSome: (handle) => Effect.succeed(handle),
			}),
		);
	return {
		/** One action of the actor of a thread that was started. */
		on: <A, E>(
			operation: string,
			thread: string,
			call: (handle: Client.Handle<D>) => Effect.Effect<A, CallFailure<E>, Client.RivetClient>,
		) => bounded(operation, thread, Effect.flatMap(actorOf(thread), call)),
		/** One action of the actor of a thread, found or created. An actor destroyed in between took nothing. */
		creating: <A, E>(
			operation: string,
			thread: string,
			call: (handle: Client.Handle<D>) => Effect.Effect<A, CallFailure<E>, Client.RivetClient>,
		) =>
			bounded(operation, thread, Effect.flatMap(Client.getOrCreate(definition, keyOf(thread)), call)).pipe(
				Effect.catchIf(
					(error): error is ThreadNotFound => error instanceof ThreadNotFound,
					(error) => Effect.fail(destroyed(operation, error)),
				),
			),
	};
}

/** The operations of `Remote` on the ways `reach` gives to the actors of a thread actor's definition. */
function make({ on, creating }: Reach): Service {
	const outcome = (thread: string) => on("outcome", thread, (handle) => Client.call(handle, "outcome", { thread }));
	/** `call` as an operation on a swarm: with the thread it is given, or with the one the swarm id names. */
	const onSwarm = <A>(
		call: (thread: string, swarmId: string) => Effect.Effect<A, Failure | ThreadNotFound>,
	): OnSwarm<A> => {
		function addressed(swarmId: string): Effect.Effect<A, Failure | ThreadNotFound | SwarmId.SwarmIdNotOfThread>;
		function addressed(thread: string, swarmId: string): Effect.Effect<A, Failure | ThreadNotFound>;
		function addressed(first: string, second?: string) {
			return second === undefined
				? Effect.flatMap(SwarmId.threadOf(first), (thread) => call(thread, first))
				: call(first, second);
		}
		return addressed;
	};
	/** The swarm's result as its coordinator stored it, which `result` decodes with the definition. */
	const stored = onSwarm((thread, swarmId) =>
		on("swarmResult", thread, (handle) => Client.call(handle, "swarmResult", { swarmId })),
	);
	function result<A>(
		swarm: Swarm.Swarm<never, A>,
		swarmId: string,
	): Effect.Effect<
		Option.Option<Swarm.Outcome<A>>,
		Failure | ThreadNotFound | Swarm.InvalidValue | SwarmId.SwarmIdNotOfThread
	>;
	function result<A>(
		swarm: Swarm.Swarm<never, A>,
		thread: string,
		swarmId: string,
	): Effect.Effect<Option.Option<Swarm.Outcome<A>>, Failure | ThreadNotFound | Swarm.InvalidValue>;
	function result<A>(swarm: Swarm.Swarm<never, A>, first: string, second?: string) {
		return Effect.flatMap(
			second === undefined ? stored(first) : stored(first, second),
			Option.match({
				onNone: () => Effect.succeedNone,
				onSome: (value) => Effect.asSome(Swarm.typed(swarm.work, value)),
			}),
		);
	}
	return {
		threads: {
			start: (work, key) => creating("start", work.thread, (handle) => Client.call(handle, "start", { work, key })),
			resume: (thread, key) => on("resume", thread, (handle) => Client.call(handle, "resume", { thread, key })),
			cancel: (thread) => Effect.asVoid(on("cancel", thread, (handle) => Client.call(handle, "cancel", { thread }))),
			probe: (thread) =>
				on("probe", thread, (handle) => Client.call(handle, "probe", { thread })).pipe(
					Effect.catchTag("ThreadNotFound", () => Effect.succeed({ alive: false })),
				),
			outcome,
			ended: (thread, schedule) =>
				Effect.flatMap(
					outcome(thread),
					Option.match({
						onNone: () => Effect.fail(new StillWorking({ thread })),
						onSome: (ended) => Effect.succeed(ended),
					}),
				).pipe(Effect.retry({ schedule, while: (error) => error._tag === "StillWorking" })),
			release: (thread, decision) =>
				on("release", thread, (handle) => Client.call(handle, "release", { thread, decision })),
			pending: (thread) => on("pending", thread, (handle) => Client.call(handle, "pending", null)),
			decide: (thread, request, decision) =>
				on("decide", thread, (handle) =>
					Client.call(handle, "decide", { request: { task: request.task, id: request.id }, decision }),
				),
		},
		swarms: {
			run: (swarm, { thread, id, jobs, cap, onFailure, pins, at, agent, fork }) =>
				Effect.gen(function* () {
					// Before anything is sent: an id that names another thread could never be found again by itself.
					yield* SwarmId.ofThread(thread, id);
					// The JSON form of each input, which is what the coordinator stores and what crosses.
					const encoded = yield* Effect.forEach(jobs, (job) =>
						Effect.map(swarm.work.encodeInput(job.input), (input) => ({ key: job.key, input })),
					);
					const plan = { swarm: swarm.name, thread, id, jobs: encoded, cap, onFailure, pins: pins ?? [], fork };
					// Names only: a tool or an extension is code, installed in the actor under its name.
					const change = agent === undefined ? {} : { agent: yield* ForkAgent.toWire(id, agent) };
					return yield* on("runSwarm", thread, (handle) =>
						Client.call(handle, "runSwarm", { ...plan, ...change, ...(at === undefined ? {} : { at }) }),
					);
				}),
			cancel: onSwarm((thread, swarmId) =>
				on("cancelSwarm", thread, (handle) => Client.call(handle, "cancelSwarm", { swarmId })),
			),
			probe: onSwarm((thread, swarmId) =>
				on("probeSwarm", thread, (handle) => Client.call(handle, "probeSwarm", { swarmId })),
			),
			result,
			spent: onSwarm((thread, swarmId) =>
				on("swarmSpent", thread, (handle) => Client.call(handle, "swarmSpent", { swarmId })),
			),
		},
		forks: {
			destroy: ({ thread, swarmId, jobKey }) =>
				Effect.flatMap(thread === undefined ? SwarmId.threadOf(swarmId) : Effect.succeed(thread), (found) =>
					on("destroyFork", found, (handle) => Client.call(handle, "destroyFork", { swarmId, jobKey })),
				),
		},
	};
}

/** A call that found its actor destroyed between the lookup and the call: nothing was admitted. */
function destroyed(operation: string, error: ThreadNotFound): OperationFailed {
	return new OperationFailed({
		operation,
		reason: error._tag,
		message: `The actor of thread ${error.thread} was destroyed`,
	});
}
