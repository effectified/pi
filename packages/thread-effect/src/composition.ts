// The reference composition: every pi-effect plugin installed on one harness, in the order their READMEs require.

import type { Provider } from "@effectified/pi-ai";
import { Models } from "@effectified/pi-ai";
import * as Approvals from "@effectified/pi-approvals";
import {
	type BudgetEvents,
	BudgetedModels,
	type Estimator,
	type Lease,
	type Prices,
	Shares,
	type Spend,
} from "@effectified/pi-budget";
import type { ConversationRecord, HarnessSettings } from "@effectified/pi-durable";
import {
	type DurableError,
	type Extension,
	Harness,
	type Registry,
	type Storage,
	type Tx,
} from "@effectified/pi-durable";
import {
	Conversations,
	type DeniedTool,
	Guard,
	type InvalidPolicy,
	type Policy,
	type ReservedExtension,
	type Rule,
} from "@effectified/pi-guard";
import { Advisory, Recorder, type RecordSink } from "@effectified/pi-recorder";
import * as Review from "@effectified/pi-review";
import {
	type RouteEvents,
	Router,
	type RouterOptions,
	type RouteTable,
	type RouteTableError,
} from "@effectified/pi-router";
import { Subagents } from "@effectified/pi-subagent";
import * as Swarm from "@effectified/pi-swarm";
import { PiTelemetry } from "@effectified/pi-telemetry";
import { Effect, Layer } from "effect";
import * as ChildSetup from "./child-setup.ts";
import * as Constraints from "./constraints.ts";
import * as Fallbacks from "./fallbacks.ts";
import * as ForkSetup from "./fork-setup.ts";
import * as Forks from "./forks.ts";
import * as Opened from "./opened.ts";
import * as Courier from "./outcome-courier.ts";
import type { OutcomeSink } from "./outcome-sink.ts";
import * as Outcomes from "./outcomes.ts";
import * as ReviewCalls from "./review-calls.ts";
import * as Reviewers from "./reviewers.ts";
import * as Session from "./session.ts";
import * as Swarms from "./swarms.ts";
import * as Threads from "./threads.ts";

/**
 * What a product supplies as data. What it supplies as services is in the requirements of the Layers: its `Lease`,
 * `Estimator` and `Prices`, its `Approvals.Inbox`, its `RecordSink`, its `OutcomeSink`, its `PiTelemetry`, its
 * storage, and whatever its tools, argument rules, approval rule and review checks need (a
 * `Review.Citations.Verifier`, a `SearchProvider`). `ForkNeeds` is what the chosen fork driver needs of the host.
 */
export interface Config<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
	Checks extends ReadonlyArray<Review.Check.Any>,
	ApprovalRule,
	ForkNeeds = never,
> {
	/** The product's own extensions: its tools, the search tools among them. */
	readonly extensions: Extensions;
	readonly guard: {
		readonly policy: Policy.Policy;
		readonly rules?: Rules;
	};
	readonly approvals: Approvals.Policy<ApprovalRule>;
	readonly models: {
		/** The providers the routes name. Nothing else reaches them: a request goes through the router and the budget. */
		readonly providers: ReadonlyArray<Provider>;
		/**
		 * The routes, with their prices, as a product writes them (the table's encoded form, plain strings) or decoded:
		 * `Router.layer` validates it. `priceRows(routes)` of the router gives the rows of the product's `Prices`.
		 */
		readonly routes: typeof RouteTable.Encoded;
		readonly router?: RouterOptions;
	};
	readonly review: Review.Options<Checks>;
	readonly subagents: Subagents.Config & Pick<ChildSetup.Options, "caps">;
	readonly swarms: ReadonlyArray<Swarm.Swarm<never, unknown>>;
	/**
	 * Where a swarm's forks live. Default: `Forks.conversations`, conversations of the harness the swarm runs in. A
	 * host inside a Rivet actor chooses actor forks (`@effectified/pi-thread/rivet`).
	 */
	readonly forks?: Forks.Forks<ForkNeeds>;
	readonly recorder?: Recorder.Options;
	/** How a failed delivery to the product's `OutcomeSink` is tried again. */
	readonly outcomes?: Outcomes.Options;
	/** Pi's run policy. */
	readonly settings?: HarnessSettings;
}

/**
 * The extensions the registry holds after the guard's own, in order:
 *
 * 1. The product's tools.
 * 2. `approvals`: after everything that blocks or rewrites a call, so nobody is asked about a call the guard refuses.
 * 3. `review`: the only `onYield` hook.
 * 4. `subagent`, `swarm` and `thread` (the courier of a thread's outcome events): tools and tasks without hooks.
 * 5. `recorder` (the advisory record): last, because it observes and decides nothing.
 */
function installed<
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Checks extends ReadonlyArray<Review.Check.Any>,
	ApprovalRule,
