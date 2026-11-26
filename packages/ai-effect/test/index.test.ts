// What this package does with every value pi-ai exports, in its root and in the subpaths an application uses: the
// record of what is offered as it is, what is replaced by an Effect form, and what is still open; and, for every
// subpath of pi-ai, where an application finds it or why it does not need it.

import { readdirSync, readFileSync } from "node:fs";
import * as PiAi from "@earendil-works/pi-ai";
import type * as PiModels from "@earendil-works/pi-ai/models";
import type * as PiSessionResources from "@earendil-works/pi-ai/session-resources";
import type * as PiDiagnostics from "@earendil-works/pi-ai/utils/diagnostics";
import * as PiEstimate from "@earendil-works/pi-ai/utils/estimate";
import type * as PiIdentity from "@earendil-works/pi-ai/utils/identity";
import type * as PiJsonParse from "@earendil-works/pi-ai/utils/json-parse";
import type * as PiOverflow from "@earendil-works/pi-ai/utils/overflow";
import type * as PiRetry from "@earendil-works/pi-ai/utils/retry";
import type * as PiStreamingJson from "@earendil-works/pi-ai/utils/streaming-json";
import type * as PiStringEnum from "@earendil-works/pi-ai/utils/string-enum";
import type * as PiTranscript from "@earendil-works/pi-ai/utils/transcript";
import type * as PiUuid from "@earendil-works/pi-ai/utils/uuid";
import type * as PiValidation from "@earendil-works/pi-ai/utils/validation";
import type * as PiVersion from "@earendil-works/pi-ai/utils/version";
import { describe, expect, it } from "vitest";
import type { Assert, Coverage, Covers } from "../../../effect/conformance.ts";
import * as Estimate from "../src/estimate.ts";
import * as Package from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";

const offered: Coverage = { kind: "offered" };
/**
 * Replaced by the export `by` names: a name of this package's root, or of a subpath (`testing/ScriptedModels`),
 * followed by a member (`Models.layer`).
 */
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** pi-ai's root. */
const COVERAGE = {
	// Models, requests and their failures.
	createModels: replaced("Models.layer"),
	InMemoryModelsStore: replaced("Models.layer"),
	// pi-ai's one error class: a request's failure is ModelRequestError, a lookup's ModelNotFound, an auth operation's
	// AuthError.
	ModelsError: replaced("AuthError"),
	EventStream: replaced("stream"),
	createProvider: offered,
	createAssistantMessageEventStream: offered,
	// Testing: the faux provider, and its core for a scripted provider of another API (ScriptedModels takes the API and
	// provider ids in its options).
	fauxText: replaced("testing/fauxText"),
	fauxThinking: replaced("testing/fauxThinking"),
	fauxToolCall: replaced("testing/fauxToolCall"),
	fauxAssistantMessage: replaced("testing/fauxAssistantMessage"),
	fauxProvider: replaced("testing/ScriptedModels.layer"),
	createFauxCore: replaced("testing/ScriptedModels.layer"),
	// The provider kit. A provider whose requests are Effects is `EffectProvider.make`; its lazy setup is the layer
	// it builds once. The streaming JSON parsers never throw and keep their own state, like an event stream.
	lazyStream: replaced("EffectProvider.make"),
	lazyApi: replaced("EffectProvider.make"),
	StreamingJsonParser: offered,
	ToolCallArgumentsStream: offered,
	parseStreamingJson: offered,
	parseToolCallArguments: offered,
	formatThrownValue: offered,
	// Credentials and auth. `envApiKeyAuth` and `lazyOAuth` build the auth of a pi-ai provider for `createProvider`:
	// building it does no I/O.
	defaultProviderAuthContext: replaced("ProviderAuthContext.layer"),
	InMemoryCredentialStore: replaced("Credentials.layerMemory"),
	envApiKeyAuth: offered,
	lazyOAuth: offered,
	// Prompt cache warming: the numbers and the decision are pure; the lifetime reads the environment, and the request
	// options exist for the refresh request.
	CACHE_WARMING_MAX_AGE_MS: offered,
	CACHE_WARMING_MAX_IDLE_AGE_MS: offered,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS: offered,
	CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY: offered,
	getCacheWarmingDelayMs: offered,
	getPromptCacheTtlMs: replaced("getPromptCacheTtlMs"),
	isCacheWarmingReplayable: offered,
	getCacheWarmingRequestOptions: replaced("warmCache"),
	evaluateCacheWarming: offered,
	// Client identity. `formatUserAgent` names the runtime (platform, architecture, version), which a process cannot
	// change: no environment variable is read.
	PI_ATTRIBUTION: offered,
	mergeClientIdentity: offered,
	getClientVersion: offered,
	formatUserAgent: offered,
	getAttributionHeaders: offered,
	getOpenCodeSessionHeaders: offered,
	getIdentityHeaders: offered,
	withClientIdentity: replaced("withClientIdentity"),
	// A model's JSON, retry and overflow.
	repairJson: offered,
	parseJsonWithRepair: replaced("parseJsonWithRepair"),
	isContextOverflow: offered,
	isRecoverableLength: offered,
	getOverflowPatterns: offered,
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS: offered,
	retryDelayMs: offered,
	retryAssistantCall: replaced("retryAssistantCall"),
	isRetryableAssistantError: offered,
	// Transcripts and tool declarations.
	contentText: offered,
	getSystemMessageText: offered,
	renderSystemMessageUpdate: offered,
	createInitialSystemMessage: offered,
	normalizeContext: offered,
	getInitialSystemMessage: offered,
	withoutInitialSystemMessage: offered,
	getCurrentTools: offered,
	getCurrentSystemMessage: offered,
	getCurrentSystemPrompt: offered,
	collapseSystemMessages: offered,
	resolveTranscript: offered,
	toToolDeclaration: offered,
	declarationsEqual: offered,
	getToolStateChanges: offered,
	getDeclaredTools: offered,
	hasToolRedefinitions: offered,
	hasNonAdditiveToolChanges: offered,
	resolveTranscriptTools: offered,
	validateToolCall: replaced("validateToolCall"),
	validateToolArguments: replaced("validateToolArguments"),
	StringEnum: offered,
	// Assistant message diagnostics.
	extractDiagnosticError: offered,
	createAssistantMessageDiagnostic: replaced("createAssistantMessageDiagnostic"),
	appendAssistantMessageDiagnostic: offered,
	// Models, usage and sessions.
	uuidv7: replaced("uuidv7"),
	PI_AI_VERSION: offered,
	AI_TELEMETRY_SCHEMA: offered,
	getModelType: offered,
	isModelType: offered,
	hasApi: offered,
	calculateCost: offered,
	getSupportedThinkingLevels: offered,
	clampThinkingLevel: offered,
	modelsAreEqual: offered,
	registerSessionResourceCleanup: replaced("registerSessionResourceCleanup"),
	cleanupSessionResources: replaced("cleanupSessionResources"),
} satisfies Record<keyof typeof PiAi, Coverage>;

