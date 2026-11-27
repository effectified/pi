// pi-coding-agent's session in Effect: one conversation with its model, tools and extensions as a scoped service, a
// prompt as an Effect that aborts the run when interrupted, and the session's events as Streams.

import {
	type AgentSessionEvent,
	type AgentSessionServices,
	type CompactionResult,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CreateAgentSessionServicesOptions,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionError,
	type AgentSession as PiAgentSession,
	type PromptOptions,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { type Cause, Context, Effect, Layer, Queue, type Scope, Stream } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type Awaits, awaits, type Fields, fields, type Reads, reads, type Writes, writes } from "./lift.ts";
import { fromPiRuntime, ModelRuntime, type ModelRuntimeHandle } from "./model-runtime.ts";
import { ResourceLoader, type ResourceLoaderHandle, type Options as ResourceLoaderOptions } from "./resource-loader.ts";
import { SessionManager, type SessionManagerHandle } from "./session-manager.ts";
import { SettingsManager, type SettingsManagerHandle } from "./settings-manager.ts";
import type * as Tool from "./tool.ts";

/** The fields and getters of Pi's session, each an Effect that reads it when it runs. */
export const FIELDS = [
	"state",
	"cacheWarmingStatus",
	"model",
	"thinkingLevel",
	"routedModel",
	"isStreaming",
	"isIdle",
	"systemPrompt",
	"retryAttempt",
	"isCompacting",
	"messages",
	"steeringMode",
	"followUpMode",
	"sessionFile",
	"sessionId",
	"sessionName",
	"scopedModels",
	"promptTemplates",
	"pendingMessageCount",
	"autoCompactionEnabled",
	"isRetrying",
	"autoRetryEnabled",
	"isBashRunning",
	"hasPendingBashMessages",
] as const;

/** The methods of Pi's session that only read, as Effects. */
export const READS = [
	"getActiveToolNames",
	"getCallableToolNames",
	"getAllTools",
	"getToolDefinition",
	"getSteeringMessages",
	"getFollowUpMessages",
	"getAvailableThinkingLevels",
	"supportsThinking",
	"getUserMessagesForForking",
	"getSessionStats",
	"getContextUsage",
	"getLastAssistantText",
	"hasExtensionHandlers",
] as const;

/** The synchronous methods of Pi's session that change it, as Effects that fail with what Pi throws. */
export const WRITES = [
	"refreshContext",
	"setCacheWarmingMode",
	"setActiveToolsByName",
	"setScopedModels",
	"clearQueue",
	"setThinkingLevel",
	"cycleThinkingLevel",
	"setSteeringMode",
	"setFollowUpMode",
	"abortCompaction",
	"abortBranchSummary",
	"setAutoCompactionEnabled",
	"abortRetry",
	"setAutoRetryEnabled",
	"recordBashResult",
	"abortBash",
	"setSessionName",
	"exportToJsonl",
] as const;

/** The asynchronous methods of Pi's session that run to their end on their own, as Effects. */
export const AWAITS = [
	"steer",
	"followUp",
	"sendCustomMessage",
	"sendUserMessage",
	"abort",
	"waitForIdle",
	"setModel",
	"cycleModel",
	"exportToHtml",
] as const;

/** Pi's options of a prompt, without RPC mode's internal observer of its dispatch. */
export type Prompt = Omit<PromptOptions, "preflightResult">;

/** Pi's options of moving to another point of the session tree. */
export type NavigateOptions = NonNullable<Parameters<PiAgentSession["navigateTree"]>[1]>;

/** Pi's options of running a shell command of the user. Its output comes as session events. */
export type BashOptions = NonNullable<Parameters<PiAgentSession["executeBash"]>[2]>;

/** Pi's bindings of a mode, without the handlers this package gives as Effects and Streams. */
export type Bindings = Pick<
	NonNullable<Parameters<PiAgentSession["bindExtensions"]>[0]>,
	"uiContext" | "mode" | "commandContextActions"
>;

