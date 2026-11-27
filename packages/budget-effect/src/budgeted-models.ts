// The model boundary: a `Models` whose every provider request reserves on the lease first and settles after.

import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type ClassifierResult,
	createAssistantMessageEventStream,
	type ErrorReason,
	emptyUsage,
	type Model,
	ModelId,
	Models,
	type MutableModels,
	type Context as PiContext,
	ProviderId,
	requestKey,
	type StreamOptions,
	type Usage,
	SessionId,
	withoutParentSpan,
} from "@effectified/pi-ai";
import { Cause, Clock, Context, Effect, Exit, Fiber, FiberSet, Layer, Match, Option, Predicate, Stream } from "effect";
import { identity } from "effect/Function";
import { type Budget, gather, payerOf, refuse, reserve, settle } from "./budget.ts";
import { BudgetEvents } from "./budget-events.ts";
import type { Estimator } from "./estimator.ts";
import type { BudgetRequest, Lease, Outcome } from "./lease.ts";
import { cost, type ModelPrice, type Prices, type PricesService, tokensOf } from "./price-table.ts";
import { type Refusal, refusalText, ShareExhausted } from "./refusal.ts";
import { counted, Shares, type SharesService } from "./shares.ts";
import { make as makeSpend, Spend } from "./spend.ts";

/**
 * Wraps the `Models` of the context: the `Models` it provides sends a request only after the `Lease` reserved the
 * `Estimator`'s amount for it, and tells the lease what the request cost when it ended, at the `Prices`. A harness
 * opened on it cannot make an unreserved request, whoever makes it: a generation, a compaction, a tool. Also
 * provides `BudgetEvents`, and `Spend` for usage that reaches this budget as no response.
 *
 * - **Covered:** `stream`, `streamSimple`, `complete`, `completeSimple`, `streamDeferred`, `fetchDeferred`,
 *   `generateImages` and `classify`. Everything else is the wrapped `Models`' own, providers included.
 * - **Refused before anything is sent**, as a response that ends in pi-ai's `error` and that Pi does not retry: a
 *   model the table has no price for (`PriceMissing`), and a lease that fails the reservation (`LeaseFenced`).
 * - **Settled exactly once** for every reservation: with the usage the provider reported, zeros when it reported
 *   none, and whether the request returned, failed or was aborted. Interrupting a request (its `signal`, or the
 *   Layer's scope closing) aborts the provider request and settles it as aborted.
 * - **Priced** at the model the response names when the table lists it (a router's response names the route that
 *   served), else at the model that was asked. A request cut off before its response ended is priced the same way,
 *   by the model that what had arrived of it names.
 * - **Keyed** by what it asks: a chat request with a session is reserved with `requestKey`, the same for every send
 *   of one request, so the lease can tell a request sent again after a crash from a new one.
 */
export const layer: Layer.Layer<Models | BudgetEvents | Spend, never, Models | Lease | Estimator | Prices> =
	Layer.provideMerge(Layer.effectContext(Effect.suspend(() => make(undefined))), BudgetEvents.layer);

/**
 * `layer`, with a cap for single conversations: a request that carries the provider session of a conversation with
 * a share (see `Shares`) is refused with `ShareExhausted` once the conversation has settled its cap, and what it
 * settles is added to its share. Every request that names a session waits until `Shares.attach` has run.
 */
export const layerWithShares: Layer.Layer<
	Models | BudgetEvents | Spend,
	never,
	Models | Lease | Estimator | Prices | Shares
> = Layer.provideMerge(Layer.effectContext(Shares.use((shares) => make(shares))), BudgetEvents.layer);

/**
 * Builds the budgeted `Models` over the `Models` of the context, and the `Spend` of the same budget. Requests run in
 * fibers of the caller's scope.
 */
