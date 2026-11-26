// Test helper: a product in miniature. Its tools, policies and route table as data; its lease, record sink and
// approval inbox in memory, kept across reopens; and the composition opened on scripted models, with no network.

import { type FauxProviderHandle, type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import * as Approvals from "@effectified/pi-approvals";
import { type BudgetRequest, Estimator, Lease, LeaseFenced, Prices, type Settlement } from "@effectified/pi-budget";
import { Extension, Harness, Storage, Tool } from "@effectified/pi-durable";
import { Policy as GuardPolicy, Matcher } from "@effectified/pi-guard";
import { RecordSink, type Records } from "@effectified/pi-recorder";
import * as Review from "@effectified/pi-review";
import { type PriceRows, priceRows, type RouteEvent, RouteEvents, type RouteTable } from "@effectified/pi-router";
import { SearchProvider, SearchTools } from "@effectified/pi-search";
import { Subagent, Subagents } from "@effectified/pi-subagent";
import * as Swarm from "@effectified/pi-swarm";
import { PiTelemetry } from "@effectified/pi-telemetry";
import { DateTime, Effect, Layer, Queue, Schema, type Scope, Stream, Tracer } from "effect";
import {
	Composition,
	type Outcome,
	type OutcomeEvent,
	OutcomeSink,
	OutcomeSinkError,
	type Outcomes,
	Reviewers,
	type Threads,
} from "../src/index.ts";

/** The alias every thread and subagent answers with. */
export const AUTHOR = { provider: "router", modelId: "author" };

/** The alias the review asks. */
export const REVIEWER = { provider: "router", modelId: "reviewer" };

/** A reviewer alias that is served by the author's own model. */
export const SAME_FAMILY_REVIEWER = { provider: "router", modelId: "clone" };

/** The author's first route: a model of family alpha. */
export const WRITER = { provider: "author-lab", modelId: "writer" };

/** The author's second route: another lab's model of the same family. */
export const BACKUP = { provider: "backup-lab", modelId: "writer-b" };

/** The reviewer's route: a model of family beta. */
export const JUDGE = { provider: "reviewer-lab", modelId: "judge" };

/** The route table: the author falls back from its first lab to a second one. */
export const ROUTES: RouteTable = {
	classifications: ["public", "internal"],
	limits: { author: { maxInFlight: 4 }, backup: { maxInFlight: 4 }, reviewer: { maxInFlight: 4 } },
	aliases: [
		{
			alias: AUTHOR.modelId,
			routes: [
				route(WRITER, "author", {
					input: 3_000_000,
					output: 15_000_000,
					cacheRead: 300_000,
					cacheWrite: 3_750_000,
				}),
				route(BACKUP, "backup", { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 }),
			],
		},
		{
			alias: REVIEWER.modelId,
			routes: [
				route(JUDGE, "reviewer", {
					input: 2_000_001,
					output: 8_000_000,
					cacheRead: 200_000,
					cacheWrite: 2_500_000,
				}),
			],
		},
		{
			alias: SAME_FAMILY_REVIEWER.modelId,
			routes: [
				route(WRITER, "author", {
					input: 3_000_000,
					output: 15_000_000,
					cacheRead: 300_000,
					cacheWrite: 3_750_000,
				}),
			],
		},
	],
};

type TokenPrices = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
};

function route(model: { readonly provider: string; readonly modelId: string }, key: string, price: TokenPrices) {
	return {
		provider: model.provider,
		model: model.modelId,
		region: "test",
		ceiling: "internal",
		price: { currency: "USD", ...price },
		concurrencyKey: key,
	};
}

/**
 * The budget's price table, from the route table: the router gives every route's model at the route's price, and
 * every alias at the highest price of its routes. A price is written once, in `ROUTES`.
 */
export const PRICES: PriceRows = Effect.runSync(priceRows(ROUTES));

