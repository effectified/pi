// The model boundary: a `Models` whose every provider request reserves on the lease first and settles after.

import {
	type AnyModel,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type MutableModels,
	type Context as PiContext,
	type StreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { Models, requestKey } from "@gunta/pi-ai-effect";
import { Cause, Clock, Context, Effect, Exit, FiberSet, Layer, Option, Stream } from "effect";
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
const make = Effect.fnUntraced(function* (shares: SharesService | undefined) {
	const inner = yield* Models;
	const budget = yield* gather(shares);
	const clock = yield* Clock.Clock;
	const runFork = yield* FiberSet.makeRuntime<never, unknown, Refusal>();

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
		const send = Effect.flatMap(
			Stream.runLast(
				Stream.tap(responseEvents(start), (event) =>
					Effect.sync(() => {
						if (event.type === "done" || event.type === "error") return;
						partial = event.partial;
						out.push(event);
					}),
				),
			),
			(last): Effect.Effect<Sent<TerminalEvent>> => {
				const terminal = Option.getOrUndefined(last);
				if (terminal?.type === "done") {
					return Effect.succeed({ value: terminal, answer: terminal.message, outcome: "returned" });
				}
				if (terminal?.type === "error") {
					return Effect.succeed({ value: terminal, answer: terminal.error, outcome: outcomeOf(terminal.reason) });
				}
				// pi-ai's protocol ends every response in `done` or `error`; anything else is a broken provider.
				return Effect.die(new Error("pi-ai ended a response without a done or error event"));
			},
		);
		const request = { kind, model, session: options?.sessionId, context };
		const ended = (reason: "error" | "aborted", errorMessage: string): TerminalEvent => ({
			type: "error",
			reason,
			error: { ...(partial ?? blank(model, clock.currentTimeMillisUnsafe())), stopReason: reason, errorMessage },
		});
		runFork(
			unlessAborted(
				options?.signal,
				budgeted(budget, request, send, () => partial),
			),
			{
				signal: options?.signal,
			},
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
		ended: (reason: "error" | "aborted", errorMessage: string) => R,
	): Promise<R> => {
		const send = Effect.map(
			Effect.promise(call),
			(result): Sent<R> => ({
				value: result,
				answer: result,
				outcome: result.stopReason === "stop" ? "returned" : outcomeOf(result.stopReason),
			}),
		);
		return new Promise((resolve) => {
			const request = { kind, model, session: undefined, context: undefined };
			runFork(
				unlessAborted(
					signal,
					budgeted(budget, request, send, () => undefined),
				),
				{ signal },
			).addObserver((exit) => resolve(Exit.isSuccess(exit) ? exit.value : failed(exit.cause, ended)));
		});
	};

	const stream: MutableModels["stream"] = (model, context, options) =>
		// TypeScript cannot resolve the conditional type of one API's options here; the spread only replaces `signal`.
		respond("chat", model, context, options, (signal) =>
			inner.stream(model, context, { ...options, signal } as typeof options),
		);
	const streamSimple: MutableModels["streamSimple"] = (model, context, options) =>
		respond("chat", model, context, options, (signal) => inner.streamSimple(model, context, { ...options, signal }));
	const streamDeferred: MutableModels["streamDeferred"] = (model, handle, options) =>
		respond("deferred", model, undefined, options, (signal) =>
			inner.streamDeferred(model, handle, { ...options, signal }),
		);

	// The wrapped `Models` does everything that is not a provider request: catalogs, credentials and the providers
	// themselves. Its request methods are replaced one by one, because it calls its own, never these.
	const models = Models.of({
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
		// Cancels a response the provider has not finished: it asks for no generation, so it reserves nothing.
		cancelDeferred: inner.cancelDeferred.bind(inner),
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
	});
	return Context.make(Models, models).pipe(Context.add(Spend, yield* makeSpend(budget)));
});

/** The last event of a pi-ai response. */
type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

/** What pi-ai's one-shot results have in common. */
interface OneShotResult {
	readonly provider: string;
	readonly model: string;
	readonly usage?: Usage;
	readonly stopReason: "stop" | "error" | "aborted";
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

/**
 * The events of the pi-ai response `start` begins, `done` or `error` last. Closing the Stream's scope, for any
 * reason, aborts `signal`. pi-ai's event streams never reject: every failure is an `error` event, so a rejection is
 * a defect.
 */
function responseEvents(
	start: (signal: AbortSignal) => AssistantMessageEventStream,
): Stream.Stream<AssistantMessageEvent> {
	return Stream.unwrap(
		Effect.map(
			Effect.acquireRelease(
				Effect.sync(() => new AbortController()),
				(controller) => Effect.sync(() => controller.abort()),
			),
			(controller) => Stream.orDie(Stream.fromAsyncIterable(start(controller.signal), (cause) => cause)),
		),
	);
}

/** `failed` for an error of the provider, `aborted` when it gave the request up. */
function outcomeOf(reason: "error" | "aborted"): Outcome {
	return reason === "aborted" ? "aborted" : "failed";
}

/** An empty message of `model`, for a request that ended before the provider had output. */
function blank(model: Model<Api>, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp,
	};
}

/**
 * `effect`, or an interruption when `signal` is aborted already: a fiber runs up to its first wait before it sees its
 * signal, and a request that arrives aborted must not reserve.
 */
function unlessAborted<A, E>(signal: AbortSignal | undefined, effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
	return signal?.aborted === true ? Effect.interrupt : effect;
}

/**
 * Budgets one request: refuses it, or reserves, runs `send` and settles. It fails only with a refusal, and then
 * nothing was reserved and `send` never ran. From the reservation to the settlement it cannot be interrupted, except
 * inside `send`: an interruption there settles the request as aborted with `soFar`, what had arrived of the response
 * until then, and a defect of `send` settles it as failed.
 */
const budgeted = Effect.fnUntraced(function* <A>(
	budget: Budget,
	asked: {
		readonly kind: BudgetRequest["kind"];
		readonly model: AnyModel;
		readonly session: string | undefined;
		readonly context: PiContext | undefined;
	},
	send: Effect.Effect<Sent<A>>,
	soFar: () => Answer | undefined,
): Effect.fn.Return<A, Refusal> {
	const { prices } = budget;
	const payer = yield* payerOf(budget, asked.session);
	const { share } = payer;
	const key =
		asked.session === undefined || asked.context === undefined
			? undefined
			: yield* requestKey(asked.session, asked.context);
	const request: BudgetRequest = {
		kind: asked.kind,
		provider: asked.model.provider,
		model: asked.model.id,
		...(asked.session === undefined ? {} : { session: asked.session }),
		...(share === undefined ? {} : { conversation: share.conversation }),
		...(key === undefined ? {} : { requestKey: key }),
	};
	const price = yield* Effect.catch(prices.priceOf(request.provider, request.model), (missing) =>
		refuse(budget, request, missing),
	);
	if (share?.cap !== undefined && counted(share) >= share.cap) {
		const { conversation, cap } = share;
		return yield* refuse(budget, request, new ShareExhausted({ conversation, cap, settled: counted(share) }));
	}
	const estimate = yield* budget.estimator.estimate(request);
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const reserved = yield* reserve(budget, request, estimate);
			const exit = yield* Effect.exit(restore(send));
			const answer = Exit.isSuccess(exit) ? exit.value.answer : soFar();
			const usage = tokensOf(answer?.usage);
			const outcome = Exit.isSuccess(exit)
				? exit.value.outcome
				: Cause.hasInterruptsOnly(exit.cause)
					? "aborted"
					: "failed";
			const settlement = { usage, cost: cost(yield* priceOfAnswer(prices, answer, price), usage), outcome };
			yield* settle(budget, reserved, payer, settlement);
			return (yield* exit).value;
		}),
	);
});

/**
 * The price a response is settled at: of the model it names when the table lists it, else of the model asked.
 * `answer` is the response, or what had arrived of one that was cut off; undefined when nothing had.
 */
function priceOfAnswer(
	prices: PricesService,
	answer: Answer | undefined,
	asked: ModelPrice,
): Effect.Effect<ModelPrice> {
	return answer === undefined
		? Effect.succeed(asked)
		: Effect.orElseSucceed(prices.priceOf(answer.provider, answer.model), () => asked);
}

/**
 * How a request that did not get the provider's own last word ends for its caller: a refusal with its text, which
 * Pi does not retry; an interruption as aborted; a defect with its message.
 */
function failed<A>(cause: Cause.Cause<Refusal>, ended: (reason: "error" | "aborted", errorMessage: string) => A): A {
	if (Cause.hasInterruptsOnly(cause)) return ended("aborted", "Request was aborted");
	const refusal = Cause.findErrorOption(cause);
	if (Option.isSome(refusal)) return ended("error", refusalText(refusal.value));
	const defect = Cause.squash(cause);
	return ended("error", defect instanceof Error ? defect.message : String(defect));
}
