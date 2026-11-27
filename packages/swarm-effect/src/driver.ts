// The driver port: what a swarm's coordinator needs from a place where forks live, as Schemas and Effects.

import {
	type Agent,
	Conversation,
	type ConversationId,
	type EntryId,
	Task,
	type TaskId,
} from "@effectified/pi-durable";
import { Context, type Effect, type Option, Schema } from "effect";
import type { ForkSetupService } from "./fork-setup.ts";
import { ForkId, JobKey, RequestId, SwarmId } from "./ids.ts";

export { ForkId, JobKey, RequestId, SwarmId } from "./ids.ts";

/** A span of time in milliseconds: a driver's own hint, a polling interval. */
export const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** A number of bytes, as a driver measures what a fork wrote. */
export const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * "Retry later": the driver could not do the operation now, and the same call may succeed later (a call that timed
 * out, a source that is not idle yet, a host that is restarting). Nothing is known to have changed: every operation
 * is idempotent, so the coordinator makes the same call again.
 */
export class ForkRetryLater extends Schema.TaggedError<ForkRetryLater, { readonly brand: unique symbol }>()(
	"ForkRetryLater",
	{
		operation: Schema.Literals(["fork", "run", "job", "cancel", "destroy", "list"]),
		reason: Schema.String,
		/** How long to wait before the next attempt, when the driver knows; the coordinator backs off by itself otherwise. */
		afterMillis: Schema.optionalKey(Millis),
		/**
		 * True when the driver is well and the source is what is in the way: it has work in flight, and this driver
		 * forks only a source that has none. The coordinator then waits for as long as it takes, as it waits for an idle
		 * source before the first fork, and does not count the answer towards the attempts after which a job fails.
		 */
		sourceBusy: Schema.optionalKey(Schema.Boolean),
	},
) {
	override get message(): string {
		return `${this.operation}: ${this.reason}`;
	}
}

/**
 * "Gone": what the operation addresses does not exist any more and never will again: the source to fork, or a fork
 * that was destroyed or lost. `depth` says that the source exists and can never be forked: its storage is a copy as
 * many times over as the engine allows. Retrying cannot help, so the coordinator fails the job: as `too-deep` for
 * `depth`, as `gone` otherwise.
 */
export class ForkGone extends Schema.TaggedError<ForkGone, { readonly brand: unique symbol }>()("ForkGone", {
	what: Schema.Literals(["source", "fork", "depth"]),
	swarmId: SwarmId,
	jobKey: JobKey,
	reason: Schema.String,
}) {
	override get message(): string {
		return this.what === "depth"
			? `No fork for job ${this.jobKey} of swarm ${this.swarmId}: ${this.reason}`
			: `The ${this.what} of job ${this.jobKey} of swarm ${this.swarmId} is gone: ${this.reason}`;
	}
}

/** What a driver operation fails with: one of the port's two failures. Choose with `ForkFailure.match`. */
export const ForkFailure = Schema.Union([ForkRetryLater, ForkGone]).pipe(Schema.toTaggedUnion("_tag"));

/** What a driver operation fails with. */
export type ForkFailure = typeof ForkFailure.Type;

/** One fork of a swarm: the job it was made for, and the driver's own id of it. Plain JSON, kept by the coordinator. */
export const Fork = Schema.Struct({
	swarmId: SwarmId,
	jobKey: JobKey,
	/** The driver's id of the fork: a conversation id, an actor id. Only the driver reads it. */
	forkId: ForkId,
});

/** One fork of a swarm. */
export type Fork = typeof Fork.Type;

/**
 * Where a job runs, for a host that attributes a fork's spend and records to its swarm: the conversation, by its id
 * in the harness storage the fork lives in, and the actor that holds that storage when the fork is an actor of its
 * own; null for a fork inside the storage of the swarm itself. The actor's id is Rivet's as text: this port knows no
 * engine, and the Rivet driver's `ActorId` is a string.
 */
export const Place = Schema.Struct({
	conversationId: Conversation.Id,
	actorId: Schema.NullOr(Schema.String),
});

/** Where a job runs. */
export type Place = typeof Place.Type;

/**
 * How the coordinator learns that a job settled, which `run` answers. Choose with `Notice.match`.
 *
 * - `Signal`: a Pi signal named `signal` will be delivered to the task `notify.taskId` under `notify.key` once the
 *   job has settled, whatever its value. The coordinator sleeps on that key, holding no process, and asks `job` when
 *   it wakes. Answer it only when the delivery is certain, also across a crash of the driver's own host.
 * - `Poll`: nothing is delivered. The coordinator sleeps `afterMillis` and asks `job`, again and again.
 *
 * Either one may say with `place` where the job runs; the coordinator stores it with the job, and `status` and
 * `result` give it. A driver that does not know leaves it out.
 */
export const Notice = Schema.TaggedUnion({
	Signal: { signal: Schema.String, place: Schema.optionalKey(Place) },
	Poll: { afterMillis: Millis, place: Schema.optionalKey(Place) },
});

/** How the coordinator learns that a job settled. */
export type Notice = typeof Notice.Type;

/**
 * Where a job stands in its fork, which `job` answers. Choose with `JobStatus.match`.
 *
 * - `Unknown`: the fork holds no job under that request id.
 * - `Running`: accepted and not settled.
 * - `Answered`: settled with the fork's final answer, as text.
 * - `Unanswered`: settled without an answer (aborted, a model error, a turn limit), with the fork's reason.
 */