>(config: Config<Extensions, ReadonlyArray<Rule.Any>, Checks, ApprovalRule, unknown>) {
	return [
		...config.extensions,
		Approvals.extension(config.approvals),
		Review.extension(config.review),
		Subagents.extension(config.subagents),
		Swarm.extension(config.swarms),
		Courier.extension,
		Advisory.extension,
	] as const;
}

/**
 * What `layer` provides: the registry and the models a harness opens on, and the plugins' services of before it. The
 * `Models` is the budgeted one. `Opened` is what `services` gives the open harness to, and `OutcomeCourier.Delivery`
 * what it gives the delivery of outcome events to. The `ForkSetup` is provided because a host that holds forks in
 * actors runs it in each fork.
 */
export type Provided =
	| Registry.Registry
	| Guard.Guard
	| Models
	| BudgetEvents
	| Spend
	| Shares
	| Router
	| RouteEvents
	| Swarm.ForkDriver
	| Swarm.ForkSetup.ForkSetup
	| Forks.Accounts
	| Reviewers.Reviewers
	| Opened.Opened
	| Courier.Delivery;

/** What building `layer` fails with: a policy, a registry or a route table that cannot be used. */
export type Failure = DeniedTool | InvalidPolicy | ReservedExtension | Guard.RegistryError | RouteTableError;

/**
 * What a product provides as services: the ports of the plugins, and what its own tools, argument rules, approval
 * rule and review checks need. The `Guard` is given to them by the composition.
 */
export type Requirements<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
	Checks extends ReadonlyArray<Review.Check.Any>,
	ApprovalRule,
> =
	| Lease
	| Estimator
	| Prices
	| Approvals.Inbox
	| RecordSink
	| OutcomeSink
	| ApprovalRule
	| Review.Check.Services<Checks[number]>
	| Exclude<Extension.Services<Extensions[number]> | Rule.Services<Rules[number]>, Guard.Guard>;

/**
 * What the harness runs on beside its storage: the guarded registry and the budgeted models, with what the plugins
 * provide before a harness is open. A host builds it first, then the harness with `harness`, then `services`: the
 * three arguments a Rivet actor takes. Inside out:
 *
 * - **The guard**, from its policy alone (`Guard.fromPolicy`), so everything below can hold it: one value, one guard.
 * - **`Opened`**, the place the open harness is given to, and on it **the constraint source**, which reads a
 *   conversation's grant through the guard and answers the router.
 * - **Models.** The providers, and on that one `Models` both the router, with that source, and the budget: the
 *   `Models` this provides is the budgeted one, so one request of the harness to an alias is one reservation,
 *   whichever route serves it. `Fallbacks.layer` is the router's settlement port on the budget's `Spend`: an attempt
 *   another route takes over is charged before that route is tried.
 * - **Before the harness.** The budget's `Shares`, the `ForkDriver` of the host's choice (`config.forks`), the two
 *   setup ports, `ChildSetup` and `ForkSetup`, which grant through the guard and cap on the shares, and the place the
 *   delivery of outcome events is given to (`OutcomeCourier.holder`), which the registry's couriers wait at.
 * - **Registry.** Checked by the guard (`Guard.registry`), whose extension comes first, then `installed` in its
 *   order. A tool the policy denies fails the build.
 * - **The reviewer check**, from the route table and the review's family table, which only this Layer has both of.
 */
export function layer<
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Rules extends ReadonlyArray<Rule.Any> = readonly [],
	const Checks extends ReadonlyArray<Review.Check.Any> = readonly [],
	ApprovalRule = never,
	ForkNeeds = never,
>(
	config: Config<Extensions, Rules, Checks, ApprovalRule, ForkNeeds>,
): Layer.Layer<Provided, Failure, Requirements<Extensions, Rules, Checks, ApprovalRule> | ForkNeeds> {
	// One value, built once: the router and the budget are built on the same plain `Models`, into which the router
	// puts its provider. The harness opens on the budgeted one.
	const providers = Models.layer(config.models.providers);
	const budgeted = BudgetedModels.layerWithShares.pipe(Layer.provideMerge(Shares.layer), Layer.provide(providers));
	const routed = Router.layer(config.models.routes, config.models.router).pipe(
		// The settlement gets the budget's `Spend` and nothing else of it: the router stays on the providers' `Models`.
		Layer.provide(Layer.provide(Fallbacks.layer, budgeted)),
		Layer.provide(providers),
	);
	const models = Layer.merge(routed, budgeted);
	const registry = Guard.registry({ rules: config.guard.rules, extensions: installed(config) }).pipe(
		Layer.provide(ChildSetup.layer(config.subagents)),
	);
	const forks: Forks.Forks<ForkNeeds> = config.forks ?? Forks.conversations;
	const reviewers = Reviewers.layer(config.models.routes, config.review.policy, config.models.router?.id ?? ROUTER);
	const composed = Layer.mergeAll(registry, reviewers).pipe(
		Layer.provideMerge(ForkSetup.layer),
		Layer.provideMerge(forks.driver),
		Layer.provideMerge(Courier.holder),
		Layer.provideMerge(models),
		// Under the router: it takes the `ConstraintSource` of the context it is built in.
		Layer.provideMerge(Constraints.layer),
		// Under everything that reads the harness storage and is built before the harness.
		Layer.provideMerge(Opened.layer),
		// One Layer value is one guard: the setup ports and the source grant and read with the one that checked the
		// registry.
		Layer.provideMerge(Guard.fromPolicy(config.guard.policy)),
	);
	// TypeScript cannot carry each handler's requirement through the list of extensions, where it is a conditional
	// type over a type parameter: by construction the registry needs what the product's and the plugins' handlers
	// need, less the `ChildSetup`, `ForkSetup`, `ForkDriver`, `Shares` and `OutcomeCourier.Delivery` provided here,
	// which is `Requirements` without its `OutcomeSink` (`services` takes that one), and the driver needs `ForkNeeds`.
	return composed as Layer.Layer<Provided, Failure, Requirements<Extensions, Rules, Checks, ApprovalRule> | ForkNeeds>;
}

