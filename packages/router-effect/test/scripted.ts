// Scripted pi-ai providers under several ids, and route tables over them, shared by the tests of this package.

import {
	type AssistantMessage,
	type FauxModelDefinition,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type Context as PiContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Models, type ResponseEvent } from "@gunta/pi-ai-effect";
import { Effect, type Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { Price, Route, RouteEvent, RouteEventsService, RouteTable } from "../src/index.ts";

/** What every test asks. pi-ai's scripted provider counts it as 2 input tokens: "user:hi", four characters each. */
export const context: PiContext = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** USD 3, 15, 0.30 and 3.75 per million tokens. */
export const PRICE: Price = {
	currency: "USD",
	input: 3_000_000,
	output: 15_000_000,
	cacheRead: 300_000,
	cacheWrite: 3_750_000,
};

/** A scripted provider under `id` with the chat model `m`. Equal token bounds make every delta four characters. */
export function scripted(id: string, model: Omit<FauxModelDefinition, "id"> = {}): FauxProviderHandle {
	return fauxProvider({ provider: id, models: [{ id: "m", ...model }], tokenSize: { min: 1, max: 1 } });
}

/** A `Models` that holds the providers of `handles`. */
export function modelsLayer(...handles: FauxProviderHandle[]): Layer.Layer<Models> {
	return Models.layer(handles.map((handle) => handle.provider));
}

/** A route to model `m` of `provider`: region `us`, ceiling `public`, its own concurrency key, at `PRICE`. */
export function route(provider: string, overrides: Partial<Route> = {}): Route {
	return {
		provider,
		model: "m",
		region: "us",
		ceiling: "public",
		price: PRICE,
		concurrencyKey: provider,
		...overrides,
	};
}

/** A table over `aliases` with the labels `public`, `internal` and `secret`, and four slots for every key named. */
export function table(aliases: RouteTable["aliases"], overrides: Partial<RouteTable> = {}): RouteTable {
	const keys = aliases.flatMap((alias) => alias.routes.map((entry) => entry.concurrencyKey));
	return {
		classifications: ["public", "internal", "secret"],
		limits: Object.fromEntries(keys.map((key) => [key, { maxInFlight: 4 }])),
		aliases,
		...overrides,
	};
}

/** A scripted response that fails with `errorMessage` before any output, as a refused HTTP request does. */
export function failing(errorMessage: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
	return fauxAssistantMessage([], { stopReason, errorMessage });
}

/** What a test compares of pi-ai's events: the type, and the text of a delta. */
export function label(event: ResponseEvent): string {
	switch (event.type) {
		case "start":
			return "start";
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return `${event.type} ${event.delta}`;
		case "done":
			return `done ${event.reason}`;
		default:
			return event.type;
	}
}

/** A `RouteEvents` that keeps what is published in `seen`, so a test reads the record without a subscriber fiber. */
export function recording(): { readonly seen: RouteEvent[]; readonly events: RouteEventsService } {
	const seen: RouteEvent[] = [];
	return {
		seen,
		events: {
			publish: (event) =>
				Effect.sync(() => {
					seen.push(event);
				}),
			stream: Stream.empty,
			subscribe: Effect.succeed(Stream.empty),
		},
	};
}

/** The parts of a route event a test compares; times are compared where a test controls the Clock. */
export function summary(event: RouteEvent) {
	return {
		request: event.request,
		attempt: event.attempt,
		route: `${event.route.provider}/${event.route.model}`,
		outcome: event.outcome,
		fallback: event.fallback,
		errorMessage: event.errorMessage,
		usage: event.usage,
		micros: event.cost.micros,
	};
}

/** A scripted response that never arrives, and the abort signal its request carried. */
export function hanging() {
	let report: (signal: AbortSignal | undefined) => void = () => {};
	const signal = new Promise<AbortSignal | undefined>((resolve) => {
		report = resolve;
	});
	const response = (_context: unknown, options: SimpleStreamOptions | undefined) => {
		report(options?.signal);
		return new Promise<AssistantMessage>(() => {});
	};
	return { response, signal };
}

/** Lets pi-ai's promises and microtasks run while the test clock stands still. */
export const realTick = TestClock.withLive(Effect.sleep("2 millis"));

/** Waits in real time until `condition` holds. */
export function until(condition: () => boolean): Effect.Effect<void> {
	return Effect.suspend(() => (condition() ? Effect.void : Effect.andThen(realTick, until(condition))));
}
