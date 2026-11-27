// The ids pi-ai names its providers, models, tool calls and sessions by, branded so that one is never passed for
// another.

import { Schema } from "effect";

/**
 * The id of a pi-ai provider (`anthropic`, `faux`, an `EffectProvider`'s own): what `Models` registers a provider
 * under and keys its credentials by. pi-ai's ids are plain strings; the brand is applied where one enters this
 * package (`ProviderId.make("anthropic")`, or decoding a `ModelRef`).
 */
export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"));

/** The id of a pi-ai provider. */
export type ProviderId = typeof ProviderId.Type;

/** The id of a model within its provider (`claude-opus-4-7`, `faux-1`): a pi-ai model's `id`. */
export const ModelId = Schema.String.pipe(Schema.brand("ModelId"));

/** The id of a model within its provider. */
export type ModelId = typeof ModelId.Type;

/**
 * The id a model gives one tool call (pi-ai's `ToolCall.id`), which the call's result answers (`toolCallId`). Every
 * framework on pi-ai hands the same id on: pi-agent's tool handlers, Pi Durable's tool api and hooks, the plugins'
 * records. Branded where one enters from Pi (`ToolCallId.make(call.id)`).
 */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"));

/** The id a model gives one tool call. */
export type ToolCallId = typeof ToolCallId.Type;

/**
 * The id of a provider session (pi-ai's `StreamOptions.sessionId`): what a provider caches a conversation's prompt
 * by, and what Pi Durable sends with every request of a conversation. Branded where one enters from Pi.
 */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));

/** The id of a provider session. */
export type SessionId = typeof SessionId.Type;
