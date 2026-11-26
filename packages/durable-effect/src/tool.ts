// Tools in Effect: parameters and result as Schemas, the handler as an Effect, built into a Pi Durable tool.

import {
	defineTool,
	type ToolControl,
	type ToolDiagnostic,
	type ToolExecutionMode,
	type ToolExecutionResult,
	type ToolPark,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { JsonValue } from "@effectified/pi-chord/json";
import {
	decodeUnknown,
	encode,
	SchemaConversionError,
	type SchemaDecodeError,
	toJsonSchema,
} from "@effectified/pi-schema";
import { Effect, Formatter, Option, Predicate, Record, Schema, Stream } from "effect";
import * as AiTool from "effect/ai/Tool";
import type * as Toolkit from "effect/ai/Toolkit";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";
import { invoker } from "./invocation.ts";
import * as Signal from "./signal.ts";
import * as ToolApi from "./tool-api.ts";
import * as Wrap from "./wrap.ts";

/** What a handler may use besides its arguments: commits, memos, signals, documents, nested calls, details. */
export type Api = ToolApi.Api;

/** A conversation as a tool call may drive it: what `api.conversation` gives. */
export type Handle = ToolApi.Handle;

/** How a nested call is made: its key within the calling call, and whether its progress is shown. */
export type NestedOptions = ToolApi.NestedOptions;

/** A nested call started without waiting for it: what `api.startTool` gives. */
export type Started = ToolApi.Started;

/** What `make` takes besides the tool's name. */
export interface Options<P extends Schema.Constraint, S extends Schema.Constraint, E, R> {
	readonly description: string;
	/** The arguments: the model gets their JSON Schema, the handler gets the decoded value. */
	readonly parameters: P;
	/** What the handler succeeds with; its JSON form is the tool's output. */
	readonly success: S;
	/** Whether a call cut off by a crash may run again on reopen. Pi's default: `unsafe`. */
	readonly replay?: ToolRegistration["replay"];
	/** Who may call the tool: the model, other tools, or both (Pi's default). */
	readonly callers?: ToolRegistration["callers"];
	/**
	 * Programs that call the tool (a nested call, a code mode script) get the success value as JSON instead of the text
	 * the model reads: Pi's `structuredOutput`, declared with the JSON Schema of `success`, which Pi validates.
	 */
	readonly structured?: boolean;
	/**
	 * Whether the calls of one round run at once or one after another, passed on unchanged. Pi's default: the
	 * settings' `toolExecution`; one `sequential` call makes its whole round sequential.
	 */
	readonly executionMode?: ToolExecutionMode;
	/**
	 * Not offered to the model until loaded (Pi's `deferred`), passed on unchanged: the model gets the tool only once
	 * the conversation's `modelTools` names it. Other tools can call it any time.
	 */
	readonly deferred?: ToolRegistration["deferred"];
	/**
	 * Repairs arguments models commonly get wrong, before Pi validates them, passed on unchanged: Pi's own callback,
	 * which gets the arguments as the model sent them. Pure, and it must not change `args`: Pi may run it again.
	 */
	readonly prepareArguments?: ToolRegistration["prepareArguments"];
	/** How much of the output the model reads, and which end is kept; passed on unchanged. */
	readonly outputLimits?: ToolRegistration["outputLimits"];
	/** pi-ai's provider-side constrained sampling of the arguments, passed on unchanged. */
	readonly constrainedSampling?: ToolRegistration["constrainedSampling"];
	/**
	 * Runs one call, or one run of it after a park. Succeeds with the success value, or with a `Reply` for more than
	 * that. Interrupted when Pi aborts the call.
	 */
	readonly handler: (params: P["Type"], api: Api) => Effect.Effect<S["Type"] | Reply<S["Type"]>, E, R>;
	/**
	 * Cleans up the outside work of a call that parked, when it is aborted while no handler runs: `api.checkpoint` is
	 * the last park's. Pi may run it more than once, and reports a failure without keeping the call alive.
	 */
	readonly cancel?: (params: P["Type"], api: Api) => Effect.Effect<void, E, R>;
}

/** A tool made by `make`. */
export interface Tool<Name extends string, P extends Schema.Constraint, S extends Schema.Constraint, E, R>
	extends Options<P, S, E, R> {
	readonly name: Name;
	/** Builds the Pi tool; its handler runs with the context this Effect is run in (`Registry.layer` runs it). */
	readonly registration: Effect.Effect<ToolRegistration, SchemaConversionError, Requirements<P, S, R>>;
}

/** What running a tool needs: its handler's services and those its schemas decode and encode with. */
export type Requirements<P extends Schema.Constraint, S extends Schema.Constraint, R> =
	| R
	| P["DecodingServices"]
	| S["EncodingServices"];

/** Any tool, whatever its schemas and requirements: what an extension holds and a registry installs. */
export interface Any {
	readonly name: string;
	readonly registration: Effect.Effect<ToolRegistration, SchemaConversionError, unknown>;
}

/** The services a tool, or each tool of a union, needs to run. */
export type Services<T> = T extends { readonly registration: Effect.Effect<infer _A, infer _E, infer R> } ? R : never;

const ReplyTypeId = "~@effectified/pi-durable/Tool/Reply";

/**
 * What a handler succeeds with instead of the bare success value: a result with more than text, an error result, or a
 * park. Made by `result`, `error`, `sleep` and `wait`.
 */
export type Reply<A> = Result<A> | ErrorResult | Sleep | Wait;

/** What a result may carry besides what the model reads. All of it is Pi's, passed on unchanged. */
export interface Extras {
	/** What the model reads instead of the success value's text, such as an image or a shorter summary. */
	readonly output?: ToolExecutionResult["output"];
	/** JSON for a host or a UI, stored with the result; the model never reads it. Default: the last `api.details`. */
	readonly details?: Schema.Json;
	/** Spend of the call itself, such as a model call it made: added to the conversation's usage under the tool. */
	readonly usage?: ToolExecutionResult["usage"];
	/** `terminate` ends the run when every result of the round asks; `handoff` starts a new context; `addTools`. */
	readonly control?: ToolControl;
	/** Remarks for the model and a UI, after those recorded with `api.diagnostic`. */
	readonly diagnostics?: ReadonlyArray<ToolDiagnostic>;
}

/** A success with extras. */
export interface Result<A> extends Extras {
	readonly [ReplyTypeId]: typeof ReplyTypeId;
	readonly _tag: "Result";
	readonly value: A;
}

/** An error result the handler decides itself: the model reads `text`, and the run goes on. */
export interface ErrorResult extends Omit<Extras, "output"> {
	readonly [ReplyTypeId]: typeof ReplyTypeId;
	readonly _tag: "Error";
	readonly text: string;
}

/** Pi's park of `kind`, which a `Sleep` or a `Wait` reply becomes. */
type Park<Kind extends ToolPark["kind"]> = Extract<ToolPark, { readonly kind: Kind }>;

/** A park until a signal or a time: the call holds no process meanwhile, then the handler runs again. */
export interface Sleep {
	readonly [ReplyTypeId]: typeof ReplyTypeId;
	readonly _tag: "Sleep";
	readonly signals?: ReadonlyArray<Signal.Key>;
	/** Epoch milliseconds on the harness clock (`api.now`). */
	readonly until?: Park<"sleep">["until"];
	/** JSON the next run finds in `api.checkpoint`. */
	readonly checkpoint?: Schema.Json;
}

/** A park until tasks this call owns have ended: nested calls started with `api.startTool`, child tasks. */
export interface Wait {
	readonly [ReplyTypeId]: typeof ReplyTypeId;
	readonly _tag: "Wait";
	readonly on: Park<"wait">["on"];
	/** `allSettled`: all of them; `failFast`: also aborts the others once one fails; `any`: the first one. */
	readonly policy: Park<"wait">["policy"];
	readonly checkpoint?: Schema.Json;
}

/** The success value with extras: details, usage, control, diagnostics, or another output for the model. */
export function result<A>(value: A, extras?: Extras): Reply<A> {
	return { ...extras, [ReplyTypeId]: ReplyTypeId, _tag: "Result", value };
}

/** An error result with `text` for the model, as Pi's `isError`: no failure of the handler. It may carry details. */
export function error(text: string, extras?: Omit<Extras, "output">): Reply<never> {
	return { ...extras, [ReplyTypeId]: ReplyTypeId, _tag: "Error", text };
}

/**
 * Parks the call until one of `signals` holds a value or the harness clock reaches `until`, whichever comes first;
 * Pi ends a park with neither as `invalid_park`. The handler then runs again with the same arguments, `api.wake`
 * saying why and `api.checkpoint` holding `checkpoint`. A restart while it is parked runs no handler.
 */
export function sleep(options: StrictOmit<Sleep, typeof ReplyTypeId | "_tag">): Reply<never> {
	return { ...options, [ReplyTypeId]: ReplyTypeId, _tag: "Sleep" };
}

/** Parks the call until tasks it owns have ended, as `policy` says; `api.wake` then lists the ended ones. */
export function wait(options: StrictOmit<Wait, typeof ReplyTypeId | "_tag">): Reply<never> {
	return { ...options, [ReplyTypeId]: ReplyTypeId, _tag: "Wait" };
}

/**
 * Defines a tool. Pi validates a call's arguments against the JSON Schema of `parameters`; the handler then gets them
 * decoded, and Pi's api for the call as its second argument. The model reads the result as text: a string as it is,
 * anything else as JSON. A call the model can recover from never fails its task: arguments the schema rejects after Pi
 * accepted them (`invalid_arguments`), a handler failure and a result `success` cannot encode (`tool_error`) each
 * become an error result with that diagnostic, as Pi writes its own. A defect of the handler rejects, which Pi turns
 * into its `tool_error` result.
 */
export function make<const Name extends string, P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: Name,
	options: Options<P, S, E, R>,
): Tool<Name, P, S, E, R> {
	return { ...options, name, registration: registration(name, options) };
}

