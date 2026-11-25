// The thread actor: the composition hosted in a Rivet actor, one actor per thread, with the thread and swarm
// operations as actions and the forks of its swarms as actor forks.

import * as Budget from "@gunta/pi-budget-effect";
import type { Extension } from "@gunta/pi-durable-effect";
import { type Action, Actor, type ActorDatabase, ActorInfo, type Fork } from "@gunta/pi-durable-rivet-effect";
import type { Rule } from "@gunta/pi-guard-effect";
import * as Recorder from "@gunta/pi-recorder-effect";
import type * as Review from "@gunta/pi-review-effect";
import * as Subagent from "@gunta/pi-subagent-effect";
import * as Rivet from "@gunta/pi-swarm-effect/rivet";
import type { PiTelemetry } from "@gunta/pi-telemetry-effect";
import { Layer } from "effect";
import type { ActorOptionsInput } from "rivetkit";
import * as Composition from "../composition.ts";
import * as StorageFork from "../storage-fork.ts";
import * as Accounts from "./accounts.ts";
import * as SwarmActions from "./swarm-actions.ts";
import * as ThreadActions from "./thread-actions.ts";

/**
 * What a product gives to have its threads hosted in Rivet actors.
 *
 * - `composition`: the composition's configuration, as for one process. Where a swarm's forks live is not the
 *   product's choice here: they are forks of the thread's actor.
 * - `ports`: the product's ports as one Layer: its `Lease`, `Estimator` and `Prices`, its `RecordSink`, its
 *   `OutcomeSink`, its `Approvals.Inbox`, its `PiTelemetry`, and what its tools, rules and checks need. It is built
 *   at each wake of each actor, a swarm's fork included, and may read the actor it is built in (`ActorInfo`), which
 *   is how a fork gets a lease and a record stream of its own.
 * - `swarm`: options of the swarm's Rivet driver, such as how often a coordinator asks its forks.
 * - `actions`: the product's own actions, beside the fixed ones (`ProductActions`): what the fixed set cannot say of
 *   a product, such as an action that gives the actor its work before `start`.
 * - `services`: a Layer of the product's own on the open harness, built after the composition's services at each
 *   wake, as a product builds one on `Composition.open` in one process: for what a port built before the harness
 *   needs of it, such as the recorder a product's own sender flushes first. It is built for what it does: what it
 *   provides reaches nobody. Not built while fork hygiene runs.
 * - `forkHygiene`: what the product does to a copied storage beside the composition's own hygiene, after it: its
 *   own tables, a first record of the fork's stream.
 * - `prefix` and `rivet`: the host's options of the same names (`Actor.make`): the prefix of Pi's tables in the actor
 *   database, and Rivet's actor options.
 */
export interface Options<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
	Checks extends ReadonlyArray<Review.Check.Any>,
	ApprovalRule,
	PortsError,
	Ports = Composition.Requirements<Extensions, Rules, Checks, ApprovalRule> | PiTelemetry,
	Product extends Readonly<Record<string, Action.Any>> = NoProduct,
	ServicesError = never,
> {
	readonly composition: Omit<Composition.Config<Extensions, Rules, Checks, ApprovalRule>, "forks">;
	// Twice, so that `Ports` is read off the Layer as all it provides, and the Layer is held to provide the ports.
	readonly ports: Layer.Layer<Ports, PortsError, Actor.Provided> &
		Layer.Layer<
			Composition.Requirements<Extensions, Rules, Checks, ApprovalRule> | PiTelemetry,
			PortsError,
			Actor.Provided
		>;
	readonly swarm?: Rivet.Options;
	// Held to `ProductActions` here and not in the constraint of `Product`: a constraint that names `Ports` has
	// TypeScript settle `Ports` before it has read the `ports` Layer.
	readonly actions?: Product & Reserved & ProductActions<InActor<Extensions, Rules, Checks, ApprovalRule, Ports>>;
	readonly services?: Layer.Layer<never, ServicesError, InActor<Extensions, Rules, Checks, ApprovalRule, Ports>>;
	readonly forkHygiene?: ReadonlyArray<Fork.Hygiene<ActorDatabase>>;
	readonly prefix?: string;
	readonly rivet?: ActorOptionsInput;
}

