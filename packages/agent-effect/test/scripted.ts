// What the tests share: the scripted models behind `StreamFn`, and a model response held until the run is aborted.

import { type FauxResponseFactory, fauxAssistantMessage, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect, Latch, Layer } from "effect";
import { StreamFn } from "../src/index.ts";

/** pi-ai's scripted provider behind `Models`, and `StreamFn` sending requests to it. */
export const scripted = Layer.provideMerge(StreamFn.models, ScriptedModels.layer());

/** The scripted model a test's agent or loop runs with. */
export const model = ScriptedModels.use((models) => Effect.succeed(models.model));

/**
 * A response that never comes: the request waits until its run is aborted, then ends as pi-ai ends an aborted one.
 * `started` opens when the request arrives, so a test knows the run is waiting on the model.
 */
export function held(started: Latch.Latch): FauxResponseFactory {
	return (_context, options) =>
		new Promise((resolve) => {
			options?.signal?.addEventListener(
				"abort",
				() => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })),
				{ once: true },
			);
			// Opened last: the waiting fiber may run at once and abort the request.
			Latch.openUnsafe(started);
		});
}
