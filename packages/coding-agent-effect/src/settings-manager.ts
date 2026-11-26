// pi-coding-agent's settings in Effect: the merged global and project settings as a scoped service whose methods are
// Effects under Pi's names, the writes it queued saved when its scope closes.

import {
	SettingsManager as PiSettingsManager,
	type SettingsManagerCreateOptions,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, type Scope } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type Awaits, awaits, type Reads, reads, type Writes, writes } from "./lift.ts";

/** The methods of Pi's settings manager that only read, as Effects. */
export const READS = [
	"getAllModelThinkingLevels",
	"getAutocompleteMaxVisible",
	"getBlockImages",
	"getBranchSummarySettings",
	"getBranchSummarySkipPrompt",
	"getCacheWarmingMode",
	"getClearOnShrink",
	"getCodeBlockIndent",
	"getCollapseChangelog",
	"getCompactionEnabled",
	"getCompactionKeepRecentTokens",
	"getCompactionReserveTokens",
	"getCompactionSettings",
	"getDefaultModel",
	"getDefaultProjectTrust",
	"getDefaultProvider",
	"getDefaultThinkingLevel",
	"getDefaultTools",
	"getDoubleEscapeAction",
	"getEditorPaddingX",
	"getEnableAnalytics",
	"getEnableInstallTelemetry",
	"getEnableSkillCommands",
	"getEnabledModels",
	"getExtensionChangelogVersion",
	"getExtensionPaths",
	"getExternalEditorCommand",
	"getFollowUpMode",
	"getFullscreenCopyOnSelect",
	"getFullscreenExitOutput",
	"getFullscreenScrollbar",
	"getFullscreenWheelScrollLines",
	"getGlobalSettings",
	"getHideThinkingBlock",
	"getHttpIdleTimeoutMs",
	"getImageAutoResize",
	"getImageWidthCells",
	"getLastChangelogVersion",
	"getMermaidRenderingMode",
	"getModelThinkingLevel",
	"getNotices",
	"getNpmCommand",
	"getOutputPad",
	"getPackages",
	"getProjectSettings",
	"getPromptTemplatePaths",
	"getProviderRetrySettings",
	"getQuietStartup",
	"getRetryEnabled",
	"getRetrySettings",
	"getSessionDir",
	"getSessionShareDestination",
	"getSettings",
	"getShellCommandPrefix",
	"getShellPath",
	"getShowHardwareCursor",
	"getShowImages",
	"getShowTerminalProgress",
	"getSkillPaths",
	"getSteeringMode",
	"getTerminalCapabilityOverrides",
	"getTheme",
	"getThemePaths",
	"getThemeSetting",
	"getThinkingBudgets",
	"getTrackingId",
	"getTransport",
	"getTreeFilterMode",
	"getTuiMode",
	"getWarnings",
	"getWebSocketConnectTimeoutMs",
	"isProjectTrusted",
] as const;

/**
 * The methods of Pi's settings manager that change settings (each queues a save), take the errors it collected, or
 * create the device id, as Effects that can fail.
 */
export const WRITES = [
	"applyOverrides",
	"drainErrors",
	"removeModelThinkingLevel",
	"setAutocompleteMaxVisible",
	"setBlockImages",
	"setCacheWarmingMode",
	"setClearOnShrink",
	"setCollapseChangelog",
	"setCompactionEnabled",
	"setDefaultModel",
	"setDefaultModelAndProvider",
	"setDefaultProjectTrust",
	"setDefaultProvider",
	"setDefaultThinkingLevel",
	"setDoubleEscapeAction",
	"setEditorPaddingX",
	"setEnableAnalytics",
	"setEnableInstallTelemetry",
	"setEnableSkillCommands",
	"setEnabledModels",
	"setExtensionChangelogVersion",
	"setExtensionPaths",
	"setFollowUpMode",
	"setFullscreenCopyOnSelect",
	"setFullscreenExitOutput",
	"setFullscreenScrollbar",
	"setFullscreenWheelScrollLines",
	"setHideThinkingBlock",
	"setHttpIdleTimeoutMs",
	"setImageAutoResize",
	"setImageWidthCells",
	"setLastChangelogVersion",
	"setMermaidRenderingMode",
	"setModelThinkingLevel",
	"setNotice",
	"setNpmCommand",
	"setOutputPad",
	"setPackages",
	"setProjectExtensionPaths",
	"setProjectPackages",
	"setProjectPromptTemplatePaths",
	"setProjectSkillPaths",
	"setProjectThemePaths",
	"setProjectTrusted",
	"setPromptTemplatePaths",
	"setQuietStartup",
	"setRetryEnabled",
	"setSessionShareDestination",
	"setShellCommandPrefix",
	"setShellPath",
	"setShowHardwareCursor",
	"setShowImages",
	"setShowTerminalProgress",
	"setSkillPaths",
	"setSteeringMode",
	"setTheme",
	"setThemePaths",
	"setTransport",
	"setTreeFilterMode",
	"setTuiMode",
	"setWarnings",
	"getOrCreateDeviceId",
] as const;

/** The methods of Pi's settings manager that wait for storage: `reload` reads it again, `flush` waits for the saves. */
export const AWAITS = ["reload", "flush"] as const;

/** Settings: every public method of Pi's `SettingsManager` as an Effect, under its name. */
export interface SettingsManagerHandle
	extends Reads<PiSettingsManager, (typeof READS)[number]>,
		Writes<PiSettingsManager, (typeof WRITES)[number]>,
		Awaits<PiSettingsManager, (typeof AWAITS)[number]> {
	/** Pi's manager, for what takes one as it is: `createAgentSession`, a resource loader. */
	readonly pi: PiSettingsManager;
}

/** The settings a session runs with. */
export class SettingsManager extends Context.Service<SettingsManager, SettingsManagerHandle>()(
	"@effectified/pi-coding-agent/SettingsManager",
) {
	/** `SettingsManager` from an Effect that makes one, such as `SettingsManager.inMemory()`. */
	static layer<E, R>(
		make: Effect.Effect<SettingsManagerHandle, E, R>,
	): Layer.Layer<SettingsManager, E, Exclude<R, Scope.Scope>> {
		return Layer.effect(SettingsManager, make);
	}

	/**
	 * The settings files of `agentDir` (default: `~/.pi/agent`) and of `cwd`'s project, merged. Its queued saves are
	 * waited for when the scope closes.
	 */
	static create(
		cwd: string,
		agentDir?: string,
		options?: SettingsManagerCreateOptions,
	): Effect.Effect<SettingsManagerHandle, CodingAgentFailure, Scope.Scope> {
		return Effect.acquireRelease(
			Effect.try({
				try: () => SettingsManager.fromPi(PiSettingsManager.create(cwd, agentDir, options)),
				catch: fromPi,
			}),
			(settings) => Effect.ignore(settings.flush()),
		);
	}

	/** Settings kept in memory only, starting from `settings`. */
	static inMemory(
		settings?: Parameters<typeof PiSettingsManager.inMemory>[0],
		options?: SettingsManagerCreateOptions,
	): Effect.Effect<SettingsManagerHandle, CodingAgentFailure> {
		return Effect.try({
			try: () => SettingsManager.fromPi(PiSettingsManager.inMemory(settings, options)),
			catch: fromPi,
		});
	}

	/** Pi's manager as a handle. It stays the caller's. */
	static fromPi(pi: PiSettingsManager): SettingsManagerHandle {
		return { pi, ...reads(pi, READS), ...writes(pi, WRITES), ...awaits(pi, AWAITS) };
	}
}