/** What `usage` costs at the price of `model`, worked out apart from the packages: exact, rounded up once. */
export function expectedCost(
	model: { readonly provider: string; readonly modelId: string },
	usage: TokenPrices,
): bigint {
	const price = PRICES.prices.find((row) => row.provider === model.provider && row.model === model.modelId);
	if (price === undefined) throw new Error(`No price for ${model.provider}/${model.modelId}`);
	const scaled =
		BigInt(usage.input) * BigInt(price.input) +
		BigInt(usage.output) * BigInt(price.output) +
		BigInt(usage.cacheRead) * BigInt(price.cacheRead) +
		BigInt(usage.cacheWrite) * BigInt(price.cacheWrite);
	return (scaled + 999_999n) / 1_000_000n;
}

/** What every reservation sets aside, in micro units. */
export const ESTIMATE = 50_000n;

/** One thing the lease did, in the order it happened. */
export type LeaseStep =
	| {
			readonly step: "reserve";
			readonly token: string;
			readonly estimate: bigint;
			readonly request: BudgetRequest;
			/** The Rivet actor whose lease port was asked; absent in one process. */
			readonly actor?: string;
	  }
	| { readonly step: "fenced"; readonly reason: string }
	| { readonly step: "settle"; readonly token: string; readonly settlement: Settlement };

/** The state a product keeps outside the harness: it outlives every reopen of a test. */
export interface Outside {
	readonly lease: {
		readonly steps: Array<LeaseStep>;
		/** While set, every reserve fails with `LeaseFenced` and this reason. */
		fenced: string | undefined;
	};
	/** Every batch the sink took, in the order it took them. */
	readonly delivered: Array<ReadonlyArray<Records.Record>>;
	/** Per batch of `delivered`, the Rivet actor whose sink port took it; undefined in one process. */
	readonly deliveredBy: Array<string | undefined>;
	/** Every request the inbox was shown, repeats included. */
	readonly shown: Array<Approvals.Request>;
	/** The inbox as a queue a test takes from. */
	readonly inbox: Queue.Queue<Approvals.Request>;
	/** How often each tool's handler ran, by tool name. */
	readonly ran: Record<string, number>;
	/** While set, the handler of this tool says so and then never returns, until its harness closes. */
	held: { readonly tool: string; readonly reached: () => void } | undefined;
	/** Every route event of every composition opened on this state. */
	readonly routed: Array<RouteEvent>;
	/** What the outcome sink was told. */
	readonly told: {
		/** Every event the sink took, repeats included, in the order it took them. */
		readonly events: Array<OutcomeEvent>;
		/** Every event the sink was called with, also by a call it failed. */
		readonly offered: Array<OutcomeEvent>;
		/** Per event of `events`, the ids of the records the record sink had taken when the event came. */
		readonly recorded: Array<ReadonlyArray<string>>;
		/** Per event of `events`, the Rivet actor whose sink port took it; undefined in one process. */
		readonly by: Array<string | undefined>;
		/** How many of its next calls the sink fails. */
		failing: number;
		/** How often the sink was called, failed calls included. */
		calls: number;
	};
}

/** Fresh outside state. */
export function outside(): Outside {
	return {
		lease: { steps: [], fenced: undefined },
		delivered: [],
		deliveredBy: [],
		shown: [],
		inbox: Effect.runSync(Queue.unbounded<Approvals.Request>()),
		ran: {},
		held: undefined,
		routed: [],
		told: { events: [], offered: [], recorded: [], by: [], failing: 0, calls: 0 },
	};
}

/** The reservations of a lease, each with its settlements: exactly one per reservation is what the budget promises. */
export function reservations(state: Outside) {
	return state.lease.steps.flatMap((step) =>
		step.step === "reserve"
			? [
					{
						token: step.token,
						estimate: step.estimate,
						request: step.request,
						actor: step.actor,
						settlements: state.lease.steps.flatMap((other) =>
							other.step === "settle" && other.token === step.token ? [other.settlement] : [],
						),
					},
				]
			: [],
	);
}

