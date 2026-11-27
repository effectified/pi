// Where the agent's model responses come from: Pi's stream function as a service, from `Models` or through a proxy.

import { type StreamFn as PiStreamFn, type ProxyStreamOptions, streamProxy } from "@earendil-works/pi-agent-core";
import { Models, withoutParentSpan } from "@effectified/pi-ai";
import { Context, Effect, Layer } from "effect";
import { runner } from "./runner.ts";

/** What `StreamFn.proxy` takes: Pi's proxy URL, and the auth token as an Effect asked again for every request. */
export interface ProxyOptions<R> extends Pick<ProxyStreamOptions, "proxyUrl"> {
	readonly authToken: Effect.Effect<string, never, R>;
}

/**
 * The stream function every agent and loop of the program sends its model requests through: Pi's `StreamFn`, so it
 * can be handed to anything that takes one. It replaces Pi's process-wide default (`setDefaultStreamFn`): each
 * program provides its own.
 */
export class StreamFn extends Context.Service<StreamFn, PiStreamFn>()("@effectified/pi-agent/stream-fn/StreamFn") {
	/** Requests go to the providers of `Models`, through its `streamSimple`. */
	static readonly models: Layer.Layer<StreamFn, never, Models> = Layer.effect(
		StreamFn,
		Models.use((models) =>
			Effect.succeed<PiStreamFn>((model, context, options) => models.streamSimple(model, context, options)),
		),
	);

	/**
	 * Requests go to a server that calls the providers (Pi's `streamProxy`): `POST <proxyUrl>/api/stream` with the
	 * token `authToken` gives, asked for each request under a span of its own, `StreamFn.authToken`. The request's
	 * abort signal interrupts the token's Effect.
	 */
	static proxy<R>(options: ProxyOptions<R>): Layer.Layer<StreamFn, never, R> {
		return Layer.effect(
			StreamFn,
			Effect.map(Effect.context<R>(), (context): PiStreamFn => {
				// The Layer's service outlives this Effect: each request's spans start their own trace.
				const run = runner(withoutParentSpan(context));
				return (model, transcript, request) =>
					run(Effect.withSpan(options.authToken, "StreamFn.authToken"), request?.signal).then((authToken) =>
						streamProxy(model, transcript, { ...request, authToken, proxyUrl: options.proxyUrl }),
					);
			}),
		);
	}
}
