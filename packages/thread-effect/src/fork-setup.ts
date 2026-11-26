// The fork setup of the composition: a swarm's fork is granted through the guard, capped on the budget's lease,
// indexed for the router and left out of the review, all in the commit that creates it.

import { Shares } from "@effectified/pi-budget";
import { Doc, type Tx } from "@effectified/pi-durable";
import { Conversations, Grant, Guard } from "@effectified/pi-guard";
import * as Review from "@effectified/pi-review";
import { ForkSetup, ForkSetupFailed } from "@effectified/pi-swarm";
import { Effect, Layer, Schema } from "effect";

/**
 * What every fork of one swarm may do and spend: `tools`, the tools it may call at most (it never gets one its
 * thread does not have), and `cap`, the micro units it may settle of the harness's lease.
 */
export const Allowance = Schema.Struct({
	tools: Schema.Array(Schema.String),
	cap: Schema.BigInt,
});

/** What every fork of one swarm may do and spend. */
export type Allowance = typeof Allowance.Type;

/**
 * One document per swarm id, kind `thread.swarm`, in the session scope: the allowance of the swarm's forks, or
 * none while nobody gave one. The fork setup is told the swarm id and the job key of a fork, not its plan, so what
 * the product planned for the forks is kept here, written before the swarm is started.
 */
const Document = Doc.family({
	kind: "thread.swarm",
	version: 1,
	scope: "session",
	schema: Schema.Struct({
		allowance: Schema.NullOr(Schema.Struct({ tools: Allowance.fields.tools, cap: Schema.BigIntFromString })),
	}),
	initial: (_seed: null) => ({ allowance: null }),
	// A short list and a number, written once.
	checkpointWhen: () => true,
});

/**
 * Gives the forks of the swarm `swarmId` their allowance, inside the caller's commit, unless the swarm has one: the
 * first one stands, as a swarm's first plan does.
 */
export function allowIn(tx: Tx.Tx, swarmId: string, allowance: Allowance): Effect.Effect<void, Doc.Failure> {
	return Effect.gen(function* () {
		const document = yield* tx.doc(Document, swarmId, null);
		if ((yield* document.get).allowance === null) yield* document.set({ allowance });
	});
}

/**
 * The `ForkSetup` of the composition. Everything is in `created`, the commit that creates the fork's conversation,
 * so no fork ever exists without any of it:
 *
 * - the grant of the allowance's tools, narrowed (`mode: "narrow"`) to what the fork inherited from its thread, with
 *   the classification it inherited;
 * - its cap on the lease, so what it settles is counted from its first request and attributed to its conversation;
 * - nothing for the router: its routing limits are its thread's, since the fork copies the document;
 * - the host's selection of extensions without the review: a job's answer is fanned in as a typed value, and a held
 *   fork would hold its swarm.
 *
 * It fails closed with `ForkSetupFailed`, and the job fails as `gone`: a fork of a swarm that was given no
 * allowance does not exist. `beforeStart` has nothing left to do.
 */
export const layer: Layer.Layer<ForkSetup.ForkSetup, never, Guard.Guard | Shares> = Layer.effect(
	ForkSetup.ForkSetup,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		const shares = yield* Shares;
		const refused = (fork: ForkSetup.Forked, why: string) => (cause: unknown) =>
			new ForkSetupFailed({ reason: `The fork of job ${fork.jobKey} of swarm ${fork.swarmId} ${why}.`, cause });
		return {
			created: (tx, fork) =>
				Effect.gen(function* () {
					const { allowance } = yield* (yield* tx.doc(Document, fork.swarmId, null)).get;
					if (allowance === null) return yield* refused(fork, "has no allowance")(undefined);
					const inherited = yield* (yield* tx.doc(Grant.Document, fork.conversationId)).get;
					const classification = inherited.grant?.classification;
					const grant = { tools: allowance.tools, ...(classification === undefined ? {} : { classification }) };
					yield* Conversations.grantIn(tx, fork.conversationId, grant, { mode: "narrow" }).pipe(
						Effect.provideService(Guard.Guard, guard),
					);
					yield* shares.setCapIn(tx, fork.conversationId, allowance.cap);
					yield* tx.configure(fork.conversationId, { extensions: { remove: [Review.NAME] } });
				}).pipe(
					Effect.mapError((error) =>
						error._tag === "ForkSetupFailed" ? error : refused(fork, "could not be set up")(error),
					),
				),
			beforeStart: () => Effect.void,
		};
	}),
);
