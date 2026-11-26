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
import type { ImageContent } from "@effectified/pi-ai";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { type Cause, Clock, Effect, Queue, type Scope, Stream } from "effect";
import { AgentBusy, CannotContinue } from "./errors.ts";
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
	/** The events of one prompt's run, from `agent_start` to `agent_end`. Ending the Stream early aborts the run. */
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
 */
export function make<R = never>(
	options: Options<R> = {},
): Effect.Effect<Agent, SchemaConversionError, R | StreamFn | Scope.Scope> {
	return Effect.gen(function* () {
		const streamFn = yield* StreamFn;
		const run = runner(yield* Effect.context<R>());
		const { initialState, prepareNextTurn, ...rest } = options;
		const tools = yield* Effect.forEach(initialState?.tools ?? [], (tool) => tool.agentTool);
		const signal = () => pi.signal;
		const pi: PiAgent = new PiAgent({
			...toPi(rest, run, signal),
			streamFn,
			initialState: { ...initialState, tools },
			...(prepareNextTurn && {
				prepareNextTurnWithContext: (context, aborted) => run(prepareNextTurn(context), aborted ?? signal()),
			}),
		});
		yield* Effect.addFinalizer(() => abortAndWait(pi));
		return handle(pi);
	});
}

/** The handle of `pi`: each member one of Pi's, as an Effect or a Stream. */
function handle(pi: PiAgent): Agent {
	const prompt = (input: Input, images?: ImageContent[]) =>
		Effect.flatMap(messagesOf(input, images), (messages) => running(pi, () => pi.prompt(messages), Effect.die));
	return {
		prompt,
		continue: running(
			pi,
			() => pi.continue(),
			(cause) => Effect.fail(new CannotContinue({ message: messageOf(cause) })),
		),
		stream: (input, images) =>
			Stream.callback<AgentEvent, AgentBusy>((queue) =>
				Effect.gen(function* () {
					yield* listen(pi, (event) => Queue.offerUnsafe(queue, event));
					yield* prompt(input, images);
					yield* Queue.end(queue);
				}),
			),
		subscribe: Effect.gen(function* () {
			const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
			yield* Effect.addFinalizer(() => Queue.end(queue));
			yield* listen(pi, (event) => Queue.offerUnsafe(queue, event));
			return Stream.fromQueue(queue);
		}),
		state: Effect.sync(() => snapshot(pi.state)),
		steer: (message) => Effect.sync(() => pi.steer(message)),
		followUp: (message) => Effect.sync(() => pi.followUp(message)),
		clearSteeringQueue: Effect.sync(() => pi.clearSteeringQueue()),
		clearFollowUpQueue: Effect.sync(() => pi.clearFollowUpQueue()),
		clearAllQueues: Effect.sync(() => pi.clearAllQueues()),
		hasQueuedMessages: Effect.sync(() => pi.hasQueuedMessages()),
		peekQueuedMessages: Effect.sync(() => pi.peekQueuedMessages()),
		setSteeringMode: (mode) =>
			Effect.sync(() => {
				pi.steeringMode = mode;
			}),
		setFollowUpMode: (mode) =>
			Effect.sync(() => {
				pi.followUpMode = mode;
			}),
		abort: Effect.sync(() => pi.abort()),
		waitForIdle: Effect.promise(() => pi.waitForIdle()),
		reset: refusing(pi, Effect.try({ try: () => pi.reset(), catch: (cause) => cause }), Effect.die),
		setModel: (model) =>
			Effect.sync(() => {
				pi.state.model = model;
			}),
		setThinkingLevel: (level) =>
			Effect.sync(() => {
				pi.state.thinkingLevel = level;
			}),
		setTools: (tools) =>
			Effect.map(
				Effect.forEach(tools, (tool) => tool.agentTool),
				(built) => {
					pi.state.tools = built;
				},
			),
		setMessages: (messages) =>
			Effect.sync(() => {
				pi.state.messages = messages;
			}),
	};
}

/** The messages of a prompt: text becomes a user message stamped with `Clock`, as Pi builds it. */
function messagesOf(input: Input, images: ImageContent[] | undefined): Effect.Effect<AgentMessage | AgentMessage[]> {
	if (typeof input !== "string") return Effect.succeed(input);
	return Effect.map(Clock.currentTimeMillis, (timestamp) => ({
		role: "user",
		content: [{ type: "text", text: input }, ...(images ?? [])],
		timestamp,
	}));
}

/**
 * Starts a run with `start` and waits for it to end, with the refusals of `refusing`. Interrupting it aborts the run
 * and waits until the agent is idle.
 */
function running<E>(
	pi: PiAgent,
	start: () => Promise<void>,
	refused: (cause: unknown) => Effect.Effect<never, E>,
): Effect.Effect<void, AgentBusy | E> {
	return refusing(pi, Effect.tryPromise({ try: start, catch: (cause) => cause }), refused).pipe(
		Effect.onInterrupt(() => abortAndWait(pi)),
	);
}

/**
 * `call` with what Pi rejected it with as a typed failure: `AgentBusy` when a run was going as it was called (Pi's
 * agent has an abort signal exactly then), else what `refused` makes of it. Pi refuses with plain errors only.
 */
function refusing<A, E>(
	pi: PiAgent,
	call: Effect.Effect<A, unknown>,
	refused: (cause: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, AgentBusy | E> {
	return Effect.suspend(() => {
		// Read in the same tick as the call, which is when Pi checks whether a run is active.
		const busy = pi.signal !== undefined;
		return Effect.catch(
			call,
			(cause): Effect.Effect<never, AgentBusy | E> =>
				busy ? Effect.fail(new AgentBusy({ message: messageOf(cause) })) : refused(cause),
		);
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

/** The message of what Pi rejected with. */
function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
