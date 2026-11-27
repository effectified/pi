// A job in its fork actor: the conversation it runs in, forked at the swarm's entry inside the copied storage, and
// what the actor does with a request of the job.

import type { ConversationId } from "@effectified/pi-durable";
import { Conversation, Doc, Harness, type Tx } from "@effectified/pi-durable";
import type { ActorInfo, ActorSql } from "@effectified/pi-durable-rivet";
import { Effect, Option, Schema } from "effect";
import type { JobStatus } from "../driver.ts";
import type { ForkSetupFailed } from "../errors.ts";
import { type Forked, ForkSetup, type ForkSetupService } from "../fork-setup.ts";
import { JobKey, RequestId, SwarmId } from "../ids.ts";
import { jobStatus } from "../job-status.ts";
import { type Assignment, assigned } from "./assignment.ts";
import { type RecordFailure, requireClean } from "./records.ts";

/**
 * The actor cannot take the job, now or later: `fork` when it is not the fork of that job, its fork hygiene did not
 * run, its job conversation is gone, or the product's fork setup refused it; `source` when the copy does not hold
 * the primed conversation to start from.
 */
export class JobRefused extends Schema.TaggedError<JobRefused, { readonly brand: unique symbol }>()("SwarmJobRefused", {
	what: Schema.Literals(["source", "fork"]),
	reason: Schema.String,
}) {}

/** One request of the job an actor was forked for: what the driver sends the fork's `swarmRun` action. */
export const Request = Schema.Struct({
	swarmId: SwarmId,
	jobKey: JobKey,
	/** Unique in the fork: a second request with it starts nothing. */
	requestId: RequestId,
	prompt: Schema.String,
});

/** One request of the job an actor was forked for. */
export type Request = typeof Request.Type;

/**
 * Hands the fork a request of its job, and succeeds once Pi admitted it, never at the answer, with the conversation
 * the job runs in. The first request makes that job conversation: a fork of the primed conversation at the swarm's
 * entry, with the swarm's agent change, set up by the product's `ForkSetup` of this actor: `created` inside the
 * commit that creates it, `beforeStart` before every request. Idempotent: the job conversation is claimed in the
 * commit that creates it, and Pi finds a request id again. A fork in which the fork hygiene did not run refuses: the
 * coordinator it copied is live in it.
 */
export const accept = Effect.fn("Swarm.Rivet.accept")(function* (
	request: Request,
): Effect.fn.Return<
	ConversationId,
	JobRefused | RecordFailure | Doc.Failure,
	Harness.Harness | ActorInfo | ActorSql | ForkSetup
> {
	yield* Effect.catchTag(requireClean, "SwarmForkUnclean", (unclean) =>
		Effect.fail(JobRefused.make({ what: "fork", reason: unclean.message })),
	);
	const assignment = yield* assigned;
	const mine = Option.filter(assignment, (job) => job.swarmId === request.swarmId && job.jobKey === request.jobKey);
	if (Option.isNone(mine)) {
		const reason = `This actor was not forked for job ${request.jobKey} of swarm ${request.swarmId}`;
		return yield* JobRefused.make({ what: "fork", reason });
	}
	const setup = yield* ForkSetup;
	const conversation = yield* conversationFor(mine.value, setup);
	yield* Effect.mapError(setup.beforeStart(forkedOf(mine.value, conversation.id)), refusedBySetup);
	yield* conversation.submit({ type: "input", content: request.prompt, requestId: request.requestId });
	return conversation.id;
});

/** The fork a setup is asked about: the job of the actor's assignment, in the conversation made for it here. */
function forkedOf(job: Assignment, conversationId: ConversationId): Forked {
	return {
		swarmId: job.swarmId,
		jobKey: job.jobKey,
		sourceConversationId: job.sourceConversationId,
		conversationId,
	};
}

function refusedBySetup(failure: ForkSetupFailed): JobRefused {
	return JobRefused.make({ what: "fork", reason: failure.message });
}

/** Where the request stands in the job conversation; `Unknown` while the actor accepted none. It never waits. */
export function status(requestId: RequestId): Effect.Effect<JobStatus, Doc.Failure, Harness.Harness> {
	return Effect.flatMap(
		held,
		Option.match({
			onNone: (): Effect.Effect<JobStatus, Doc.Failure, Harness.Harness> => Effect.succeed({ _tag: "Unknown" }),
			onSome: (conversationId) => jobStatus(conversationId, requestId),
		}),
	);
}

