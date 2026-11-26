// pi-agent-core's low-level loop in Effect: one run over a context, its events as a Stream, its messages as an Effect.

import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type StreamFn as PiStreamFn,
	runAgentLoop,
	runAgentLoopContinue,
} from "@earendil-works/pi-agent-core";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Effect, Queue, Stream } from "effect";
import { CannotContinue } from "./errors.ts";
import { type HookKey, type Hooks, toPi } from "./hooks.ts";
import { runner } from "./runner.ts";
import { StreamFn } from "./stream-fn.ts";
import type * as Tool from "./tool.ts";

/** The context a run starts from: Pi's, with tools of this package. */
export interface Context<R> extends Omit<AgentContext, "tools"> {
	readonly tools?: ReadonlyArray<Tool.Any<R>>;
}

/**
 * Pi's loop configuration with its callbacks as Effects. `signal` and `fetch` are left out: interrupting the run
 * aborts it, and requests go through the `StreamFn` service.
 */
export interface Config<R>
	extends Omit<AgentLoopConfig, HookKey | "signal" | "fetch" | "getSteeringMessages" | "getFollowUpMessages">,
		Hooks<R> {
	readonly convertToLlm: NonNullable<Hooks<R>["convertToLlm"]>;
	/** Messages to add after the current turn's tool calls, before the next request; asked after each turn. */
	readonly getSteeringMessages?: Effect.Effect<AgentMessage[], never, R>;
	/** Messages to add when the agent would otherwise stop; asked when a turn ends with nothing more to do. */
	readonly getFollowUpMessages?: Effect.Effect<AgentMessage[], never, R>;
}

/**
 * Runs the loop with new `prompts` added to `context`: Pi's `agentLoop`. The events arrive as Pi emits them, the prompts'
 * first and `agent_end` last. Ending the Stream early, or interrupting its consumer, aborts the run and waits until
 * Pi has settled it.
 */
export function stream<R>(
	prompts: AgentMessage[],
	context: Context<R>,
	config: Config<R>,
): Stream.Stream<AgentEvent, SchemaConversionError, R | StreamFn> {
	return events(
		context,
		config,
		(piContext, piConfig, emit, signal, streamFn) =>
			runAgentLoop(prompts, piContext, piConfig, emit, signal, streamFn),
		Effect.die,
	);
}

/**
 * Continues the loop from `context` without a new message: Pi's `agentLoopContinue`, for a retry. Fails with
 * `CannotContinue` when `context` has no messages or ends in an assistant message.
 */
export function streamContinue<R>(
	context: Context<R>,
	config: Config<R>,
): Stream.Stream<AgentEvent, CannotContinue | SchemaConversionError, R | StreamFn> {
	return events(
		context,
		config,
		(piContext, piConfig, emit, signal, streamFn) =>
			runAgentLoopContinue(piContext, piConfig, emit, signal, streamFn),
		(cause) => Effect.fail(new CannotContinue({ message: messageOf(cause) })),
	);
}

/** The messages a run of `stream` added, the prompts first: Pi's `runAgentLoop` without the events. */
export function run<R>(
	prompts: AgentMessage[],
	context: Context<R>,
	config: Config<R>,
): Effect.Effect<AgentMessage[], SchemaConversionError, R | StreamFn> {
	return messagesOf(stream(prompts, context, config));
}

/** The messages a run of `streamContinue` added: Pi's `runAgentLoopContinue` without the events. */
export function runContinue<R>(
	context: Context<R>,
	config: Config<R>,
): Effect.Effect<AgentMessage[], CannotContinue | SchemaConversionError, R | StreamFn> {
	return messagesOf(streamContinue(context, config));
}

/** Starts one of Pi's run functions with its emit sink, abort signal and stream function. */
type Start = (
	context: AgentContext,
	config: AgentLoopConfig,
	emit: (event: AgentEvent) => void,
	signal: AbortSignal,
	streamFn: PiStreamFn,
) => Promise<AgentMessage[]>;

/**
 * The events of the run `start` begins, with the tools and hooks of `context` and `config` built in the Stream's
 * context. Pi rejects before its first event only when there is nothing to continue from: `refused` says what that
 * rejection is. A rejection after the first event is a hook's defect.
 */
function events<E, R>(
	context: Context<R>,
	config: Config<R>,
	start: Start,
	refused: (cause: unknown) => Effect.Effect<never, E>,
): Stream.Stream<AgentEvent, E | SchemaConversionError, R | StreamFn> {
	return Stream.callback<AgentEvent, E | SchemaConversionError, R | StreamFn>((queue) =>
		Effect.gen(function* () {
			const streamFn = yield* StreamFn;
			const runEffect = runner(yield* Effect.context<R>());
			const tools = yield* Effect.forEach(context.tools ?? [], (tool) => tool.agentTool);
			const controller = new AbortController();
			const { getSteeringMessages, getFollowUpMessages, convertToLlm, prepareNextTurn, ...hooks } = config;
			const piConfig: AgentLoopConfig = {
				...toPi(hooks, runEffect, () => controller.signal),
				convertToLlm: (messages) => runEffect(convertToLlm(messages), controller.signal),
				...(prepareNextTurn && {
					prepareNextTurn: (turn) => runEffect(prepareNextTurn(turn), controller.signal),
				}),
				...(getSteeringMessages && {
					getSteeringMessages: () => runEffect(getSteeringMessages, controller.signal),
				}),
				...(getFollowUpMessages && {
					getFollowUpMessages: () => runEffect(getFollowUpMessages, controller.signal),
				}),
			};
			let started = false;
			// Closing the Stream aborts the run and waits for Pi to settle it, so no hook or tool outlives the Stream.
			const settled = yield* Effect.acquireRelease(
				Effect.sync(() =>
					start(
						{ ...context, tools },
						piConfig,
						(event) => {
							started = true;
							Queue.offerUnsafe(queue, event);
						},
						controller.signal,
						streamFn,
					),
				),
				(promise) =>
					Effect.promise(() => {
						controller.abort();
						return promise.then(
							() => undefined,
							() => undefined,
						);
					}),
			);
			yield* Effect.tryPromise({ try: () => settled, catch: (cause) => cause }).pipe(
				Effect.catch((cause) => (started ? Effect.die(cause) : refused(cause))),
			);
			yield* Queue.end(queue);
		}),
	);
}

/** The messages of the `agent_end` event that ends `events`. */
function messagesOf<E, R>(events: Stream.Stream<AgentEvent, E, R>): Effect.Effect<AgentMessage[], E, R> {
	return Stream.runFold(
		events,
		(): AgentMessage[] => [],
		(messages, event) => (event.type === "agent_end" ? event.messages : messages),
	);
}

/** The message of what Pi rejected with. */
function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
