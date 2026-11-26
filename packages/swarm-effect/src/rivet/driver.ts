// The Rivet fork driver: a swarm's forks are actor forks of the actor that holds the primed harness, each a
// copy-on-write copy of its storage with a harness of its own.

import type { ConversationId } from "@effectified/pi-durable";
import {
	type ActorDefect,
	type ActorGone,
	type ActorInfo,
	type ActorSql,
	Client,
	type EngineUnavailable,
	type ForkKeyHeld,
	type ForkTooDeep,
	type NotIdle,
	Self,
} from "@effectified/pi-durable-rivet";
import { type Context, Effect, Layer, Option, Schema } from "effect";
import {
	type Destroyed,
	type Fork,
	ForkDriver,
	type ForkDriverService,
	ForkGone,
	type ForkRequest,
	ForkRetryLater,
	type Notice,
} from "../driver.ts";
import { actions } from "./actions.ts";
import * as Assignment from "./assignment.ts";
import type { JobRefused } from "./job.ts";
import * as Records from "./records.ts";

/** Options of `layer`. */
export interface Options {
	/**
	 * How often the coordinator asks a fork whether its job has settled, in milliseconds. Default 1000. Between two
	 * questions the coordinator sleeps, and the source actor may sleep with it: the Rivet host wakes it at the time.
	 */
	readonly pollMillis?: number;
}

/** What the driver needs of the actor it runs in: the engine's client, the actor's identity and its database. */
export type Needs = Client.RivetClient | ActorInfo | ActorSql;

/**
 * The `ForkDriver` for the actor that holds the primed harness: build it in that actor's `layer`, over the host's
 * `Self.client`, Rivet's client of the engine the actor runs on. The actor's definition must have `actions` among its
 * actions and `forkHygiene` in its fork hygiene, and its `layer` must provide the product's `ForkSetup`, since every
 * fork is an actor of the same definition and runs the setup itself.
 *
 * - **fork**: an actor fork of this actor under the key `forkKey(own key, swarm id, job key)`, found again by that
 *   key. The intent is recorded in the actor's database before the engine is asked. "Retry later", marked
 *   `sourceBusy`, while this actor has an input, a model request or a tool call in flight: the coordinator waits
 *   that out, however long it takes. The request's `setup` is left: the fork actor runs its own.
 * - **run**: the fork's `swarmRun` action, which answers at durable acceptance. The answer is always `Poll`: nothing
 *   is called back, so nothing can be lost, and the coordinator sleeps between two questions. Its `place` is the
 *   job conversation in the fork actor, and that actor.
 * - **job**, **cancel**: the fork's `swarmJob` and `swarmCancel` actions.
 * - **destroy**: `Client.destroy`. `bytesWritten` is the size of the fork's database when it was destroyed less the
 *   size of this actor's database when the fork was first asked for, never below zero; none when either is unknown.
 * - **list**: the recorded forks that were not destroyed. One whose fork call never returned is looked up by its key.
 *
 * A call the engine does not answer in 30 seconds, an engine that cannot be reached and a failure inside an actor
 * are "retry later"; an actor that is gone, a key another actor holds and a refusal without a retry hint are "gone".
 * In an actor fork in which `forkHygiene` did not run, every operation is refused: the record it would work from is
 * its source's.
 */
export function layer(options: Options = {}): Layer.Layer<ForkDriver, never, Needs> {
	return Layer.effect(
		ForkDriver,
		Effect.gen(function* () {
			// The record's tables, at each wake: a database that cannot be written now is a harness that did not open.
			yield* Effect.orDie(Records.migrate);
			const self = yield* Self.handle(actions);
			return make(self, yield* Effect.context<Needs>(), options.pollMillis ?? DEFAULT_POLL_MILLIS);
		}),
	);
}

const DEFAULT_POLL_MILLIS = 1000;

// rivetkit's client waits without end for an engine it cannot reach: a call that takes longer is asked again.
const CALL_TIMEOUT_MILLIS = 30_000;

/** The actor the driver runs in, as a caller of the fork actions: every fork is an actor of its definition. */
type Own = Client.Handle<Client.Target<string, typeof actions>>;