const make = Effect.fn("BudgetedModels.make")(function* (shares: SharesService | undefined) {
	const inner = yield* Models;
	const budget = yield* gather(shares);
	const clock = yield* Clock.Clock;
	// A request's fiber never fails: a refusal becomes the caller's error result inside it (`charged`).
	const runFork = yield* FiberSet.makeRuntime<never, unknown, never>();
	// pi-ai's one-shot requests answer with a promise; it only awaits a fiber of the set, so it never rejects.
	// pi-ai keeps the budgeted `Models` and calls it later: a request's spans start their own trace.
	const services = yield* Effect.map(Effect.context<never>(), withoutParentSpan);
	const runPromise = Effect.runPromiseWith(services);

	/**
	 * One budgeted chat response as the pi-ai stream a caller of `Models` expects. `context` is what a chat request
	 * asks; a deferred response is fetched by its handle and has none.
	 */
	const respond = (
		kind: "chat" | "deferred",
		model: Model<Api>,
		context: PiContext | undefined,
		options: Pick<StreamOptions, "signal" | "sessionId"> | undefined,
		start: (signal: AbortSignal) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const out = createAssistantMessageEventStream();
		let partial: AssistantMessage | undefined;
		const events = Stream.tap(responseEvents(start), (event) =>
			// Per event of the response: a plain check, no span.
			Effect.sync(() => {
				if (event.type === "done" || event.type === "error") return;
				partial = event.partial;
				out.push(event);
			}),
		);
		const send = Effect.flatMap(Stream.runLast(events), sentOf);
		const ended: Ended<TerminalEvent> = (reason, errorMessage) => ({
			type: "error",
			reason,
			error: { ...(partial ?? blank(model, clock.currentTimeMillisUnsafe())), stopReason: reason, errorMessage },
		});
		// pi-ai's session id is a plain string: branded where it enters the budget.
		const session = options?.sessionId === undefined ? undefined : SessionId.make(options.sessionId);
		const asked: Asked = { kind, model, session, context, signal: options?.signal };
		runFork(
			charged(budget, asked, send, () => partial, ended),
			{ signal: options?.signal },
		).addObserver((exit) => {
			out.push(Exit.isSuccess(exit) ? exit.value : failed(exit.cause, ended));
			out.end();
		});
		return out;
	};

	/** One budgeted one-shot request (images, a classifier), which pi-ai answers with a result that never rejects. */
	const answer = <R extends OneShotResult>(
		kind: "images" | "classifier",
		model: AnyModel,
		signal: AbortSignal | undefined,
		call: (signal: AbortSignal) => Promise<R>,
		ended: Ended<R>,
	): Promise<R> => {
		const send = Effect.map(Effect.promise(call), (result): Sent<R> => ({
			value: result,
			answer: result,
			outcome: result.stopReason === "stop" ? "returned" : outcomeOf(result.stopReason),
		}));
		const asked: Asked = { kind, model, session: undefined, context: undefined, signal };
		const fiber = runFork(
			charged(budget, asked, send, () => undefined, ended),
			{ signal },
		);
		return runPromise(
			Effect.map(Fiber.await(fiber), (exit) => (Exit.isSuccess(exit) ? exit.value : failed(exit.cause, ended))),
		);
	};

	const stream: MutableModels["stream"] = (model, context, options) =>
		respond("chat", model, context, options, (signal) => {
			// Checked alone: the cast below cannot see whether pi-ai still names its abort signal `signal`.
			const abort = { signal } satisfies Pick<StreamOptions, "signal">;
			// TypeScript cannot resolve the conditional type of one API's options here; the spread only replaces `signal`.
			return inner.stream(model, context, { ...options, ...abort } as typeof options);
		});
	const streamSimple: MutableModels["streamSimple"] = (model, context, options) =>
		respond("chat", model, context, options, (signal) => inner.streamSimple(model, context, { ...options, signal }));
	const streamDeferred: MutableModels["streamDeferred"] = (model, handle, options) =>
		respond("deferred", model, undefined, options, (signal) =>
			inner.streamDeferred(model, handle, { ...options, signal }),
		);

	// The members `MEMBERS` budgets, each replacing the wrapped one: the wrapped `Models` calls its own, never these.
	const budgetedMembers: Pick<MutableModels, Budgeted> = {
		stream,
		streamSimple,
		streamDeferred,
		complete: (model, context, options) => stream(model, context, options).result(),
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
		fetchDeferred: (model, handle, options) => streamDeferred(model, handle, options).result(),
		generateImages: (model, context, options) =>
			answer(
				"images",
				model,
				options?.signal,
				(signal) => inner.generateImages(model, context, { ...options, signal }),
				(stopReason, errorMessage) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason,
					errorMessage,
					timestamp: clock.currentTimeMillisUnsafe(),
				}),
			),
		classify: (model, context, options) =>
			answer(
				"classifier",
				model,
				options?.signal,
				(signal) => inner.classify(model, context, { ...options, signal }),
				(stopReason, errorMessage) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: {},
					stopReason,
					errorMessage,
					timestamp: clock.currentTimeMillisUnsafe(),
				}),
			),
	};
	// The members `MEMBERS` forwards: catalogs, credentials and the providers themselves.
	const forwardedMembers: Pick<MutableModels, Forwarded> = {
		getProviders: inner.getProviders.bind(inner),
		getProvider: inner.getProvider.bind(inner),
		getModels: inner.getModels.bind(inner),
		getModel: inner.getModel.bind(inner),
		getModelsOfType: inner.getModelsOfType.bind(inner),
		getModelOfType: inner.getModelOfType.bind(inner),
		getAllModels: inner.getAllModels.bind(inner),
		refresh: inner.refresh.bind(inner),
		checkAuth: inner.checkAuth.bind(inner),
		getAvailable: inner.getAvailable.bind(inner),
		getAvailableOfType: inner.getAvailableOfType.bind(inner),
		getAllAvailable: inner.getAllAvailable.bind(inner),
		getAuth: inner.getAuth.bind(inner),
		login: inner.login.bind(inner),
		logout: inner.logout.bind(inner),
		setProvider: inner.setProvider.bind(inner),
		deleteProvider: inner.deleteProvider.bind(inner),
		clearProviders: inner.clearProviders.bind(inner),
		cancelDeferred: inner.cancelDeferred.bind(inner),
	};
	const models = Models.of({ ...forwardedMembers, ...budgetedMembers });
	const spend = yield* makeSpend(budget);
	return Context.make(Models, models).pipe(Context.add(Spend, spend));
});