/** pi-ai's token estimates (`utils/estimate`), the facade's `estimate` subpath. */
const ESTIMATE_COVERAGE = {
	calculateContextTokens: offered,
	estimateTextTokens: offered,
	estimateTextAndImageContentTokens: offered,
	estimateMessageTokens: offered,
	estimateContextTokens: offered,
} satisfies Record<keyof typeof PiEstimate, Coverage>;

/** Where an application finds one of pi-ai's subpaths in this package, or why it needs none. */
type Subpath =
	| { readonly kind: "root" }
	| { readonly kind: "facade"; readonly path: string }
	| { readonly kind: "not needed"; readonly why: string };

const IN_ROOT: Subpath = { kind: "root" };
const facade = (path: string): Subpath => ({ kind: "facade", path });
const notNeeded = (why: string): Subpath => ({ kind: "not needed", why });
const PROVIDER_INTERNALS = notNeeded(
	"a helper of pi-ai's providers and API implementations (HTTP bodies, SSE, headers, hashing, abort signals, " +
		"provider errors and prices); an application calls providers through `Models`",
);

/** Every subpath of pi-ai's `exports`. */
const SUBPATHS: Record<string, Subpath> = {
	".": facade("."),
	// Every value of these is also in pi-ai's root, recorded above (checked by the types below).
	"./models": IN_ROOT,
	"./session-resources": IN_ROOT,
	"./providers/*": facade("./providers/*"),
	"./oauth": notNeeded(
		"type-only: the OAuth types of coding-agent extensions, which the root's `export type *` re-exports " +
			"(OAuthCredentials, OAuthLoginCallbacks, ...)",
	),
	"./compat": notNeeded(
		"pi-ai's old global API (a registry of APIs, the built-in catalog, `stream` and `complete` with keys from the " +
			"environment, image generation), kept until coding-agent moves off it; an application uses `Models` with " +
			"the provider constructors",
	),
	"./api/*": notNeeded(
		"pi-ai's API implementations and their helpers, which its providers call; an application calls them through " +
			"`Models` with a provider of `@effectified/pi-ai/providers/<name>`, and their option types are in the root",
	),
	"./utils/*": facade("./estimate"),
	"./bedrock-provider": notNeeded(
		"the Bedrock implementation module that `amazonBedrockProvider` loads lazily; the provider is in `providers/amazon-bedrock`",
	),
	"./lazy-bedrock-provider": notNeeded(
		"registers that module with a literal import for bundlers; a bundling concern, not an API",
	),
	"./lazy-oauth": notNeeded(
		"registers the OAuth flows with literal imports for bundlers; a bundling concern, not an API",
	),
	"./bun-oauth": notNeeded("registers the OAuth flows for standalone Bun binaries; a bundling concern, not an API"),
};