/** A session: every member of Pi's `AgentSession` as an Effect (or a Stream), under its name. */
export interface AgentSessionHandle
	extends
		Fields<PiAgentSession, (typeof FIELDS)[number]>,
		Reads<PiAgentSession, (typeof READS)[number]>,
		Writes<PiAgentSession, (typeof WRITES)[number]>,
		Awaits<PiAgentSession, (typeof AWAITS)[number]> {
	/** Pi's session, for what takes one as it is: `runPrintMode`, a runtime. */
	readonly pi: PiAgentSession;
	readonly sessionManager: SessionManagerHandle;
	readonly settingsManager: SettingsManagerHandle;
	readonly modelRuntime: ModelRuntimeHandle;
	readonly resourceLoader: ResourceLoaderHandle;
	/**
	 * Sends `text` and waits for the run to end, retries included: Pi's `prompt`. Extension commands and prompt
	 * templates are expanded first. Fails when the session streams and `options` does not say whether to steer or follow
	 * up. Interrupting it aborts the run and waits until the session is idle.
	 */
	readonly prompt: (text: string, options?: Prompt) => Effect.Effect<void, CodingAgentFailure>;
	/** The events of one prompt's run, until it ends. Ending the Stream early aborts the run. */
	readonly stream: (text: string, options?: Prompt) => Stream.Stream<AgentSessionEvent, CodingAgentFailure>;
	/**
	 * Every event of the session from now until the scope closes, when the Stream ends: Pi's `subscribe`. Events wait
	 * in an unbounded buffer; Pi does not wait for the Stream's consumer.
	 */
	readonly subscribe: Effect.Effect<Stream.Stream<AgentSessionEvent>, never, Scope.Scope>;
	/** Compacts the session now. Interrupting it aborts the compaction. */
	readonly compact: (customInstructions?: string) => Effect.Effect<CompactionResult, CodingAgentFailure>;
	/**
	 * Moves to another point of the session tree, summarizing the branch left when asked. Interrupting it aborts the
	 * summary.
	 */
	readonly navigateTree: (
		targetId: string,
		options?: NavigateOptions,
	) => Effect.Effect<Awaited<ReturnType<PiAgentSession["navigateTree"]>>, CodingAgentFailure>;
	/** Runs a shell command of the user (`!command`); its output comes as events. Interrupting it kills the command. */
	readonly executeBash: (
		command: string,
		options?: BashOptions,
	) => Effect.Effect<Awaited<ReturnType<PiAgentSession["executeBash"]>>, CodingAgentFailure>;
	/** Binds the extensions to a mode (its UI and command actions) and emits `session_start`. */
	readonly bindExtensions: (bindings?: Bindings) => Effect.Effect<void, CodingAgentFailure>;
	/**
	 * The errors the session's extensions report (a handler that failed, an MCP server that could not start) from now
	 * until the scope closes.
	 */
	readonly extensionErrors: Effect.Effect<Stream.Stream<ExtensionError>, never, Scope.Scope>;
	/** Reloads the extensions, skills, prompts, themes and context files. */
	readonly reload: Effect.Effect<void, CodingAgentFailure>;
	/** A summary of the session for a bug report, written by the session's model. Interrupting it cancels the request. */
	readonly summarizeForBugReport: (hint?: string) => Effect.Effect<string, CodingAgentFailure>;
}

/**
 * What `AgentSession.make` takes: Pi's options of `createAgentSession`, with this package's handles for the model
 * runtime, the settings, the session storage and the resources (Pi's defaults where one is left out), and tools of
 * this package as the custom tools.
 */
export interface Options<R> extends Omit<
	CreateAgentSessionOptions,
	"modelRuntime" | "settingsManager" | "sessionManager" | "resourceLoader" | "customTools"
> {
	readonly modelRuntime?: ModelRuntimeHandle;
	readonly settingsManager?: SettingsManagerHandle;
	readonly sessionManager?: SessionManagerHandle;
	readonly resourceLoader?: ResourceLoaderHandle;
	readonly customTools?: ReadonlyArray<Tool.Any<R>>;
}

