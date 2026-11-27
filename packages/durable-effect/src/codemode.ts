// `@effectified/pi-durable/codemode`: Pi's code mode tool, which runs the model's JavaScript against the
// conversation's callable tools, on a sandbox of `@effectified/pi-codemode`.

import {
	CodemodeStoreDoc,
	type CodemodeToolOptions,
	createCodemodeExtension,
	createCodemodeTool,
} from "@earendil-works/pi-durable/codemode";
import { SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Predicate, Schema } from "effect";
import type * as BuiltinDoc from "./builtin-doc.ts";
import { extension as fromPi, type PiMade, type PiTool, tool as piTool } from "./pi-made.ts";

export type {
	CodemodeGlobal,
	CodemodeNestedCall,
	CodemodeToolDetails,
	CodemodeToolInput,
} from "@earendil-works/pi-durable/codemode";
// The version of code mode's module, the tool's name, and the token budget of its declarations by default.
export {
	CODEMODE_MODULE_VERSION,
	CODEMODE_TOOL_NAME,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	namespacesOf,
} from "@earendil-works/pi-durable/codemode";
export type { PiMade, PiTool } from "./pi-made.ts";

/**
 * A sandbox scripts run in: `Sandbox` of `@effectified/pi-codemode` (made by `WorkerSandbox.make`,
 * `InlineSandbox.make` or `RemoteSandbox.make`), whose `pi` is Pi's sandbox. It stays the caller's: closing its scope
 * closes it.
 */
export interface Sandbox {
	readonly pi: CodemodeToolOptions["sandbox"];
}

/** Options of `tool` and `extension`. */
export interface Options {
	readonly sandbox: Sandbox;
	/** Estimated tokens the tool declarations in the `codemode` section may use; Pi's default 3000. */
	readonly inlineBudget?: number;
	/** Give scripts `models.*`: the model catalog, classifiers and image generation. Pi's default true. */
	readonly models?: boolean;
}

/** Pi's options for `options`. */
function piOptions(options: Options): CodemodeToolOptions {
	return {
		sandbox: options.sandbox.pi,
		...(options.inlineBudget === undefined ? {} : { inlineBudget: options.inlineBudget }),
		...(options.models === undefined ? {} : { models: options.models }),
	};
}

/** Pi's `codemode` tool alone: scripts call the conversation's callable tools as `tools.<name>(args)`. */
export function tool(options: Options): PiTool {
	return piTool(createCodemodeTool(piOptions(options)));
}

/**
 * Pi's `codemode` extension: the tool, the tools behind `models.*` unless `models` is false, and the `codemode` prompt
 * section that lists what scripts can call.
 */
export function extension(options: Options): PiMade {
	return fromPi(createCodemodeExtension(piOptions(options)));
}

/** The JSON a script keeps. */
type Store = typeof CodemodeStoreDoc extends { readonly definition: { readonly initial: () => infer T } } ? T : never;

/**
 * `pi.codemode.store`: what scripts keep with `store()` and read with `load()`, per conversation. Rewindable and
 * copied as of the fork point. Code mode writes it: read only.
 */
export const store: BuiltinDoc.BuiltinDoc<Store, "rewindable"> = {
	kind: CodemodeStoreDoc.definition.kind,
	version: CodemodeStoreDoc.definition.version,
	schema: Schema.declare((value): value is Readonly<Store> => Predicate.isObject(value)),
	scope: "conversation",
	history: "rewindable",
	family: false,
	token: CodemodeStoreDoc,
	writer: "pi",
	encode: () =>
		Effect.fail(
			SchemaDecodeError.make({
				issues: [{ path: "", message: "Document pi.codemode.store is written by Pi alone" }],
			}),
		),
	// Pi's own type of what Pi stored.
	decode: (stored) => Effect.succeed(stored as Readonly<Store>),
};