/** A tool made from one tool of an `effect/ai` toolkit: what an extension holds and a registry installs. */
export interface FromToolkit<R> {
	readonly name: string;
	readonly registration: Effect.Effect<ToolRegistration, SchemaConversionError, R>;
}

/** What the tools of a toolkit need to run: its handlers (`toolkit.toLayer`), and what they and the schemas need. */
export type ToolkitServices<Tools extends Record<string, AiTool.Any>> =
	| AiTool.HandlersFor<Tools>
	| AiTool.HandlerServices<Tools[keyof Tools]>;

/**
 * The tools of an `effect/ai` toolkit as tools of this package, each made by `make` from the toolkit's own tool: its
 * name, its description, its parameters, and the handler the toolkit's Layer gives it. A call runs the toolkit's
 * `handle`, so Effect decodes the arguments and encodes the result with the tool's schemas, and the model reads the
 * encoded result of the final answer (preliminary results are dropped). A failure a tool returns
 * (`failureMode: "return"`) is an error result with the encoded failure; one it fails with becomes a `tool_error`
 * result, as for `make`. Tools a provider runs, and dynamic tools, have no handler here and are left out.
 */
export function fromToolkit<Tools extends Record<string, AiTool.Any>>(
	toolkit: Toolkit.Toolkit<Tools>,
): ReadonlyArray<FromToolkit<ToolkitServices<Tools>>> {
	return Record.keys(toolkit.tools).flatMap((name) => {
		const tool = toolkit.tools[name];
		if (!AiTool.isUserDefined(tool)) return [];
		const parameters: Schema.Constraint = tool.parametersSchema;
		const encodeParameters = encode(parameters);
		const made = make(tool.name, {
			description: AiTool.getDescription(tool) ?? "",
			parameters,
			success: Schema.Json,
			handler: (params, api) =>
				Effect.gen(function* () {
					const handlers = yield* toolkit;
					// `make` decoded the arguments for its handler; the toolkit's `handle` takes them as JSON.
					const results = yield* handlers.handle(name, yield* encodeParameters(params), api.callId);
					return Option.match(yield* Stream.runLast(results), {
						onNone: () => error(`Tool ${tool.name} gave no result`),
						// A decode boundary: Effect encoded the result with the JSON codec of the tool's schema.
						onSome: (last) =>
							last.isFailure ? error(readable(last.encodedResult)) : (last.encodedResult as Schema.Json),
					});
				}),
		});
		// A toolkit's record erases each tool's schemas (`Tool.Any`), so the requirement `make` infers is unknown: by
		// Effect's own typing of a toolkit, its tools need the handlers and what the handlers and the schemas need.
		const registered = made.registration as FromToolkit<ToolkitServices<Tools>>["registration"];
		return [{ name: made.name, registration: registered }];
	});
}

