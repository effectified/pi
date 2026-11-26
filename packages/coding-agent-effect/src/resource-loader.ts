// pi-coding-agent's resources in Effect: the extensions, skills, prompt templates, themes and context files of a
// session as a service, discovered by Pi's default loader with extensions written in Effect among them.

import {
	DefaultResourceLoader,
	type EventBus,
	type LoadExtensionsResult,
	type ResourceLoader as PiResourceLoader,
	discoverAndLoadExtensions as piDiscoverAndLoadExtensions,
	loadProjectContextFiles as piLoadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import type * as Extension from "./extension.ts";
import { type Awaits, awaits, type Reads, reads, type Writes, writes } from "./lift.ts";
import type { SettingsManagerHandle } from "./settings-manager.ts";

/** Pi's options of its default loader; pi-coding-agent's root does not export their type. */
type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** The methods of Pi's resource loader that read what it loaded, as Effects. */
export const READS = [
	"getExtensions",
	"getSkills",
	"getPrompts",
	"getThemes",
	"getAgentsFiles",
	"getSystemPrompt",
	"getSystemPromptSource",
	"getAppendSystemPrompt",
	"getAppendSystemPromptSources",
] as const;

/** The method of Pi's resource loader that adds paths of resources, as an Effect that can fail. */
export const WRITES = ["extendResources"] as const;

/** The method of Pi's resource loader that discovers and loads everything again. */
export const AWAITS = ["reload"] as const;

/** A session's resources: every method of Pi's `ResourceLoader` as an Effect, under its name. */
export interface ResourceLoaderHandle
	extends Reads<PiResourceLoader, (typeof READS)[number]>,
		Writes<PiResourceLoader, (typeof WRITES)[number]>,
		Awaits<PiResourceLoader, (typeof AWAITS)[number]> {
	/** Pi's loader, for what takes one as it is: `createAgentSession`. */
	readonly pi: PiResourceLoader;
}

/**
 * What `ResourceLoader.make` takes: Pi's options of its default loader, the settings as this package's handle, and
 * `extensions` written in Effect besides Pi's own inline ones. Package installation reports its progress on Pi's
 * console output (`onPackageProgress` and `packageCommandOutput` are left out).
 */
export interface Options<R>
	extends Omit<DefaultResourceLoaderOptions, "settingsManager" | "onPackageProgress" | "packageCommandOutput"> {
	readonly settingsManager?: SettingsManagerHandle;
	/** Extensions written in Effect, loaded after `extensionFactories` in this order. */
	readonly extensions?: ReadonlyArray<Extension.Extension<R>>;
}

/** The resources a session loads. */
export class ResourceLoader extends Context.Service<ResourceLoader, ResourceLoaderHandle>()(
	"@effectified/pi-coding-agent/ResourceLoader",
) {
	/** `ResourceLoader.make(options)` as a Layer. */
	static layer<R = never>(options: Options<R>): Layer.Layer<ResourceLoader, CodingAgentFailure, R> {
		return Layer.effect(ResourceLoader, ResourceLoader.make(options));
	}

	/**
	 * Pi's `DefaultResourceLoader`, loaded once (`reload`): the extensions, skills, prompts, themes and context files
	 * of `agentDir` and of `cwd`'s project, the paths and inline extensions of `options`, and `extensions`, whose
	 * Effects run with the services of the context this Effect runs in.
	 */
	static make<R = never>(options: Options<R>): Effect.Effect<ResourceLoaderHandle, CodingAgentFailure, R> {
		const { settingsManager, extensions, extensionFactories, ...rest } = options;
		return Effect.gen(function* () {
			const inline = yield* Effect.forEach(extensions ?? [], (extension) => extension.inline);
			const loader = new DefaultResourceLoader({
				...rest,
				...(settingsManager === undefined ? {} : { settingsManager: settingsManager.pi }),
				extensionFactories: [...(extensionFactories ?? []), ...inline],
			});
			yield* Effect.tryPromise({ try: () => loader.reload(), catch: fromPi });
			return ResourceLoader.fromPi(loader);
		});
	}

	/** Pi's loader (the default one, or one of the application's own) as a handle. It stays the caller's. */
	static fromPi(pi: PiResourceLoader): ResourceLoaderHandle {
		return { pi, ...reads(pi, READS), ...writes(pi, WRITES), ...awaits(pi, AWAITS) };
	}
}

/** The context files (`AGENTS.md`, `CLAUDE.md`) of the agent directory and of `cwd` and its parents, as Pi reads them. */
export function loadProjectContextFiles(options: {
	readonly cwd: string;
	readonly agentDir: string;
}): Effect.Effect<ReturnType<typeof piLoadProjectContextFiles>, CodingAgentFailure> {
	return Effect.try({ try: () => piLoadProjectContextFiles(options), catch: fromPi });
}

/** The extensions of `configuredPaths`, the agent directory and `cwd`'s project, loaded as Pi's loader loads them. */
export function discoverAndLoadExtensions(
	configuredPaths: ReadonlyArray<string>,
	cwd: string,
	agentDir?: string,
	eventBus?: EventBus,
): Effect.Effect<LoadExtensionsResult, CodingAgentFailure> {
	return Effect.tryPromise({
		try: () => piDiscoverAndLoadExtensions([...configuredPaths], cwd, agentDir, eventBus),
		catch: fromPi,
	});
}
