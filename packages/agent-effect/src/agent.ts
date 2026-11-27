// pi-agent-core's stateful agent in Effect: a scoped handle whose runs are Effects and whose events are Streams.

import {
	type AgentEvent,
	type AgentInitialState,
	type AgentMessage,
	type AgentOptions,
	type AgentState,
	Agent as PiAgent,
	type QueueMode,
} from "@earendil-works/pi-agent-core";
import { formatThrownValue, type ImageContent, withoutParentSpan } from "@effectified/pi-ai";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { type Cause, Clock, Deferred, Effect, Predicate, Queue, type Scope, Stream } from "effect";
import { AgentBusy, CannotContinue } from "./errors.ts";
import { buffered, EVENT_BUFFER } from "./event-buffer.ts";
import { type Hooks, toPi } from "./hooks.ts";
import { runner } from "./runner.ts";
import { StreamFn } from "./stream-fn.ts";
import type * as Tool from "./tool.ts";

/** What a prompt is: text (with images), one message, or several. */
export type Input = string | AgentMessage | AgentMessage[];

/** A copy of the agent's state at one moment: Pi's `AgentState`, as plain read-only fields. */
export type State = { readonly [K in keyof AgentState]: AgentState[K] };

/** One agent: a transcript, its runs, and the queues of messages for them. */
export interface Agent {
	/**
	 * Runs a prompt to its end: Pi's `prompt`. Succeeds when the run and its events are done; a failed or aborted model
	 * response ends the run normally, with that message in the transcript. Fails with `AgentBusy` while another run is
	 * going. Interrupting it aborts the run and waits until the agent is idle. Text becomes a user message stamped
	 * with `Clock`.
	 */
	readonly prompt: (input: Input, images?: ImageContent[]) => Effect.Effect<void, AgentBusy>;
	/**
	 * Continues from the transcript: Pi's `continue`. From an assistant message it runs the queued steering, else the
	 * queued follow-up messages; fails with `CannotContinue` when there is nothing to continue from.
	 */
	readonly continue: Effect.Effect<void, AgentBusy | CannotContinue>;
	/**
	 * The events of one prompt's run, from `agent_start` to `agent_end`. Pi awaits each event: when the consumer is 16
	 * events behind, the run waits for it. Ending the Stream early aborts the run and waits until the agent is idle.
	 * Fails with `AgentBusy` while another run is going.
	 */
	readonly stream: (input: Input, images?: ImageContent[]) => Stream.Stream<AgentEvent, AgentBusy>;
	/**
	 * Every event of every run from now until the scope closes, when the Stream ends: Pi's `subscribe`. The
	 * subscription starts when this Effect runs, so no event of a run started after it is missed. Events wait in an
	 * unbounded buffer; Pi does not wait for the Stream's consumer.
	 */
	readonly subscribe: Effect.Effect<Stream.Stream<AgentEvent>, never, Scope.Scope>;
	/** The state now: transcript, model, thinking level, tools, and whether a run is going. */
	readonly state: Effect.Effect<State>;
	/** Queues a message for after the current turn's tool calls. */
	readonly steer: (message: AgentMessage) => Effect.Effect<void>;
	/** Queues a message for when the agent would otherwise stop. */
	readonly followUp: (message: AgentMessage) => Effect.Effect<void>;
	readonly clearSteeringQueue: Effect.Effect<void>;
	readonly clearFollowUpQueue: Effect.Effect<void>;
	readonly clearAllQueues: Effect.Effect<void>;
	readonly hasQueuedMessages: Effect.Effect<boolean>;
	/** The messages the next turn would take from the queues, without taking them. */
	readonly peekQueuedMessages: Effect.Effect<AgentMessage[]>;
	/** How many steering (or follow-up) messages a turn takes: one at a time or all. */
	readonly setSteeringMode: (mode: QueueMode) => Effect.Effect<void>;
	readonly setFollowUpMode: (mode: QueueMode) => Effect.Effect<void>;
	/** Aborts the current run, if one is going, without waiting for it. */
	readonly abort: Effect.Effect<void>;
	/** Succeeds when no run is going and the last run's events are done. */
	readonly waitForIdle: Effect.Effect<void>;
	/** Clears the transcript (keeping its system message) and the queues. Fails with `AgentBusy` during a run. */
	readonly reset: Effect.Effect<void, AgentBusy>;
	/** The model of the next turns. */
	readonly setModel: (model: AgentState["model"]) => Effect.Effect<void>;
	readonly setThinkingLevel: (level: AgentState["thinkingLevel"]) => Effect.Effect<void>;
	/** Replaces the tools; the model is told of the difference before its next request. */
	readonly setTools: <R>(tools: ReadonlyArray<Tool.Any<R>>) => Effect.Effect<void, SchemaConversionError, R>;
	/** Replaces the transcript. */
	readonly setMessages: (messages: AgentMessage[]) => Effect.Effect<void>;
}

