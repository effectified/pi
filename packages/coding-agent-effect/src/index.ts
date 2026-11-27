// Pi's coding agent in Effect: extensions written as Effect programs, sessions as scoped services, prompts as Effects
// and events as Streams.

// Every type pi-coding-agent declares (`AgentSessionEvent`, `ToolDefinition`, `SessionEntry`, `Settings`, ...), so an
// application names them without importing Pi; where this package exports a name of its own, its own wins.
export type * from "@earendil-works/pi-coding-agent";
// pi-coding-agent's own names for what this package's services and namespaces of the same name hide.
export type {
	AgentSession as PiAgentSession,
	AgentSessionRuntime as PiAgentSessionRuntime,
	CredentialSynchronizationError as PiCredentialSynchronizationError,
	Extension as PiExtension,
	ExtensionContext as PiExtensionContext,
	ModelRegistry as PiModelRegistry,
	ModelRuntime as PiModelRuntime,
	PackageManager as PiPackageManager,
	ProjectTrustContext as PiProjectTrustContext,
	ProjectTrustStore as PiProjectTrustStore,
	ResourceLoader as PiResourceLoader,
	RpcClient as PiRpcClient,
	SessionManager as PiSessionManager,
	SettingsManager as PiSettingsManager,
} from "@earendil-works/pi-coding-agent";
// pi-coding-agent's pure values: the CLI's argument parser and configuration paths, session entries and context,
// compaction's token arithmetic and cut points, the guards of tool events, truncation and diffs, frontmatter, the
// built-in extensions as Pi factories (for `ResourceLoader`'s `extensionFactories`) and the local shell operations of
// the built-in tools. Synchronous; the lookups read the environment, none starts work. And interactive mode's parts that
// are plain objects, as `@effectified/pi-tui` offers pi-tui's: the message views, the border, the footer, the editor
// (its callback properties are Streams through pi-tui's `events`), the `Theme` class, and the theme helpers a
// component's synchronous `render` calls, which read the process's theme and keybindings as pi-tui's components do.
export {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	CONFIG_DIR_NAME,
	CompactionSummaryMessageComponent,
	CURRENT_SESSION_VERSION,
	CustomEditor,
	CustomMessageComponent,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	convertToLlm,
	createCodemodeExtension,
	createEventBus,
	createExtensionRuntime,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createMcpExtension,
	createSyntheticSourceInfo,
	createToolSearchExtension,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DynamicBorder,
	estimateTokens,
	FooterComponent,
	findCutPoint,
	findTurnStartIndex,
	formatDimensionNote,
	formatReadLineRange,
	formatSize,
	formatSkillsForPrompt,
	generateDiffString,
	generateUnifiedPatch,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getLanguageFromPath,
	getLastAssistantUsage,
	getLatestCompactionEntry,
	getMarkdownTheme,
	getPackageDir,
	getReadmePath,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isPowerShellToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	keyHint,
	keyText,
	migrateSessionEntries,
	parseArgs,
	parseFrontmatter,
	parseSessionEntries,
	parseSkillBlock,
	prepareBranchEntries,
	rawKeyHint,
	renderDiff,
	resolveCliModel,
	SkillInvocationMessageComponent,
	serializeConversation,
	sessionEntryToContextMessages,
	shouldCompact,
	stripFrontmatter,
	Theme,
	ToolExecutionComponent,
	truncateHead,
	truncateLine,
	truncateTail,
	truncateToVisualLines,
	UserMessageComponent,
	VERSION,
	VIRTUAL_MODEL_STATE_ENTRY,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
export {
	AgentSession,
	type AgentSessionHandle,
	type BashOptions,
	type Bindings,
	type FromServicesOptions,
	type NavigateOptions,
	type Options as AgentSessionOptions,
	type Prompt,
	type ServicesHandle,
	type ServicesOptions,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeHandle,
	type Options as AgentSessionRuntimeOptions,
} from "./agent-session-runtime.ts";
export { armin, bashExecution, borderedLoader } from "./animated-components.ts";
export * as Builtin from "./builtin.ts";
export { copyToClipboard } from "./clipboard.ts";
export * as Command from "./command.ts";
export * as Compaction from "./compaction.ts";
export type { ComponentEvent, WithEvents } from "./component-events.ts";
export {
	type ExtensionEditorCallbacks,
	type ExtensionInputCallbacks,
	type ExtensionSelectorCallbacks,
	extensionEditor,
	extensionInput,
	extensionSelector,
	type LoginDialogCallbacks,
	loginDialog,
} from "./dialogs.ts";
export {
	CodingAgentError,
	CodingAgentFailure,
	CredentialSynchronizationError,
	SessionImportFileNotFound,
} from "./errors.ts";
export * as Extension from "./extension.ts";
export {
	type CommandOptions,
	ExtensionApi,
	type ExtensionApiHandle,
	type Shortcut,
	type VirtualModel,
} from "./extension-api.ts";
export {
	CommandContext,
	type CommandContextHandle,
	type DialogOptions,
	ExtensionContext,
	type ExtensionContextHandle,
	type InNewSession,
	ProjectTrustContext,
	type ProjectTrustContextHandle,
	ReplacedSessionContext,
	type ReplacedSessionContextHandle,
	Replacement,
	ToolContext,
	type ToolContextHandle,
	type Ui,
} from "./extension-context.ts";
export type { AnswerOf, Answers, EventOf, EventType, Handlers } from "./handlers.ts";
export { convertToPng, detectSupportedImageMimeTypeFromFile, resizeImage } from "./images.ts";
export {
	Ending as InteractiveModeEnding,
	InteractiveMode,
	type InteractiveModeHandle,
	type Options as InteractiveModeOptions,
} from "./interactive-mode.ts";
export * as McpTools from "./mcp-tools.ts";
export { ModelRegistry, type ModelRegistryHandle } from "./model-registry.ts";
export {
	type AuthOptions,
	type AuthTarget,
	ModelRuntime,
	type ModelRuntimeHandle,
	readStoredCredential,
	resolveModelScopeWithDiagnostics,
} from "./model-runtime.ts";
export * as Modes from "./modes.ts";
export {
	type MissingSourceAction,
	type Options as PackageManagerOptions,
	PackageManager,
	type PackageManagerHandle,
} from "./package-manager.ts";
export {
	discoverAndLoadExtensions,
	loadProjectContextFiles,
	type Options as ResourceLoaderOptions,
	ResourceLoader,
	type ResourceLoaderHandle,
} from "./resource-loader.ts";
export { RpcClient, type RpcClientHandle } from "./rpc-client.ts";
export {
	type ModelSelectorCallbacks,
	modelSelector,
	type OAuthSelectorCallbacks,
	oauthSelector,
	type SessionSelectorCallbacks,
	type SessionSelectorOptions,
	type ShowImagesSelectorCallbacks,
	sessionSelector,
	settingsSelector,
	showImagesSelector,
	type ThemeSelectorCallbacks,
	type ThinkingSelectorCallbacks,
	type TreeSelectorCallbacks,
	themeSelector,
	thinkingSelector,
	treeSelector,
	type UserMessageSelectorCallbacks,
	userMessageSelector,
} from "./selectors.ts";
export { SessionManager, type SessionManagerHandle, type SessionView } from "./session-manager.ts";
export { SettingsManager, type SettingsManagerHandle } from "./settings-manager.ts";
export { getPowerShellConfig, getShellConfig } from "./shell.ts";
export { loadSkills, loadSkillsFromDir } from "./skills.ts";
export { initTheme } from "./theme.ts";
export * as Tool from "./tool.ts";
export { hasTrustRequiringProjectResources, ProjectTrustStore, type ProjectTrustStoreHandle } from "./trust-store.ts";
