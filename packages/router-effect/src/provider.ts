// The router as a pi-ai provider: its models are the aliases, and a pi-ai request to one runs the router.

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	getSupportedThinkingLevels,
	type Model,
	type Provider,
	type ProviderAuth,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { type ErrorReason, emptyUsage, type ResponseEvent } from "@gunta/pi-ai-effect";
import { Cause, Clock, Effect, Exit, FiberSet, Option, type Scope } from "effect";
import type { RouterError } from "./errors.ts";
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
 * What the alias model takes of each field of pi-ai's chat model. `alias`: the alias's own. `combined`: from the
 * models of its routes. `default`: left out, so pi-ai's default holds (a chat model). `dropped`: left out, because a
 * route's request is made with the route's own model, which has its own; no request is made with the alias model.
 * Pi Durable reads `inputLimits` of a conversation's model to resize the images its `read` tool returns, so under an
 * alias it resizes with its defaults. A field pi-ai adds fails to compile here until it is decided.
 */
const ALIAS_FIELDS = {
	id: "alias",
	name: "alias",
	api: "alias",
	provider: "alias",
	baseUrl: "alias",
	type: "default",
	reasoning: "combined",
	thinkingLevelMap: "combined",
	input: "combined",
	cost: "combined",
	contextWindow: "combined",
	maxTokens: "combined",
	inputLimits: "dropped",
	headers: "dropped",
	promptCache: "dropped",
	samplingParams: "dropped",
	samplingParamsByThinkingLevel: "dropped",
	compat: "dropped",
} as const satisfies Record<keyof Model<Api>, "alias" | "combined" | "default" | "dropped">;

/** The fields an alias model sets. */
type AliasField = {
	[K in keyof typeof ALIAS_FIELDS]: (typeof ALIAS_FIELDS)[K] extends "alias" | "combined" ? K : never;
}[keyof typeof ALIAS_FIELDS];

/**
 * The pi-ai model of an alias, from the models of its routes: what every route can do. Pi compacts against the
 * smallest context window, offers only what each route reads and the thinking levels each route's model offers. The
 * catalog price is the first route's; the price a response is charged at is the route's, in its route event.
 */
function aliasModel(provider: string, alias: Alias, routes: ReadonlyArray<Model<Api>>): Model<Api> {
	const [first] = routes;
	// Every field `ALIAS_FIELDS` sets, and no other.
	const model: Required<Pick<Model<Api>, AliasField>> = {
		id: alias.alias,
		name: alias.name ?? alias.alias,
		api: API,
		provider,
		// pi-ai requires a base URL; nothing reads this one, each route's provider knows where to go.
		baseUrl: `pi-router://${provider}`,
		reasoning: routes.every((model) => model.reasoning),
		thinkingLevelMap: thinkingLevels(routes),
		input: first.input.filter((modality) => routes.every((model) => model.input.includes(modality))),
		cost: first.cost,
		contextWindow: Math.min(...routes.map((model) => model.contextWindow)),
		maxTokens: Math.min(...routes.map((model) => model.maxTokens)),
	};
	return model;
}

/**
 * The thinking levels of an alias: a level every route's model offers (pi-ai's `getSupportedThinkingLevels`) is
 * mapped to its own name, so pi-ai offers it, `xhigh` and `max` included; every other level is hidden (`null`). A
 * request that falls back goes to the next route with the level it asked for, which that route's adapter lowers to
 * one its model offers: the alias offers a level only when every route serves it as asked, as it promises the
 * smallest context window. The names are never sent: a route's request maps the level with the route's own model.
 */
function thinkingLevels(routes: ReadonlyArray<Model<Api>>): ThinkingLevelMap {
	const offered = routes.map((model) => getSupportedThinkingLevels(model));
	const levels: ThinkingLevelMap = {};
	for (const level of MODEL_THINKING_LEVELS) {
		levels[level] = offered.every((supported) => supported.includes(level)) ? level : null;
	}
	return levels;
}

/** An empty message of the alias model, for a request that ended before any route had output. */
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
 * How a failed request ends in pi-ai. `soFar` is the response as the caller last saw it, or the empty message of
 * the alias model: an interruption and a defect end it there, keeping its content and usage.
 */
function errorEvent(
	cause: Cause.Cause<RouterError>,
	soFar: AssistantMessage,
): Extract<AssistantMessageEvent, { type: "error" }> {
	const ended = (reason: ErrorReason, errorMessage: string) =>
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
