// Tools in Effect: parameters and result as Schemas, the handler as an Effect, built into a pi-agent-core tool.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	decodeUnknown,
	encode,
	SchemaConversionError,
	type SchemaDecodeError,
	toJsonSchema,
} from "@effectified/pi-schema";
// effect's `Result` is `Res` here: this module exports a `Result` of its own, the reply of a handler.
import { Effect, Formatter, Match, Predicate, Result as Res, type Schema } from "effect";
import { ToolFailed } from "./errors.ts";
import { ToolCallId, ToolName } from "./ids.ts";
import { runner } from "./runner.ts";

/** What a handler may use besides its arguments. */
export interface Api {
	/** The id of the model's tool call. */
	readonly toolCallId: ToolCallId;
	/**
	 * Reports progress: Pi emits it as a `tool_execution_update` event. Ignored once the call has finished, as Pi
	 * ignores late updates.
	 */
	readonly update: (partial: AgentToolResult) => Effect.Effect<void>;
}

/** What `make` takes besides the tool's name. */
export interface Options<P extends Schema.Constraint, S extends Schema.Constraint, E, R> {
	/** The name a UI shows. */
	readonly label: string;
	readonly description: string;
	/** The arguments: the model gets their JSON Schema, the handler gets the decoded value. */
	readonly parameters: P;
	/** What the handler succeeds with; its JSON form is the text the model reads. */
	readonly success: S;
	/**
	 * Programs that call the tool get the success value as JSON besides the text the model reads: Pi's
	 * `structuredContent`, declared with the JSON Schema of `success` as the tool's `outputSchema`.
	 */
	readonly structured?: boolean;
	/** Whether this tool's calls run one at a time with the others of a turn (`sequential`), passed on unchanged. */
	readonly executionMode?: AgentTool["executionMode"];
	/** Recovery policy of a durable host for a call whose outcome is unknown, passed on unchanged. */
	readonly replay?: AgentTool["replay"];
	/**
	 * Repairs arguments models commonly get wrong, before Pi validates them: Pi's own callback, passed on unchanged.
	 * Pure: it gets the arguments as the model sent them.
	 */
	readonly prepareArguments?: AgentTool["prepareArguments"];
	/** pi-ai's provider-side constrained sampling of the arguments, passed on unchanged. */
	readonly constrainedSampling?: AgentTool["constrainedSampling"];
	/**
	 * Runs one call. Succeeds with the success value, or with a `Reply` for more than that. A failure becomes an error
	 * result the model reads, with the failure's message. Interrupted when Pi aborts the run.
	 */
	readonly handler: (params: P["Type"], api: Api) => Effect.Effect<S["Type"] | Reply<S["Type"]>, E, R>;
}

/** A tool made by `make`. */
export interface Tool<Name extends string, P extends Schema.Constraint, S extends Schema.Constraint, E, R>
	extends Options<P, S, E, R>, Any<Requirements<P, S, R>> {
	readonly name: Name & ToolName;
}

/** Any tool, whatever its schemas: what an agent, a loop and `runToolCall` take. */
export interface Any<R> {
	readonly name: ToolName;
	/** Builds Pi's tool; its handler runs with the services of the context this Effect runs in. */
	readonly agentTool: Effect.Effect<AgentTool, SchemaConversionError, R>;
}

/** What running a tool needs: its handler's services and those its schemas decode and encode with. */
export type Requirements<P extends Schema.Constraint, S extends Schema.Constraint, R> =
	| R
	| P["DecodingServices"]
	| S["EncodingServices"];

const ReplyTypeId = "~@effectified/pi-agent/Tool/Reply";

/**
 * What a handler succeeds with instead of the bare success value: a result with extras, or an error result. Not a
 * Schema: it is generic in the success value, its extras are Pi's types, and telling it from a success value of any
 * shape takes the type id a value of the handler's own cannot carry by accident.
 */
export type Reply<A> = Result<A> | ErrorResult;