/** Pi's initial state, with tools of this package. */
export interface InitialState<R> extends Omit<AgentInitialState, "tools"> {
	readonly tools?: ReadonlyArray<Tool.Any<R>>;
}

/** The settings of Pi's agent that `make` takes as they are. */
export type Settings = Pick<
	AgentOptions,
	| "steeringMode"
	| "followUpMode"
	| "sessionId"
	| "thinkingBudgets"
	| "transport"
	| "maxRetryDelayMs"
	| "toolExecution"
	| "identity"
>;

/** What `make` takes: the initial state, Pi's settings, and the hooks as Effects. */
export interface Options<R> extends Settings, Hooks<R> {
	readonly initialState?: InitialState<R>;
}

/**
 * A new agent: Pi's `Agent`, sending its requests through the `StreamFn` service. Its tools and hooks run with the
 * services of the context `make` runs in. Closing the scope aborts a run that is going and waits until it settles.
 * Untraced: the agent keeps this Effect's context for its tools and hooks as long as it lives, which a span of `make`
 * would not outlive; runs, tool calls and hooks have spans of their own.
 */
export const make: <R = never>(
	options?: Options<R>,
) => Effect.Effect<Agent, SchemaConversionError, R | StreamFn | Scope.Scope> = Effect.fnUntraced(function* <R>(
	options: Options<R> = {},
): Effect.fn.Return<Agent, SchemaConversionError, R | StreamFn | Scope.Scope> {
	const streamFn = yield* StreamFn;
	// The agent outlives this Effect: Pi calls its hooks and tools later, so their spans start their own trace instead
	// of hanging under the caller's, which may have ended by then.
	const services = yield* Effect.map(Effect.context<R>(), withoutParentSpan);
	const run = runner(services);
	const { initialState, prepareNextTurn, ...rest } = options;
	const tools = yield* Effect.forEach(initialState?.tools ?? [], (tool) => tool.agentTool, { concurrency: 1 }).pipe(
		Effect.provideContext(services),
	);
	const signal = () => pi.signal;
	const pi: PiAgent = new PiAgent({
		...toPi(rest, run, signal),
		streamFn,
		initialState: { ...initialState, tools },
		...(prepareNextTurn && {
			prepareNextTurnWithContext: (context, aborted) =>
				run(Effect.withSpan(prepareNextTurn(context), "Hooks.prepareNextTurn"), aborted ?? signal()),
		}),
	});
	// Completed first when the scope closes: a stream's event waiting for a consumer that stopped reading is dropped,
	// so the run the close aborts can settle.
	const closing = yield* Deferred.make<void>();
	yield* Effect.addFinalizer(() => Effect.andThen(Deferred.succeed(closing, undefined), abortAndWait(pi)));
	return handle(pi, Deferred.await(closing));
});