/** The arguments of a call as Pi gives them to a tool: validated against its JSON Schema, not decoded. */
export type Args = Parameters<ToolRegistration["execute"]>[0];

/** What Pi's `execute` settles with: a result, or a park. */
export type Execution = ToolExecutionResult | ToolPark;

/** A tool as a wrapper finds it: Pi's registration, and its execution as an Effect. */
export interface Wrapped {
	/** The wrapped tool as Pi holds it: its name, description, parameters and the rest. */
	readonly tool: ToolRegistration;
	/** Runs the wrapped tool for this call; it fails as Pi's `execute` rejects. */
	readonly execute: (args: Args, api: Api) => Effect.Effect<Execution, DurableError>;
}

/**
 * What a wrapper makes of a tool: fields of Pi's registration that replace the wrapped tool's (its description, its
 * parameters, ...), and the execution that replaces it. Left out, a field and the execution are the wrapped tool's.
 */
export type Wrapping<E, R> = Partial<StrictOmit<ToolRegistration, "name" | "execute" | "cancel">> & {
	readonly execute?: (args: Args, api: Api) => Effect.Effect<Execution, E, R>;
};

/**
 * Wraps the tool `name` of any extension, wherever the wrapping extension is selected (Pi's `wrapTool`). The wrapper
 * gets the tool, its execution as an Effect, and gives what replaces it. A wrapper is applied when the registry
 * composes, so it must be pure. It never parks itself: it passes `api` on to the wrapped execution and returns that
 * execution's park as it is; a park of its own ends the call `invalid_park`. A failure of the execution it gives
 * becomes Pi's `tool_error` result, as a rejection of `execute` does.
 */
