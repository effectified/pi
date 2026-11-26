// What coding-agent-effect lists of pi-coding-agent by hand, checked against pi-coding-agent's own types. Type-only:
// nothing here runs. A failure names what moved upstream.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionEvent,
	ExtensionToolContext,
	ExtensionUIContext,
	AgentSession as PiAgentSession,
	AgentSessionRuntime as PiAgentSessionRuntime,
	ExtensionContext as PiExtensionContext,
	InteractiveMode as PiInteractiveMode,
	ModelRegistry as PiModelRegistry,
	ModelRuntime as PiModelRuntime,
	PackageManager as PiPackageManager,
	ProjectTrustStore as PiProjectTrustStore,
	ResourceLoader as PiResourceLoader,
	RpcClient as PiRpcClient,
	SessionManager as PiSessionManager,
	SettingsManager as PiSettingsManager,
	SettingsCallbacks,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type * as AgentSessionModule from "../src/agent-session.ts";
import type * as RuntimeModule from "../src/agent-session-runtime.ts";
import type * as ApiModule from "../src/extension-api.ts";
import type { AnswerOf, EventOf, EventType, Handlers } from "../src/handlers.ts";
import type {
	AgentSessionHandle,
	AgentSessionRuntimeHandle,
	CommandContextHandle,
	ExtensionApiHandle,
	ExtensionContextHandle,
	InteractiveModeHandle,
	ModelRegistryHandle,
	ModelRuntimeHandle,
	PackageManagerHandle,
	RpcClientHandle,
	Tool,
	ToolContextHandle,
	Ui,
} from "../src/index.ts";
import type { MethodKeys } from "../src/lift.ts";
import type * as PackageModule from "../src/package-manager.ts";
import type * as LoaderModule from "../src/resource-loader.ts";
import type * as RpcModule from "../src/rpc-client.ts";
import type * as SelectorsModule from "../src/selectors.ts";
import type * as SessionModule from "../src/session-manager.ts";
import type * as SettingsModule from "../src/settings-manager.ts";
import type * as TrustModule from "../src/trust-store.ts";

/** The methods a facade lists, read and write together. */
type Listed<M extends { readonly READS: ReadonlyArray<unknown>; readonly WRITES: ReadonlyArray<unknown> }> =
	| M["READS"][number]
	| M["WRITES"][number];

/**
 * The session manager's lists are exactly its public methods (but `_persist`, its own write of an entry, public only
 * by its name's convention): a method Pi adds fails here until it is sorted.
 */
export type SessionManagerListed = Assert<
	Conform<Listed<typeof SessionModule> | "_persist", MethodKeys<PiSessionManager>>
>;

/** The read-only view of a session is exactly Pi's `ReadonlySessionManager`, the one an extension context holds. */
export type SessionViewListed = Assert<
	Conform<(typeof SessionModule.VIEW)[number], MethodKeys<PiExtensionContext["sessionManager"]>>
>;

/** The settings manager's lists are exactly its public methods. */
export type SettingsManagerListed = Assert<
	Conform<Listed<typeof SettingsModule> | (typeof SettingsModule.AWAITS)[number], MethodKeys<PiSettingsManager>>
>;

/** The resource loader's lists are exactly the methods of Pi's `ResourceLoader` interface. */
export type ResourceLoaderListed = Assert<
	Conform<Listed<typeof LoaderModule> | (typeof LoaderModule.AWAITS)[number], MethodKeys<PiResourceLoader>>
>;

/** The trust store's lists are exactly its public methods. */
export type TrustStoreListed = Assert<Conform<Listed<typeof TrustModule>, MethodKeys<PiProjectTrustStore>>>;

/** Every method of Pi's package manager is a member, or its progress callback, which `progress` streams. */
export type PackageManagerCovered = Assert<Covers<PiPackageManager, PackageManagerHandle, "setProgressCallback">>;

/** The package manager's lists name methods of Pi's manager only. */
export type PackageManagerListed = Assert<
	Covers<
		Pick<PiPackageManager, Listed<typeof PackageModule> | (typeof PackageModule.AWAITS)[number]>,
		PackageManagerHandle
	>
>;

/**
 * Every public member of Pi's session is a member of the handle, or named here: what the handle owns or Pi keeps for
 * its own host.
 */
export type AgentSessionCovered = Assert<
	Covers<
		PiAgentSession,
		AgentSessionHandle,
		// pi-agent-core's agent and the extension runner: the session's own machinery, driven through its members.
		| "agent"
		| "extensionRunner"
		// Closing the session's scope disposes it.
		| "dispose"
		// What the runtime hands a `withSession` callback; `InNewSession` runs with it.
		| "createReplacedSessionContext"
	>