/** The handle of `pi`: each member one of Pi's, as an Effect or a Stream. `closing` completes as the agent closes. */
function handle(pi: PiAgent, closing: Effect.Effect<void>): Agent {
	const prompt = Effect.fn("Agent.prompt")(function* (input: Input, images?: ImageContent[]) {
		const messages = yield* messagesOf(input, images);
		return yield* running(pi, () => pi.prompt(messages), Effect.die);
	});
	return {
		prompt,
		continue: running(
			pi,
			() => pi.continue(),
			(thrown) => Effect.fail(CannotContinue.make({ message: formatThrownValue(thrown) })),
		).pipe(Effect.withSpan("Agent.continue")),
		stream: (input, images) =>
			Stream.callback<AgentEvent, AgentBusy>(
				(queue) =>
					Effect.gen(function* () {
						const messages = yield* messagesOf(input, images);
						yield* running(
							pi,
							(consumer) => {
								// Subscribed before the run starts, as Pi emits its first events while `prompt` is called. A run
								// going already, whose call Pi then refuses, is not this Stream's.
								const going = pi.signal;
								const offer = buffered(queue, consumer, closing);
								const unsubscribe = pi.subscribe((event, run) => (run === going ? undefined : offer(event)));
								return pi.prompt(messages).finally(unsubscribe);
							},
							Effect.die,
						).pipe(Effect.withSpan("Agent.stream"));
						yield* Queue.end(queue);
					}),
				{ bufferSize: EVENT_BUFFER },
			),
		subscribe: Effect.gen(function* () {
			const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
			yield* Effect.addFinalizer(() => Queue.end(queue));
			yield* listen(pi, (event) => Queue.offerUnsafe(queue, event));
			return Stream.fromQueue(queue);
		}),
		state: Effect.sync(() => snapshot(pi.state)),
		steer: Effect.fn("Agent.steer")((message: AgentMessage) => Effect.sync(() => pi.steer(message))),
		followUp: Effect.fn("Agent.followUp")((message: AgentMessage) => Effect.sync(() => pi.followUp(message))),
		clearSteeringQueue: Effect.sync(() => pi.clearSteeringQueue()),
		clearFollowUpQueue: Effect.sync(() => pi.clearFollowUpQueue()),
		clearAllQueues: Effect.sync(() => pi.clearAllQueues()),
		hasQueuedMessages: Effect.sync(() => pi.hasQueuedMessages()),
		peekQueuedMessages: Effect.sync(() => pi.peekQueuedMessages()),
		setSteeringMode: Effect.fn("Agent.setSteeringMode")((mode: QueueMode) =>
			Effect.sync(() => {
				pi.steeringMode = mode;
			}),
		),
		setFollowUpMode: Effect.fn("Agent.setFollowUpMode")((mode: QueueMode) =>
			Effect.sync(() => {
				pi.followUpMode = mode;
			}),
		),
		abort: Effect.sync(() => pi.abort()),
		waitForIdle: Effect.promise(() => pi.waitForIdle()),
		// Pi's `reset` refuses only while a run is going.
		reset: Effect.try({
			try: () => pi.reset(),
			catch: (thrown) => AgentBusy.make({ message: formatThrownValue(thrown) }),
		}),
		setModel: Effect.fn("Agent.setModel")((model: AgentState["model"]) =>
			Effect.sync(() => {
				pi.state.model = model;
			}),
		),
		setThinkingLevel: Effect.fn("Agent.setThinkingLevel")((level: AgentState["thinkingLevel"]) =>
			Effect.sync(() => {
				pi.state.thinkingLevel = level;
			}),
		),
		setTools: Effect.fn("Agent.setTools")(function* <R>(
			tools: ReadonlyArray<Tool.Any<R>>,
		): Effect.fn.Return<void, SchemaConversionError, R> {
			pi.state.tools = yield* Effect.forEach(tools, (tool) => tool.agentTool, { concurrency: 1 });
		}),
		setMessages: Effect.fn("Agent.setMessages")((messages: AgentMessage[]) =>
			Effect.sync(() => {
				pi.state.messages = messages;
			}),
		),
	};
}

/** The messages of a prompt: text becomes a user message stamped with `Clock`, as Pi builds it. */
function messagesOf(input: Input, images: ImageContent[] | undefined): Effect.Effect<AgentMessage | AgentMessage[]> {
	if (!Predicate.isString(input)) return Effect.succeed(input);
	return Effect.map(Clock.currentTimeMillis, (timestamp) => ({
		role: "user",
		content: [{ type: "text", text: input }, ...(images ?? [])],
		timestamp,
	}));
}

/**
 * Starts a run with `start` and waits for it to end. Pi refuses a call while a run is going: then it fails with
 * `AgentBusy`, else with what `refused` makes of Pi's refusal. Interrupting it aborts the run (`start` gets the signal
 * of that interruption) and waits until the agent is idle; a refused call has no run to abort.
 */
function running<E>(
	pi: PiAgent,
	start: (signal: AbortSignal) => Promise<void>,
	refused: (thrown: unknown) => Effect.Effect<never, E>,
): Effect.Effect<void, AgentBusy | E> {
	return Effect.callback<void, AgentBusy | E>((resume, signal) => {
		// Read in the same tick as the call, which is when Pi checks whether a run is going.
		const busy = pi.signal !== undefined;
		const done = start(signal).then(
			() => resume(Effect.void),
			(thrown: unknown) =>
				resume(busy ? Effect.fail(AgentBusy.make({ message: formatThrownValue(thrown) })) : refused(thrown)),
		);
		if (busy) return;
		signal.addEventListener("abort", () => pi.abort(), { once: true });
		return Effect.promise(() => done);
	});
}

/** Aborts the run that is going, if any, and waits until the agent is idle. */
function abortAndWait(pi: PiAgent): Effect.Effect<void> {
	return Effect.promise(() => {
		pi.abort();
		return pi.waitForIdle();
	});
}

/** Listens to every event of `pi` until the scope closes. */
function listen(pi: PiAgent, listener: (event: AgentEvent) => void): Effect.Effect<void, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => pi.subscribe(listener)),
		(unsubscribe) => Effect.sync(unsubscribe),
	);
}

/**
 * The state of `pi` as plain fields. Only the transcript is copied: Pi appends to it during a run, while it replaces
 * its tools and its set of pending calls instead of changing them.
 */
function snapshot(state: AgentState): State {
	return {
		systemPrompt: state.systemPrompt,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		tools: state.tools,
		messages: state.messages.slice(),
		isStreaming: state.isStreaming,
		streamingMessage: state.streamingMessage,
		pendingToolCalls: state.pendingToolCalls,
		errorMessage: state.errorMessage,
	};
}
