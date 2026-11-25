// The router as a pi-ai provider: its models are the aliases, and a pi-ai request to one runs the router.

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type Provider,
	type ProviderAuth,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ResponseEvent } from "@gunta/pi-ai-effect";
import { Cause, Clock, Effect, Exit, FiberSet, Option, type Scope } from "effect";
import type { RouterError } from "./errors.ts";
import { noUsage } from "./price.ts";
import type { Alias, ValidRouteTable } from "./route-table.ts";

/** What the provider is built from. */
export interface ProviderOptions {
	/** The provider id the alias models are looked up under. */
	readonly id: string;
	/** Display name. Default: `id`. */
	readonly name?: string;
	readonly table: ValidRouteTable;
	/**
	 * Runs one request to `alias` with pi-ai's request options as the caller gave them. `emit` takes the events
	 * of the response up to and including `done`; a failure is how the request ends in pi-ai's `error` event.
	 */
	readonly run: (
		alias: string,
		transcript: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		emit: (event: ResponseEvent) => Effect.Effect<void>,
	) => Effect.Effect<AssistantMessage, RouterError>;
}

/** The smallest valid pi-ai auth: always configured, resolving to no key. Each route's provider has its own. */
const KEYLESS: ProviderAuth = { apiKey: { name: "Route table", resolve: () => Promise.resolve({ auth: {} }) } };

/**
 * A pi-ai provider (built with pi-ai's `createProvider`) that lists one chat model per alias. Each request runs
 * `options.run` in a fiber of the caller's scope: aborting the request's signal interrupts the fiber, and closing
 * the scope interrupts every open request. A request that fails ends in pi-ai's `error` event: with the failed
 * route's own message when a route answered, else with an empty message of the alias model whose `errorMessage`
 * is the typed error's text. An attempt that could not be settled ends it with that route's message under the typed
 * error's text.
 */
export function make(options: ProviderOptions): Effect.Effect<Provider, never, Scope.Scope> {
	return Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		const runFork = yield* FiberSet.makeRuntime<never, AssistantMessage, RouterError>();
		const request = (
			model: Model<Api>,
			transcript: TranscriptContext,
			requestOptions?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const events = createAssistantMessageEventStream();
			let partial: AssistantMessage | undefined;
			const emit = (event: ResponseEvent): Effect.Effect<void> =>
				Effect.sync(() => {
					if (event.type !== "done") partial = event.partial;
					events.push(event);
				});
			// A fiber runs up to its first wait before it sees its signal, so a request that arrives aborted is
			// interrupted here: none of it runs.
			const run = requestOptions?.signal?.aborted
				? Effect.interrupt
				: options.run(model.id, transcript, requestOptions, emit);
			// The observer also runs for a request that never started (a closed scope), so the pi-ai stream
			// always ends.
			runFork(run, { signal: requestOptions?.signal }).addObserver((exit) => {
				if (Exit.isFailure(exit)) {
					events.push(errorEvent(exit.cause, partial ?? blank(model, clock.currentTimeMillisUnsafe())));
				}
				events.end();
			});
			return events;
		};
		return createProvider({
			id: options.id,
			name: options.name,
			auth: KEYLESS,
			models: options.table.aliases.map(({ entry, models }) => aliasModel(options.id, entry, models)),
			// A route's model may have any API, so the options of one API cannot be passed on: both entry points
			// take pi-ai's provider-neutral options.
			api: { stream: request, streamSimple: request },
		});
	});
}

/** The `api` of every alias model. */
const API = "pi-router";

/**
 * The pi-ai model of an alias, from the models of its routes: what every route can do. Pi compacts against the
 * smallest context window and offers only what each route reads. The catalog price is the first route's; the
 * price a response is charged at is the route's, in its route event.
 */
function aliasModel(provider: string, alias: Alias, routes: ReadonlyArray<Model<Api>>): Model<Api> {
	const [first] = routes;
	return {
		id: alias.alias,
		name: alias.name ?? alias.alias,
		api: API,
		provider,
		// pi-ai requires a base URL; nothing reads this one, each route's provider knows where to go.
		baseUrl: `pi-router://${provider}`,
		reasoning: routes.every((model) => model.reasoning),
		input: first.input.filter((modality) => routes.every((model) => model.input.includes(modality))),
		cost: first.cost,
		contextWindow: Math.min(...routes.map((model) => model.contextWindow)),
		maxTokens: Math.min(...routes.map((model) => model.maxTokens)),
	};
}

/** An empty message of the alias model, for a request that ended before any route had output. */
function blank(model: Model<Api>, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: noUsage(),
		stopReason: "pending",
		timestamp,
	};
}

/**
 * How a failed request ends in pi-ai. `soFar` is the response as the caller last saw it, or the empty message of
 * the alias model: an interruption and a defect end it there, keeping its content and usage.
 */
function errorEvent(
	cause: Cause.Cause<RouterError>,
	soFar: AssistantMessage,
): Extract<AssistantMessageEvent, { type: "error" }> {
	const ended = (reason: "error" | "aborted", errorMessage: string) =>
		({ type: "error", reason, error: { ...soFar, stopReason: reason, errorMessage } }) as const;
	if (Cause.hasInterruptsOnly(cause)) return ended("aborted", "Request was aborted");
	const failure = Cause.findErrorOption(cause);
	if (Option.isNone(failure)) {
		const defect = Cause.squash(cause);
		return ended("error", defect instanceof Error ? defect.message : String(defect));
	}
	const error = failure.value;
	// The route's own message goes to Pi unchanged, so Pi's retry and overflow rules read pi-ai's own text.
	if (error._tag === "ModelRequestError") return { type: "error", reason: error.reason, error: error.response };
	if (error._tag === "RoutesExhausted" && error.response !== undefined) {
		return { type: "error", reason: "error", error: error.response };
	}
	if (error._tag === "AttemptUnsettled") {
		// The attempt's own message, so what wraps the router settles its usage at its route's price; with the router's
		// text, because the provider's was retryable and Pi must not send this request again.
		return {
			type: "error",
			reason: "error",
			error: { ...error.response, stopReason: "error", errorMessage: error.message },
		};
	}
	return ended("error", error.message);
}
