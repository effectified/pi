import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });
const open = (why: string): Coverage => ({ kind: "open", why });

/** Interactive mode's parts: they need the terminal UI in Effect terms. */
const TUI = open("waits for @effectified/pi-tui");

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
	InteractiveMode: TUI,
	// Files and the system.
	copyToClipboard: replaced("copyToClipboard (an Effect)"),
	parseFrontmatter: offered,
	stripFrontmatter: offered,
	convertToPng: replaced("convertToPng (an Effect)"),
	formatDimensionNote: offered,
	resizeImage: replaced("resizeImage (an Effect)"),
	detectSupportedImageMimeTypeFromFile: replaced("detectSupportedImageMimeTypeFromFile (an Effect)"),
	// Interactive mode's components, theme and terminal formatting.
	ArminComponent: TUI,
	AssistantMessageComponent: TUI,
	BashExecutionComponent: TUI,
	BorderedLoader: TUI,
	BranchSummaryMessageComponent: TUI,
	CompactionSummaryMessageComponent: TUI,
	CustomEditor: TUI,
	CustomMessageComponent: TUI,
	DynamicBorder: TUI,
	ExtensionEditorComponent: TUI,
	ExtensionInputComponent: TUI,
	ExtensionSelectorComponent: TUI,
	FooterComponent: TUI,
	LoginDialogComponent: TUI,
	ModelSelectorComponent: TUI,
	OAuthSelectorComponent: TUI,
	SessionSelectorComponent: TUI,
	SettingsSelectorComponent: TUI,
	ShowImagesSelectorComponent: TUI,
	SkillInvocationMessageComponent: TUI,
	ThemeSelectorComponent: TUI,
	ThinkingSelectorComponent: TUI,
	ToolExecutionComponent: TUI,
	TreeSelectorComponent: TUI,
	UserMessageComponent: TUI,
	UserMessageSelectorComponent: TUI,
	Theme: TUI,
	initTheme: TUI,
	getMarkdownTheme: TUI,
	getSelectListTheme: TUI,
	getSettingsListTheme: TUI,
	highlightCode: TUI,
	keyHint: TUI,
	keyText: TUI,
	rawKeyHint: TUI,
	renderDiff: TUI,
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

	it("leaves open only the parts of interactive mode, which wait for @effectified/pi-tui", () => {
		const opened = Object.entries(COVERAGE).filter(([, coverage]) => coverage.kind === "open");
		expect(opened.every(([, coverage]) => coverage === TUI)).toBe(true);
		expect(opened.length).toBe(37);
	});
});