>;

/** The session's lists name members of Pi's session, each once. */
export type AgentSessionListed = Assert<
	Covers<
		Pick<
			PiAgentSession,
			| (typeof AgentSessionModule.FIELDS)[number]
			| Listed<typeof AgentSessionModule>
			| (typeof AgentSessionModule.AWAITS)[number]
		>,
		AgentSessionHandle
	>
>;

/** Every public member of Pi's interactive mode is a member of the handle, or what `make` and its scope do. */
export type InteractiveModeCovered = Assert<Covers<PiInteractiveMode, InteractiveModeHandle, "init" | "stop">>;

/** The settings selector's list of callbacks is exactly Pi's `SettingsCallbacks`, each a kind of its events. */
export type SettingsCallbacksListed = Assert<
	Conform<(typeof SelectorsModule.SETTINGS_CALLBACKS)[number], keyof SettingsCallbacks>
>;

/** Every public member of Pi's runtime is a member of the handle, or disposed of by its scope. */
export type RuntimeCovered = Assert<Covers<PiAgentSessionRuntime, AgentSessionRuntimeHandle, "dispose">>;

/** The runtime's lists name members of Pi's runtime. */
export type RuntimeListed = Assert<
	Covers<
		Pick<PiAgentSessionRuntime, (typeof RuntimeModule.FIELDS)[number] | (typeof RuntimeModule.READS)[number]>,
		AgentSessionRuntimeHandle
	>
>;

/** The requests a model runtime makes, which a session makes through it; and OAuth's interactive login. */
type RuntimeRequests =
	| "stream"
	| "complete"
	| "streamSimple"
	| "completeSimple"
	| "streamDeferred"
	| "fetchDeferred"
	| "cancelDeferred"
	| "generateImages"
	| "classify"
	| "login";

/** Every public member of Pi's model runtime is a member of the handle, or one of its requests or its login. */
export type ModelRuntimeCovered = Assert<Covers<PiModelRuntime, ModelRuntimeHandle, RuntimeRequests>>;

/** Every public member of Pi's model registry is a member of the handle, or one of its requests, which a session makes. */
export type ModelRegistryCovered = Assert<
	Covers<PiModelRegistry, ModelRegistryHandle, "stream" | "streamSimple" | "complete" | "classify" | "generateImages">
>;

/** Every command of Pi's RPC client is a member, or one of what the client's scope does (`start`, `stop`). */
export type RpcClientCovered = Assert<Covers<PiRpcClient, RpcClientHandle, "start" | "stop" | "onEvent">>;

/** The RPC client's lists name methods of Pi's client. */
export type RpcClientListed = Assert<
	Covers<Pick<PiRpcClient, (typeof RpcModule.AWAITS)[number] | (typeof RpcModule.READS)[number]>, RpcClientHandle>
>;

/**
 * Every member of Pi's extension context is a member of the handle, or the abort signal, which the fiber owns
 * (interrupting a tool's fiber aborts its call).
 */
export type ExtensionContextCovered = Assert<Covers<PiExtensionContext, ExtensionContextHandle, "signal">>;

/** Every member a tool context adds to the extension context is a member of the tool context handle. */
export type ToolContextCovered = Assert<
	Covers<Omit<ExtensionToolContext, keyof PiExtensionContext>, ToolContextHandle>
>;

/** Every member a command context adds to the extension context is a member of the command context handle. */
export type CommandContextCovered = Assert<
	Covers<Omit<ExtensionCommandContext, keyof PiExtensionContext>, CommandContextHandle>
>;

/**
 * Every method of Pi's UI is one of `Ui`, or one that hands Pi a component, a factory of one or a raw input listener,
 * which `Ui` does not wrap yet (an extension that draws reaches them through Pi's context).
 */
export type UiCovered = Assert<
	Covers<
		ExtensionUIContext,
		Ui,
		| "onTerminalInput"
		| "setFooter"
		| "setHeader"
		| "custom"
		| "addAutocompleteProvider"
		| "setEditorComponent"
		| "getEditorComponent"
		| "theme"
		| "getTheme"
	>
>;

/**
 * Every member of Pi's extension API is a member of the handle, a part of `Extension.make` (`on`), or a renderer (a
 * factory of components Pi calls while drawing), which the handle does not wrap yet.
 */
