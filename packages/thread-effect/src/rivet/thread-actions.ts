// The actions of a thread actor for its thread: start, resume, cancel, release, probe, outcome, and the approvals of
// its parked calls. None waits for the thread: Rivet ends an action after its timeout.

import * as Approvals from "@effectified/pi-approvals";
import type { Harness } from "@effectified/pi-durable";
import { Action } from "@effectified/pi-durable-rivet";
import * as Review from "@effectified/pi-review";
import { Effect, Schema } from "effect";
import { Outcome } from "../outcome.ts";
import * as Threads from "../threads.ts";
import { crossing, Failure, StartFailure } from "./wire.ts";

/** One thread, by the product's key: what every action but `start` takes at least. */
const Thread = Schema.Struct({ thread: Schema.String });

/** What `start` takes: the thread's work, and the request key it is admitted under. */
const Start = Schema.Struct({ work: Threads.Work, key: Schema.String });

/** What `start` answers: `Threads.Admitted`. */
const Started = Schema.Struct({ created: Schema.Boolean, key: Schema.String });

/** What `resume` takes: the thread, and the request key a continuation of its run is admitted under. */
const Resume = Schema.Struct({ thread: Schema.String, key: Schema.String });

/** What `resume` answers: `Threads.TakenOn`. */
const Resumed = Schema.Literals(["continued", "retried", "unchanged"]);

/** What `release` takes: a person's decision about a held answer. */
const Release = Schema.Struct({ thread: Schema.String, decision: Review.Decision });

/** What `decide` takes: where a pending approval request is, and a person's decision about it. */
const Decide = Schema.Struct({
	request: Schema.Struct({ task: Approvals.Request.fields.task, id: Schema.String }),
	decision: Approvals.Decision,
});

/** What `decide` answers: `Approvals.Delivery`. */
const Delivered = Schema.Literals(["delivered", "already_decided", "superseded", "gone", "unknown"]);

/**
 * The thread actions of a thread actor, by name. Each returns once what it was asked is durably admitted or read,
 * and each is safe to send again:
 *
 * - `start`: admits the thread's task under a request key. The same key again, and any key for a thread that
 *   exists, is the same work: `created` is false and `key` is the one that stands.
 * - `resume`: continues a run that ended without an answer, under a request key, or asks for a deferred review
 *   again: `Threads.takeOn`.
 * - `cancel`: aborts the thread's run and answers once nothing of it runs.
 * - `release`: delivers a person's decision to a held thread.
 * - `probe`: whether the thread has unfinished work; false for a key this actor holds no thread under.
 * - `outcome`: the durable outcome so far; none while the thread works.
 * - `pending`, `decide`: the approval requests of the actor's parked calls, and a person's decision about one.
 *
 * The actor is awake while the thread works, by the host's wake keeper, and may sleep while a call is parked, an
 * answer is held, or the thread stopped: every action wakes it. Nothing checks who calls: authenticate in the host.
 */
export const actions = {
	start: Action.make({
		input: Start,
		output: Started,
		error: StartFailure,
		handler: ({ work, key }) =>
			crossing(
				"start",
				Threads.Threads.use((threads) => threads.admit(work, key)),
			),
	}),
	resume: Action.make({
		input: Resume,
		output: Resumed,
		error: Failure,
		handler: ({ thread, key }) =>
			crossing(
				"resume",
				Threads.Threads.use((threads) => threads.takeOn(thread, key)),
			),
	}),
	cancel: Action.make({
		input: Thread,
		output: Schema.Null,
		error: Failure,
		handler: ({ thread }) =>
			crossing(
				"cancel",
				Effect.as(
					Threads.Threads.use((threads) => threads.cancel(thread)),
					null,
				),
			),
	}),
	release: Action.make({
		input: Release,
		output: Schema.Literals(["released", "already_released"]),
		error: Failure,
		handler: ({ thread, decision }) =>
			crossing(
				"release",
				Threads.Threads.use((threads) => threads.decide(thread, decision)),
			),
	}),
	probe: Action.make({
		input: Thread,
		output: Schema.Struct({ alive: Schema.Boolean }),
		error: Failure,
		handler: ({ thread }) =>
			crossing(
				"probe",
				Threads.Threads.use((threads) => threads.probe(thread)),
			),
	}),
	outcome: Action.make({
		input: Thread,
		output: Schema.Option(Outcome),
		error: Failure,
		handler: ({ thread }) =>
			crossing(
				"outcome",
				Threads.Threads.use((threads) => threads.outcome(thread)),
			),
	}),
	pending: Action.make({
		input: Schema.Null,
		output: Schema.Array(Approvals.Request),
		error: Failure,
		handler: (): Effect.Effect<ReadonlyArray<Approvals.Request>, typeof Failure.Type, Harness.Harness> =>
			crossing("pending", Approvals.pending),
	}),
	decide: Action.make({
		input: Decide,
		output: Delivered,
		error: Failure,
		handler: ({ request, decision }) => crossing("decide", Approvals.decide(request, decision)),
	}),
};

/** The thread actions of a thread actor, as a caller's `Client.call` is typed by them. */
export type Actions = typeof actions;
