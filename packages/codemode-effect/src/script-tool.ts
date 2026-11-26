// The tools and globals a script calls: tools of `@effectified/pi-agent` (`Tool.make`) as pi-codemode's tools.

import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import type { AgentTool, AgentToolResult, SchemaConversionError, Tool } from "@effectified/pi-agent";
import { Effect } from "effect";

/**
 * A tool exposed as a top-level function of the script instead of on `tools`, such as a host helper. It is not
 * recorded in a result's `calls`.
 */
export interface Global<R> {
	/** The function: its name is the global's, an identifier or `namespace.member`. */
	readonly tool: Tool.Any<R>;
	/** The handler gets all call arguments as an array (its `parameters` a tuple) instead of the first one. */
	readonly spread?: boolean;
	/** The parameter list and return type the declarations show, such as `(id: string): Promise<Item>`. */
	readonly signature?: string;
}

/**
 * pi-codemode's tool for a tool of `@effectified/pi-agent`, in the shape Pi documents for agent tools in code mode: the
 * input type is the JSON Schema of `parameters`; the script gets the success value as JSON when the tool is
 * `structured`, else the text the model would read. A failure of the handler and a `Tool.error` reply reject the
 * script's call with that text. The handler runs with the services of the context this Effect runs in, sees the tool
 * call id `"nested"`, and is interrupted when Pi aborts the call. Its `api.update` reaches nobody: a script has no
 * progress channel.
 */
export function fromAgent<R>(tool: Tool.Any<R>): Effect.Effect<CodemodeTool, SchemaConversionError, R> {
	return Effect.map(tool.agentTool, (agentTool) => ({
		name: agentTool.name,
		description: agentTool.description,
		inputSchema: jsonSchema(agentTool.parameters),
		outputSchema: agentTool.outputSchema === undefined ? { type: "string" } : jsonSchema(agentTool.outputSchema),
		execute: (args, { signal }) => agentTool.execute(NESTED_CALL_ID, args, signal).then(scriptValue(agentTool)),
	}));
}

/** pi-codemode's global for `global`: its tool as `fromAgent` gives it, with `spread` and `signature`. */
export function global<R>(global: Global<R>): Effect.Effect<CodemodeTool, SchemaConversionError, R> {
	return Effect.map(fromAgent(global.tool), (tool) => ({
		...tool,
		...(global.spread === undefined ? {} : { spread: global.spread }),
		...(global.signature === undefined ? {} : { signature: global.signature }),
	}));
}

/** The tool call id a handler sees for a script's call: there is no model call, as in Pi's documented bridge. */
const NESTED_CALL_ID = "nested";

/**
 * What the script's call settles with: the structured value of a structured tool, else the text. An error result
 * rejects, which is how a failure reaches the script.
 */
function scriptValue(agentTool: AgentTool): (result: AgentToolResult) => unknown {
	return (result) => {
		if (agentTool.outputSchema !== undefined && result.structuredContent !== undefined) {
			return result.structuredContent;
		}
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		if (result.isError !== true) return text;
		return Promise.reject(new Error(text === "" ? `Tool ${agentTool.name} failed` : text));
	};
}

/** A JSON Schema document as pi-codemode types it. A decided invariant: pi-agent-core types the same documents `object`. */
function jsonSchema(schema: object): CodemodeJsonSchema {
	return schema as CodemodeJsonSchema;
}
