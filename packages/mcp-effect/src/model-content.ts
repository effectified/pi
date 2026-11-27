// The model-facing content of an MCP result, as pi-mcp builds it, in Effect terms: what saves the output the model
// cannot read inline is an Effect, and so is the content.

import {
	type CallToolResult,
	type LimitedMcpContent,
	type LlmContent,
	type McpModelContentOptions,
	limitMcpContent as piLimitMcpContent,
	toMcpModelContent as piToMcpModelContent,
} from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import type { McpFailure } from "./errors.ts";
import type { McpServerName } from "./names.ts";
import { currentRunner } from "./run-in-pi.ts";

/**
 * Saves data the model cannot get in full (the full text of a truncated result, a binary resource) and succeeds with
 * where it went, a path the model can read. `extension` includes the dot, for example `.txt`.
 */
export type OutputSaver<R = never> = (
	data: string | Uint8Array,
	extension: string,
) => Effect.Effect<string, McpFailure, R>;

/** pi-mcp's model content options, with an `OutputSaver` in place of Pi's promise one. */
export interface ModelContentOptions<R = never> extends Omit<McpModelContentOptions, "saveOutput"> {
	/** Saves binary resources other than images where the model can read them. Without it they are left out. */
	readonly saveOutput?: OutputSaver<R>;
}

/**
 * The model-facing content of `server`'s result, before the output limit (`limitMcpContent`): Pi's own conversion. A
 * save that fails becomes a line saying why, as in Pi.
 */
export const toMcpModelContent: <R = never>(
	server: McpServerName,
	result: Pick<CallToolResult, "content" | "structuredContent">,
	options?: ModelContentOptions<R>,
) => Effect.Effect<LlmContent[], never, R> = Effect.fn("McpModelContent.toMcpModelContent")(function* <R>(
	server: McpServerName,
	result: Pick<CallToolResult, "content" | "structuredContent">,
	options: ModelContentOptions<R> = {},
) {
	const run = yield* currentRunner<R>();
	const { saveOutput, ...rest } = options;
	return yield* Effect.promise(() =>
		piToMcpModelContent(server, result, {
			...rest,
			...(saveOutput === undefined ? {} : { saveOutput: (data, extension) => run(saveOutput(data, extension)) }),
		}),
	);
});

/**
 * Model-facing content within `MCP_OUTPUT_MAX_BYTES`: longer text keeps its start and end, and its full text is saved
 * with `saveOutput` when given. Pi's own limit; a save that fails becomes a line saying why.
 */
export const limitMcpContent: <R = never>(
	content: LlmContent[],
	saveOutput?: OutputSaver<R>,
) => Effect.Effect<LimitedMcpContent, never, R> = Effect.fn("McpModelContent.limitMcpContent")(function* <R>(
	content: LlmContent[],
	saveOutput?: OutputSaver<R>,
) {
	const run = yield* currentRunner<R>();
	return yield* Effect.promise(() =>
		piLimitMcpContent(
			content,
			saveOutput === undefined ? undefined : (data, extension) => run(saveOutput(data, extension)),
		),
	);
});