/** Every record the sink took, each id once, in the order of its first delivery. */
export function records(state: Outside): ReadonlyArray<Records.Record> {
	const seen = new Set<string>();
	return state.delivered.flat().filter((record) => (seen.has(record.id) ? false : seen.add(record.id) !== undefined));
}

/** The ids the sink took more than once with different content: none is what the recorder promises. */
export function conflicts(state: Outside): ReadonlyArray<string> {
	const first = new Map<string, string>();
	const differing = new Set<string>();
	for (const record of state.delivered.flat()) {
		const content = JSON.stringify(record);
		const known = first.get(record.id);
		if (known === undefined) first.set(record.id, content);
		else if (known !== content) differing.add(record.id);
	}
	return [...differing];
}

const Lookup = (state: Outside) =>
	Tool.make("lookup", {
		description: "Look a record up by id.",
		parameters: Schema.Struct({ id: Schema.String }),
		success: Schema.String,
		replay: "safe",
		handler: ({ id }) => ran(state, "lookup", `Record ${id} is titled Answer.`),
	});

const WriteNote = (state: Outside) =>
	Tool.make("write_note", {
		description: "Write a note.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		handler: ({ text }) => ran(state, "write_note", `Wrote ${text}`),
	});

const Transfer = (state: Outside) =>
	Tool.make("transfer", {
		description: "Transfer money to someone.",
		parameters: Schema.Struct({ to: Schema.String, amount: Schema.Number }),
		success: Schema.String,
		handler: ({ to, amount }) => ran(state, "transfer", `Sent ${amount} to ${to}.`),
	});

/** Counts a run of `tool` and gives its result, unless the test holds the tool: then the handler never returns. */
function ran(state: Outside, tool: string, result: string): Effect.Effect<string> {
	return Effect.suspend(() => {
		state.ran[tool] = (state.ran[tool] ?? 0) + 1;
		if (state.held?.tool !== tool) return Effect.succeed(result);
		state.held.reached();
		return Effect.never;
	});
}

/** A subagent that may look records up, and nothing else. */
export const Researcher = Subagent.make("researcher", {
	description: "Looks records up and reports what it found.",
	agent: { model: AUTHOR, tools: ["lookup"], instructions: "Report what the record says.", maxTurns: 4 },
});

/** What the researcher may settle of the lease, in micro units. */
export const RESEARCHER_CAP = 400n;

/** A swarm whose jobs ask whether the primed thread covers a topic. */
export const Covers = Swarm.make({
	name: "covers",
	input: Schema.Struct({ topic: Schema.String }),
	result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
	prompt: ({ topic }) => `Does the record you read cover ${topic}?`,
});

/** What every fork of a swarm of the tests may do and settle: no tool, and more than a job costs. */
export const FORK = { tools: [], cap: 10_000n };

/** No tool may be registered under these verbs. */
export const FORBIDDEN = ["approve", "sign", "export", "send", "delete"];

/** The guard's policy: the forbidden verbs, and both aliases cleared for internal content. */
export const GUARD_POLICY: GuardPolicy.Policy = {
	...GuardPolicy.empty,
	denied: [Matcher.firstWord(FORBIDDEN)],
	classifications: ["public", "internal"],
	modelCeilings: [{ ...AUTHOR, ceiling: "internal" }],
};

/**
 * One corrective run; the author's two labs are one family, the reviewer's another. A reviewer alias has a row of its
 * own and one for each of its routes: the rule is applied to the alias before the request and to the route that
 * served after it.
 */
export const REVIEW_POLICY: Review.Policy.Policy = {
	reviewer: REVIEWER,
	families: [
		{ ...WRITER, family: "alpha" },
		{ ...BACKUP, family: "alpha" },
		{ ...REVIEWER, family: "beta" },
		{ ...JUDGE, family: "beta" },
		{ ...SAME_FAMILY_REVIEWER, family: "alpha" },
	],
	maxCorrections: 1,
	blocking: "block",
};