/** What a result may carry besides what the model reads. All of it is Pi's, passed on unchanged. */
export type Extras = Partial<Pick<AgentToolResult, "content" | "details" | "usage" | "terminate">>;

/** A success with extras: `content` replaces the success value's text for the model (an image, a summary). */
export interface Result<A> extends Extras {
	readonly [ReplyTypeId]: typeof ReplyTypeId;
	readonly _tag: "Result";
	readonly value: A;
}

/** An error result the handler decides itself (Pi's `isError`): the model reads `text`, and the run goes on. */
export interface ErrorResult extends Omit<Extras, "content"> {
	readonly [ReplyTypeId]: typeof ReplyTypeId;
	readonly _tag: "Error";
	readonly text: string;
}

/** The success value with extras: details for a UI, usage, `terminate`, or other content for the model. */
export function result<A>(value: A, extras?: Extras): Reply<A> {
	return { ...extras, [ReplyTypeId]: ReplyTypeId, _tag: "Result", value };
}

/** An error result with `text` for the model, as Pi's `isError`: no failure of the handler. It may carry details. */
export function error(text: string, extras?: Omit<Extras, "content">): Reply<never> {
	return { ...extras, [ReplyTypeId]: ReplyTypeId, _tag: "Error", text };
}

/**
 * Defines a tool. Pi validates a call's arguments against the JSON Schema of `parameters`; the handler then gets them
 * decoded. The model reads the result as text: a string as it is, anything else as JSON. Arguments the schema rejects
 * after Pi accepted them, a handler failure and a result `success` cannot encode each reject the call with
 * `ToolFailed`, whose message Pi turns into its own error result. The JSON Schemas are built once, when the tool is
 * first built, so every agent and loop given the tool shares them (pi-ai compiles one validator per schema object).
 */
export function make<const Name extends string, P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: Name,
	options: Options<P, S, E, R>,
): Tool<Name, P, S, E, R> {
	// The brand checks nothing of a string, so the branded name keeps the literal type it was given.
	const branded = ToolName.make(name) as Name & ToolName;
	return { ...options, name: branded, agentTool: agentTool(branded, options, jsonSchemas(branded, options)) };
}

/** The JSON Schemas Pi gets for a tool: its parameters, and its success value when the tool is `structured`. */
interface JsonSchemas {
	readonly parameters: object;
	readonly outputSchema: object | undefined;
}

/** The JSON Schemas of a tool, converted on the first evaluation and kept with the tool for the next ones. */
function jsonSchemas<P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: ToolName,
	options: Options<P, S, E, R>,
): Effect.Effect<JsonSchemas, SchemaConversionError> {
	let converted: Res.Result<JsonSchemas, SchemaConversionError> | undefined;
	return Effect.suspend(() => {
		converted ??= Res.all({
			parameters: objectSchema(name, "parameters", options.parameters),
			outputSchema:
				options.structured === true ? objectSchema(name, "success", options.success) : Res.succeed(undefined),
		});
		return Effect.fromResult(converted);
	});
}

/**
 * Pi's tool for a tool of `make`. Untraced: the tool it builds keeps this Effect's context for every call, which a span
 * of the build would not outlive; each call has its own span, `Tool.execute`.
 */