/**
 * What the budgeted `Models` does with each member of pi-ai's: `budgeted`, a member that sends a provider request and
 * is reserved and settled; `forwarded`, the wrapped `Models`' own. `cancelDeferred` asks for no generation, so it
 * reserves nothing. A member pi-ai adds fails to compile here until it is decided, so a new paid request is never
 * forwarded unbudgeted by default.
 */
const MEMBERS = {
	stream: "budgeted",
	streamSimple: "budgeted",
	complete: "budgeted",
	completeSimple: "budgeted",
	streamDeferred: "budgeted",
	fetchDeferred: "budgeted",
	generateImages: "budgeted",
	classify: "budgeted",
	cancelDeferred: "forwarded",
	getProviders: "forwarded",
	getProvider: "forwarded",
	getModels: "forwarded",
	getModel: "forwarded",
	getModelsOfType: "forwarded",
	getModelOfType: "forwarded",
	getAllModels: "forwarded",
	refresh: "forwarded",
	checkAuth: "forwarded",
	getAvailable: "forwarded",
	getAvailableOfType: "forwarded",
	getAllAvailable: "forwarded",
	getAuth: "forwarded",
	login: "forwarded",
	logout: "forwarded",
	setProvider: "forwarded",
	deleteProvider: "forwarded",
	clearProviders: "forwarded",
} as const satisfies Record<keyof MutableModels, "budgeted" | "forwarded">;