export function wrap<E = never, R = never>(name: string, wrapper: (tool: Wrapped) => Wrapping<E, R>): Wrap.Wrap<R> {
	return Wrap.registered((invoke) => ({
		kind: "tool",
		tool: name,
		wrap: (tool) => {
			const { execute, ...fields } = wrapper({
				tool,
				execute: (args, api) => call((context) => tool.execute(args, api.pi, context)),
			});
			return {
				...tool,
				...fields,
				name: tool.name,
				...(execute === undefined
					? {}
					: { execute: (args: Args, api, context) => invoke(execute(args, ToolApi.fromPi(api)), context) }),
			};
		},
	}));
}

function registration<P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: string,
	options: Options<P, S, E, R>,
): Effect.Effect<ToolRegistration, SchemaConversionError, Requirements<P, S, R>> {
	return Effect.gen(function* () {
		const parameters = yield* objectSchema(name, "parameters", options.parameters);
		const structured =
			options.structured === true ? yield* objectSchema(name, "success", options.success) : undefined;
		const invoke = invoker(yield* Effect.context<Requirements<P, S, R>>());
		const decode = decodeUnknown(options.parameters);
		const encodeSuccess = encode(options.success);
		const run = (
			args: unknown,
			api: Api,
		): Effect.Effect<ToolExecutionResult | ToolPark, never, Requirements<P, S, R>> =>
			decode(args).pipe(
				Effect.matchEffect({
					onFailure: (failure) => Effect.succeed(errorResult("invalid_arguments", failure.message)),
					onSuccess: (params) =>
						options.handler(params, api).pipe(
							Effect.flatMap((returned) =>
								answer(
									isReply(returned) ? returned : result(returned),
									encodeSuccess,
									structured !== undefined,
								),
							),
							Effect.catch((failure) => Effect.succeed(errorResult("tool_error", failureText(failure)))),
						),
				}),
			);
		const cancel = options.cancel;
		return defineTool({
			name,
			description: options.description,
			parameters,
			...(options.replay === undefined ? {} : { replay: options.replay }),
			...(options.callers === undefined ? {} : { callers: options.callers }),
			...(structured === undefined ? {} : { structuredOutputSchema: structured }),
			...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
			...(options.deferred === undefined ? {} : { deferred: options.deferred }),
			...(options.prepareArguments === undefined ? {} : { prepareArguments: options.prepareArguments }),
			...(options.outputLimits === undefined ? {} : { outputLimits: options.outputLimits }),
			...(options.constrainedSampling === undefined ? {} : { constrainedSampling: options.constrainedSampling }),
			// Pi aborts the call through its context: that interrupts the handler's fiber, and the rejection that follows
			// is what Pi expects of an aborted `execute()`.
			execute: (args, api, context) => invoke(run(args, ToolApi.fromPi(api)), context),
			...(cancel === undefined
				? {}
				: {
						cancel: (args: unknown, api, context) =>
							invoke(
								Effect.flatMap(decode(args), (params) => cancel(params, ToolApi.fromPi(api))),
								context,
							),
					}),
		});
	});
}

