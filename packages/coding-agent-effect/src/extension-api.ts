// What an extension can do to the session it is loaded into: Pi's `ExtensionAPI` as a service whose members are
// Effects, its tools and commands those of this package, its event bus a Stream.

import type { ExecOptions, ExtensionAPI, ExtensionVirtualModel, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider as PiProvider } from "@effectified/pi-ai";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Context, Effect, Queue, Stream } from "effect";
import type * as Command from "./command.ts";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { ExtensionContext, fromPiContext } from "./extension-context.ts";
import { type Reads, reads, type Writes, writes } from "./lift.ts";
import { runner } from "./runner.ts";
import type * as Tool from "./tool.ts";

/** The methods of Pi's extension API that only read, as Effects. */
export const READS = [
	"getSessionName",
	"getActiveTools",
	"getAllTools",
	"getSettings",
	"getCommands",
	"getThinkingLevel",
	"getFlag",
	"getMcpServers",
] as const;

/** The methods of Pi's extension API that act on the session, as Effects that fail with what Pi throws. */
export const WRITES = [
	"sendMessage",
	"sendUserMessage",
	"appendEntry",
	"setSessionName",
	"setLabel",
	"setActiveTools",
	"setThinkingLevel",
	"registerFlag",
	"registerMarkdownTransformer",
	"unregisterProvider",
	"registerMcpServer",
	"unregisterMcpServer",
	"unregisterVirtualModel",
] as const;

/** Pi's options of `exec`, without the signal: interrupting the fiber kills the command. */
export type CommandOptions = Omit<ExecOptions, "signal">;

/** A virtual model whose `route` is an Effect that runs with the context of the request. */
export interface VirtualModel<R> extends Omit<ExtensionVirtualModel, "route"> {
	readonly route: (
		request: Parameters<ExtensionVirtualModel["route"]>[0],
	) => Effect.Effect<Awaited<ReturnType<ExtensionVirtualModel["route"]>>, unknown, R | ExtensionContext>;
}

/** A keyboard shortcut of interactive mode whose handler is an Effect with the extension context. */
export interface Shortcut<R> {
	/** The key, as pi-tui names it (`"ctrl+shift+p"`). */
	readonly shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0];
	readonly description?: string;
	readonly handler: Effect.Effect<void, unknown, R | ExtensionContext>;
}

/**
 * The extension's API: every member of Pi's `ExtensionAPI` an extension acts through, as an Effect under its name.
 * Drawing (message, entry and tool renderers, factories Pi calls while it renders) is not wrapped yet; handlers are
 * given to `Extension.make`.
 */
export interface ExtensionApiHandle
	extends Reads<ExtensionAPI, (typeof READS)[number]>,
		Writes<ExtensionAPI, (typeof WRITES)[number]> {
	/** Runs a program to its end; interrupting the fiber kills it. A non-zero exit is a result, not a failure. */
	readonly exec: (
		command: string,
		args: ReadonlyArray<string>,
		options?: CommandOptions,
	) => Effect.Effect<Awaited<ReturnType<ExtensionAPI["exec"]>>, CodingAgentFailure>;
	/** Selects a model for this session; `false` when its provider has no credentials. */
	readonly setModel: (model: Parameters<ExtensionAPI["setModel"]>[0]) => Effect.Effect<boolean, CodingAgentFailure>;
	/** Registers (or replaces) a tool while the session runs. */
	readonly registerTool: <R>(tool: Tool.Any<R>) => Effect.Effect<void, SchemaConversionError | CodingAgentFailure, R>;
	/** Registers (or replaces) a command while the session runs. */
	readonly registerCommand: <R>(command: Command.Any<R>) => Effect.Effect<void, CodingAgentFailure, R>;
	/** Registers a keyboard shortcut of interactive mode. */
	readonly registerShortcut: <R>(shortcut: Shortcut<R>) => Effect.Effect<void, CodingAgentFailure, R>;
	/** Registers (or replaces) a pi-ai provider, such as one of `@effectified/pi-ai`'s `EffectProvider.make`. */
	readonly registerProvider: (provider: PiProvider) => Effect.Effect<void, CodingAgentFailure>;
	/** Registers (or overrides) the provider `name` from configuration, as `models.json` declares one: Pi's other form. */
	readonly registerProviderConfig: (name: string, config: ProviderConfig) => Effect.Effect<void, CodingAgentFailure>;
	/** Registers a virtual model, which routes each request to a physical model. */
	readonly registerVirtualModel: <R>(model: VirtualModel<R>) => Effect.Effect<void, CodingAgentFailure, R>;
	/** Sends `data` to the listeners of `channel` on the bus the session's extensions share. */
	readonly emit: (channel: string, data: unknown) => Effect.Effect<void>;
	/** What is sent on `channel` from when the Stream starts until it ends. */
	readonly events: (channel: string) => Stream.Stream<unknown>;
}

/** The API of the extension whose handler, tool, command or setup is running. */
export class ExtensionApi extends Context.Service<ExtensionApi, ExtensionApiHandle>()(
	"@effectified/pi-coding-agent/ExtensionApi",
) {}

/** Pi's extension API as a handle. */
export function fromPiApi(pi: ExtensionAPI): ExtensionApiHandle {
	const write = (act: () => void) => Effect.try({ try: act, catch: fromPi });
	return {
		...reads(pi, READS),
		...writes(pi, WRITES),
		exec: (command, args, options) =>
			Effect.tryPromise({ try: (signal) => pi.exec(command, [...args], { ...options, signal }), catch: fromPi }),
		setModel: (model) => Effect.tryPromise({ try: () => pi.setModel(model), catch: fromPi }),
		registerTool: (tool) => Effect.flatMap(tool.definition, (definition) => write(() => pi.registerTool(definition))),
		registerCommand: (command) =>
			Effect.flatMap(command.registration, (registration) =>
				write(() => pi.registerCommand(command.name, registration)),
			),
		registerShortcut: <R>(shortcut: Shortcut<R>) =>
			Effect.flatMap(Effect.context<R>(), (context) => {
				const run = runner(context);
				return write(() =>
					pi.registerShortcut(shortcut.shortcut, {
						...(shortcut.description === undefined ? {} : { description: shortcut.description }),
						handler: (ctx) => run(Effect.provideService(shortcut.handler, ExtensionContext, fromPiContext(ctx))),
					}),
				);
			}),
		registerProvider: (provider) => write(() => pi.registerProvider(provider)),
		registerProviderConfig: (name, config) => write(() => pi.registerProvider(name, config)),
		registerVirtualModel: <R>(model: VirtualModel<R>) =>
			Effect.flatMap(Effect.context<R>(), (context) => {
				const run = runner(context);
				return write(() =>
					pi.registerVirtualModel({
						...model,
						route: (request, ctx) =>
							run(
								Effect.provideService(model.route(request), ExtensionContext, fromPiContext(ctx)),
								request.signal,
							),
					}),
				);
			}),
		emit: (channel, data) => Effect.sync(() => pi.events.emit(channel, data)),
		events: (channel) =>
			Stream.callback<unknown>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => pi.events.on(channel, (data) => Queue.offerUnsafe(queue, data))),
					(unsubscribe) => Effect.sync(unsubscribe),
				),
			),
	};
}
