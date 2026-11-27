// Pi's models in Effect: the Models service, requests as Stream and Effect, auth and credentials as services, the
// bridges to effect/ai, and pi-ai's helpers as pure values or as Effects.

// Every type pi-ai declares (`Model`, `Context`, `AssistantMessage`, `Provider`, ...), so an application names them
// without importing pi-ai; where this package exports a name of its own, its own wins. Providers are in
// `@effectified/pi-ai/providers/<name>`.
export type * from "@earendil-works/pi-ai";
// pi-ai's own name for its collection of models, which `Models` (this package's service) would hide.
export type { Models as PiModels } from "@earendil-works/pi-ai";
// pi-ai's pure helpers, offered as they are: synchronous, free of I/O, and they never throw. Reading messages,
// transcripts and settings; classifying a failed response; pricing; the numbers of prompt cache warming; client
// identity headers (`formatUserAgent` names the runtime, which a process cannot change); and building a pi-ai
// provider (a router is one) in pi-ai's own terms, with its streaming JSON parsers and auth definitions.
export {
	AI_TELEMETRY_SCHEMA,
	appendAssistantMessageDiagnostic,
	CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	calculateCost,
	clampThinkingLevel,
	collapseSystemMessages,
	contentText,
	createAssistantMessageEventStream,
	createInitialSystemMessage,
	createProvider,
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	declarationsEqual,
	envApiKeyAuth,
	evaluateCacheWarming,
	extractDiagnosticError,
	formatThrownValue,
	formatUserAgent,
	getAttributionHeaders,
	getCacheWarmingDelayMs,
	getClientVersion,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getDeclaredTools,
	getIdentityHeaders,
	getInitialSystemMessage,
	getModelType,
	getOpenCodeSessionHeaders,
	getOverflowPatterns,
	getSupportedThinkingLevels,
	getSystemMessageText,
	getToolStateChanges,
	hasApi,
	hasNonAdditiveToolChanges,
	hasToolRedefinitions,
	isCacheWarmingReplayable,
	isContextOverflow,
	isModelType,
	isRecoverableLength,
	isRetryableAssistantError,
	lazyOAuth,
	mergeClientIdentity,
	modelsAreEqual,
	normalizeContext,
	PI_AI_VERSION,
	PI_ATTRIBUTION,
	parseStreamingJson,
	parseToolCallArguments,
	renderSystemMessageUpdate,
	repairJson,
	resolveTranscript,
	resolveTranscriptTools,
	retryDelayMs,
	StreamingJsonParser,
	StringEnum,
	ToolCallArgumentsStream,
	toToolDeclaration,
	withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
export { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
export {
	type AuthOverrides,
	checkAuth,
	getAllAvailable,
	getAuth,
	getAvailable,
	getAvailableOfType,
	type LoginEffectOptions,
	type LoginInteraction,
	type LoginPrompt,
	login,
	logout,
	type RedactedModelAuth,
	type ResolvedAuth,
	refreshModels,
} from "./auth.ts";
export { ProviderAuthContext, type ProviderAuthContextService } from "./auth-context.ts";
export { getPromptCacheTtlMs, warmCache } from "./cache-warming.ts";
export {
	Credentials,
	type CredentialsService,
	type RedactedApiKeyCredential,
	type RedactedCredential,
	type RedactedOAuthCredential,
	redactCredential,
	revealCredential,
} from "./credentials.ts";
export { createAssistantMessageDiagnostic } from "./diagnostics.ts";
export * as EffectProvider from "./effect-provider.ts";
export {
	AuthError,
	type AuthErrorReason,
	CredentialStoreError,
	InvalidToolCall,
	MalformedJson,
	ModelNotFound,
	ModelRequestError,
	SessionCleanupError,
} from "./errors.ts";
export { withClientIdentity } from "./identity.ts";
// The provider, model, tool call and session ids, branded. `ProviderId` replaces pi-ai's type of that name
// (`KnownProvider | string`).
export { ModelId, ProviderId, SessionId, ToolCallId } from "./ids.ts";
export { parseJsonWithRepair } from "./json.ts";
export { fromPiModelRef, getModel, ModelRef, modelRefOf, type PiModelRef } from "./model-ref.ts";
export { Models } from "./models.ts";
export * as PiLanguageModel from "./pi-language-model.ts";
export {
	complete,
	completeSimple,
	type ErrorReason,
	finalMessage,
	type RequestOptions,
	type ResponseEvent,
	stream,
	streamSimple,
} from "./request.ts";
export { RequestKey, requestKey } from "./request-key.ts";
// The numbers pi-ai reports of a response, as a record keeps them: finite, a non-finite one as 0.
export { Reported, reported } from "./reported.ts";
// A context for the Effects of a callback Pi keeps, so their spans do not hang under one that ended.
export { withoutParentSpan } from "./run-in-pi.ts";
export { type RetryNotifications, retryAssistantCall } from "./retry.ts";
export { cleanupSessionResources, registerSessionResourceCleanup } from "./session-resources.ts";
export { ANSWERED } from "./stop-reason.ts";
export type { StrictOmit } from "./strict-omit.ts";
export { validateToolArguments, validateToolCall } from "./tool-validation.ts";
export { emptyUsage, TOKEN_KINDS, type TokenKind } from "./usage.ts";
export { uuidv7 } from "./uuid.ts";
