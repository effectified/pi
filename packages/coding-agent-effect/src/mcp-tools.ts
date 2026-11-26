// An MCP server's tools as tools of a coding agent's session, through `@effectified/pi-mcp`'s client: named,
// described, grouped and converted as pi-coding-agent's own MCP extension does it.

import type { AgentToolResult, ToolAnnotations, ToolDefinition, ToolExposure } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@effectified/pi-ai";
import {
	type CallToolResult,
	createMcpResultSchema,
	createMcpToolName,
	limitMcpContent,
	type McpClientService,
	type McpFailure,
	type Tool as McpTool,
	mcpNamespace,
	normalizeMcpInputSchema,
	type OutputSaver,
	type ProgressNotification,
	toMcpModelContent,
} from "@effectified/pi-mcp";
import { type Duration, Effect, Queue, Stream } from "effect";
import { runner } from "./runner.ts";
import type * as Tool from "./tool.ts";

/** How a server's tools are offered to the model. */
export interface Options<R = never> {
	/** The server's name: its tools are `mcp__<server>__<tool>` and its namespace `mcp__<server>`, as Pi names them. */
	readonly server: string;
	/** How the model reaches the tools (Pi's tool exposure). Default: `direct`. */
	readonly exposure?: ToolExposure;
	/** The short summary of the server that model-facing tool listings show with its namespace. */
	readonly description?: string;
	/** The `timeout` of each call. Default: the client's. */
	readonly timeout?: Duration.Input;
	/** Saves the full text of a truncated result and binary resources where the model can read them. */
	readonly saveOutput?: OutputSaver<R>;
	/** The tool that reads the resources resource links name, when the session has one. */
	readonly readResourceTool?: string;
}

/** What a tool of an MCP server answers besides the content: which server and tool, and where its full text went. */
export interface Details {
	readonly server: string;
	readonly tool: string;
	readonly fullOutputPath?: string;
}

/**
 * The tools `client`'s server lists now, each a tool of this package for an extension, `ExtensionApi.registerTool` or
 * a session's `customTools`. A call goes to the server through `client`; its progress notifications are the call's
 * updates; its result reaches the model as Pi's MCP extension gives it (text over the output limit keeps its start and
 * end, `isError` is an error result) and programs as the whole result without `_meta`.
 */
export function tools<R = never>(
	client: McpClientService,
	options: Options<R>,
): Effect.Effect<ReadonlyArray<Tool.Any<R>>, McpFailure> {
	return Effect.map(client.listTools(), (listed) => {
		const plain = listed.map((tool) => createMcpToolName(options.server, tool.name));
		const named = new Set<string>();
		return listed.map((tool) => {
			// As Pi: every tool whose name sanitizes to a name another tool shares gets the hash suffix.
			const name = createMcpToolName(
				options.server,
				tool.name,
				(candidate) => named.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate),
			);
			named.add(name);
			return { name, definition: definition(client, tool, name, options) };
		});
	});
}

/** Pi's tool definition of the server's `tool`, its calls run with the services of the context it is built in. */
function definition<R>(
	client: McpClientService,
	tool: McpTool,
	name: string,
	options: Options<R>,
): Effect.Effect<ToolDefinition, never, R> {
	return Effect.map(Effect.context<R>(), (context): ToolDefinition => {
		const run = runner(context);
		const { server } = options;
		const annotations = toolAnnotations(tool);
		const instructions = client.initialize.instructions;
		return {
			name,
			label: `${server}/${tool.name}`,
			description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server}`,
			// JSON Schema objects, which is what Pi's TypeBox schemas are at run time (Pi's MCP extension casts alike).
			parameters: normalizeMcpInputSchema(tool.inputSchema) as unknown as ToolDefinition["parameters"],
			outputSchema: createMcpResultSchema(tool.outputSchema) as unknown as ToolDefinition["parameters"],
			exposure: options.exposure ?? "direct",
			namespace: {
				name: mcpNamespace(server),
				aliases: [server],
				...(options.description === undefined ? {} : { description: options.description }),
				...(instructions === undefined ? {} : { instructions }),
			},
			...(annotations === undefined ? {} : { annotations }),
			execute: (_toolCallId, params, signal, onUpdate) =>
				run(
					Effect.scoped(
						Effect.gen(function* () {
							const progress = yield* Queue.unbounded<ProgressNotification>();
							yield* Effect.forkScoped(
								Stream.runForEach(Stream.fromQueue(progress), (notification) =>
									Effect.sync(() => onUpdate?.(update(server, tool.name, notification))),
								),
							);
							// Pi validated the arguments against the normalized input schema, which is an object schema.
							const args = params as Record<string, unknown>;
							const result = yield* client.callTool(tool.name, args, {
								...(options.timeout === undefined ? {} : { timeout: options.timeout }),
								progress,
							});
							return yield* converted(server, tool.name, result, options);
						}),
					),
					signal,
				),
		};
	});
}

/** A progress notification of a call as the call's update, as Pi words it. */
function update(server: string, tool: string, notification: ProgressNotification): AgentToolResult<Details> {
	const total = notification.total === undefined ? "" : `/${notification.total}`;
	const text = notification.message ?? `Progress ${notification.progress}${total}`;
	return { content: [{ type: "text", text }], details: { server, tool } };
}

/** The result of a call as Pi's MCP extension gives it to the model and to programs. */
function converted<R>(
	server: string,
	tool: string,
	result: CallToolResult,
	options: Options<R>,
): Effect.Effect<AgentToolResult<Details>, never, R> {
	return Effect.gen(function* () {
		const content = yield* toMcpModelContent(server, result, {
			...(options.saveOutput === undefined ? {} : { saveOutput: options.saveOutput }),
			...(options.readResourceTool === undefined ? {} : { readResourceTool: options.readResourceTool }),
		});
		if (result.isError === true && !content.some((block) => block.type === "text" && block.text !== "")) {
			content.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
		}
		const limited = yield* limitMcpContent(content, options.saveOutput);
		const { _meta: _dropped, ...forPrograms } = result;
		return {
			content: limited.content,
			details: {
				server,
				tool,
				...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
			},
			// A CallToolResult is JSON as the server sent it.
			structuredContent: forPrograms as unknown as JsonValue,
			...(result.isError === true ? { isError: true } : {}),
		};
	});
}

/** The hints the server annotates `tool` with, as Pi's tool annotations: of the server's data, its boolean hints. */
function toolAnnotations(tool: McpTool): ToolAnnotations | undefined {
	const hints = tool.annotations;
	const annotations: ToolAnnotations = {
		...(typeof hints?.readOnlyHint === "boolean" ? { readOnlyHint: hints.readOnlyHint } : {}),
		...(typeof hints?.destructiveHint === "boolean" ? { destructiveHint: hints.destructiveHint } : {}),
		...(typeof hints?.idempotentHint === "boolean" ? { idempotentHint: hints.idempotentHint } : {}),
		...(typeof hints?.openWorldHint === "boolean" ? { openWorldHint: hints.openWorldHint } : {}),
	};
	return Object.keys(annotations).length === 0 ? undefined : annotations;
}
