// Pi's models in Effect: the Models service, requests as Stream and Effect, and the bridges to effect/ai.

// Every type pi-ai declares (`Model`, `Context`, `AssistantMessage`, `Provider`, ...), so an application names them
// without importing pi-ai; where this package exports a name of its own, its own wins. Providers are in
// `@effectified/pi-ai/providers/<name>`.
export type * from "@earendil-works/pi-ai";
// pi-ai's own name for its collection of models, which `Models` (this package's service) would hide.
export type { Models as PiModels } from "@earendil-works/pi-ai";
// pi-ai's helpers a plugin builds on: reading messages and settings, classifying a failed response, and building a
// pi-ai provider (a router is one) in pi-ai's own terms. Synchronous and free of I/O.
export {
	appendAssistantMessageDiagnostic,
	contentText,
	createAssistantMessageEventStream,
	createProvider,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
} from "@earendil-works/pi-ai";
export { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
export * as EffectProvider from "./effect-provider.ts";
export { ModelNotFound, ModelRequestError } from "./errors.ts";
export { getModel, ModelRef } from "./model-ref.ts";
export { Models } from "./models.ts";
export * as PiLanguageModel from "./pi-language-model.ts";
export {
	complete,
	completeSimple,
	type ErrorReason,
	type RequestOptions,
	type ResponseEvent,
	stream,
	streamSimple,
} from "./request.ts";
export { requestKey } from "./request-key.ts";
export { ANSWERED } from "./stop-reason.ts";
export type { StrictOmit } from "./strict-omit.ts";
export { emptyUsage, TOKEN_KINDS, type TokenKind } from "./usage.ts";