/** Citations are written `[source]`; the verifier resolves every source but `missing`. */
const Cited = Review.Citations.check((text) =>
	[...text.matchAll(/\[([a-z-]+)\]/g)].map((match) => ({ source: match[1] ?? "", claim: text })),
);

/** The scripted turns of one open composition, per provider. */
export interface Scripts {
	readonly author?: ReadonlyArray<FauxResponseStep>;
	readonly backup?: ReadonlyArray<FauxResponseStep>;
	readonly reviewer?: ReadonlyArray<FauxResponseStep>;
}

/** What a test changes of the product. */
export interface Options {
	readonly scripts?: Scripts;
	/** Default: memory. Give a SQLite storage to close and reopen. */
	readonly storage?: Layer.Layer<Storage.HarnessStorage>;
	/** Default: `REVIEW_POLICY`. */
	readonly review?: Review.Policy.Policy;
	/** Default: `ROUTES`. */
	readonly routes?: RouteTable;
	/** Default: `RESEARCHER_CAP`. */
	readonly researcherCap?: bigint;
	/** The tracer Pi's telemetry is recorded on. Default: Effect's own. */
	readonly tracer?: Tracer.Tracer;
	/** The reviewer check the thread service asks. Default: the composition's own, from its two tables. */
	readonly reviewers?: Layer.Layer<Reviewers.Reviewers>;
	/** How a failed delivery to the outcome sink is tried again. Default: the composition's. */
	readonly outcomes?: Outcomes.Options;
}

/** A reviewer check that lets every thread start: what a product without the composition's check has. */
export const UNCHECKED: Layer.Layer<Reviewers.Reviewers> = Layer.succeed(Reviewers.Reviewers, {
	check: () => Effect.void,
});

/** The scripted providers of one open composition: what a test reads the request counts from. */
export interface Providers {
	readonly author: FauxProviderHandle;
	readonly backup: FauxProviderHandle;
	readonly reviewer: FauxProviderHandle;
}

/** Three scripted providers with their turns queued. The api names are fixed, so stored messages compare. */
export function providers(scripts: Scripts = {}): Providers {
	const lab = (
		model: { readonly provider: string; readonly modelId: string },
		turns: ReadonlyArray<FauxResponseStep>,
	) => {
		const handle = fauxProvider({
			provider: model.provider,
			api: `scripted-${model.provider}`,
			models: [{ id: model.modelId }],
		});
		handle.setResponses([...turns]);
		return handle;
	};
	return {
		author: lab(WRITER, scripts.author ?? []),
		backup: lab(BACKUP, scripts.backup ?? []),
		reviewer: lab(JUDGE, scripts.reviewer ?? []),
	};
}

/** The composition's configuration for this product, on `labs`. */
export function config(state: Outside, labs: Providers, options: Options = {}) {
	return {
		extensions: [
			Extension.make({
				name: "app",
				tools: [Lookup(state), WriteNote(state), Transfer(state)],
			}),
			SearchTools.extension({ maxResults: 3 }),
		],
		guard: { policy: GUARD_POLICY },
		approvals: { tools: ["transfer"], expiresAfter: "1 day" } satisfies Approvals.Policy,
		models: {
			providers: [labs.author.provider, labs.backup.provider, labs.reviewer.provider],
			routes: options.routes ?? ROUTES,
		},
		review: { policy: options.review ?? REVIEW_POLICY, checks: [Cited] },
		subagents: {
			subagents: [Researcher],
			maxDepth: 1,
			maxLive: 2,
			caps: { researcher: options.researcherCap ?? RESEARCHER_CAP },
		},
		swarms: [Covers],
	};
}

/**
 * The services a product provides: its lease, its estimator and the prices of `options.routes`, its two sinks, its
 * inbox, its verifier, telemetry. With `actor`, the lease and the sinks note which Rivet actor's port was asked.
 */