export type ExtensionApiCovered = Assert<
	Covers<
		ExtensionAPI,
		ExtensionApiHandle,
		"on" | "events" | "registerMessageRenderer" | "registerEntryRenderer" | "registerToolRenderer"
	>
>;

/** The extension API's lists name methods of Pi's API. */
export type ExtensionApiListed = Assert<Covers<Pick<ExtensionAPI, Listed<typeof ApiModule>>, ExtensionApiHandle>>;

/** Every event of Pi's extensions has a handler key, and every handler key is an event. */
export type HandlersCovered = Assert<Conform<keyof Handlers, ExtensionEvent["type"]>>;

/** Pi's handler of the event `K`, built from the handler of `Handlers`, as `subscribe` builds it. */
type PiHandlerOf<K extends EventType> = (event: EventOf<K>, ctx: PiExtensionContext) => Promise<AnswerOf<K>>;

/**
 * Pi's `on` takes, for each event, a handler of that event that answers with `AnswerOf` of it: the answers listed in
 * `Answers` are Pi's. Never called; it compiles only while Pi's overloads accept each one.
 */
export function onTakesEachHandler(pi: ExtensionAPI): void {
	pi.on("resources_discover", handler("resources_discover"));
	pi.on("session_start", handler("session_start"));
	pi.on("session_info_changed", handler("session_info_changed"));
	pi.on("session_before_switch", handler("session_before_switch"));
	pi.on("session_before_fork", handler("session_before_fork"));
	pi.on("session_before_compact", handler("session_before_compact"));
	pi.on("session_compact", handler("session_compact"));
	pi.on("session_compact_failed", handler("session_compact_failed"));
	pi.on("session_shutdown", handler("session_shutdown"));
	pi.on("mcp_servers_change", handler("mcp_servers_change"));
	pi.on("session_before_tree", handler("session_before_tree"));
	pi.on("session_tree", handler("session_tree"));
	pi.on("context", handler("context"));
	pi.on("context_with_system", handler("context_with_system"));
	pi.on("cache_warming_decision", handler("cache_warming_decision"));
	pi.on("before_provider_request", handler("before_provider_request"));
	pi.on("before_provider_headers", handler("before_provider_headers"));
	pi.on("after_provider_response", handler("after_provider_response"));
	pi.on("provider_stream_event", handler("provider_stream_event"));
	pi.on("before_agent_start", handler("before_agent_start"));
	pi.on("agent_start", handler("agent_start"));
	pi.on("agent_end", handler("agent_end"));
	pi.on("agent_before_settle", handler("agent_before_settle"));
	pi.on("agent_settled", handler("agent_settled"));
	pi.on("ui_prompt_start", handler("ui_prompt_start"));
	pi.on("ui_prompt_end", handler("ui_prompt_end"));
	pi.on("turn_start", handler("turn_start"));
	pi.on("turn_end", handler("turn_end"));
	pi.on("message_start", handler("message_start"));
	pi.on("message_update", handler("message_update"));
	pi.on("message_end", handler("message_end"));
	pi.on("tool_execution_start", handler("tool_execution_start"));
	pi.on("tool_execution_update", handler("tool_execution_update"));
	pi.on("tool_execution_end", handler("tool_execution_end"));
	pi.on("model_select", handler("model_select"));
	pi.on("thinking_level_select", handler("thinking_level_select"));
	pi.on("tool_call", handler("tool_call"));
	pi.on("tool_result", handler("tool_result"));
	pi.on("user_bash", handler("user_bash"));
	pi.on("input", handler("input"));
}

/** A handler of `type`, for the checks above. */
declare function handler<K extends EventType>(type: K): PiHandlerOf<K>;

/** The events `onTakesEachHandler` checks are every event a handler of `Extension.make` gets. */
export type OnChecksEveryEvent = Assert<Conform<Parameters<typeof handler>[0], EventType>>;

/**
 * Every field of Pi's tool definition is set from `Tool.make`'s options, or a renderer of interactive mode (not
 * wrapped yet), or built by `make`: `execute` runs the handler, `outputSchema` is `success`'s JSON Schema.
 */
export type ToolCovered = Assert<
	Covers<
		ToolDefinition,
		Tool.Options<never, never, never, never> & { readonly name: string },
		"execute" | "outputSchema" | "renderShell" | "renderCall" | "renderResult"
	>
>;

/** An Effect handler answers what Pi's handler answers. */
export type HandlerAnswers = Assert<
	Conform<
		Effect.Success<ReturnType<NonNullable<Handlers["tool_call"]>>>,
		Awaited<ReturnType<PiHandlerOf<"tool_call">>>
	>
>;
