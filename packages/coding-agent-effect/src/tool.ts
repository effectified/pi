// An extension's tools in Effect: parameters and result as Schemas, the handler as an Effect with the tool call's
// context as a service, built into pi-coding-agent's tool definition.

import type { ExtensionToolContext as PiToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Tool as AgentTool, ToolName } from "@effectified/pi-agent";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Effect, type Schema } from "effect";
import { ExtensionContext, fromPiContext, fromPiToolContext, ToolContext } from "./extension-context.ts";

/** What a tool definition of pi-coding-agent holds beyond a plain agent tool, passed on unchanged. */
export type Session = Pick<
	ToolDefinition,
	| "promptSnippet"
	| "promptGuidelines"
	| "exposure"
	| "namespace"
	| "annotations"
	| "defaultActive"
	| "reachesTools"
	| "prepareLoadout"
>;

/** The contexts a tool's handler gets as services. */
export type Contexts = ExtensionContext | ToolContext;

/**
 * What `make` takes besides the tool's name: `@effectified/pi-agent`'s tool options, whose handler may use the
 * contexts of the call, and the session fields of Pi's tool definition. A durable host's `replay` has no meaning in a
 * coding agent's session, and drawing a call (`renderCall`, `renderResult`, `renderShell`, factories Pi calls while
 * it renders) is not wrapped yet.
 */
export interface Options<P extends Schema.Constraint, S extends Schema.Constraint, E, R>
	extends Omit<AgentTool.Options<P, S, E, R>, "replay">, Session {}

/** A tool made by `make`. */
export interface Tool<Name extends string, P extends Schema.Constraint, S extends Schema.Constraint, E, R>
	extends Options<P, S, E, R>, Any<AgentTool.Requirements<P, S, Exclude<R, Contexts>>> {
	readonly name: Name & ToolName;
}

/** Any tool, whatever its schemas: what an extension, `ExtensionApi.registerTool` and a session take. */
export interface Any<R> {
	readonly name: ToolName;
	/** Builds Pi's tool definition; its handler runs with the services of the context this Effect runs in. */
	readonly definition: Effect.Effect<ToolDefinition, SchemaConversionError, R>;
}

/**
 * Defines a tool of a coding agent's session. As `@effectified/pi-agent`'s `Tool.make`: Pi validates the arguments
 * against the JSON Schema of `parameters`, the handler gets them decoded, and the model reads the success value as
 * text (a string as it is, anything else as JSON). A failure of the handler becomes an error result with its message.
 * The handler is interrupted when Pi aborts the call, and runs with `ExtensionContext` and `ToolContext` of the call.
 */
export function make<const Name extends string, P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: Name,
	options: Options<P, S, E, R>,
): Tool<Name, P, S, E, R> {
	// The brand checks nothing of a string, so the branded name keeps the literal type it was given.
	const branded = ToolName.make(name) as Name & ToolName;
	return { ...options, name: branded, definition: definition(branded, options) };
}

/** The tool definition of `make`: an agent tool of `@effectified/pi-agent`, given the context of each call. */
function definition<P extends Schema.Constraint, S extends Schema.Constraint, E, R>(
	name: ToolName,
	options: Options<P, S, E, R>,
): Effect.Effect<ToolDefinition, SchemaConversionError, AgentTool.Requirements<P, S, Exclude<R, Contexts>>> {
	const {
		promptSnippet,
		promptGuidelines,
		exposure,
		namespace,
		annotations,
		defaultActive,
		reachesTools,
		prepareLoadout,
		handler,
		...agentOptions
	} = options;
	// Pi passes the context of a call to `execute`; the agent tool's handler finds it by the call's id, which Pi keeps
	// unique within a session (a nested call's id is `<calling id>/<n>`).
	const contexts = new Map<string, PiToolContext>();
	const agentTool = AgentTool.make(name, {
		...agentOptions,
		handler: (params, api) =>
			Effect.suspend(() => {
				const ctx = contexts.get(api.toolCallId);
				if (ctx === undefined) return Effect.die(new Error(`Tool ${name} was called without a context`));
				return handler(params, api).pipe(
					Effect.provideService(ExtensionContext, fromPiContext(ctx)),
					Effect.provideService(ToolContext, fromPiToolContext(ctx)),
				);
			}),
	});
	return Effect.map(agentTool.agentTool, (built): ToolDefinition => ({
		name: built.name,
		label: built.label,
		description: built.description,
		parameters: built.parameters,
		...(built.outputSchema === undefined ? {} : { outputSchema: built.outputSchema }),
		...(built.executionMode === undefined ? {} : { executionMode: built.executionMode }),
		...(built.prepareArguments === undefined ? {} : { prepareArguments: built.prepareArguments }),
		...(built.constrainedSampling === undefined ? {} : { constrainedSampling: built.constrainedSampling }),
		...(promptSnippet === undefined ? {} : { promptSnippet }),
		...(promptGuidelines === undefined ? {} : { promptGuidelines }),
		...(exposure === undefined ? {} : { exposure }),
		...(namespace === undefined ? {} : { namespace }),
		...(annotations === undefined ? {} : { annotations }),
		...(defaultActive === undefined ? {} : { defaultActive }),
		...(reachesTools === undefined ? {} : { reachesTools }),
		...(prepareLoadout === undefined ? {} : { prepareLoadout }),
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			contexts.set(toolCallId, ctx);
			return built.execute(toolCallId, params, signal, onUpdate).finally(() => contexts.delete(toolCallId));
		},
	}));
}

/** The success value with extras, as `@effectified/pi-agent`'s `Tool.result`. */
export const result = AgentTool.result;

/** An error result the model reads, as `@effectified/pi-agent`'s `Tool.error`. */
export const error = AgentTool.error;

/** What a handler may use besides its arguments: the call's id and its progress reports. */
export type Api = AgentTool.Api;

/** What a handler succeeds with instead of the bare success value: a result with extras, or an error result. */
export type Reply<A> = AgentTool.Reply<A>;

/** What a result may carry besides what the model reads. */
export type Extras = AgentTool.Extras;