/** The conversation the actor's job runs in; none before its first request, and in an actor that is no job's fork. */
export const conversation: Effect.Effect<
	Option.Option<Conversation.Conversation>,
	Doc.Failure,
	Harness.Harness
> = Effect.suspend(() =>
	Effect.flatMap(
		held,
		Option.match({
			onNone: () => Effect.succeedNone,
			onSome: (conversationId) => Harness.conversation(conversationId),
		}),
	),
);

/** Stops the job's work, and succeeds once nothing of it runs: an unsettled request then reads `Unanswered`. */
export const cancel: Effect.Effect<void, Doc.Failure, Harness.Harness> = Effect.flatMap(
	conversation,
	Option.match({ onNone: () => Effect.void, onSome: (job) => job.abort() }),
);

/**
 * Forgets the job conversation: what a copy of a fork's storage does first, since the job its source ran is not the
 * copy's. Its own job, if it was forked for one, makes a conversation of its own.
 */
export const forget: Effect.Effect<void, Doc.Failure, Harness.Harness> = Effect.suspend(() =>
	Effect.flatMap(
		held,
		Option.match({
			onNone: () => Effect.void,
			onSome: () => Harness.commit((tx) => Effect.flatMap(tx.doc(Held), (job) => job.set({ conversationId: null }))),
		}),
	),
);

/**
 * The job conversation of a fork actor, in its harness storage. Written in the commit that creates the conversation,
 * so the two exist together or not at all.
 */
const Held = Doc.make({
	kind: "swarm.rivet.job",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ conversationId: Schema.NullOr(Conversation.Id) }),
	initial: () => ({ conversationId: null }),
	checkpointWhen: () => false,
});

/** The id of the job conversation, once it was made. */
const held: Effect.Effect<Option.Option<ConversationId>, Doc.Failure, Harness.Harness> = Effect.suspend(() =>
	Effect.map(Harness.snapshot(Held), (stored) =>
		Option.flatMap(stored, ({ conversationId }) => Option.fromNullOr(conversationId)),
	),
);

/** The job conversation is made already: what fails the creating commit of a second one. */
class Claimed extends Schema.TaggedError<Claimed, { readonly brand: unique symbol }>()("SwarmJobClaimed", {
	conversationId: Conversation.Id,
}) {}

/**
 * Finds the job conversation, or forks the primed conversation for it in one commit that also claims it and runs the
 * product's `created`.
 */
const conversationFor = Effect.fn("Swarm.Rivet.jobConversation")(function* (
	job: Assignment,
	setup: ForkSetupService,
): Effect.fn.Return<Conversation.Conversation, JobRefused | Doc.Failure, Harness.Harness> {
	const found = (conversationId: ConversationId) =>
		Effect.flatMap(Harness.conversation(conversationId), (existing) =>
			Effect.fromOption(existing, () =>
				JobRefused.make({ what: "fork", reason: "Its job conversation does not exist" }),
			),
		);
	const made = yield* held;
	if (Option.isSome(made)) return yield* found(made.value);
	const source = yield* Harness.conversation(job.sourceConversationId);
	if (Option.isNone(source)) {
		const reason = `The copied storage holds no conversation ${job.sourceConversationId}`;
		return yield* JobRefused.make({ what: "source", reason });
	}
	return yield* source.value
		.fork({
			// The copy is the source as it was when the actor was forked, which may be past the swarm's entry.
			at: job.at,
			ownership: { kind: "ownerless" },
			// Decoded with `Agent.ByName` where the assignment was read: a change `configure` takes.
			...(job.agent === null ? {} : { agent: job.agent }),
			// The conversation is claimed and the product has set it up, or it does not exist.
			init: (tx, conversationId) =>
				Effect.andThen(claim(tx, conversationId), setup.created(tx, forkedOf(job, conversationId))),
		})
		.pipe(
			Effect.catchTags({
				// Another request claimed it between the look above and this commit: its conversation is the one.
				SwarmJobClaimed: (claimed) => found(claimed.conversationId),
				ForkSetupFailed: (failure) => Effect.fail(refusedBySetup(failure)),
			}),
		);
});

/** Claims the job conversation being created, inside its creating commit; fails it when there is one already. */
const claim = Effect.fn("Swarm.Rivet.claimJobConversation")(function* (tx: Tx.Tx, conversationId: ConversationId) {
	const job = yield* tx.doc(Held);
	const current = (yield* job.get).conversationId;
	if (current !== null) return yield* Claimed.make({ conversationId: current });
	yield* job.set({ conversationId });
});