/** The actions of a thread actor: the thread's, its swarms', and what a fork serves its source. */
export type Actions = ThreadActions.Actions & SwarmActions.Actions & Rivet.Actions & typeof Accounts.actions;

/**
 * What an action of a thread actor runs with: the harness, the registry and the models, the actor it runs in
 * (`ActorInfo`, `ActorDatabase`, `ActorEngine`), what the composition's `layer` and `services` provide (`Threads`,
 * `Swarms`, the recorder, the guard, the shares), the product's ports, and `Ports`: all the product's `ports` Layer
 * provides, so also services of its own beside the ports.
 */
export type InActor<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
	Checks extends ReadonlyArray<Review.Check.Any>,
	ApprovalRule,
	Ports = never,
> = Actor.InActor<
	Composition.Provided | Composition.Requirements<Extensions, Rules, Checks, ApprovalRule> | PiTelemetry | Ports,
	Composition.Services
>;

/**
 * The product's own actions of a thread actor, by name: `Action`s of the Rivet host, which run inside the actor with
 * `R` (`InActor`), as the fixed ones do. A caller reaches one with `Client.call`, or for a thread with
 * `Remote.product`. As every action, one returns within Rivet's action timeout and is safe to send again.
 *
 * A product action takes no name of a fixed action (`Actions`), and neither of the host's own, `pi` and `destroy`:
 * `Options.actions` does not type check with one (`Reserved`).
 */
export type ProductActions<R = never> = Readonly<
	Record<string, Action.Action<Action.Wire, Action.Wire, Action.Wire, R>>
>;

/** The names no product action has: those of the fixed actions of a thread actor, and the host's own two. */
export type Reserved = { readonly [Fixed in keyof Actions | "pi" | "destroy"]?: never };

/** The product actions of a thread actor that has none. */
export type NoProduct = Readonly<Record<never, never>>;

/**
 * A thread actor made by `make`: what a host registers, and what `Remote.layer` calls. `Product` is the product's own
 * actions, which `Client.call` and `Remote.product` are typed by.
 */
export type Definition<Name extends string = string, Product = NoProduct> = Actor.Definition<Name, Actions & Product>;

/**
 * The actor definition `name` for the threads of a product: one actor is one thread, found by the thread's key, with
 * the composition on the actor's own SQLite.
 *
 * - **Wake.** `Composition.layer` on the product's ports, the harness, and `Composition.services` are built at each
 *   wake; work a sleep or a crash cut off continues. The host's wake keeper holds the actor awake while the thread
 *   works and lets it sleep while a call is parked, an answer is held or the thread stopped.
 * - **Outcomes.** The actor tells the product's `OutcomeSink` itself that the thread's work started and what the
 *   thread came to. The delivery is a task of the harness (`OutcomeCourier`), so the keeper holds the actor awake
 *   while an event is being delivered, and schedules a wake for the next attempt of one the sink refused: an actor
 *   that sleeps with an event undelivered is woken for it at that time.
 * - **Actions.** The thread's (`ThreadActions.actions`), its swarms' (`SwarmActions.actions`), the swarm driver's own
 *   (`swarmRun`, `swarmJob`, `swarmCancel`), and `forkAccount`. None waits for a thread or a swarm. Beside them, the
 *   product's own (`options.actions`), under names of their own.
 * - **Swarms.** A swarm's coordinator lives in the actor of its thread, and each fork is an actor fork of it: one
 *   definition is the thread and every fork. The fork setup of the composition runs inside each fork, on the fork's
 *   own harness, guard, shares and lease.
 * - **Fork hygiene**, inside a fork before its first call, in this order (`hygiene`).
 */
export function make<
	const Name extends string,
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Rules extends ReadonlyArray<Rule.Any> = readonly [],
	const Checks extends ReadonlyArray<Review.Check.Any> = readonly [],
	ApprovalRule = never,
	PortsError = never,
	Ports = Composition.Requirements<Extensions, Rules, Checks, ApprovalRule> | PiTelemetry,
	Product extends Readonly<Record<string, Action.Any>> = NoProduct,
	ServicesError = never,