/** What Pi's `execute` returns for a reply: a result or a park. `structured`: a result carries its value as JSON. */
function answer<A, R>(
	reply: Reply<A>,
	encodeSuccess: (value: A) => Effect.Effect<Schema.Json, SchemaDecodeError, R>,
	structured: boolean,
): Effect.Effect<ToolExecutionResult | ToolPark, SchemaConversionError | SchemaDecodeError, R> {
	switch (reply._tag) {
		case "Result":
			return Effect.map(
				encodeSuccess(reply.value),
				(json): ToolExecutionResult => ({
					...extras(reply),
					output: reply.output ?? [{ type: "text", text: readable(json) }],
					...(structured ? { structuredOutput: stored(json) } : {}),
				}),
			);
		case "Error":
			return Effect.succeed({ ...extras(reply), isError: true, output: [{ type: "text", text: reply.text }] });
		case "Sleep":
			return Effect.map(
				Effect.forEach(reply.signals ?? [], Signal.toPiKey),
				(signals): ToolPark => ({
					kind: "sleep",
					...(reply.signals === undefined ? {} : { signals }),
					...(reply.until === undefined ? {} : { until: reply.until }),
					...(reply.checkpoint === undefined ? {} : { checkpoint: stored(reply.checkpoint) }),
				}),
			);
		case "Wait":
			return Effect.succeed({
				kind: "wait",
				on: reply.on,
				policy: reply.policy,
				...(reply.checkpoint === undefined ? {} : { checkpoint: stored(reply.checkpoint) }),
			});
	}
}

/** JSON as the model reads it: a string as it is, anything else as JSON text. */
function readable(json: unknown): string {
	return Predicate.isString(json) ? json : JSON.stringify(json);
}

/** Whether a handler's value is a `Reply`: a success value is of any type, so the brand tells them apart. */
function isReply<A>(returned: A | Reply<A>): returned is Reply<A> {
	return Predicate.hasProperty(returned, ReplyTypeId);
}

/** The fields of a reply that Pi's result takes as they are. */
function extras(
	reply: Omit<Extras, "output">,
): Pick<ToolExecutionResult, "details" | "usage" | "control" | "diagnostics"> {
	return {
		...(reply.details === undefined ? {} : { details: stored(reply.details) }),
		...(reply.usage === undefined ? {} : { usage: reply.usage }),
		...(reply.control === undefined ? {} : { control: reply.control }),
		...(reply.diagnostics === undefined ? {} : { diagnostics: reply.diagnostics }),
	};
}

/** JSON as Pi takes it. A decode boundary: Effect types JSON read-only, Chord types the same values mutable. */
function stored(json: Schema.Json): JsonValue {
	return json as JsonValue;
}

/** The JSON Schema Pi gets for one of the tool's schemas. Pi takes an object, never a boolean schema. */
function objectSchema(
	name: string,
	what: "parameters" | "success",
	schema: Schema.Constraint,
): Effect.Effect<object, SchemaConversionError> {
	return Effect.try({
		try: () => toJsonSchema(schema),
		catch: (cause) => new SchemaConversionError({ reason: `Tool ${name}: ${failureText(cause)}` }),
	}).pipe(
		Effect.filterOrFail(
			Predicate.isObject,
			() => new SchemaConversionError({ reason: `Tool ${name}: the JSON Schema of the ${what} is not an object` }),
		),
	);
}

/** An error result in the shape of those Pi writes itself (spec 7.3): `isError` and an error diagnostic with a code. */
function errorResult(code: "invalid_arguments" | "tool_error", message: string): ToolExecutionResult {
	return { isError: true, diagnostics: [{ severity: "error", code, message }] };
}

/** The text the model reads for a failure: an error's message, else the value formatted (a tagged error: its tag). */
function failureText(failure: unknown): string {
	return Predicate.isError(failure) && failure.message !== "" ? failure.message : Formatter.format(failure);
}