/** The members of `Models` that `MEMBERS` gives `decision`. */
type Decided<Decision> = {
	[K in keyof typeof MEMBERS]: (typeof MEMBERS)[K] extends Decision ? K : never;
}[keyof typeof MEMBERS];

/** The members of `Models` this budget reserves and settles. */
type Budgeted = Decided<"budgeted">;

/** The members of `Models` that are the wrapped one's own. */
type Forwarded = Decided<"forwarded">;

/** The last event of a pi-ai response. */
type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

/** What pi-ai's one-shot results have in common. */
interface OneShotResult {
	readonly provider: string;
	readonly model: string;
	readonly usage?: Usage;
	readonly stopReason: AssistantImages["stopReason"] | ClassifierResult["stopReason"];
}

/** Who answered a request and what it used, as the provider's adapter reported it. */
interface Answer {
	readonly provider: string;
	readonly model: string;
	readonly usage?: Usage;
}

/** A request the provider answered, one way or another. */
interface Sent<A> {
	/** What the caller gets. */
	readonly value: A;
	readonly answer: Answer;
	readonly outcome: Outcome;
}

/** What a caller gets for a request that did not get the provider's own last word: an error result of its kind. */
type Ended<A> = (reason: ErrorReason, errorMessage: string) => A;

/** What one request asks, as `Models` was called. */
interface Asked {
	readonly kind: BudgetRequest["kind"];
	readonly model: AnyModel;
	readonly session: SessionId | undefined;
	readonly context: PiContext | undefined;
	readonly signal: AbortSignal | undefined;
}

/**
 * The events of the pi-ai response `start` begins, `done` or `error` last. Closing the Stream's scope, for any
 * reason, aborts `signal`. pi-ai's event streams never reject: every failure is an `error` event, so a rejection is
 * a defect.
 */
function responseEvents(
	start: (signal: AbortSignal) => AssistantMessageEventStream,
): Stream.Stream<AssistantMessageEvent> {
	return Stream.unwrap(
		Effect.map(Effect.abortSignal, (signal) => Stream.orDie(Stream.fromAsyncIterable(start(signal), identity))),
	);
}

/** The request a response's last event says was answered: returned with `done`, failed or aborted with `error`. */
function sentOf(last: Option.Option<AssistantMessageEvent>): Effect.Effect<Sent<TerminalEvent>> {
	return Option.match(last, {
		onNone: () => unterminated,
		onSome: (event) =>
			Match.value(event).pipe(
				Match.when({ type: "done" }, (done) =>
					Effect.succeed<Sent<TerminalEvent>>({ value: done, answer: done.message, outcome: "returned" }),
				),
				Match.when({ type: "error" }, (error) =>
					Effect.succeed<Sent<TerminalEvent>>({
						value: error,
						answer: error.error,
						outcome: outcomeOf(error.reason),
					}),
				),
				Match.orElse(() => unterminated),
			),
	});
}

/** pi-ai's protocol ends every response in `done` or `error`; anything else is a broken provider. */
const unterminated = Effect.die(new Error("pi-ai ended a response without a done or error event"));

/** `failed` for an error of the provider, `aborted` when it gave the request up. */
function outcomeOf(reason: ErrorReason): Outcome {
	return OUTCOMES[reason];
}

// Typed by pi-ai's reasons, so a reason pi-ai adds fails to compile here until it is decided.
const OUTCOMES = { error: "failed", aborted: "aborted" } as const satisfies Record<ErrorReason, Outcome>;

/** An empty message of `model`, for a request that ended before the provider had output. */
function blank(model: Model<Api>, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp,
	};
}

/**
 * `budgeted`, with a refusal as what its caller gets: an error result with the refusal's text, which Pi does not
 * retry. It fails only by an interruption or a defect.
 */