/** Every module of pi-ai's `utils/*`. */
const UTILS: Record<string, Subpath> = {
	diagnostics: IN_ROOT,
	"event-stream": notNeeded(
		"`EventStream` and `createAssistantMessageEventStream` are in the root; its `AssistantMessageEventStream` class is what that function makes",
	),
	identity: IN_ROOT,
	"json-parse": IN_ROOT,
	overflow: IN_ROOT,
	retry: IN_ROOT,
	"streaming-json": IN_ROOT,
	"string-enum": IN_ROOT,
	transcript: IN_ROOT,
	uuid: IN_ROOT,
	validation: IN_ROOT,
	version: IN_ROOT,
	estimate: facade("./estimate"),
	"models-error": notNeeded("its `ModelsError` is in the root"),
	"model-operations": notNeeded(
		"`getModelType` and `isModelType` are in the root; the rest asserts a model's type and builds failed results inside `Models`",
	),
	text: notNeeded(
		"`contentText`, `getSystemMessageText` and `renderSystemMessageUpdate` are in the root; `ownedSlice` is a provider's memory helper",
	),
	"provider-env": notNeeded(
		"pi-ai's own read of the process environment; this package reads the environment through `Config` " +
			"(`ProviderAuthContext`, `getPromptCacheTtlMs`)",
	),
	sleep: notNeeded("a promise sleep on a signal; an Effect sleeps with `Effect.sleep`"),
	"oauth-page": notNeeded("the page pi-ai's OAuth callback servers answer the browser with; the login flows use it"),
	abort: PROVIDER_INTERNALS,
	"abort-signals": PROVIDER_INTERNALS,
	"error-body": PROVIDER_INTERNALS,
	hash: PROVIDER_INTERNALS,
	headers: PROVIDER_INTERNALS,
	"node-http-proxy": PROVIDER_INTERNALS,
	"openrouter-cost": PROVIDER_INTERNALS,
	"openrouter-finish-reason": PROVIDER_INTERNALS,
	"provider-retry": PROVIDER_INTERNALS,
	"sanitize-unicode": PROVIDER_INTERNALS,
	sse: PROVIDER_INTERNALS,
};

/** Every value of a subpath or `utils/*` module recorded `root` is a value of pi-ai's root, so its entry above. */
const IN_ROOT_COVERED: Assert<
	Covers<
		typeof PiModels &
			typeof PiSessionResources &
			typeof PiDiagnostics &
			typeof PiIdentity &
			typeof PiJsonParse &
			typeof PiOverflow &
			typeof PiRetry &
			typeof PiStreamingJson &
			typeof PiStringEnum &
			typeof PiTranscript &
			typeof PiUuid &
			typeof PiValidation &
			typeof PiVersion,
		typeof COVERAGE
	>
> = true;

const LEDGERS = [
	["pi-ai", COVERAGE, PiAi, Package],
	["pi-ai/utils/estimate", ESTIMATE_COVERAGE, PiEstimate, Estimate],
] as const;

const MODULES: Record<string, Record<string, unknown>> = { "": Package, testing: Testing };

/** The value `by` names: `[module/]Name[.member]`. */
function resolve(by: string): unknown {
	const [module, path] = by.includes("/") ? by.split("/") : ["", by];
	let value: unknown = MODULES[module ?? ""];
	for (const part of (path ?? "").split(".")) {
		value = typeof value === "object" || typeof value === "function" ? Reflect.get(value ?? {}, part) : undefined;
	}
	return value;
}

describe.each(LEDGERS)("the coverage of %s", (_name, coverage, pi, ours) => {
	const entries: ReadonlyArray<readonly [string, Coverage]> = Object.entries(coverage);

	it("offers pi-ai's own value for every entry it records as offered", () => {
		const exported: Record<string, unknown> = ours;
		const piValues: Record<string, unknown> = pi;
		const wrong = entries
			.filter(([name, entry]) => entry.kind === "offered" && exported[name] !== piValues[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});

	it("exports the Effect form every replaced entry names", () => {
		const missing = entries.flatMap(([name, entry]) =>
			entry.kind === "replaced" && resolve(entry.by) === undefined ? [`${name}: ${entry.by}`] : [],
		);
		expect(missing).toEqual([]);
	});

	it("leaves nothing open", () => {
		expect(entries.filter(([, entry]) => entry.kind === "open")).toEqual([]);
	});
});

describe("the subpaths of pi-ai", () => {
	const aiPackage = new URL("../../ai/", import.meta.url);

	it("are each recorded: where an application finds them, or why it needs none", () => {
		const manifest: { exports: Record<string, unknown> } = JSON.parse(
			readFileSync(new URL("package.json", aiPackage), "utf8"),
		);
		expect(Object.keys(SUBPATHS).sort()).toEqual(Object.keys(manifest.exports).sort());
	});

	it("record as root only modules whose every value the root ledger records (checked by the types)", () => {
		expect(IN_ROOT_COVERED).toBe(true);
	});

	it("record every module of utils", () => {
		const modules = readdirSync(new URL("src/utils/", aiPackage))
			.filter((file) => file.endsWith(".ts"))
			.map((file) => file.slice(0, -".ts".length));
		expect(Object.keys(UTILS).sort()).toEqual(modules.sort());
	});

	it("name subpaths this package exports", () => {
		const manifest: { exports: Record<string, unknown> } = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		const named = [...Object.values(SUBPATHS), ...Object.values(UTILS)].flatMap((entry) =>
			entry.kind === "facade" ? [entry.path] : [],
		);
		expect(named.filter((path) => !(path in manifest.exports))).toEqual([]);
	});
});
