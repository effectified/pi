// The agent's hooks as Effects: what pi-agent-core calls around requests, turns and tool calls, in Effect terms.

import type { AgentLoopConfig } from "@earendil-works/pi-agent-core";
import { Effect } from "effect";
import type { Run } from "./runner.ts";

/** A Pi callback of one argument (and Pi's abort signal) as an Effect of the same argument and the awaited result. */
type Hook<F extends ((...args: never[]) => unknown) | undefined, R> = (
	argument: Parameters<NonNullable<F>>[0],
) => Effect.Effect<Awaited<ReturnType<NonNullable<F>>>, never, R>;

/**
 * A Pi callback whose answer may be `void` or `undefined`, both meaning "go on as usual", as an Effect of the answer
 * or `undefined`: Pi takes a promise of exactly that.
 */
type Decision<F extends ((...args: never[]) => unknown) | undefined, R> = (
	argument: Parameters<NonNullable<F>>[0],
) => Effect.Effect<Exclude<Awaited<ReturnType<NonNullable<F>>>, void> | undefined, never, R>;

/** A Pi observer of a provider request, which gets a value and the model, as an Effect. */
type Observer<F extends ((...args: never[]) => unknown) | undefined, R> = (
	value: Parameters<NonNullable<F>>[0],
	model: Parameters<NonNullable<F>>[1],
) => Effect.Effect<Awaited<ReturnType<NonNullable<F>>>, never, R>;

/**
 * pi-agent-core's hooks, each an Effect of what Pi's callback returns. Pi asks them as it documents on
 * `AgentLoopConfig`; an aborted run interrupts the hook that runs. A hook cannot fail: Pi's contract is that hooks do
 * not throw, so a defect reaches Pi as a thrown error and Pi handles it as it handles one.
 */
export interface Hooks<R> {
	/** The messages the model gets, from the agent's. The agent's default keeps system, user, assistant and tool results. */
	readonly convertToLlm?: Hook<AgentLoopConfig["convertToLlm"], R>;
	/** Changes the agent's messages before `convertToLlm`, such as pruning old ones. */
	readonly transformContext?: Hook<AgentLoopConfig["transformContext"], R>;
	/** The API key of a provider, asked before each request. */
	readonly getApiKey?: Hook<AgentLoopConfig["getApiKey"], R>;
	/** Asked before a tool runs, with validated arguments: `{ block: true }` stops it with an error result. */
	readonly beforeToolCall?: Hook<AgentLoopConfig["beforeToolCall"], R>;
	/** Asked after a tool ran: replaces fields of its result. */
	readonly afterToolCall?: Hook<AgentLoopConfig["afterToolCall"], R>;
	/** Asked after a turn, before `turn_end`: `{ action: "end" }` ends the run, `{ action: "continue" }` asks again. */
	readonly finishTurn?: Decision<AgentLoopConfig["finishTurn"], R>;
	/** Asked before every provider request: replaces the context, model or thinking level of the run. */
	readonly prepareRequest?: Decision<AgentLoopConfig["prepareRequest"], R>;
	/** Asked before the next turn: replaces the context, model or thinking level, or adds messages. */
	readonly prepareNextTurn?: Hook<AgentLoopConfig["prepareNextTurn"], R>;
	/** Inspects or replaces a provider payload before it is sent; `undefined` keeps it. */
	readonly onPayload?: Observer<AgentLoopConfig["onPayload"], R>;
	/** Observes each HTTP response of a provider request. */
	readonly onResponse?: Observer<AgentLoopConfig["onResponse"], R>;
	/** Observes each provider stream event before Pi normalizes it. */
	readonly onProviderStreamEvent?: Observer<AgentLoopConfig["onProviderStreamEvent"], R>;
}

/** The keys of `Hooks`: the callbacks of Pi's loop configuration this package gives as Effects. */
export type HookKey = keyof Hooks<never>;

/** Pi's callbacks for the hooks `toPi` converts. */
export type PiHooks = Partial<Pick<AgentLoopConfig, Exclude<HookKey, "prepareNextTurn">>>;

/**
 * `config` with its hooks replaced by Pi's callbacks, each running its Effect with `run`; its other fields are kept.
 * A hook Pi gives an abort signal runs with it; the others run with `signal()`, the signal of the run that asks them.
 * Each call of a hook has a span, `Hooks.<name>` (Pi asks them per turn, per request or per tool call), except
 * `onProviderStreamEvent`, which Pi asks per event of a provider's stream. `prepareNextTurn` is dropped and left to
 * the caller: Pi's loop and Pi's agent take it in different shapes.
 */
export function toPi<R, C extends Hooks<R>>(
	config: C,
	run: Run<R>,
	signal: () => AbortSignal | undefined,
): Omit<C, HookKey> & PiHooks {
	const {
		convertToLlm,
		transformContext,
		getApiKey,
		beforeToolCall,
		afterToolCall,
		finishTurn,
		prepareRequest,
		prepareNextTurn: _prepareNextTurn,
		onPayload,
		onResponse,
		onProviderStreamEvent,
		...settings
	} = config;
	return {
		...settings,
		...(convertToLlm && {
			convertToLlm: (messages) => run(Effect.withSpan(convertToLlm(messages), "Hooks.convertToLlm"), signal()),
		}),
		...(transformContext && {
			transformContext: (messages, aborted) =>
				run(Effect.withSpan(transformContext(messages), "Hooks.transformContext"), aborted ?? signal()),
		}),
		...(getApiKey && {
			getApiKey: (provider) => run(Effect.withSpan(getApiKey(provider), "Hooks.getApiKey"), signal()),
		}),
		...(beforeToolCall && {
			beforeToolCall: (context, aborted) =>
				run(Effect.withSpan(beforeToolCall(context), "Hooks.beforeToolCall"), aborted ?? signal()),
		}),
		...(afterToolCall && {
			afterToolCall: (context, aborted) =>
				run(Effect.withSpan(afterToolCall(context), "Hooks.afterToolCall"), aborted ?? signal()),
		}),
		...(finishTurn && {
			finishTurn: (turn, aborted) => run(Effect.withSpan(finishTurn(turn), "Hooks.finishTurn"), aborted ?? signal()),
		}),
		...(prepareRequest && {
			prepareRequest: (request, aborted) =>
				run(Effect.withSpan(prepareRequest(request), "Hooks.prepareRequest"), aborted ?? signal()),
		}),
		...(onPayload && {
			onPayload: (payload, model) => run(Effect.withSpan(onPayload(payload, model), "Hooks.onPayload"), signal()),
		}),
		...(onResponse && {
			onResponse: (response, model) =>
				run(Effect.withSpan(onResponse(response, model), "Hooks.onResponse"), signal()),
		}),
		...(onProviderStreamEvent && {
			onProviderStreamEvent: (data, model) => run(onProviderStreamEvent(data, model), signal()),
		}),
	};
}
