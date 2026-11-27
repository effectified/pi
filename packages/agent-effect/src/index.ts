// Pi's agent loop in Effect: the agent and its loop as Effects and Streams, tools as Effects.

// Every type pi-agent-core declares (`AgentMessage`, `AgentEvent`, `AgentTool`, `AgentState`, ...), so an application
// names them without importing pi-agent-core; where this package exports a name of its own, its own wins.
export type * from "@earendil-works/pi-agent-core";
// pi-agent-core's own names for its agent class, its stream function and its tool-call options, which this package's
// `Agent`, `StreamFn` and `RunToolCallOptions` hide.
export type {
	Agent as PiAgent,
	RunToolCallOptions as PiRunToolCallOptions,
	StreamFn as PiStreamFn,
} from "@earendil-works/pi-agent-core";
// The request identity of agent loops: pi-ai's defaults with provider attribution to Pi. A setting's default.
export { DEFAULT_AGENT_IDENTITY } from "@earendil-works/pi-agent-core";
// The schema failure building a tool can fail with, so a caller needs no second import to name it.
export { SchemaConversionError } from "@effectified/pi-schema";
export * as Agent from "./agent.ts";
export * as AgentEvents from "./agent-events.ts";
export * as AgentLoop from "./agent-loop.ts";
export { AgentBusy, type AgentError, CannotContinue, ToolFailed } from "./errors.ts";
export type { Hooks } from "./hooks.ts";
// The names of tools and the ids of their calls, branded.
export { ToolCallId, ToolName } from "./ids.ts";
export { type RunToolCallOptions, runToolCall } from "./run-tool-call.ts";
export { type ProxyOptions, StreamFn } from "./stream-fn.ts";
export * as Tool from "./tool.ts";
