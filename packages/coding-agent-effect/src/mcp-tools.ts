// An MCP server's tools as tools of a coding agent's session, through `@effectified/pi-mcp`'s client: named,
// described, grouped and converted as pi-coding-agent's own MCP extension does it.

import type { AgentToolResult, ToolAnnotations, ToolDefinition, ToolExposure } from "@earendil-works/pi-coding-agent";
import { ToolName } from "@effectified/pi-agent";
import type { JsonValue } from "@effectified/pi-ai";
import {
	type CallToolResult,
	createMcpResultSchema,
	createMcpToolName,
	limitMcpContent,
	type McpClientService,
	type McpFailure,
	McpServerName,
	type Tool as McpTool,
	McpToolName,
	mcpNamespace,
	normalizeMcpInputSchema,
	type OutputSaver,
	type ProgressNotification,
	toMcpModelContent,
} from "@effectified/pi-mcp";
import { Array as Arr, type Duration, Effect, Predicate, Queue, Record, Schema, Stream, String as Str } from "effect";
import { runner } from "./runner.ts";
import type * as Tool from "./tool.ts";

/** How a server's tools are offered to the model. */
export interface Options<R = never> {
	/** The server's name: its tools are `mcp__<server>__<tool>` and its namespace `mcp__<server>`, as Pi names them. */
	readonly server: McpServerName;
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

/**
 * What a tool of an MCP server answers besides the content (Pi's MCP extension's details): which server and which of
 * its tools, and where its full text went.
 */
export const Details = Schema.Struct({
	server: McpServerName,
	tool: McpToolName,
	fullOutputPath: Schema.optionalKey(Schema.String),
});

/** What a tool of an MCP server answers besides the content. */
export type Details = typeof Details.Type;

/**
 * The tools `client`'s server lists now, each a tool of this package for an extension, `ExtensionApi.registerTool` or
 * a session's `customTools`. A call goes to the server through `client`; its progress notifications are the call's
 * updates; its result reaches the model as Pi's MCP extension gives it (text over the output limit keeps its start and
 * end, `isError` is an error result) and programs as the whole result without `_meta`.
 */
export const tools = Effect.fn("McpTools.tools")(function* <R = never>(
	client: McpClientService,
	options: Options<R>,
): Effect.fn.Return<ReadonlyArray<Tool.Any<R>>, McpFailure> {
	const listed = yield* client.listTools();
	const plain = Arr.map(listed, (tool) => createMcpToolName(options.server, tool.name));
	const named = new Set<string>();
	return Arr.map(listed, (tool): Tool.Any<R> => {
		// As Pi: every tool whose name sanitizes to a name another tool shares gets the hash suffix.
		const name = ToolName.make(
			createMcpToolName(
				options.server,
				tool.name,
				(candidate) => named.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate),
			),
		);
		named.add(name);
		return { name, definition: definition(client, tool, name, options) };
	});
});

/** Pi's tool definition of the server's `tool`, its calls run with the services of the context it is built in. */
function definition<R>(
	client: McpClientService,
	tool: McpTool,
	name: ToolName,
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
			description:
				(tool.description === undefined ? "" : Str.trim(tool.description)) ||
				tool.title ||
				`MCP tool ${tool.name} from server ${server}`,
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
							// Unbounded: the server's notifications arrive as it sends them.
							const progress = yield* Queue.unbounded<ProgressNotification>();
							yield* Effect.forkScoped(
								Stream.runForEach(Stream.fromQueue(progress), (notification) =>
									Effect.sync(() => onUpdate?.(update(server, tool.name, notification))),
								),
							);
							// Pi validated the arguments against the normalized input schema, which is an object schema.
							const args = params as Readonly<Record<string, unknown>>;
							const result = yield* client.callTool(
								tool.name,
								{ ...args },
								{
									...(options.timeout === undefined ? {} : { timeout: options.timeout }),
									progress,
								},
							);
							return yield* converted(server, tool.name, result, options);
						}),
					).pipe(Effect.withSpan("McpTools.call", { attributes: { server, tool: tool.name } })),
					signal,
				),
		};
	});
}

/** A progress notification of a call as the call's update, as Pi words it. */
function update(
	server: McpServerName,
	tool: McpToolName,
	notification: ProgressNotification,
): AgentToolResult<Details> {
	const total = notification.total === undefined ? "" : `/${notification.total}`;
	const text = notification.message ?? `Progress ${notification.progress}${total}`;
	return { content: [{ type: "text", text }], details: { server, tool } };
}

/** The result of a call as Pi's MCP extension gives it to the model and to programs; untraced: the call is the span. */
const converted = Effect.fnUntraced(function* <R>(
	server: McpServerName,
	tool: McpToolName,
	result: CallToolResult,
	options: Options<R>,
): Effect.fn.Return<AgentToolResult<Details>, never, R> {
	const content = yield* toMcpModelContent(server, result, {
		...(options.saveOutput === undefined ? {} : { saveOutput: options.saveOutput }),
		...(options.readResourceTool === undefined ? {} : { readResourceTool: options.readResourceTool }),
	});
	const errorText = { type: "text" as const, text: `MCP tool ${server}/${tool} returned an error` };
	const answered = Arr.some(content, (block) => block.type === "text" && block.text !== "");
	const withError = result.isError === true && !answered ? Arr.append(content, errorText) : content;
	const limited = yield* limitMcpContent(withError, options.saveOutput);
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

/** The hints of Pi's tool annotations, each a boolean an MCP server's annotations may carry. */
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const satisfies ReadonlyArray<
	keyof ToolAnnotations
>;

/** The hints the server annotates `tool` with, as Pi's tool annotations: of the server's data, its boolean hints. */
function toolAnnotations(tool: McpTool): ToolAnnotations | undefined {
	const hints = tool.annotations;
	const given = Record.filter(
		Record.fromIterableWith(HINTS, (key) => [key, hints?.[key]]),
		Predicate.isBoolean,
	);
	return Record.isEmptyRecord(given) ? undefined : given;
}
