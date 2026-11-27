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
import { formatThrownValue } from "@effectified/pi-ai";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Effect, Queue, Stream } from "effect";
import * as AgentEvents from "./agent-events.ts";
import { CannotContinue } from "./errors.ts";
import { buffered, EVENT_BUFFER } from "./event-buffer.ts";
import { type HookKey, type Hooks, toPi } from "./hooks.ts";
import { type Run, runner } from "./runner.ts";
import { untilSettled } from "./settled.ts";
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
	extends
		Omit<AgentLoopConfig, HookKey | "signal" | "fetch" | "getSteeringMessages" | "getFollowUpMessages">,
		Hooks<R> {
	readonly convertToLlm: NonNullable<Hooks<R>["convertToLlm"]>;
	/** Messages to add after the current turn's tool calls, before the next request; asked after each turn. */
	readonly getSteeringMessages?: Effect.Effect<AgentMessage[], never, R>;
	/** Messages to add when the agent would otherwise stop; asked when a turn ends with nothing more to do. */
	readonly getFollowUpMessages?: Effect.Effect<AgentMessage[], never, R>;
}

/**
 * Runs the loop with new `prompts` added to `context`: Pi's `agentLoop`. The events arrive as Pi emits them, the
 * prompts' first and `agent_end` last. Pi awaits each event: when the consumer is 16 events behind, the run waits for
 * it. Ending the Stream early, or interrupting its consumer, aborts the run and waits until Pi has settled it. The
 * run's hooks and tools are traced under the Stream's span, `AgentLoop.stream`.
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
	).pipe(Stream.withSpan("AgentLoop.stream"));
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
		(thrown) => Effect.fail(CannotContinue.make({ message: formatThrownValue(thrown) })),
	).pipe(Stream.withSpan("AgentLoop.streamContinue"));
}

/** The messages a run of `stream` added, the prompts first: Pi's `runAgentLoop` without the events. */
export const run: <R>(
	prompts: AgentMessage[],
	context: Context<R>,
	config: Config<R>,
) => Effect.Effect<AgentMessage[], SchemaConversionError, R | StreamFn> = Effect.fn("AgentLoop.run")(function* <R>(
	prompts: AgentMessage[],
	context: Context<R>,
	config: Config<R>,
): Effect.fn.Return<AgentMessage[], SchemaConversionError, R | StreamFn> {
	return yield* Stream.run(stream(prompts, context, config), AgentEvents.messages);
});

/** The messages a run of `streamContinue` added: Pi's `runAgentLoopContinue` without the events. */
export const runContinue: <R>(
	context: Context<R>,
	config: Config<R>,
) => Effect.Effect<AgentMessage[], CannotContinue | SchemaConversionError, R | StreamFn> = Effect.fn(
	"AgentLoop.runContinue",
)(function* <R>(
	context: Context<R>,
	config: Config<R>,
): Effect.fn.Return<AgentMessage[], CannotContinue | SchemaConversionError, R | StreamFn> {
	return yield* Stream.run(streamContinue(context, config), AgentEvents.messages);
});

/** Starts one of Pi's run functions with its emit sink, abort signal and stream function. */
type Start = (
	context: AgentContext,
	config: AgentLoopConfig,
	emit: (event: AgentEvent) => Promise<void> | undefined,
	signal: AbortSignal,
	streamFn: PiStreamFn,
) => Promise<AgentMessage[]>;

/**
 * The events of the run `start` begins, with the tools and hooks of `context` and `config` built in the Stream's
 * context, under an abort signal the Stream owns. Pi rejects before its first event only when there is nothing to
 * continue from: `refused` says what that rejection is. A rejection after the first event is a hook's defect.
 */
function events<E, R>(
	context: Context<R>,
	config: Config<R>,
	start: Start,
	refused: (thrown: unknown) => Effect.Effect<never, E>,
): Stream.Stream<AgentEvent, E | SchemaConversionError, R | StreamFn> {
	return Stream.callback<AgentEvent, E | SchemaConversionError, R | StreamFn>(
		(queue) =>
			Effect.gen(function* () {
				const streamFn = yield* StreamFn;
				const services = yield* Effect.context<R>();
				const run = runner(services);
				const tools = yield* Effect.forEach(context.tools ?? [], (tool) => tool.agentTool, { concurrency: 1 });
				let started = false;
				// The signal is the consumer's: closing the Stream aborts the run, drops the events that wait on a full
				// buffer, and waits for Pi to settle the run, so no hook or tool outlives the Stream.
				yield* untilSettled(
					(signal) => {
						// Nothing outlives the Stream here: its consumer leaving is the only end.
						const offer = buffered(queue, signal, Effect.never);
						const emit = (event: AgentEvent) => {
							started = true;
							return offer(event);
						};
						return start({ ...context, tools }, piConfig(config, run, signal), emit, signal, streamFn);
					},
					(thrown) => (started ? Effect.die(thrown) : refused(thrown)),
				);
				yield* Queue.end(queue);
			}),
		{ bufferSize: EVENT_BUFFER },
	);
}

/** Pi's loop configuration for `config`: its hooks and callbacks run with `run`, under the run's abort `signal`. */
function piConfig<R>(config: Config<R>, run: Run<R>, signal: AbortSignal): AgentLoopConfig {
	const { getSteeringMessages, getFollowUpMessages, convertToLlm, prepareNextTurn, ...hooks } = config;
	return {
		...toPi(hooks, run, () => signal),
		convertToLlm: (messages) => run(Effect.withSpan(convertToLlm(messages), "Hooks.convertToLlm"), signal),
		...(prepareNextTurn && {
			prepareNextTurn: (turn) => run(Effect.withSpan(prepareNextTurn(turn), "Hooks.prepareNextTurn"), signal),
		}),
		...(getSteeringMessages && {
			getSteeringMessages: () => run(Effect.withSpan(getSteeringMessages, "AgentLoop.getSteeringMessages"), signal),
		}),
		...(getFollowUpMessages && {
			getFollowUpMessages: () => run(Effect.withSpan(getFollowUpMessages, "AgentLoop.getFollowUpMessages"), signal),
		}),
	};
}
