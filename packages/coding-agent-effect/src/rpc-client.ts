// pi-coding-agent's RPC client in Effect: a Pi agent process in RPC mode as a scoped resource, its commands as
// Effects and its events as a Stream.

import {
	type JsonAgentSessionEvent,
	RpcClient as PiRpcClient,
	type RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@effectified/pi-ai";
import { Context, Effect, Fiber, Layer, Queue, type Scope, Stream } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type Awaits, awaits, type Reads, reads } from "./lift.ts";

/** The commands of Pi's RPC client, each a request to the agent process. */
export const AWAITS = [
	"prompt",
	"steer",
	"followUp",
	"abort",
	"clearQueue",
	"newSession",
	"getState",
	"setModel",
	"cycleModel",
	"getAvailableModels",
	"setThinkingLevel",
	"cycleThinkingLevel",
	"getAvailableThinkingLevels",
	"setSteeringMode",
	"setFollowUpMode",
	"compact",
	"setAutoCompaction",
	"setAutoRetry",
	"abortRetry",
	"bash",
	"abortBash",
	"getSessionStats",
	"exportHtml",
	"switchSession",
	"fork",
	"clone",
	"getForkMessages",
	"getEntries",
	"getTree",
	"getLastAssistantText",
	"setSessionName",
	"getMessages",
	"getCommands",
] as const;

/** What the client read of the process's stderr. */
export const READS = ["getStderr"] as const;

/** A connection to an agent process in RPC mode: every command of Pi's `RpcClient` as an Effect, under its name. */
export interface RpcClientHandle
	extends Awaits<PiRpcClient, (typeof AWAITS)[number]>,
		Reads<PiRpcClient, (typeof READS)[number]> {
	/** Pi's client, for what takes one as it is. */
	readonly pi: PiRpcClient;
	/** The process's events from when the Stream starts until it ends. */
	readonly events: Stream.Stream<JsonAgentSessionEvent>;
	/** Succeeds at the next `agent_settled`: when the agent will not go on by itself. No deadline: add one on `Clock`. */
	readonly waitForIdle: Effect.Effect<void>;
	/** The events until the next `agent_settled`, that one included. */
	readonly collectEvents: Effect.Effect<ReadonlyArray<JsonAgentSessionEvent>>;
	/** Sends a prompt and gives its events until `agent_settled`. */
	readonly promptAndWait: (
		message: string,
		images?: ImageContent[],
	) => Effect.Effect<ReadonlyArray<JsonAgentSessionEvent>, CodingAgentFailure>;
}

/** The agent process of the program, in RPC mode. */
export class RpcClient extends Context.Service<RpcClient, RpcClientHandle>()("@effectified/pi-coding-agent/RpcClient") {
	/** `RpcClient.make(options)` as a Layer. */
	static layer(options?: RpcClientOptions): Layer.Layer<RpcClient, CodingAgentFailure> {
		return Layer.effect(RpcClient, RpcClient.make(options));
	}

	/**
	 * Starts `node <cliPath> --mode rpc` (Pi's `start`; `cliPath` default `dist/cli.js` of `cwd`) for the scope; closing
	 * it stops the process as Pi does.
	 */
	static make(options?: RpcClientOptions): Effect.Effect<RpcClientHandle, CodingAgentFailure, Scope.Scope> {
		return Effect.acquireRelease(
			Effect.suspend(() => {
				const pi = new PiRpcClient(options);
				return Effect.as(Effect.tryPromise({ try: () => pi.start(), catch: fromPi }), pi);
			}),
			(pi) => Effect.promise(() => pi.stop()),
		).pipe(Effect.map(RpcClient.fromPi));
	}

	/** Pi's client as a handle. It stays the caller's. */
	static fromPi(pi: PiRpcClient): RpcClientHandle {
		const events = Stream.callback<JsonAgentSessionEvent>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => pi.onEvent((event) => Queue.offerUnsafe(queue, event))),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		);
		const untilSettled = events.pipe(
			Stream.takeUntil((event) => event.type === "agent_settled"),
			Stream.runCollect,
		);
		return {
			pi,
			...awaits(pi, AWAITS),
			...reads(pi, READS),
			events,
			waitForIdle: Effect.asVoid(untilSettled),
			collectEvents: untilSettled,
			promptAndWait: (message, images) =>
				Effect.gen(function* () {
					const collecting = yield* Effect.forkChild(untilSettled, { startImmediately: true });
					yield* Effect.tryPromise({ try: () => pi.prompt(message, images), catch: fromPi });
					return yield* Fiber.join(collecting);
				}),
		};
	}
}