function charged<A>(
	budget: Budget,
	asked: Asked,
	send: Effect.Effect<Sent<A>>,
	soFar: () => Answer | undefined,
	ended: Ended<A>,
): Effect.Effect<A> {
	return Effect.catch(budgeted(budget, asked, send, soFar), (refusal) =>
		Effect.map(refusalText(refusal), (text) => ended("error", text)),
	);
}

/**
 * Budgets one request: refuses it, or reserves, runs `send` and settles. It fails only with a refusal, and then
 * nothing was reserved and `send` never ran. From the reservation to the settlement it cannot be interrupted, except
 * inside `send`: an interruption there settles the request as aborted with `soFar`, what had arrived of the response
 * until then, and a defect of `send` settles it as failed.
 */
const budgeted = Effect.fn("BudgetedModels.budgeted")(function* <A>(
	budget: Budget,
	asked: Asked,
	send: Effect.Effect<Sent<A>>,
	soFar: () => Answer | undefined,
): Effect.fn.Return<A, Refusal> {
	// A fiber runs up to its first wait before it sees its signal, and a request that arrives aborted must not reserve.
	if (asked.signal?.aborted === true) return yield* Effect.interrupt;
	const { prices } = budget;
	const payer = yield* payerOf(budget, asked.session);
	const { share } = payer;
	const key =
		asked.session === undefined || asked.context === undefined
			? undefined
			: yield* requestKey(asked.session, asked.context);
	const request: BudgetRequest = {
		kind: asked.kind,
		// pi-ai's ids are plain strings: branded where they enter the budget.
		provider: ProviderId.make(asked.model.provider),
		model: ModelId.make(asked.model.id),
		...(asked.session === undefined ? {} : { session: asked.session }),
		...(share === undefined ? {} : { conversation: share.conversation }),
		...(key === undefined ? {} : { requestKey: key }),
	};
	const price = yield* Effect.catch(prices.priceOf(request.provider, request.model), (missing) =>
		refuse(budget, request, missing),
	);
	if (share?.cap !== undefined && counted(share) >= share.cap) {
		const { conversation, cap } = share;
		return yield* refuse(budget, request, ShareExhausted.make({ conversation, cap, settled: counted(share) }));
	}
	const estimate = yield* budget.estimator.estimate(request);
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const reserved = yield* reserve(budget, request, estimate);
			const exit = yield* Effect.exit(restore(send));
			const answer = Exit.isSuccess(exit) ? exit.value.answer : soFar();
			const usage = tokensOf(answer?.usage);
			const outcome = Exit.match(exit, {
				onSuccess: (sent) => sent.outcome,
				onFailure: (cause): Outcome => (Cause.hasInterruptsOnly(cause) ? "aborted" : "failed"),
			});
			const settledAt = yield* priceOfAnswer(prices, answer, price);
			yield* settle(budget, reserved, payer, { usage, cost: cost(settledAt, usage), outcome });
			const sent = yield* exit;
			return sent.value;
		}),
	);
});

/**
 * The price a response is settled at: of the model it names when the table lists it, else of the model asked.
 * `answer` is the response, or what had arrived of one that was cut off; undefined when nothing had.
 */
const priceOfAnswer = Effect.fn("BudgetedModels.priceOfAnswer")(function* (
	prices: PricesService,
	answer: Answer | undefined,
	asked: ModelPrice,
) {
	if (answer === undefined) return asked;
	const named = prices.priceOf(ProviderId.make(answer.provider), ModelId.make(answer.model));
	return yield* Effect.orElseSucceed(named, () => asked);
});

/**
 * How a request that did not get the provider's own last word ends for its caller when its fiber did not answer:
 * an interruption as aborted, a defect with its message. A refusal never gets here (`charged`).
 */
function failed<A>(cause: Cause.Cause<never>, ended: Ended<A>): A {
	if (Cause.hasInterruptsOnly(cause)) return ended("aborted", "Request was aborted");
	const defect = Cause.squash(cause);
	return ended("error", Predicate.isError(defect) ? defect.message : String(defect));
}
