// pi-coding-agent's package manager in Effect: installing, updating, removing and resolving Pi packages (extensions,
// skills, prompts, themes from npm, git or a path) as Effects, and their progress as a Stream.

import {
	DefaultPackageManager,
	type PackageManager as PiPackageManager,
	type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import { type Cause, Context, Effect, Layer, Queue, type Scope, Stream } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type Awaits, awaits, type Reads, reads, type Writes, writes } from "./lift.ts";
import type { SettingsManagerHandle } from "./settings-manager.ts";

/** The methods of Pi's package manager that only read. */
export const READS = ["listConfiguredPackages", "getInstalledPath"] as const;

/** The methods of Pi's package manager that change the settings' package lists. */
export const WRITES = ["addSourceToSettings", "removeSourceFromSettings"] as const;

/** The methods of Pi's package manager that install, remove, update or resolve packages. */
export const AWAITS = [
	"install",
	"installAndPersist",
	"remove",
	"removeAndPersist",
	"update",
	"resolveExtensionSources",
] as const;

/** What Pi's `resolve` does with a configured package that is not installed: install it, skip it, or fail. */
export type MissingSourceAction = Awaited<ReturnType<NonNullable<Parameters<PiPackageManager["resolve"]>[0]>>>;

/** A package manager: every member of Pi's `PackageManager` as an Effect, under its name. */
export interface PackageManagerHandle
	extends Reads<PiPackageManager, (typeof READS)[number]>,
		Writes<PiPackageManager, (typeof WRITES)[number]>,
		Awaits<PiPackageManager, (typeof AWAITS)[number]> {
	/** Pi's manager, for what takes one as it is. */
	readonly pi: PiPackageManager;
	/**
	 * The paths of every configured package's resources. `onMissing` decides what happens to a package that is not
	 * installed; without it Pi installs it.
	 */
	readonly resolve: (
		onMissing?: (source: string) => Effect.Effect<MissingSourceAction>,
	) => Effect.Effect<Awaited<ReturnType<PiPackageManager["resolve"]>>, CodingAgentFailure>;
	/**
	 * The progress of every install, update and removal from now until the scope closes, when the Stream ends: Pi's
	 * `setProgressCallback`, which holds one listener, so a second subscription replaces the first.
	 */
	readonly progress: Effect.Effect<Stream.Stream<ProgressEvent>, never, Scope.Scope>;
}

/** Pi's options of its default manager, with the settings as this package's handle. */
export interface Options extends Omit<ConstructorParameters<typeof DefaultPackageManager>[0], "settingsManager"> {
	readonly settingsManager: SettingsManagerHandle;
}

/** The package manager of the program. */
export class PackageManager extends Context.Service<PackageManager, PackageManagerHandle>()(
	"@effectified/pi-coding-agent/PackageManager",
) {
	/** `PackageManager.make(options)` as a Layer. */
	static layer(options: Options): Layer.Layer<PackageManager> {
		return Layer.effect(PackageManager, PackageManager.make(options));
	}

	/** Pi's `DefaultPackageManager` for the packages of `agentDir` and of `cwd`'s project. */
	static make(options: Options): Effect.Effect<PackageManagerHandle> {
		const { settingsManager, ...rest } = options;
		return Effect.sync(() =>
			PackageManager.fromPi(new DefaultPackageManager({ ...rest, settingsManager: settingsManager.pi })),
		);
	}

	/** Pi's manager as a handle. It stays the caller's. */
	static fromPi(pi: PiPackageManager): PackageManagerHandle {
		return {
			pi,
			...reads(pi, READS),
			...writes(pi, WRITES),
			...awaits(pi, AWAITS),
			resolve: (onMissing) =>
				Effect.tryPromise({
					try: () =>
						pi.resolve(onMissing === undefined ? undefined : (source) => Effect.runPromise(onMissing(source))),
					catch: fromPi,
				}),
			progress: Effect.gen(function* () {
				const queue = yield* Queue.unbounded<ProgressEvent, Cause.Done>();
				yield* Effect.acquireRelease(
					Effect.sync(() => pi.setProgressCallback((event) => Queue.offerUnsafe(queue, event))),
					() =>
						Effect.andThen(
							Effect.sync(() => pi.setProgressCallback(undefined)),
							Queue.end(queue),
						),
				);
				return Stream.fromQueue(queue);
			}),
		};
	}
}