/** The id of the router's provider when the product names none: the router's own default. */
const ROUTER = "router";

/**
 * The options the harness is opened with:
 *
 * - `conversationCreated`, run in every commit that creates or forks a conversation: the guard's, so the conversation
 *   is offered exactly what it may call and a task-owned one is never labelled below its owner; then its entry in
 *   the session index, so the router finds the conversation of each of its requests.
 * - Pi's telemetry on the product's `PiTelemetry`, and the settings.
 *
 * An Effect, because the telemetry adapter is a service: a Rivet actor takes it as it is, with `PiTelemetry` among
 * what its `layer` provides.
 */
export function harness(
	config: { readonly settings?: HarnessSettings } = {},
): Effect.Effect<Harness.Options<Guard.Guard>, never, PiTelemetry> {
	return PiTelemetry.use((telemetry) =>
		Effect.succeed({
			telemetry,
			conversationCreated: (tx: Tx.Tx, conversation: ConversationRecord) =>
				Effect.andThen(Conversations.created(tx, conversation), Session.noteIn(tx, conversation.id)),
			...(config.settings === undefined ? {} : { settings: config.settings }),
		}),
	);
}

/** What `services` provides: the services of this package, and the recorder's pump. */
export type Services = Threads.Threads | Swarms.Swarms | Recorder.Recorder;

/**
 * What is built on the open harness, in this order:
 *
 * 1. The budget's shares, the fork driver of the host's choice (`config.forks`, the one `layer` was given) and the
 *    constraint source get the harness: until then every request that names a session, and every call of the driver,
 *    waits.
 * 2. The recorder's pump starts and queues what an earlier process left undelivered. Its sink is the product's
 *    behind `ReviewCalls.layer`, which adds a `ModelCall` record for the reviewer's request of every verdict.
 * 3. The thread and swarm services are made, and the delivery of outcome events starts (`Outcomes.layer`): the
 *    couriers get what they do, and every thread with an event an earlier process did not deliver is looked at.
 *
 * It requires the harness, what `layer` provides, and the product's `RecordSink` and `OutcomeSink`.
 */
export function services<ForkNeeds = never>(
	config: {
		readonly recorder?: Recorder.Options;
		readonly outcomes?: Outcomes.Options;
		readonly forks?: Forks.Forks<ForkNeeds>;
	} = {},
): Layer.Layer<
	Services,
	DurableError,
	| Harness.Harness
	| Guard.Guard
	| Shares
	| Swarm.ForkDriver
	| Forks.Accounts
	| Reviewers.Reviewers
	| Opened.Opened
	| Courier.Delivery
	| RecordSink
	| OutcomeSink
> {
	const forks: Forks.Forks<ForkNeeds> = config.forks ?? Forks.conversations;
	return Layer.mergeAll(Threads.layer, Swarms.layer, Outcomes.layer(config.outcomes)).pipe(
		Layer.provideMerge(Layer.provide(Recorder.layer(config.recorder), ReviewCalls.layer)),
		Layer.provideMerge(Layer.mergeAll(Shares.attach, forks.attach, Opened.attach)),
	);
}

/**
 * The whole composition in one process: `layer`, the harness on the `HarnessStorage` of the context, and `services`.
 * Work the last process left unfinished continues as soon as it is built.
 */
export function open<
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Rules extends ReadonlyArray<Rule.Any> = readonly [],
	const Checks extends ReadonlyArray<Review.Check.Any> = readonly [],
	ApprovalRule = never,
	ForkNeeds = never,
>(
	config: Config<Extensions, Rules, Checks, ApprovalRule, ForkNeeds>,
): Layer.Layer<
	Services | Harness.Harness | Provided,
	Failure | DurableError,
	Requirements<Extensions, Rules, Checks, ApprovalRule> | ForkNeeds | Storage.HarnessStorage | PiTelemetry
> {
	return services(config).pipe(
		Layer.provideMerge(Layer.unwrap(Effect.map(harness(config), (options) => Harness.layer(options)))),
		Layer.provideMerge(layer(config)),
	);
}
