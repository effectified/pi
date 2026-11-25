// A scripted effect/ai `LanguageModel` for tests: each request takes the next queued response.

import { Context, Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/ai";

/**
 * One scripted response: an Effect of the parts of the finished response. `Effect.succeed(parts)` answers at once,
 * `Effect.fail(error)` fails the request, and an Effect that waits (`Effect.never`, a `Deferred`) holds the request
 * open so a test can interrupt it.
 */
export type ScriptedResponse = Effect.Effect<ReadonlyArray<Response.PartEncoded>, AiError.AiError>;

/** The controls of the scripted model `ScriptedLanguageModel.layer` provides. */
export interface ScriptedLanguageModelService {
	/** Replaces the queue of responses. Each request takes the next one; a request with none queued fails. */
	readonly setResponses: (responses: ReadonlyArray<ScriptedResponse>) => Effect.Effect<void>;
	/** Adds responses to the end of the queue. */
	readonly appendResponses: (responses: ReadonlyArray<ScriptedResponse>) => Effect.Effect<void>;
	/** What the model was asked, one entry per request, in order: prompt, tools and tool choice. */
	readonly requests: Effect.Effect<ReadonlyArray<LanguageModel.ProviderOptions>>;
}

/** A scripted effect/ai model for tests: no network, no keys, responses in the order they were queued. */
export class ScriptedLanguageModel extends Context.Service<ScriptedLanguageModel, ScriptedLanguageModelService>()(
	"@gunta/pi-ai-effect/testing/ScriptedLanguageModel",
) {
	/**
	 * A fresh scripted `LanguageModel` and its controls. `generateText` returns a response's parts as they are;
	 * `streamText` sends text, reasoning and tool call parameters as start, delta and end parts, four characters a
	 * delta, and every other part unchanged.
	 */
	static layer(
		responses: ReadonlyArray<ScriptedResponse> = [],
	): Layer.Layer<ScriptedLanguageModel | LanguageModel.LanguageModel> {
		return Layer.effectContext(
			Effect.gen(function* () {
				let queue = [...responses];
				const requests: LanguageModel.ProviderOptions[] = [];
				const next = (request: LanguageModel.ProviderOptions): ScriptedResponse =>
					Effect.suspend(() => {
						requests.push(request);
						return queue.shift() ?? Effect.fail(noResponse(requests.length));
					});
				const model = yield* LanguageModel.make({
					generateText: (request) => Effect.map(next(request), (parts) => [...parts]),
					streamText: (request) =>
						Stream.unwrap(Effect.map(next(request), (parts) => Stream.fromIterable(parts.flatMap(streamParts)))),
				});
				return Context.make(LanguageModel.LanguageModel, model).pipe(
					Context.add(ScriptedLanguageModel, {
						setResponses: (replacement) =>
							Effect.sync(() => {
								queue = [...replacement];
							}),
						appendResponses: (more) =>
							Effect.sync(() => {
								queue.push(...more);
							}),
						requests: Effect.sync(() => [...requests]),
					}),
				);
			}),
		);
	}
}

function noResponse(request: number): AiError.AiError {
	return AiError.make({
		module: "ScriptedLanguageModel",
		method: "next",
		reason: new AiError.UnknownError({ description: `No scripted response is queued for request ${request}` }),
	});
}

/** The stream form of one finished part; `index` makes the id of its text or reasoning block. */
function streamParts(part: Response.PartEncoded, index: number): ReadonlyArray<Response.StreamPartEncoded> {
	const id = String(index);
	switch (part.type) {
		case "text":
			return [
				{ type: "text-start", id },
				...pieces(part.text).map((delta) => ({ type: "text-delta" as const, id, delta })),
				{ type: "text-end", id },
			];
		case "reasoning":
			return [
				{ type: "reasoning-start", id },
				...pieces(part.text).map((delta) => ({ type: "reasoning-delta" as const, id, delta })),
				{ type: "reasoning-end", id },
			];
		case "tool-call":
			return [
				{
					type: "tool-params-start",
					id: part.id,
					name: part.name,
					providerExecuted: part.providerExecuted ?? false,
				},
				...pieces(JSON.stringify(part.params)).map((delta) => ({
					type: "tool-params-delta" as const,
					id: part.id,
					delta,
				})),
				{ type: "tool-params-end", id: part.id },
				part,
			];
		default:
			return [part];
	}
}

const DELTA_SIZE = 4;

function pieces(text: string): string[] {
	const result: string[] = [];
	for (let start = 0; start < text.length; start += DELTA_SIZE) result.push(text.slice(start, start + DELTA_SIZE));
	return result;
}
