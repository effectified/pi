// The accounts of a swarm's forks when the forks are actors: what each job's fork settled is read from the fork, and
// kept in the swarm's own storage before the fork is destroyed.

import { Shares } from "@gunta/pi-budget-effect";
import { Doc, Harness } from "@gunta/pi-durable-effect";
import { Action, type ActorEngine, type ActorInfo, type ActorSql, Client, Self } from "@gunta/pi-durable-rivet-effect";
import { Recorder } from "@gunta/pi-recorder-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import * as Rivet from "@gunta/pi-swarm-effect/rivet";
import { type Context, type Deferred, Effect, Layer, Option, Schema } from "effect";
import * as Forks from "../forks.ts";
import * as Opened from "../opened.ts";

/**
 * The action a fork actor answers its source with, by name. It first waits until the records of everything the fork
 * committed are in the product's sink, then answers what the conversation of its job settled of the lease so far, in
 * micro units, as the budget stored it there; none before its job got a request. So a fork that answered has
 * nothing left that only its own storage holds. Only the source's accounts call it. Spread it into the actor's
 * actions beside the swarm driver's own.
 */
export const actions = {
	forkAccount: Action.make({
		input: Schema.Null,
		output: Schema.Option(Schema.BigInt),
		handler: () =>
			Effect.gen(function* () {
				yield* Recorder.flushAll;
				const job = yield* Rivet.jobConversation;
				if (Option.isNone(job)) return Option.none();
				const share = yield* Shares.use((shares) => shares.get(job.value.id));
				return Option.map(share, (found) => found.settled);
			}).pipe(Effect.orDie),
	}),
};

/**
 * One document per swarm id, kind `thread.spent`, in the session scope of the actor the swarm runs in: per job
 * key, what its fork had settled when it was last asked before its destruction. A fork's own storage, and the share
 * in it, is gone with the fork.
 */
const Ledger = Doc.family({
	kind: "thread.spent",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ jobs: Schema.Record(Schema.String, Schema.BigIntFromString) }),
	initial: (_seed: null) => ({ jobs: {} }),
	// One number per job, written once per fork.
	checkpointWhen: () => true,
});

/** What the accounts need of the actor they run in: the swarm's Rivet driver, and the way to its forks. */
type Needs = Client.RivetClient | ActorInfo | ActorSql;

/**
 * Forks that are Rivet actors: the swarm's Rivet driver (`@gunta/pi-swarm-effect/rivet`), for a composition hosted in
 * a Rivet actor whose definition has `actions`, the driver's own actions and its fork hygiene. `options` are the
 * driver's.
 *
 * - **A fork's money** is the share of its job's conversation, in the fork actor's storage. `spent` answers what the
 *   swarm's storage kept, else asks the fork; none when the fork is gone without an account, or cannot be asked now.
 * - **Before a fork is destroyed** it is asked for its account once more (`forkAccount`): the fork delivers the
 *   records it still holds to the sink, and what it settled is kept in the swarm's storage (`thread.spent`). So
 *   neither the records nor the money of a job are lost with its fork's storage. This is the driver's `destroy`,
 *   which the coordinator's clean-up, a cancel and `Swarm.destroyFork` all go through. A fork that cannot be asked
 *   is not destroyed now: the driver says "retry later", as for an engine it cannot reach.
 */
export function forks(options?: Rivet.Options): Forks.Forks<ActorInfo | ActorSql | ActorEngine> {
	const accounted = Layer.effect(
		Swarm.ForkDriver,
		Effect.gen(function* () {
			const driver = yield* Swarm.ForkDriver;
			const { settle } = yield* accounts;
			return { ...driver, destroy: (fork) => Effect.andThen(settle(fork), driver.destroy(fork)) };
		}),
	);
	const kept = Layer.effect(
		Forks.Accounts,
		Effect.map(accounts, ({ spent }) => ({ spent })),
	);
	return {
		driver: Layer.merge(accounted, kept).pipe(Layer.provide(Rivet.layer(options)), Layer.provide(Self.client)),
		attach: Layer.empty,
	};
}

/** The accounts of the actor of the context: how a fork is asked, and where its answer is kept. */
const accounts = Effect.gen(function* () {
	const opened = yield* Opened.Opened;
	const context = yield* Effect.context<Needs>();
	const self = yield* Self.handle(actions);
	return make(self, opened, context);
});

/** The actor the accounts run in, as a caller of `forkAccount`: every fork is an actor of its definition. */
type Own = Client.Handle<Client.Target<string, typeof actions>>;

function make(self: Own, opened: Deferred.Deferred<Harness.Open>, context: Context.Context<Needs>) {
	/** What the fork actor says its job settled; none for a fork that is gone, or whose job got no request. */
	const asked = (swarmId: string, jobKey: string, actorId: string) =>
		Client.call(
			{ definition: self.definition, actorId, key: Rivet.forkKey(self.key, swarmId, jobKey) },
			"forkAccount",
			null,
		).pipe(
			Effect.catchTag("ActorGone", () => Effect.succeedNone),
			Effect.provideContext(context),
		);
	const keep = (swarmId: string, jobKey: string, settled: bigint) =>
		Opened.on(
			opened,
			Harness.commit((tx) =>
				Effect.flatMap(tx.doc(Ledger, swarmId, null), (ledger) =>
					ledger.update((held) => ({ jobs: { ...held.jobs, [jobKey]: settled } })),
				),
			),
		);
	const keptOf = (swarmId: string, jobKey: string) =>
		Effect.map(Opened.on(opened, Harness.snapshot(Ledger, swarmId)), (ledger) => {
			const jobs = Option.getOrUndefined(ledger)?.jobs ?? {};
			return Object.hasOwn(jobs, jobKey) ? Option.fromUndefinedOr(jobs[jobKey]) : Option.none<bigint>();
		});
	return {
		/** Asks the fork for its account and keeps it: what the driver does before it destroys the fork. */
		settle: (fork: Swarm.Fork): Effect.Effect<void, Swarm.ForkRetryLater> =>
			Effect.gen(function* () {
				const settled = yield* asked(fork.swarmId, fork.jobKey, fork.forkId);
				if (Option.isSome(settled)) yield* keep(fork.swarmId, fork.jobKey, settled.value);
			}).pipe(
				// The fork exists and its account is not kept: destroying it now would lose the money of its job.
				Effect.mapError(
					(error) => new Swarm.ForkRetryLater({ operation: "destroy", reason: `${error._tag}: ${error.message}` }),
				),
			),
		spent: (swarmId: string, job: Swarm.JobReport): Effect.Effect<Option.Option<bigint>, Doc.Failure> =>
			Effect.gen(function* () {
				const kept = yield* keptOf(swarmId, job.key);
				if (Option.isSome(kept) || Option.isNone(job.ran)) return kept;
				const { actorId } = job.ran.value;
				// A fork in the swarm's own storage: the Rivet driver makes none.
				if (actorId === null) return kept;
				// A fork that cannot be asked now has no account to give: the caller asks again.
				return yield* Effect.orElseSucceed(asked(swarmId, job.key, actorId), () => Option.none<bigint>());
			}),
	};
}
