import type * as PiAi from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });
const open = (why: string): Coverage => ({ kind: "open", why });
const TESTING = replaced("@effectified/pi-ai/testing");
const PROVIDER_KIT = open("pi-ai's kit for writing a provider; in Effect a provider is `EffectProvider.make`");
const CREDENTIALS = open("provider credentials and OAuth: not wrapped (COMPAT.md: OAuth login)");
const CACHE_WARMING = open("prompt cache warming: not wrapped");
const IDENTITY = open("client identity and attribution headers: not wrapped");
const JSON_REPAIR = open("repairing a model's JSON: not wrapped");
const RETRY = open("pi-ai's retry and overflow rules: not wrapped; a fiber retries with `Effect.retry`");
const TRANSCRIPT = open("reading system messages and tools from a transcript: not wrapped");
const DIAGNOSTICS = open("assistant message diagnostics: not wrapped");
const MODEL_HELPERS = open("model, usage and session helpers: not wrapped");

/** What this package does with every value pi-ai exports: the list of what is left to put in Effect terms. */
const COVERAGE = {
	createModels: replaced("Models.layer"),
	InMemoryModelsStore: replaced("Models.layer"),
	ModelsError: replaced("ModelNotFound and ModelRequestError"),
	createProvider: offered,
	EventStream: replaced("stream and streamSimple: a Stream of the same events"),
	createAssistantMessageEventStream: offered,
	fauxText: TESTING,
	fauxThinking: TESTING,
	fauxToolCall: TESTING,
	fauxAssistantMessage: TESTING,
	fauxProvider: TESTING,
	createFauxCore: open("the faux provider's core, for a scripted provider of another API: not wrapped"),
	lazyStream: PROVIDER_KIT,
	lazyApi: PROVIDER_KIT,
	StreamingJsonParser: PROVIDER_KIT,
	ToolCallArgumentsStream: PROVIDER_KIT,
	parseStreamingJson: PROVIDER_KIT,
	parseToolCallArguments: PROVIDER_KIT,
	formatThrownValue: PROVIDER_KIT,
	defaultProviderAuthContext: CREDENTIALS,
	InMemoryCredentialStore: CREDENTIALS,
	envApiKeyAuth: CREDENTIALS,
	lazyOAuth: CREDENTIALS,
	CACHE_WARMING_MAX_AGE_MS: CACHE_WARMING,
	CACHE_WARMING_MAX_IDLE_AGE_MS: CACHE_WARMING,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS: CACHE_WARMING,
	CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY: CACHE_WARMING,
	getCacheWarmingDelayMs: CACHE_WARMING,
	getPromptCacheTtlMs: CACHE_WARMING,
	isCacheWarmingReplayable: CACHE_WARMING,
	getCacheWarmingRequestOptions: CACHE_WARMING,
	evaluateCacheWarming: CACHE_WARMING,
	PI_ATTRIBUTION: IDENTITY,
	mergeClientIdentity: IDENTITY,
	getClientVersion: IDENTITY,
	formatUserAgent: IDENTITY,
	getAttributionHeaders: IDENTITY,
	getOpenCodeSessionHeaders: IDENTITY,
	getIdentityHeaders: IDENTITY,
	withClientIdentity: IDENTITY,
	repairJson: JSON_REPAIR,
	parseJsonWithRepair: JSON_REPAIR,
	isContextOverflow: offered,
	isRecoverableLength: RETRY,
	getOverflowPatterns: RETRY,
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS: RETRY,
	retryDelayMs: RETRY,
	retryAssistantCall: RETRY,
	isRetryableAssistantError: offered,
	contentText: offered,
	getSystemMessageText: TRANSCRIPT,
	renderSystemMessageUpdate: TRANSCRIPT,
	createInitialSystemMessage: TRANSCRIPT,
	normalizeContext: TRANSCRIPT,
	getInitialSystemMessage: TRANSCRIPT,
	withoutInitialSystemMessage: TRANSCRIPT,
	getCurrentTools: TRANSCRIPT,
	getCurrentSystemMessage: TRANSCRIPT,
	getCurrentSystemPrompt: TRANSCRIPT,
	collapseSystemMessages: TRANSCRIPT,
	resolveTranscript: TRANSCRIPT,
	toToolDeclaration: TRANSCRIPT,
	declarationsEqual: TRANSCRIPT,
	getToolStateChanges: TRANSCRIPT,
	getDeclaredTools: TRANSCRIPT,
	hasToolRedefinitions: TRANSCRIPT,
	hasNonAdditiveToolChanges: TRANSCRIPT,
	resolveTranscriptTools: TRANSCRIPT,
	validateToolCall: TRANSCRIPT,
	validateToolArguments: TRANSCRIPT,
	StringEnum: TRANSCRIPT,
	extractDiagnosticError: DIAGNOSTICS,
	createAssistantMessageDiagnostic: DIAGNOSTICS,
	appendAssistantMessageDiagnostic: offered,
	uuidv7: MODEL_HELPERS,
	PI_AI_VERSION: MODEL_HELPERS,
	AI_TELEMETRY_SCHEMA: MODEL_HELPERS,
	getModelType: MODEL_HELPERS,
	isModelType: MODEL_HELPERS,
	hasApi: MODEL_HELPERS,
	calculateCost: MODEL_HELPERS,
	getSupportedThinkingLevels: offered,
	clampThinkingLevel: MODEL_HELPERS,
	modelsAreEqual: MODEL_HELPERS,
	registerSessionResourceCleanup: MODEL_HELPERS,
	cleanupSessionResources: MODEL_HELPERS,
} satisfies Record<keyof typeof PiAi, Coverage>;

describe("the coverage of pi-ai", () => {
	it("offers every value it records as offered, so the record stays true", () => {
		const ours = new Set(Object.keys(Package));
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && !ours.has(name))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});

	it("offers the faux provider and its helpers in testing", () => {
		const testing = new Set(Object.keys(Testing));
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === TESTING && !testing.has(name))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});
});
