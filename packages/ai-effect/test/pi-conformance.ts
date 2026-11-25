// What ai-effect restates of pi-ai by hand, and which of pi-ai's members it leaves out, checked against pi-ai's own
// types. Type-only: nothing here runs. A failure names what moved upstream.

import type { Api, Model, ModelCostRates, MutableModels, Usage } from "@earendil-works/pi-ai";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type * as AiEffect from "../src/index.ts";

/**
 * Every member of pi-ai's model collection is lifted into an Effect here (`stream`, `complete`, `streamSimple`,
 * `completeSimple`, `getModel`), or used on the `Models` service value, which is pi-ai's own object. A member pi-ai
 * adds fails here until it is wrapped or named below.
 */
export type ModelsCovered = Assert<
	Covers<
		MutableModels,
		typeof AiEffect,
		// Synchronous reads and the provider registry: nothing to lift, used on the service value.
		| "getProviders"
		| "getProvider"
		| "getModels"
		| "getModelsOfType"
		| "getModelOfType"
		| "getAllModels"
		| "setProvider"
		| "deleteProvider"
		| "clearProviders"
		// Not wrapped yet (README, "Not wrapped yet"): reachable through the service value.
		| "refresh"
		| "checkAuth"
		| "getAvailable"
		| "getAvailableOfType"
		| "getAllAvailable"
		| "getAuth"
		| "login"
		| "logout"
		| "streamDeferred"
		| "fetchDeferred"
		| "cancelDeferred"
		| "generateImages"
		| "classify"
	>
>;

/** `ModelRequestError.reason` takes exactly the reasons of pi-ai's `error` event. */
export type RequestErrorReasonSame = Assert<Conform<AiEffect.ModelRequestError["reason"], AiEffect.ErrorReason>>;

/** `TOKEN_KINDS` are exactly the kinds a model's cost has a rate for. */
export type TokenKindsSame = Assert<Conform<AiEffect.TokenKind, keyof ModelCostRates>>;

/** Every count of pi-ai's usage is a token kind, or a part or the sum of them. */
export type UsageCounted = Assert<
	Covers<Usage, Record<AiEffect.TokenKind, number>, "cacheWrite1h" | "reasoning" | "totalTokens" | "cost">
>;

/** Every cost of pi-ai's usage is the cost of a token kind, or their total. */
export type CostCounted = Assert<
	Covers<Usage["cost"], Record<AiEffect.TokenKind, number>, "total" | "totalFromProvider">
>;

/**
 * Every field of a pi-ai chat model is one an Effect model gives, one `EffectProvider.make` sets itself (`api`,
 * `provider`, `baseUrl`, the chat `type` by default), or one it cannot carry yet.
 */
export type EffectModelCovered = Assert<
	Covers<
		Model<Api>,
		AiEffect.EffectProvider.EffectModel,
		| "api"
		| "provider"
		| "baseUrl"
		| "type"
		// Not carried yet: the provider's models run on the layer's own settings.
		| "inputLimits"
		| "headers"
		| "thinkingLevelMap"
		| "promptCache"
		| "samplingParams"
		| "samplingParamsByThinkingLevel"
		| "compat"
	>
>;
