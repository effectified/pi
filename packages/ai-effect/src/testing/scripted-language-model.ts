// A scripted effect/ai `LanguageModel` for tests: each request takes the next queued response.

import {
	Array as Arr,
	Context,
	Effect,
	Formatter,
	Layer,
	Match,
	Option,
	pipe,
	Ref,
	String as Str,
	Stream,
} from "effect";
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
	"@effectified/pi-ai/testing/scripted-language-model/ScriptedLanguageModel",
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
				const queue = yield* Ref.make(responses);
				const requests = yield* Ref.make<ReadonlyArray<LanguageModel.ProviderOptions>>([]);
				const next = Effect.fn("ScriptedLanguageModel.next")(function* (request: LanguageModel.ProviderOptions) {
					const asked = yield* Ref.updateAndGet(requests, Arr.append(request));
					const response = yield* Ref.modify(queue, (queued) => [Arr.head(queued), Arr.drop(queued, 1)] as const);
					if (Option.isNone(response)) return yield* noResponse(asked.length);
					return yield* response.value;
				});
				const model = yield* LanguageModel.make({
					generateText: (request) => Effect.map(next(request), Arr.fromIterable),
					streamText: (request) =>
						Stream.unwrap(
							Effect.map(next(request), (parts) => Stream.fromIterable(Arr.flatMap(parts, streamParts))),
						),
				});
				return Context.make(LanguageModel.LanguageModel, model).pipe(
					Context.add(ScriptedLanguageModel, {
						setResponses: Effect.fn("ScriptedLanguageModel.setResponses")(function* (
							replacement: ReadonlyArray<ScriptedResponse>,
						) {
							yield* Ref.set(queue, replacement);
						}),
						appendResponses: Effect.fn("ScriptedLanguageModel.appendResponses")(function* (
							more: ReadonlyArray<ScriptedResponse>,
						) {
							yield* Ref.update(queue, Arr.appendAll(more));
						}),
						requests: Ref.get(requests),
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
		reason: AiError.UnknownError.make({ description: `No scripted response is queued for request ${request}` }),
	});
}

/** The stream form of one finished part; `index` makes the id of its text or reasoning block. */
function streamParts(part: Response.PartEncoded, index: number): ReadonlyArray<Response.StreamPartEncoded> {
	const id = String(index);
	return Match.value(part).pipe(
		Match.discriminators("type")({
			text: ({ text }): ReadonlyArray<Response.StreamPartEncoded> => [
				{ type: "text-start", id },
				...Arr.map(pieces(text), (delta) => ({ type: "text-delta" as const, id, delta })),
				{ type: "text-end", id },
			],
			reasoning: ({ text }): ReadonlyArray<Response.StreamPartEncoded> => [
				{ type: "reasoning-start", id },
				...Arr.map(pieces(text), (delta) => ({ type: "reasoning-delta" as const, id, delta })),
				{ type: "reasoning-end", id },
			],
			"tool-call": (call): ReadonlyArray<Response.StreamPartEncoded> => [
				{
					type: "tool-params-start",
					id: call.id,
					name: call.name,
					providerExecuted: call.providerExecuted ?? false,
				},
				...Arr.map(pieces(Formatter.formatJson(call.params)), (delta) => ({
					type: "tool-params-delta" as const,
					id: call.id,
					delta,
				})),
				{ type: "tool-params-end", id: call.id },
				call,
			],
		}),
		Match.orElse((other): ReadonlyArray<Response.StreamPartEncoded> => [other]),
	);
}

const DELTA_SIZE = 4;

/** `text` in pieces of `DELTA_SIZE` characters; none for no text. */
function pieces(text: string): ReadonlyArray<string> {
	return Arr.unfold(0, (start) =>
		start < text.length
			? Option.some([pipe(text, Str.slice(start, start + DELTA_SIZE)), start + DELTA_SIZE] as const)
			: Option.none(),
	);
}