function make(self: Own, context: Context.Context<Needs>, pollMillis: number): ForkDriverService {
	const { definition } = self;
	const keyOf = (swarmId: string, jobKey: string) => Assignment.forkKey(self.key, swarmId, jobKey);
	const handleOf = (fork: Fork): Own => ({ definition, actorId: fork.forkId, key: keyOf(fork.swarmId, fork.jobKey) });
	/**
	 * One operation: refused in a fork whose hygiene did not run, on this actor's services, bounded in time, and
	 * failing as the port says, by `failure`.
	 */
	const bounded = <A, E extends ForkRetryLater | ForkGone>(
		operation: Operation,
		failure: (error: Failure) => E,
		effect: Effect.Effect<A, Failure, Needs>,
	): Effect.Effect<A, E | ForkRetryLater> =>
		Effect.flatMap(
			Effect.andThen(Records.requireClean, effect).pipe(
				Effect.mapError(failure),
				Effect.provideContext(context),
				Effect.timeoutOption(CALL_TIMEOUT_MILLIS),
			),
			Option.match({
				onNone: () =>
					Effect.fail(new ForkRetryLater({ operation, reason: `No answer in ${CALL_TIMEOUT_MILLIS} ms` })),
				onSome: (value) => Effect.succeed(value),
			}),
		);
	/** Nothing is called back: the coordinator asks. The job runs in the fork actor, in the conversation it made. */
	const notice = (fork: Fork, conversationId: ConversationId): Notice => ({
		_tag: "Poll",
		afterMillis: pollMillis,
		place: { conversationId, actorId: fork.forkId },
	});

	/** Finds the recorded fork of the job, or records the intent and asks the engine for it. */
	const fork = (request: ForkRequest): Effect.Effect<Fork, Failure, Needs> =>
		Effect.gen(function* () {
			const held = yield* Records.find(request.swarmId, request.jobKey);
			if (Option.isNone(held)) yield* Records.intend(request.swarmId, request.jobKey);
			else {
				switch (held.value._tag) {
					case "Destroyed":
						return yield* new WasDestroyed();
					case "Made":
						return toFork(request, held.value.actorId);
					case "Intended":
						// The call of an earlier attempt never returned: the same key finds its fork, or makes it now.
						break;
				}
			}
			const made = yield* Client.fork(self, {
				key: keyOf(request.swarmId, request.jobKey),
				input: Assignment.of(request),
			});
			yield* Records.made(request.swarmId, request.jobKey, made.actorId);
			return toFork(request, made.actorId);
		});

	/** The actor of a fork whose call never returned, if the engine made it: it is this actor's fork under the key. */
	const adopt = (swarmId: string, jobKey: string): Effect.Effect<Option.Option<Fork>, Failure, Needs> =>
		Effect.gen(function* () {
			const found = yield* Client.find(definition, keyOf(swarmId, jobKey));
			if (Option.isNone(found)) return Option.none();
			const lineage = yield* Client.lineage(found.value).pipe(
				Effect.asSome,
				Effect.catchTag("ActorGone", () => Effect.succeedNone),
			);
			// Another actor's fork under this key, or an actor destroyed meanwhile, is not a fork of this swarm.
			if (Option.isNone(lineage) || lineage.value.chain.at(-1)?.actorId !== self.actorId) return Option.none();
			yield* Records.made(swarmId, jobKey, found.value.actorId);
			return Option.some(toFork({ swarmId, jobKey }, found.value.actorId));
		});

	const destroy = (target: Fork): Effect.Effect<Destroyed, Failure, Needs> =>
		Effect.gen(function* () {
			const held = Option.getOrElse(yield* Records.find(target.swarmId, target.jobKey), () => UNRECORDED);
			// Destroyed already: the bytes the first call learnt are the answer again.
			if (held._tag === "Destroyed") return { bytesWritten: held.bytesWritten };
			const destroyed = yield* Client.destroy(handleOf(target));
			const bytesWritten = Option.zipWith(destroyed.databaseBytes, held.baseBytes, (size, before) =>
				Math.max(0, size - before),
			);
			yield* Records.destroyed(target.swarmId, target.jobKey, bytesWritten);
			return { bytesWritten };
		});

	const list = (swarmId: string): Effect.Effect<Array<Fork>, Failure, Needs> =>
		Effect.gen(function* () {
			const forks = yield* Effect.forEach(yield* Records.live(swarmId), ({ jobKey, held }) => {
				switch (held._tag) {
					case "Made":
						return Effect.succeed(Option.some(toFork({ swarmId, jobKey }, held.actorId)));
					case "Intended":
						return adopt(swarmId, jobKey);
				}
			});
			return forks.flatMap(Option.toArray);
		});

	return {
		fork: (request) => bounded("fork", portFailure("fork", request, "source"), fork(request)),
		run: (request) =>
			bounded(
				"run",
				portFailure("run", request.fork, "fork"),
				Effect.map(
					Client.call(handleOf(request.fork), "swarmRun", {
						swarmId: request.fork.swarmId,
						jobKey: request.fork.jobKey,
						requestId: request.requestId,
						prompt: request.prompt,
					}),
					({ conversationId }) => notice(request.fork, conversationId),
				),
			),
		job: (target, requestId) =>
			bounded("job", portFailure("job", target, "fork"), Client.call(handleOf(target), "swarmJob", { requestId })),
		cancel: (target) =>
			bounded(
				"cancel",
				retryLater("cancel"),
				// A fork that is gone is cancelled already.
				Effect.catchTag(
					Effect.asVoid(Client.call(handleOf(target), "swarmCancel", null)),
					"ActorGone",
					() => Effect.void,
				),
			),
		destroy: (target) => bounded("destroy", retryLater("destroy"), destroy(target)),
		list: (swarmId) => bounded("list", retryLater("list"), list(swarmId)),
	};
}