const agentTool: <P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: ToolName,
	options: Options<P, S, E, R>,
	schemas: Effect.Effect<JsonSchemas, SchemaConversionError>,
) => Effect.Effect<AgentTool, SchemaConversionError, Requirements<P, S, R>> = Effect.fnUntraced(function* <
	P extends Schema.Constraint,
	S extends Schema.Constraint,
	E,
	R,
>(name: ToolName, options: Options<P, S, E, R>, schemas: Effect.Effect<JsonSchemas, SchemaConversionError>) {
	const { parameters, outputSchema } = yield* schemas;
	const context = yield* Effect.context<Requirements<P, S, R>>();
	const run = runner(context);
	const decode = decodeUnknown(options.parameters);
	const encodeSuccess = encode(options.success);
	const structured = outputSchema !== undefined;
	// A span per call of the model, never per token.
	const call = Effect.fn("Tool.execute")(
		function* (args: unknown, api: Api) {
			yield* Effect.annotateCurrentSpan({ "pi.tool.name": name, "pi.tool.call_id": api.toolCallId });
			const params = yield* decode(args);
			const returned = yield* options.handler(params, api);
			return yield* answer(isReply(returned) ? returned : result(returned), encodeSuccess, structured);
		},
		// Pi reads a thrown error's message; a tagged error's own message may be empty.
		Effect.mapError((failure) => ToolFailed.make({ tool: name, message: failureText(failure), cause: failure })),
	);
	return {
		name,
		label: options.label,
		description: options.description,
		parameters,
		...(outputSchema === undefined ? {} : { outputSchema }),
		...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
		...(options.replay === undefined ? {} : { replay: options.replay }),
		...(options.prepareArguments === undefined ? {} : { prepareArguments: options.prepareArguments }),
		...(options.constrainedSampling === undefined ? {} : { constrainedSampling: options.constrainedSampling }),
		execute: (toolCallId, args, signal, onUpdate) =>
			run(
				call(args, {
					toolCallId: ToolCallId.make(toolCallId),
					update: (partial) => Effect.sync(() => onUpdate?.(partial)),
				}),
				signal,
			),
	} satisfies AgentTool;
});

/** Pi's result for a reply. `structured`: a result carries its value as JSON too. */
function answer<A, R>(
	reply: Reply<A>,
	encodeSuccess: (value: A) => Effect.Effect<Schema.Json, SchemaDecodeError, R>,
	structured: boolean,
): Effect.Effect<AgentToolResult, SchemaDecodeError, R> {
	return Match.valueTags(reply, {
		Result: (success) =>
			Effect.map(encodeSuccess(success.value), (json): AgentToolResult => ({
				content: success.content ?? [{ type: "text", text: readable(json) }],
				details: success.details,
				...(structured ? { structuredContent: stored(json) } : {}),
				...(success.usage === undefined ? {} : { usage: success.usage }),
				...(success.terminate === undefined ? {} : { terminate: success.terminate }),
			})),
		Error: (refusal) =>
			Effect.succeed<AgentToolResult>({
				content: [{ type: "text", text: refusal.text }],
				details: refusal.details,
				isError: true,
				...(refusal.usage === undefined ? {} : { usage: refusal.usage }),
				...(refusal.terminate === undefined ? {} : { terminate: refusal.terminate }),
			}),
	});
}

/** JSON as the model reads it: a string as it is, anything else as JSON text. */
function readable(json: Schema.Json): string {
	return Predicate.isString(json) ? json : Formatter.formatJson(json);
}

/** JSON as Pi takes it. A decode boundary: Effect types JSON read-only, pi-ai types the same values mutable. */
function stored(json: Schema.Json): AgentToolResult["structuredContent"] {
	return json as AgentToolResult["structuredContent"];
}

/** Whether a handler's value is a `Reply`: a success value is of any type, so the type id tells them apart. */
function isReply<A>(returned: A | Reply<A>): returned is Reply<A> {
	return Predicate.hasProperty(returned, ReplyTypeId);
}

/** The JSON Schema Pi gets for one of the tool's schemas. Pi takes an object, never a boolean schema. */
function objectSchema(
	name: ToolName,
	what: "parameters" | "success",
	schema: Schema.Constraint,
): Res.Result<object, SchemaConversionError> {
	return Res.try({
		try: () => toJsonSchema(schema),
		catch: (cause) => SchemaConversionError.make({ reason: `Tool ${name}: ${failureText(cause)}` }),
	}).pipe(
		Res.filterOrFail(Predicate.isObject, () =>
			SchemaConversionError.make({ reason: `Tool ${name}: the JSON Schema of the ${what} is not an object` }),
		),
	);
}

/** The text the model reads for a failure: an error's message, else the value formatted (a tagged error: its tag). */
function failureText(failure: unknown): string {
	return Predicate.isError(failure) && failure.message !== "" ? failure.message : Formatter.format(failure);
}
