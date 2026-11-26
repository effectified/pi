// What ai-effect restates of pi-ai by hand, and which of pi-ai's members it leaves out, checked against pi-ai's own
// types. Type-only: nothing here runs. A failure names what moved upstream.

import type {
	Api,
	ApiKeyCredential,
	AuthContext,
	AuthInteraction,
	AuthResult,
	CredentialStore,
	LoginOptions,
	Model,
	ModelAuth,
	ModelCostRates,
	ModelsErrorCode,
	MutableModels,
	OAuthCredential,
	RetryCallbacks,
	Usage,
} from "@earendil-works/pi-ai";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type * as AiEffect from "../src/index.ts";

/**
 * Every member of pi-ai's model collection is lifted into an Effect here (`stream`, `complete`, `streamSimple`,
 * `completeSimple`, `getModel`, `getAuth`, `checkAuth`, `getAvailable`, `getAvailableOfType`, `getAllAvailable`,
 * `login`, `logout`), or used on the `Models` service value, which is pi-ai's own object. A member pi-ai adds fails
 * here until it is wrapped or named below.
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

/** The keys of `T` that are named, without those of an index signature. */
type NamedKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

/** `AuthError.reason` takes pi-ai's `ModelsError` codes, and `login`. */
export type AuthErrorReasonSame = Assert<Conform<AiEffect.AuthError["reason"], ModelsErrorCode | "login">>;

/** A redacted API key credential has exactly the fields of pi-ai's. */
export type ApiKeyCredentialSame = Assert<Conform<keyof AiEffect.RedactedApiKeyCredential, keyof ApiKeyCredential>>;

/** A redacted OAuth credential names exactly the fields pi-ai's names; both keep a flow's own fields. */
export type OAuthCredentialSame = Assert<
	Conform<NamedKeys<AiEffect.RedactedOAuthCredential>, NamedKeys<OAuthCredential>>
>;

/** Resolved auth has the fields of pi-ai's `AuthResult` and `ModelAuth`. */
export type ResolvedAuthSame = Assert<Conform<keyof AiEffect.ResolvedAuth, keyof AuthResult>>;
export type ModelAuthSame = Assert<Conform<keyof AiEffect.RedactedModelAuth, keyof ModelAuth>>;

/** The overrides of `getAuth` are pi-ai's without `signal`. */
export type AuthOverridesSame = Assert<
	Conform<keyof AiEffect.AuthOverrides | "signal", keyof NonNullable<Parameters<MutableModels["getAuth"]>[1]>>
>;

/** A login interaction is pi-ai's without `signal`; its options are pi-ai's with the device id as an Effect. */
export type LoginInteractionCovered = Assert<Covers<AuthInteraction, AiEffect.LoginInteraction, "signal">>;
export type LoginOptionsCovered = Assert<Covers<LoginOptions, AiEffect.LoginEffectOptions, "getDeviceId">>;

/** The services have the members of pi-ai's ports. */
export type CredentialsSame = Assert<Conform<keyof AiEffect.CredentialsService, keyof CredentialStore>>;
export type AuthContextSame = Assert<Conform<keyof AiEffect.ProviderAuthContextService, keyof AuthContext>>;

/** The notifications of `retryAssistantCall` are pi-ai's callbacks. */
export type RetryNotificationsSame = Assert<Conform<keyof AiEffect.RetryNotifications, keyof RetryCallbacks>>;