/**
 * What `AgentSession.services` takes: Pi's `createAgentSessionServices` options, with this package's handles and the
 * resources' options with extensions written in Effect.
 */
export interface ServicesOptions<R> extends Pick<
	CreateAgentSessionServicesOptions,
	"cwd" | "agentDir" | "extensionFlagValues" | "resourceLoaderReloadOptions"
> {
	readonly settingsManager?: SettingsManagerHandle;
	readonly modelRuntime?: ModelRuntimeHandle;
	readonly resources?: Omit<ResourceLoaderOptions<R>, "cwd" | "agentDir" | "settingsManager">;
}

/** The services of a working directory a session is made over: Pi's, and this package's handles of them. */
export interface ServicesHandle {
	readonly pi: AgentSessionServices;
	readonly modelRuntime: ModelRuntimeHandle;
	readonly settingsManager: SettingsManagerHandle;
	readonly resourceLoader: ResourceLoaderHandle;
}

/** What `AgentSession.fromServices` takes besides the services: Pi's options, with tools of this package. */
export interface FromServicesOptions<R> extends Omit<
	CreateAgentSessionFromServicesOptions,
	"services" | "sessionManager" | "customTools"
> {
	readonly sessionManager: SessionManagerHandle;
	readonly customTools?: ReadonlyArray<Tool.Any<R>>;
}