export const JobStatus = Schema.TaggedUnion({
	Unknown: {},
	Running: {},
	Answered: { text: Schema.String },
	Unanswered: { reason: Schema.String },
});

/** Where a job stands in its fork. */
export type JobStatus = typeof JobStatus.Type;

/**
 * What destroying a fork answers: what the fork wrote, as far as its driver can measure it, and none when it cannot.
 * The number is the driver's own measure, not one unit across drivers: the in-storage driver gives the bytes of the
 * UTF-8 JSON of the entries the fork's conversation appended after its fork point, the Rivet driver the growth of
 * the fork's database over its source's. Neither says that anything was freed.
 */
export const Destroyed = Schema.Struct({ bytesWritten: Schema.Option(Bytes) });

/** What destroying a fork answers. */
export type Destroyed = typeof Destroyed.Type;

/** What `fork` takes: the job, the coordinator that asks, and the primed source to fork. */
export interface ForkRequest {
	readonly swarmId: SwarmId;
	/** Unique in the swarm. With `swarmId` it is the key of the fork: a second call finds the first call's fork. */
	readonly jobKey: JobKey;
	/**
	 * The coordinator's task, in the harness of the source: a driver whose forks live in that harness makes them the
	 * task's own work, so Pi's abort of the task reaches them.
	 */
	readonly coordinatorTaskId: TaskId;
	/** The primed conversation, in the coordinator's harness. */
	readonly sourceConversationId: ConversationId;
	/**
	 * The newest entry of the source the fork may see, fixed once for the whole swarm when the source was idle. A
	 * driver that copies a whole storage copies it as it is and continues the job from this entry.
	 */
	readonly at: EntryId;
	/**
	 * What the fork runs with, over what the source had at `at`: a cheaper model, fewer tools. Tools and extensions are
	 * given by name (`Agent.ByName`), so the change is plain JSON and can cross a process boundary.
	 */
	readonly agent: Option.Option<Agent.ByName>;
	/**
	 * The product's fork setup, as the coordinator's harness has it. A driver whose fork is a conversation of that
	 * harness calls `created` inside the commit that creates the conversation and `beforeStart` once it is stored. A
	 * driver whose forks live in another harness leaves this one and calls the setup of that harness, where the fork's
	 * conversation is created. It is a service, not data: it does not cross a process boundary.
	 */
	readonly setup: ForkSetupService;
}

/** What `run` takes: the fork, the job's prompt, the key that makes it one job, and where to say that it settled. */
export const RunRequest = Schema.Struct({
	fork: Fork,
	/** Unique in the fork. A second call with it starts nothing and answers as the first did. */
	requestId: RequestId,
	prompt: Schema.String,
	/** The coordinator's task and the signal key it sleeps on for this request: see `Notice`. */
	notify: Schema.Struct({ taskId: Task.Id, key: Schema.String }),
});

/** What `run` takes. */
export type RunRequest = typeof RunRequest.Type;

/**
 * A place where the forks of a swarm live. The coordinator calls it from a durable task that Pi runs again from the
 * top of a phase after a crash, so every operation may be called twice with the same arguments and must then do
 * nothing new. Every operation fails with `ForkRetryLater` when it may work later and with `ForkGone` when it never
 * will; it does not fail in any other way.
 */
export interface ForkDriverService {
	/**
	 * Finds the fork of `(swarmId, jobKey)` or makes it from the source: find or create, never a second copy. A driver
	 * whose creation answers "duplicate key" looks the fork up and succeeds with it. `ForkRetryLater` when the source
	 * cannot be forked now; a driver that forks only an idle harness answers it with `sourceBusy` while the source is
	 * busy. `ForkGone` with `what: "source"` when it never can, with `what: "depth"` when it is as deep as forks go,
	 * and with `what: "fork"` when the key's fork was destroyed or the product's fork setup refused it
	 * (`ForkRequest.setup`).
	 */
	readonly fork: (request: ForkRequest) => Effect.Effect<Fork, ForkFailure>;
	/**
	 * Hands the fork its job and succeeds once the fork has durably accepted it, never at the answer: it must not hold
	 * the caller while the fork works. Idempotent by `requestId`. The answer may say where the job runs (`place`).
	 */
	readonly run: (request: RunRequest) => Effect.Effect<Notice, ForkFailure>;
	/** Where the job `requestId` stands in the fork, and its final answer once it settled. It never waits. */
	readonly job: (fork: Fork, requestId: RequestId) => Effect.Effect<JobStatus, ForkFailure>;
	/**
	 * Stops the fork's work and succeeds once nothing of it runs any more: a job that had not settled then reads
	 * `Unanswered`. A fork that is gone or idle is cancelled already.
	 */
	readonly cancel: (fork: Fork) => Effect.Effect<void, ForkRetryLater>;
	/**
	 * Destroys the fork for good: its work is stopped, it is never listed, run or found by its key again. A fork that
	 * is gone already is destroyed: the call succeeds, with the bytes when the driver still knows them.
	 */
	readonly destroy: (fork: Fork) => Effect.Effect<Destroyed, ForkRetryLater>;
	/**
	 * Every fork of the swarm that exists and was not destroyed, also one whose `fork` call the coordinator never saw
	 * return. The coordinator cleans up from this list.
	 */
	readonly list: (swarmId: SwarmId) => Effect.Effect<ReadonlyArray<Fork>, ForkRetryLater>;
}

/** The driver a swarm's coordinator and the host operations use: the product provides one. */
export class ForkDriver extends Context.Service<ForkDriver, ForkDriverService>()(
	"@effectified/pi-swarm/driver/ForkDriver",
) {}
