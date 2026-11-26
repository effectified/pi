// The events an extension handles, each with the answer Pi takes from its handler: the handlers of `Extension.make`
// as Effects, and their registration on Pi's extension API.

import type {
	AgentBeforeSettleEventResult,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEventResult,
	CacheWarmingDecisionEventResult,
	ContextEventResult,
	ExtensionEvent,
	InputEventResult,
	MessageEndEventResult,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolCallEventResult,
	ToolResultEventResult,
	TurnEndEventResult,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";
import type { ExtensionContext, ProjectTrustContext } from "./extension-context.ts";

/** The events a handler of `Extension.make` gets with the extension context: every event but `project_trust`. */
export type EventType = Exclude<ExtensionEvent["type"], "project_trust">;

/** The event of type `K`. */
export type EventOf<K extends EventType> = Extract<ExtensionEvent, { readonly type: K }>;

/** What Pi takes from the handler of each event that answers; the others answer nothing. */
export interface Answers {
	readonly resources_discover: ResourcesDiscoverResult;
	readonly session_before_switch: SessionBeforeSwitchResult;
	readonly session_before_fork: SessionBeforeForkResult;
	readonly session_before_compact: SessionBeforeCompactResult;
	readonly session_before_tree: SessionBeforeTreeResult;
	readonly context: ContextEventResult;
	readonly context_with_system: ContextEventResult;
	readonly cache_warming_decision: CacheWarmingDecisionEventResult;
	readonly before_provider_request: BeforeProviderRequestEventResult;
	readonly before_agent_start: BeforeAgentStartEventResult;
	readonly agent_before_settle: AgentBeforeSettleEventResult;
	readonly turn_end: TurnEndEventResult;
	readonly message_end: MessageEndEventResult;
	readonly tool_call: ToolCallEventResult;
	readonly tool_result: ToolResultEventResult;
	readonly user_bash: UserBashEventResult;
	readonly input: InputEventResult;
}

/** What the handler of `K` answers: its answer, or `undefined` to leave things as they are. */
// biome-ignore lint/suspicious/noConfusingVoidType: as Pi's handlers, one that answers nothing may succeed with anything.
export type AnswerOf<K extends EventType> = K extends keyof Answers ? Answers[K] | undefined : void;

/**
 * The handlers of an extension, each an Effect of the event that runs with `ExtensionContext` (and `project_trust`'s
 * with `ProjectTrustContext`). A failure or a defect is reported by Pi as an extension error, as a throw is.
 */
export type Handlers = {
	readonly [K in EventType]?: (event: EventOf<K>) => Effect.Effect<AnswerOf<K>, unknown, unknown>;
} & {
	readonly project_trust?: (event: ProjectTrustEvent) => Effect.Effect<ProjectTrustEventResult, unknown, unknown>;
};

/** The services the handlers of `H` need besides the contexts they are given. */
export type Services<H> = {
	[K in keyof H]-?: NonNullable<H[K]> extends (...args: never[]) => Effect.Effect<infer _A, infer _E, infer R>
		? Exclude<R, ExtensionContext | ProjectTrustContext>
		: never;
}[keyof H];