export function ports(state: Outside, options: Pick<Options, "tracer" | "routes"> & { readonly actor?: string } = {}) {
	const actor = options.actor === undefined ? {} : { actor: options.actor };
	const lease = Layer.succeed(Lease, {
		reserve: (estimate, request) =>
			Effect.suspend(() => {
				const { fenced } = state.lease;
				if (fenced !== undefined) {
					state.lease.steps.push({ step: "fenced", reason: fenced });
					return Effect.fail(new LeaseFenced({ reason: fenced }));
				}
				const token = `r${state.lease.steps.filter((step) => step.step === "reserve").length + 1}`;
				state.lease.steps.push({ step: "reserve", token, estimate, request, ...actor });
				return Effect.succeed(token);
			}),
		settle: (token, settlement) =>
			Effect.sync(() => void state.lease.steps.push({ step: "settle", token, settlement })),
	});
	const sink = Layer.succeed(RecordSink, {
		deliver: (batch) =>
			Effect.sync(() => {
				state.delivered.push(batch);
				state.deliveredBy.push(options.actor);
			}),
	});
	const outcomes = Layer.succeed(OutcomeSink, {
		deliver: (event) =>
			Effect.suspend(() => {
				state.told.calls += 1;
				state.told.offered.push(event);
				if (state.told.failing > 0) {
					state.told.failing -= 1;
					return Effect.fail(new OutcomeSinkError({ cause: "scripted" }));
				}
				state.told.events.push(event);
				state.told.recorded.push(state.delivered.flat().map((record) => record.id));
				state.told.by.push(options.actor);
				return Effect.void;
			}),
	});
	const inbox = Layer.succeed(Approvals.Inbox, {
		publish: (request) =>
			Effect.suspend(() => {
				state.shown.push(request);
				return Effect.asVoid(Queue.offer(state.inbox, request));
			}),
	});
	const verifier = Layer.succeed(Review.Citations.Verifier, {
		verify: (citation) =>
			Effect.succeed<Review.Citations.Verification>(
				citation.source === "missing" ? { _tag: "Unresolved" } : { _tag: "Verified" },
			),
	});
	const search = Layer.succeed(SearchProvider, {
		search: (query) =>
			Effect.map(DateTime.now, (retrievedAt) => ({
				provider: "scripted",
				request: { method: "POST", url: "https://search.test/search", body: { query } },
				retrievedAt,
				raw: JSON.stringify({ results: [{ url: "https://example.test/answer", title: "Answer" }] }),
				hits: [{ url: "https://example.test/answer", title: "Answer" }],
				unfetched: [],
			})),
		fetch: () => Effect.die(new Error("not scripted")),
	});
	return Layer.mergeAll(
		lease,
		Estimator.fixed(ESTIMATE),
		Layer.orDie(Layer.unwrap(Effect.map(priceRows(options.routes ?? ROUTES), Prices.layer))),
		sink,
		outcomes,
		inbox,
		verifier,
		search,
		// The adapter takes the tracer of the context its Layer is built in.
		options.tracer === undefined
			? PiTelemetry.layer
			: Layer.provide(PiTelemetry.layer, Layer.succeed(Tracer.Tracer, options.tracer)),
	);
}

/** What an open composition gives a test. */
export type Opened = Layer.Success<ReturnType<typeof open>>;

/**
 * The composition of this product, open: on `labs`, on the storage of `options`, and on the outside `state`, which
 * a later open on the same storage shares. Route events are kept from before the harness opens, so those of work a
 * reopened harness resumes at once are kept too.
 */
export function open(state: Outside, labs: Providers, options: Options = {}) {
	const routed = Layer.effectDiscard(
		Effect.gen(function* () {
			const events = yield* RouteEvents.use((hub) => hub.subscribe);
			yield* Effect.forkScoped(
				Stream.runForEach(events, (event) => Effect.sync(() => void state.routed.push(event))),
			);
		}),
	);
	// Nearest wins: a check a test gives is the one the thread service takes.
	const built = Composition.services(options.outcomes === undefined ? {} : { outcomes: options.outcomes });
	const services = options.reviewers === undefined ? built : Layer.provide(built, options.reviewers);
	const composition = services.pipe(
		Layer.provideMerge(Layer.unwrap(Effect.map(Composition.harness(), (harness) => Harness.layer(harness)))),
		Layer.provideMerge(routed),
		Layer.provideMerge(Composition.layer(config(state, labs, options))),
	);
	return composition.pipe(
		Layer.provide(options.storage ?? Storage.memory),
		Layer.provide(ports(state, options)),
		Layer.orDie,
	);
}