/** The job's fork was destroyed through this driver: its key never gives a fork again. */
class WasDestroyed extends Schema.TaggedError<WasDestroyed>()("SwarmForkDestroyed", {}) {}

/** The port's operations of one kind. */
type Operation = ForkRetryLater["operation"];

/** What a call of the host, of a fork's action or of the record fails with, before the port's two failures. */
type Failure =
	| NotIdle
	| ForkKeyHeld
	| ForkTooDeep
	| ActorGone
	| EngineUnavailable
	| ActorDefect
	| Client.ActionFailure<JobRefused>
	| Records.RecordFailure
	| Records.Unclean
	| WasDestroyed;

/** The job a failure is about. */
interface Subject {
	readonly swarmId: string;
	readonly jobKey: string;
}

/**
 * A failure as the port's "retry later" or "gone". `missing` is what an actor that does not exist, or that the engine
 * refuses for good, stands for in this operation: the source being forked, or the fork being called.
 */
function portFailure(operation: Operation, subject: Subject, missing: "source" | "fork") {
	return (error: Failure): ForkRetryLater | ForkGone => {
		switch (error._tag) {
			case "NotIdle":
				// The source has work in flight: nothing is wrong with the engine, and the coordinator waits it out.
				return new ForkRetryLater({ operation, reason: error.message, sourceBusy: true });
			case "ActorDefect":
				return new ForkRetryLater({ operation, reason: error.message });
			case "SwarmRecordFailure":
				return new ForkRetryLater({ operation, reason: error.reason });
			case "SwarmForkDestroyed":
				return gone(subject, "fork", "It was destroyed");
			case "SwarmForkUnclean":
				// This actor, which would be the source of every fork it makes, can never be one.
				return gone(subject, "source", error.message);
			case "ForkKeyHeld":
				return gone(subject, "fork", error.message);
			case "ForkTooDeep":
				return gone(subject, "depth", error.message);
			case "ActorGone":
				return gone(subject, missing, error.message);
			case "ActionFailed":
				return gone(subject, error.error.what, error.error.reason);
			case "EngineUnavailable": {
				const reason = `${error.code}: ${error.message}`;
				if (!error.retryable) return gone(subject, missing, reason);
				const hint = error.retryAfterMillis === undefined ? {} : { afterMillis: error.retryAfterMillis };
				return new ForkRetryLater({ operation, reason, ...hint });
			}
		}
	};
}

/**
 * A failure of an operation the port lets fail with "retry later" only, whatever it is: the coordinator bounds its
 * attempts, and leaves a fork it could not destroy.
 */
function retryLater(operation: Operation) {
	// Only the reason of a "gone" is kept, so the job it would name does not matter.
	const classify = portFailure(operation, { swarmId: "", jobKey: "" }, "fork");
	return (error: Failure): ForkRetryLater => {
		const failure = classify(error);
		return failure._tag === "ForkGone" ? new ForkRetryLater({ operation, reason: failure.reason }) : failure;
	};
}

/** A fork this actor has no record of, such as one a copy of the actor was told to destroy: no size to subtract. */
const UNRECORDED: Records.Held = { _tag: "Intended", baseBytes: Option.none() };

function toFork(subject: Subject, actorId: string): Fork {
	return { swarmId: subject.swarmId, jobKey: subject.jobKey, forkId: actorId };
}

function gone(subject: Subject, what: ForkGone["what"], reason: string): ForkGone {
	return new ForkGone({ what, swarmId: subject.swarmId, jobKey: subject.jobKey, reason });
}