/** The session of the program. */
export class AgentSession extends Context.Service<AgentSession, AgentSessionHandle>()(
	"@effectified/pi-coding-agent/agent-session/AgentSession",
) {
	/**
	 * A session for the scope with the program's `ModelRuntime`, `SettingsManager`, `SessionManager` and
	 * `ResourceLoader`, and `options` besides.
	 */
	static layer<R = never>(
		options: Omit<Options<R>, "modelRuntime" | "settingsManager" | "sessionManager" | "resourceLoader"> = {},
	): Layer.Layer<
		AgentSession,
		CodingAgentFailure | SchemaConversionError,
		R | ModelRuntime | SettingsManager | SessionManager | ResourceLoader
	> {
		return Layer.effect(
			AgentSession,
			Effect.gen(function* () {
				return yield* AgentSession.make({
					...options,
					modelRuntime: yield* ModelRuntime,
					settingsManager: yield* SettingsManager,
					sessionManager: yield* SessionManager,
					resourceLoader: yield* ResourceLoader,
				});
			}),
		);
	}

	/**
	 * A new session: Pi's `createAgentSession`. Closing the scope aborts what the session runs, waits until it is idle
	 * and disposes it. The custom tools run with the services of the context this Effect runs in.
	 */
	static readonly make = Effect.fn("AgentSession.make")(function* <R = never>(
		options: Options<R> = {},
	): Effect.fn.Return<AgentSessionHandle, CodingAgentFailure | SchemaConversionError, R | Scope.Scope> {
		const { modelRuntime, settingsManager, sessionManager, resourceLoader, customTools, ...rest } = options;
		const tools = yield* definitions(customTools);
		const created = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () =>
					createAgentSession({
						...rest,
						...(modelRuntime === undefined ? {} : { modelRuntime: modelRuntime.pi }),
						...(settingsManager === undefined ? {} : { settingsManager: settingsManager.pi }),
						...(sessionManager === undefined ? {} : { sessionManager: sessionManager.pi }),
						...(resourceLoader === undefined ? {} : { resourceLoader: resourceLoader.pi }),
						...(tools.length === 0 ? {} : { customTools: tools }),
					}),
				catch: fromPi,
			}),
			({ session }) => close(session),
		);
		return AgentSession.fromPi(created.session);
	});

	/**
	 * The services of the working directory `options.cwd`: Pi's `createAgentSessionServices`, which makes what
	 * `options` leaves out (model runtime, settings) and loads the resources. Interrupting it cancels the model
	 * runtime's first refresh.
	 */
	static readonly services = Effect.fn("AgentSession.services")(function* <R = never>(
		options: ServicesOptions<R>,
	): Effect.fn.Return<ServicesHandle, CodingAgentFailure, R> {
		const services = yield* createdServices(options);
		return servicesHandle(services);
	});

	/**
	 * A new session over `services`: Pi's `createAgentSessionFromServices`. Closing the scope aborts what the session
	 * runs, waits until it is idle and disposes it.
	 */
	static readonly fromServices = Effect.fn("AgentSession.fromServices")(function* <R = never>(
		services: ServicesHandle,
		options: FromServicesOptions<R>,
	): Effect.fn.Return<AgentSessionHandle, CodingAgentFailure | SchemaConversionError, R | Scope.Scope> {
		const { session } = yield* Effect.acquireRelease(createdFromServices(services.pi, options), (created) =>
			close(created.session),
		);
		return AgentSession.fromPi(session);
	});

	/**
	 * Pi's session as a handle. It stays the caller's: the handle adds nothing to its lifetime. The session's own
	 * operations (a prompt, a compaction, a move in the tree) are spans named for them; Pi's members lifted under their
	 * names are not.
	 */
	static fromPi(pi: PiAgentSession): AgentSessionHandle {
		const call = <A>(start: () => Promise<A>) => Effect.tryPromise({ try: start, catch: fromPi });
		const prompt = Effect.fn("AgentSession.prompt")((text: string, options?: Prompt) =>
			call(() => pi.prompt(text, options)).pipe(
				Effect.onInterrupt(() => call(() => pi.abort()).pipe(Effect.ignore)),
			),
		);
		return {
			pi,
			...fields(pi, FIELDS),
			...reads(pi, READS),
			...writes(pi, WRITES),
			...awaits(pi, AWAITS),
			sessionManager: SessionManager.fromPi(pi.sessionManager),
			settingsManager: SettingsManager.fromPi(pi.settingsManager),
			modelRuntime: fromPiRuntime(pi.modelRuntime),
			resourceLoader: ResourceLoader.fromPi(pi.resourceLoader),
			prompt,
			// The callback's buffer is unbounded: Pi's listener cannot wait for the Stream's consumer.
			stream: (text, options) =>
				Stream.callback<AgentSessionEvent, CodingAgentFailure>((queue) =>
					Effect.gen(function* () {
						yield* listen((listener) => pi.subscribe(listener), queue);
						yield* prompt(text, options);
						yield* Queue.end(queue);
					}),
				).pipe(Stream.withSpan("AgentSession.stream")),
			subscribe: subscription((listener) => pi.subscribe(listener)),
			compact: Effect.fn("AgentSession.compact")((customInstructions?: string) =>
				call(() => pi.compact(customInstructions)).pipe(
					Effect.onInterrupt(() => Effect.sync(() => pi.abortCompaction())),
				),
			),
			navigateTree: Effect.fn("AgentSession.navigateTree")((targetId: string, options?: NavigateOptions) =>
				call(() => pi.navigateTree(targetId, options)).pipe(
					Effect.onInterrupt(() => Effect.sync(() => pi.abortBranchSummary())),
				),
			),
			executeBash: Effect.fn("AgentSession.executeBash")((command: string, options?: BashOptions) =>
				call(() => pi.executeBash(command, undefined, options)).pipe(
					Effect.onInterrupt(() => Effect.sync(() => pi.abortBash())),
				),
			),
			bindExtensions: Effect.fn("AgentSession.bindExtensions")((bindings?: Bindings) =>
				call(() => pi.bindExtensions({ ...bindings })),
			),
			extensionErrors: subscription((listener) => pi.extensionRunner.onError(listener)),
			reload: call(() => pi.reload()).pipe(Effect.withSpan("AgentSession.reload")),
			summarizeForBugReport: Effect.fn("AgentSession.summarizeForBugReport")((hint?: string) =>
				Effect.tryPromise({
					try: (signal) => pi.summarizeForBugReport({ ...(hint === undefined ? {} : { hint }), signal }),
					catch: fromPi,
				}),
			),
		};
	}
}