/** The input of a thread of this product: the author's alias, internal content, and a cap no test reaches by chance. */
export function work(thread: string, task: string, tools: ReadonlyArray<string> = ["lookup"]): Threads.Work {
	return { thread, task, model: AUTHOR, grant: { tools: [...tools], classification: "internal" }, cap: 1_000_000n };
}

/** The name of the foreground subagent tool, for a grant. */
export const SUBAGENT = Subagents.TOOLS.foreground;

/**
 * The route events kept so far, once there are `count` of them: the router publishes an event before the response
 * reaches its caller, and the fiber that keeps them runs after it.
 */
export function routed(state: Outside, count: number): Effect.Effect<ReadonlyArray<RouteEvent>> {
	return Effect.gen(function* () {
		while (state.routed.length < count) yield* Effect.sleep("1 millis");
		return state.routed;
	});
}

/**
 * The events the outcome sink took so far, once `ready` says so: a thread's courier delivers after the commit that
 * ends the thread's work, so a test that reads the sink right after an outcome waits for it.
 */
export function told(
	state: Outside,
	ready: (events: ReadonlyArray<OutcomeEvent>) => boolean,
): Effect.Effect<ReadonlyArray<OutcomeEvent>> {
	return Effect.gen(function* () {
		while (!ready(state.told.events)) yield* Effect.sleep("1 millis");
		return [...state.told.events];
	});
}

/** For `told`: the newest event says that the thread reached the outcome `tag`. */
export function reached(tag: Outcome["_tag"]): (events: ReadonlyArray<OutcomeEvent>) => boolean {
	return (events) => {
		const newest = events.at(-1);
		return newest?._tag === "Reached" && newest.outcome._tag === tag;
	};
}

/** What an event says, without its id and without what its thread took: its tag, and the outcome it tells. */
export function said(event: OutcomeEvent): string {
	return event._tag === "Started" ? "Started" : event.outcome._tag;
}

/** Runs `program` on the composition of this product, opened for it and closed after it. */
export function run<A, E>(
	state: Outside,
	labs: Providers,
	program: Effect.Effect<A, E, Opened | Scope.Scope>,
	options: Options = {},
): Promise<A> {
	return Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(open(state, labs, options))));
}

/** What a record says, without what differs from run to run: its ids, its times, its token counts. */
export function shape(record: Records.Record): Record<string, unknown> {
	switch (record._tag) {
		case "Message":
			return { _tag: record._tag, role: record.role, entryKind: record.entryKind, text: record.text };
		case "ModelCall": {
			const { provider, model, stopReason, error } = record;
			return { _tag: record._tag, provider, model, stopReason, error };
		}
		case "ToolCallRequested":
			return { _tag: record._tag, name: record.name, callId: record.callId, arguments: record.arguments };
		case "ToolCallResult": {
			const { name, callId, isError, codes, text } = record;
			return { _tag: record._tag, name, callId, isError, codes, text };
		}
		case "Entry":
			return { _tag: record._tag, kind: record.kind };
		case "ModelCallRequested":
			return { _tag: record._tag };
	}
}

/** The records derived from committed entries, each id once, in delivery order. */
export function committed(state: Outside): ReadonlyArray<Exclude<Records.Record, Records.ModelCallRequested>> {
	return records(state).flatMap((record) => (record._tag === "ModelCallRequested" ? [] : [record]));
}

/** The advisory records, each id once, in delivery order. */
export function advisory(state: Outside): ReadonlyArray<Records.ModelCallRequested> {
	return records(state).flatMap((record) => (record._tag === "ModelCallRequested" ? [record] : []));
}
