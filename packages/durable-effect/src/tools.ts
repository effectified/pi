// `@effectified/pi-durable/tools`: Pi's built-in tools (read, write, edit, bash, PowerShell) and its `coding-tools`
// extension, as tools and an extension of this package; a shell's preparation of a command as an Effect.

import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import {
	type BashExecution,
	createBashTool,
	createEditTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import { Effect } from "effect";
import type * as Extension from "./extension.ts";
import type { Processor } from "./images/processor.ts";
import { type Invoke, invoker } from "./invocation.ts";
import { type PiTool, tool } from "./pi-made.ts";
import * as ToolApi from "./tool-api.ts";

// Every type of Pi's tools (`BashExecution`, `ReadToolDetails`, `ImageLimits`, ...).
export type * from "@earendil-works/pi-durable/tools";
// Pi's image limits: the default, and those of a model (pure).
export { DEFAULT_IMAGE_LIMITS, imageLimits } from "@earendil-works/pi-durable/tools";
export type { PiTool } from "./pi-made.ts";

/** Options of `read` and `coding`. */
export interface ReadOptions {
	/** Prepares the images `read` returns; without one, images within the default byte limit pass through as they are. */
	readonly images?: Processor;
}

/**
 * Pi's `read`: text files with continuation and truncation remarks, and images, prepared by `options.images` when
 * given. It reads through the conversation's environment (the harness's `env`).
 */
export function read(options?: ReadOptions): PiTool {
	return tool(createReadTool(options?.images === undefined ? {} : { images: options.images.pi }));
}

/** Pi's `write`: writes a whole file through the conversation's environment. */
export const write: PiTool = tool(createWriteTool());

/** Pi's `edit`: replaces exact text in a file, with fuzzy matching and a diff in its details. */
export const edit: PiTool = tool(createEditTool());

/** What a shell tool takes: Pi's options, with the preparation of each command as an Effect. */
export interface ShellOptions<E, R> {
	/** Lines run before each command. */
	readonly commandPrefix?: string;
	/**
	 * Changes a command about to run (its script, working directory and environment) by mutating `execution`, with the
	 * services of the registry. A failure fails the call with Pi's error result.
	 */
	readonly prepare?: (execution: BashExecution, api: ToolApi.Api) => Effect.Effect<void, E, R>;
}

/**
 * Pi's `bash`: runs a command in the conversation's environment. `NoInfer`: what it needs is read from `prepare`
 * only, so one made inside an extension without a preparation needs nothing.
 */
export function bash<E = never, R = never>(options?: ShellOptions<E, R>): PiTool<NoInfer<R>> {
	return shell(options, (prepare) =>
		createBashTool({
			...(options?.commandPrefix === undefined ? {} : { commandPrefix: options.commandPrefix }),
			...(prepare === undefined ? {} : { prepare }),
		}),
	);
}

/** Options of `powershell`. */
export interface PowerShellOptions<E, R> extends ShellOptions<E, R> {
	/** PowerShell programs to try in order; Pi's default `pwsh`, then `powershell`. */
	readonly programs?: ReadonlyArray<string>;
}

/** Pi's `powershell`: runs a PowerShell command in the conversation's environment; what it needs as for `bash`. */
export function powershell<E = never, R = never>(options?: PowerShellOptions<E, R>): PiTool<NoInfer<R>> {
	return shell(options, (prepare) =>
		createPowerShellTool({
			...(options?.commandPrefix === undefined ? {} : { commandPrefix: options.commandPrefix }),
			...(options?.programs === undefined ? {} : { programs: options.programs }),
			...(prepare === undefined ? {} : { prepare }),
		}),
	);
}

/**
 * Pi's `coding-tools` extension: `read`, `write`, `edit` and `bash`; install it in a registry and select it where a
 * conversation codes.
 */
export function coding(
	options?: ReadOptions,
): Extension.Extension<readonly [PiTool, PiTool, PiTool, PiTool], readonly [], readonly [], readonly [], readonly []> {
	return { name: "coding-tools", tools: [read(options), write, edit, bash()] };
}

/** Pi's preparation of a command, as a shell tool's options take it. */
type Prepare = (execution: BashExecution, api: ToolExecutionApi, context: ChordContext) => Promise<void>;

/** A shell tool `make` builds with Pi's form of `options.prepare`, which runs with the registry's services. */
function shell<E, R>(
	options: ShellOptions<E, R> | undefined,
	make: (prepare: Prepare | undefined) => ToolRegistration,
): PiTool<R> {
	const prepare = options?.prepare;
	return {
		// Pi names its tool: one made without a preparation says the name.
		name: make(undefined).name,
		registration: Effect.map(Effect.context<R>(), (context) => {
			const invoke: Invoke<R> = invoker(context);
			return make(
				prepare === undefined
					? undefined
					: (execution, api, chord) => invoke(prepare(execution, ToolApi.fromPi(api)), chord),
			);
		}),
	};
}