/**
 * Pi's services for `options`, the Effect extensions among the resources run with the services of the context.
 * Untraced: `AgentSession.services` and the runtime's session factory are the spans.
 */
export const createdServices = Effect.fnUntraced(function* <R = never>(
	options: ServicesOptions<R>,
): Effect.fn.Return<AgentSessionServices, CodingAgentFailure, R> {
	const { settingsManager, modelRuntime, resources, ...rest } = options;
	const { extensions, extensionFactories, ...loader } = resources ?? {};
	// One after another, as Pi loads its extension factories in order.
	const inline = yield* Effect.forEach(extensions ?? [], (extension) => extension.inline, { concurrency: 1 });
	return yield* Effect.tryPromise({
		try: (signal) =>
			createAgentSessionServices({
				...rest,
				...(settingsManager === undefined ? {} : { settingsManager: settingsManager.pi }),
				...(modelRuntime === undefined ? {} : { modelRuntime: modelRuntime.pi }),
				modelRuntimeSignal: signal,
				resourceLoaderOptions: { ...loader, extensionFactories: [...(extensionFactories ?? []), ...inline] },
			}),
		catch: fromPi,
	});
});

/**
 * Pi's session over `services`, with the custom tools of `options` built with the services of the context.
 * Untraced: `AgentSession.fromServices` and the runtime's session factory are the spans.
 */
export const createdFromServices = Effect.fnUntraced(function* <R = never>(
	services: AgentSessionServices,
	options: FromServicesOptions<R>,
): Effect.fn.Return<CreateAgentSessionResult, CodingAgentFailure | SchemaConversionError, R> {
	const { sessionManager, customTools, ...rest } = options;
	const tools = yield* definitions(customTools);
	return yield* Effect.tryPromise({
		try: () =>
			createAgentSessionFromServices({
				...rest,
				services,
				sessionManager: sessionManager.pi,
				...(tools.length === 0 ? {} : { customTools: tools }),
			}),
		catch: fromPi,
	});
});

/** Pi's definitions of `tools`, built one after another in their order with the services of the context. */
function definitions<R>(
	tools: ReadonlyArray<Tool.Any<R>> | undefined,
): Effect.Effect<ToolDefinition[], SchemaConversionError, R> {
	return Effect.forEach(tools ?? [], (tool) => tool.definition, { concurrency: 1 });
}

/** Pi's services as a handle. */
function servicesHandle(pi: AgentSessionServices): ServicesHandle {
	return {
		pi,
		modelRuntime: fromPiRuntime(pi.modelRuntime),
		settingsManager: SettingsManager.fromPi(pi.settingsManager),
		resourceLoader: ResourceLoader.fromPi(pi.resourceLoader),
	};
}

/** Aborts what `pi` runs, waits until it is idle, and disposes it. */
function close(pi: PiAgentSession): Effect.Effect<void> {
	return Effect.promise(() => pi.abort()).pipe(Effect.ensuring(Effect.sync(() => pi.dispose())));
}

/** Everything `subscribe` reports from now until the scope closes, as a Stream that then ends. */
const subscription = Effect.fnUntraced(function* <A>(
	subscribe: (listener: (value: A) => void) => () => void,
): Effect.fn.Return<Stream.Stream<A>, never, Scope.Scope> {
	// Unbounded: Pi's listeners cannot wait for the Stream's consumer.
	const queue = yield* Queue.unbounded<A, Cause.Done>();
	yield* Effect.addFinalizer(() => Queue.end(queue));
	yield* listen(subscribe, queue);
	return Stream.fromQueue(queue);
});

/** Offers everything `subscribe` reports to `queue` until the scope closes. */
function listen<A, E>(
	subscribe: (listener: (value: A) => void) => () => void,
	queue: Queue.Queue<A, E>,
): Effect.Effect<void, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => subscribe((value) => Queue.offerUnsafe(queue, value))),
		(unsubscribe) => Effect.sync(unsubscribe),
	);
}
