import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** A component of interactive mode whose constructor takes callbacks: made for a scope, its calls a Stream. */
const withEvents = (by: string): Coverage =>
	replaced(`${by}: a scoped Effect giving the component and its callbacks as a Stream`);

/** A component of interactive mode that animates on a timer from the moment it is made. */
const animated = (by: string): Coverage => replaced(`${by}: a scoped Effect, its timer stopped when the scope closes`);

/** What this package does with every value pi-coding-agent exports. */
const COVERAGE = {
	// The CLI's arguments and configuration paths: pure values and lookups.
	parseArgs: offered,
	CONFIG_DIR_NAME: offered,
	getAgentDir: offered,
	getDocsPath: offered,
	getExamplesPath: offered,
	getPackageDir: offered,
	getReadmePath: offered,
	VERSION: offered,
	// Sessions.
	AgentSession: replaced("AgentSession.make, AgentSession.layer and AgentSession.fromPi: a scoped session handle"),
	parseSkillBlock: offered,
	readStoredCredential: replaced("readStoredCredential (an Effect)"),
	AgentSessionRuntime: replaced("AgentSessionRuntime.make and AgentSessionRuntime.layer: a scoped runtime handle"),
	createAgentSession: replaced("AgentSession.make"),
	createAgentSessionFromServices: replaced("AgentSession.fromServices"),
	createAgentSessionRuntime: replaced("AgentSessionRuntime.make"),
	createAgentSessionServices: replaced("AgentSession.services"),
	SessionManager: replaced("SessionManager: its methods as Effects, its constructors and listings as Effects"),
	SettingsManager: replaced("SettingsManager: its methods as Effects, create scoped (its saves are waited for)"),
	buildContextEntries: offered,
	buildSessionContext: offered,
	buildSessionProjection: offered,
	CURRENT_SESSION_VERSION: offered,
	getLatestCompactionEntry: offered,
	migrateSessionEntries: offered,
	parseSessionEntries: offered,
	sessionEntryToContextMessages: offered,
	convertToLlm: offered,
	// Compaction and summaries.
	calculateContextTokens: offered,
	collectEntriesForBranchSummary: offered,
	compact: replaced("Compaction.compact"),
	DEFAULT_COMPACTION_SETTINGS: offered,
	estimateTokens: offered,
	findCutPoint: offered,
	findTurnStartIndex: offered,
	generateBranchSummary: replaced("Compaction.generateBranchSummary"),
	generateSummary: replaced("Compaction.generateSummary (its text)"),
	generateSummaryWithUsage: replaced("Compaction.generateSummary"),
	getLastAssistantUsage: offered,
	prepareBranchEntries: offered,
	serializeConversation: offered,
	shouldCompact: offered,
	// Extensions.
	createEventBus: offered,
	createExtensionRuntime: offered,
	defineTool: replaced("Tool.make"),
	discoverAndLoadExtensions: replaced("discoverAndLoadExtensions (an Effect)"),
	ExtensionRunner: replaced(
		"AgentSession, which runs it: bindExtensions, extensionErrors, hasExtensionHandlers; extensions are Extension.make",
	),
	isBashToolResult: offered,
	isEditToolResult: offered,
	isFindToolResult: offered,
	isGrepToolResult: offered,
	isLsToolResult: offered,
	isPowerShellToolResult: offered,
	isReadToolResult: offered,
	isToolCallEventType: offered,
	isWriteToolResult: offered,
	wrapRegisteredTool: offered,
	wrapRegisteredTools: offered,
	createSyntheticSourceInfo: offered,
	createCodemodeExtension: offered,
	createMcpExtension: offered,
	createToolSearchExtension: offered,
	// Models.
	ModelRegistry: replaced("ModelRegistry: its queries as Effects"),
	resolveCliModel: offered,
	resolveModelScopeWithDiagnostics: replaced("resolveModelScopeWithDiagnostics (an Effect)"),
	CredentialSynchronizationError: replaced("CredentialSynchronizationError (a tagged error)"),
	ModelRuntime: replaced("ModelRuntime.layer and ModelRuntime.make: its queries and credential operations as Effects"),
	VIRTUAL_MODEL_STATE_ENTRY: offered,
	// Resources, packages and trust.
	DefaultPackageManager: replaced("PackageManager.make: its operations as Effects, its progress as a Stream"),
	DefaultResourceLoader: replaced("ResourceLoader.make: Pi's default loader with extensions written in Effect"),
	loadProjectContextFiles: replaced("loadProjectContextFiles (an Effect)"),
	formatSkillsForPrompt: offered,
	loadSkills: replaced("loadSkills (an Effect)"),
	loadSkillsFromDir: replaced("loadSkillsFromDir (an Effect)"),
	hasTrustRequiringProjectResources: replaced("hasTrustRequiringProjectResources (an Effect)"),
	ProjectTrustStore: replaced("ProjectTrustStore.make: its decisions read and written as Effects"),
	// Tools.
	createBashTool: replaced("Builtin.bash(...).agentTool"),
	createCodingTools: replaced("Builtin.coding"),
	createEditTool: replaced("Builtin.edit(...).agentTool"),
	createFindTool: replaced("Builtin.find(...).agentTool"),
	createGrepTool: replaced("Builtin.grep(...).agentTool"),
	createLsTool: replaced("Builtin.ls(...).agentTool"),
	createPowerShellTool: replaced("Builtin.powershell(...).agentTool"),
	createReadOnlyTools: replaced("Builtin.readOnly"),
	createReadTool: replaced("Builtin.read(...).agentTool"),
	createWriteTool: replaced("Builtin.write(...).agentTool"),
	createBashToolDefinition: replaced("Builtin.bash: its definition, and its run as an Effect"),
	createEditToolDefinition: replaced("Builtin.edit"),
	createFindToolDefinition: replaced("Builtin.find"),
	createGrepToolDefinition: replaced("Builtin.grep"),
	createLsToolDefinition: replaced("Builtin.ls"),
	createPowerShellToolDefinition: replaced("Builtin.powershell"),
	createReadToolDefinition: replaced("Builtin.read"),
	createWriteToolDefinition: replaced("Builtin.write"),
	createLocalBashOperations: offered,
	createLocalPowerShellOperations: offered,
	DEFAULT_MAX_BYTES: offered,
	DEFAULT_MAX_LINES: offered,
	formatSize: offered,
	truncateHead: offered,
	truncateLine: offered,
	truncateTail: offered,
	withFileMutationQueue: replaced("Builtin.withFileMutationQueue"),
	formatReadLineRange: offered,
	generateDiffString: offered,
	generateUnifiedPatch: offered,
	getPowerShellConfig: replaced("getPowerShellConfig (an Effect)"),
	getShellConfig: replaced("getShellConfig (an Effect)"),
	// Modes.
	main: replaced("Modes.main"),
	runPrintMode: replaced("Modes.print"),
	runRpcMode: replaced("Modes.rpc"),
	RpcClient: replaced("RpcClient.make: a scoped agent process, its commands as Effects, its events as a Stream"),
	InteractiveMode: replaced(
		"InteractiveMode.make and InteractiveMode.layer: started for the scope, run until the user quits, its TUI the Tui service",
	),
	// Files and the system.
	copyToClipboard: replaced("copyToClipboard (an Effect)"),
	parseFrontmatter: offered,
	stripFrontmatter: offered,
	convertToPng: replaced("convertToPng (an Effect)"),
	formatDimensionNote: offered,
	resizeImage: replaced("resizeImage (an Effect)"),
	detectSupportedImageMimeTypeFromFile: replaced("detectSupportedImageMimeTypeFromFile (an Effect)"),
	// Interactive mode's components. Those that are plain objects are offered as pi-tui's are; their callback properties
	// are Streams through pi-tui's `events`.
	AssistantMessageComponent: offered,
	BranchSummaryMessageComponent: offered,
	CompactionSummaryMessageComponent: offered,
	CustomEditor: offered,
	CustomMessageComponent: offered,
	DynamicBorder: offered,
	FooterComponent: offered,
	SkillInvocationMessageComponent: offered,
	ToolExecutionComponent: offered,
	UserMessageComponent: offered,
	ArminComponent: animated("armin"),
	BashExecutionComponent: animated("bashExecution"),
	BorderedLoader: animated("borderedLoader"),
	ExtensionEditorComponent: withEvents("extensionEditor"),
	ExtensionInputComponent: withEvents("extensionInput"),
	ExtensionSelectorComponent: withEvents("extensionSelector"),
	LoginDialogComponent: withEvents("loginDialog"),
	ModelSelectorComponent: withEvents("modelSelector"),
	OAuthSelectorComponent: withEvents("oauthSelector"),
	SessionSelectorComponent: withEvents("sessionSelector"),
	SettingsSelectorComponent: withEvents("settingsSelector"),
	ShowImagesSelectorComponent: withEvents("showImagesSelector"),
	ThemeSelectorComponent: withEvents("themeSelector"),
	ThinkingSelectorComponent: withEvents("thinkingSelector"),
	TreeSelectorComponent: withEvents("treeSelector"),
	UserMessageSelectorComponent: withEvents("userMessageSelector"),
	// The theme: the class and the helpers a component's synchronous `render` calls, which read the process's theme
	// and keybindings at the call, as pi-tui's components read their keybindings. Setting the theme is an Effect.
	Theme: offered,
	getMarkdownTheme: offered,
	getSelectListTheme: offered,
	getSettingsListTheme: offered,
	highlightCode: offered,
	keyHint: offered,
	keyText: offered,
	rawKeyHint: offered,
	renderDiff: offered,
	initTheme: replaced("initTheme: an Effect that sets the process's theme"),
	getLanguageFromPath: offered,
	truncateToVisualLines: offered,
} satisfies Record<keyof typeof PiCodingAgent, Coverage>;

describe("the coverage of pi-coding-agent", () => {
	it("offers every value it records as offered, Pi's own and not copies", () => {
		const ours: Record<string, unknown> = Package;
		const theirs: Record<string, unknown> = PiCodingAgent;
		const differing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== theirs[name])
			.map(([name]) => name);
		expect(differing).toEqual([]);
	});

	it("exports no value it records as replaced under Pi's name unless it is the Effect form", () => {
		const ours: Record<string, unknown> = Package;
		const theirs: Record<string, unknown> = PiCodingAgent;
		const same = Object.entries(COVERAGE)
			.filter(
				([name, coverage]) =>
					coverage.kind === "replaced" && ours[name] !== undefined && ours[name] === theirs[name],
			)
			.map(([name]) => name);
		expect(same).toEqual([]);
	});

	it("leaves nothing open", () => {
		expect(Object.values(COVERAGE).filter((coverage) => coverage.kind === "open")).toEqual([]);
	});
});
