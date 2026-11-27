// Pi Durable in Effect: the harness as a scoped Layer, conversations, commits and submissions as Effects and Streams,
// and tools, hooks, gates, signals, documents and entries as Effect definitions.

// Every type Pi Durable declares (`ConversationId`, `Entry`, `JsonObject`, ...), so an application names them
// without importing Pi Durable; where this package exports a name of its own, its own wins.
export type * from "@earendil-works/pi-durable";
// Pi's built-in entries and task kinds, as Pi's own tokens: an entry's `kind` and a task's kind compare against them.
// Pi's defaults (what a setting left out gets) and the vocabulary of its telemetry: plain values.
export {
	AssistantEntry,
	CompactionEntry,
	CompactionTask,
	DEFAULT_COMPACTION_POLICY,
	DEFAULT_HARNESS_IDENTITY,
	DEFAULT_PROGRESS_POLICY,
	DEFAULT_RESTART_LIMIT,
	DEFAULT_RETRY_POLICY,
	DURABLE_TELEMETRY_SCHEMA,
	GenerationTask,
	ResetEntry,
	SystemEntry,
	ToolResultEntry,
	ToolTask,
	UserEntry,
} from "@earendil-works/pi-durable";
// The JSON Pi stores (a memo, a checkpoint, tool details), so a caller needs no second import to name it.
export type { JsonValue } from "@effectified/pi-chord/json";
// The schema failures this package's functions can fail with, so a caller needs no second import to name them.
export { SchemaConversionError, SchemaDecodeError } from "@effectified/pi-schema";
export * as Agent from "./agent.ts";
export * as BuiltinDoc from "./builtin-doc.ts";
export { ParentContext } from "./call.ts";
export * as Conversation from "./conversation.ts";
export * as Doc from "./doc.ts";
export * as Entry from "./entry.ts";
export {
	Cancelled,
	ConversationBusy,
	ConversationIdle,
	DurableError,
	ReadAfterWrite,
	ReadOnlySession,
	SessionFailed,
	StorageRequestError,
	UnexpectedError,
} from "./errors.ts";
export * as Extension from "./extension.ts";
export * as Gate from "./gate.ts";
export * as Harness from "./harness.ts";
export * as Hook from "./hook.ts";
export * as Idle from "./idle.ts";
export type { Memo } from "./memo.ts";
export * as Registry from "./registry.ts";
export * as Scans from "./scans.ts";
export * as Section from "./section.ts";
export * as Signal from "./signal.ts";
export * as Storage from "./storage.ts";
export * as Submission from "./submission.ts";
export * as Task from "./task.ts";
export * as TaskHooks from "./task-hooks.ts";
export * as Tool from "./tool.ts";
export { ToolName } from "./tool-name.ts";
// The id a model gives a tool call: pi-ai's, branded by @effectified/pi-ai, here for the plugins that build on this.
export { ToolCallId } from "@effectified/pi-ai";
export * as Transcript from "./transcript.ts";
export * as Tx from "./tx.ts";
export * as Watch from "./watch.ts";
export type * as Wrap from "./wrap.ts";