>(
	name: Name,
	options: Options<Extensions, Rules, Checks, ApprovalRule, PortsError, Ports, Product, ServicesError>,
): Definition<Name, Product> {
	const forks = Accounts.forks(options.swarm);
	const composition = { ...options.composition, forks };
	const layer = Composition.layer(composition).pipe(Layer.provideMerge(options.ports));
	const fixed = {
		...Rivet.actions,
		...Accounts.actions,
		...ThreadActions.actions,
		...SwarmActions.actions(options.composition.swarms),
	};
	const product: Product | undefined = options.actions;
	const composed = Composition.services(composition);
	// The product's own Layer on the composition's services, which it may use. A cast: TypeScript reads the `ports`
	// Layer by its ports alone, so it does not see that `layer` provides the rest of `Ports`; and what this Layer
	// fails with is, like every failure of `services`, a harness that did not open.
	const services =
		options.services === undefined ? composed : (Layer.provideMerge(options.services, composed) as typeof composed);
	const actor = Actor.make(name, {
		layer,
		harness: Composition.harness(composition),
		services,
		// The fixed actions last: by its type a product action has a name of its own.
		actions: { ...product, ...fixed },
		forkHygiene: [...hygiene, ...(options.forkHygiene ?? [])],
		...(options.prefix === undefined ? {} : { prefix: options.prefix }),
		...(options.rivet === undefined ? {} : { options: options.rivet }),
	});
	// TypeScript types the spread of an optional record of a type parameter by the fixed actions alone: the definition
	// holds the product's too, and each runs with `InActor`, which is what this `layer` and these `services` provide.
	return actor as Definition<Name, Product>;
}

/**
 * What a fork of a thread actor does to the storage it copied, before its first call, in order. A fork is made only
 * of an actor with nothing in flight (no unsettled submission, no live task but a background task of the product), so
 * the copy holds no parked call, no held or deferred review and no request in flight. What it can hold live is a
 * swarm's coordinator and the run of a background subagent whose child is not at work.
 *
 * 1. The recorder's `onStorageFork`: every conversation's cursor moves to the copied head, so the fork delivers only
 *    what it commits itself and nothing its source delivered or still has to deliver. First, so that whatever the
 *    fork commits from here on is its own to deliver.
 * 2. The swarm's (`Rivet.forkHygiene`): the copied coordinators end as copied, the driver's record of forks is
 *    emptied, and the job conversation of a source that was itself a fork is forgotten.
 * 3. The subagents' `onStorageFork`: every run the copy inherited live ends as copied. It hands its child no task and
 *    sends its parent no report, and the child's document says why.
 * 4. The budget's `onStorageFork`, under the fork's actor id: what every copied share had settled becomes what it
 *    inherited. A cap still counts it, and the fork's own total starts at zero, so the same money is not stored as
 *    spent in two actors.
 * 5. The composition's own (`StorageFork.onStorageFork`): the swarms the copied thread lists are marked as its
 *    source's, so the fork does not add their forks' money to its copy of the thread; and the thread's outcome events
 *    are its source's to tell, so the copied courier ends, no event is pending, and the delivery cursor stands where
 *    the thread does.
 *
 * Only the first place is decided by what the steps do. Steps 2 to 5 write documents and abort marks of their own
 * plugin and read nothing another step writes: they are in the order of what they end (tasks, then money, then what
 * is added up over both, and what is told of the thread). The product's steps come after all of them.
 *
 * Nothing for the other plugins, whose state is right in a copy as it is:
 *
 * - **guard**: the grants, as they are. The job's conversation is narrowed by the fork setup.
 * - **approvals**: nothing pending. A parked call is live work, and an actor with one is not forked.
 * - **review**: the verdict and release entries of the transcript. A held or a deferred review keeps its submission
 *   open, and an actor with one is not forked.
 * - **this package, otherwise**: the thread's document, the session index, the routing limits and the swarm
 *   allowances, which the fork setup reads in the fork. A job's conversation is no thread: it has no courier, and
 *   nothing is told of it.
 */
export const hygiene: ReadonlyArray<Fork.Hygiene<ActorDatabase | Budget.Shares>> = [
	Recorder.onStorageFork,
	Rivet.forkHygiene,
	Subagent.onStorageFork,
	ActorInfo.use((actor) => Budget.onStorageFork(actor.actorId)),
	StorageFork.onStorageFork,
];
