// Scripted model responses for tests: the turns a scripted provider answers with.

import type { AssistantMessage } from "@effectified/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@effectified/pi-ai/testing";
import { Deferred, Effect, Exit } from "effect";

/** A response the model is asked for but holds back: what a test uses to act while a run is busy. */
export interface Held {
	/** The scripted response. */
	readonly response: FauxResponseFactory;
	/** Succeeds once the model was asked for this response. */
	readonly requested: Effect.Effect<void>;
	/** Lets the model answer. An aborted request answers by itself, so an aborted run never hangs. */
	readonly release: Effect.Effect<void>;
}

/** A final answer of the model. */
export function answer(text: string): AssistantMessage {
	return fauxAssistantMessage([fauxText(text)]);
}

/** A model turn that calls the tool `name` with `args`. Pass an `id` when the transcript is compared across runs. */
export function toolCall(
	name: string,
	args: Parameters<typeof fauxToolCall>[1],
	options?: { readonly id?: string },
): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args, options)], { stopReason: "toolUse" });
}

/** `turn`, given only once `release` ran or the request was aborted. */
export function held(turn: AssistantMessage): Held {
	// Made outside any fiber, as the scripted provider calls `response` from outside one: settled once, awaited by many.
	const requested = Deferred.makeUnsafe<void>();
	const released = Deferred.makeUnsafe<void>();
	return {
		// pi-ai's faux provider awaits a promise of the turn: the bridge of this test helper into it.
		response: (_context, options) => {
			Deferred.doneUnsafe(requested, Exit.void);
			const aborted = Effect.callback<void>((resume) => {
				options?.signal?.addEventListener("abort", () => resume(Effect.void), { once: true });
			});
			return Effect.runPromise(Effect.as(Effect.raceFirst(Deferred.await(released), aborted), turn));
		},
		requested: Deferred.await(requested),
		release: Effect.asVoid(Deferred.succeed(released, undefined)),
	};
}
