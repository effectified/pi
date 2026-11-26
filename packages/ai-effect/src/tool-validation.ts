// pi-ai's validation of a model's tool call against the tool's JSON Schema, as Effects with a typed failure.

import {
	validateToolArguments as piValidateToolArguments,
	validateToolCall as piValidateToolCall,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { InvalidToolCall } from "./errors.ts";

/**
 * The arguments of `toolCall`, validated against the schema of the tool of its name among `tools` (pi-ai's
 * `validateToolCall`). Fails with `InvalidToolCall` when no tool has the name or the arguments do not validate.
 */
export function validateToolCall(
	tools: ReadonlyArray<Tool>,
	toolCall: ToolCall,
): Effect.Effect<unknown, InvalidToolCall> {
	return Effect.try({
		try: (): unknown => piValidateToolCall([...tools], toolCall),
		catch: (error) => invalid(toolCall, error),
	});
}

/**
 * The arguments of `toolCall`, validated against `tool`'s JSON Schema (pi-ai's `validateToolArguments`): coerced first,
 * as models send `"42"` for a number or one value for an array, and copied, so the call in the transcript stays as
 * the model sent it. Fails with `InvalidToolCall` when the arguments were malformed JSON or do not validate.
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): Effect.Effect<unknown, InvalidToolCall> {
	return Effect.try({
		try: (): unknown => piValidateToolArguments(tool, toolCall),
		catch: (error) => invalid(toolCall, error),
	});
}

function invalid(toolCall: ToolCall, error: unknown): InvalidToolCall {
	return new InvalidToolCall({
		toolName: toolCall.name,
		message: error instanceof Error ? error.message : String(error),
	});
}
