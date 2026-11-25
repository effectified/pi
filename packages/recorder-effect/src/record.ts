// The records a recorder delivers: one Schema union of plain JSON values, each with a deterministic id.

import { Schema } from "effect";

/** An image of a message or a tool result, as Pi stores it: base64 data and its MIME type. */
export const Image = Schema.Struct({ mimeType: Schema.String, data: Schema.String });

/** An image of a message or a tool result. */
export type Image = typeof Image.Type;

/** The tokens of one model response, or of a tool's own work; `null` where no such count is reported. */
export const Usage = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	/** The part of `cacheWrite` written with one hour of retention. */
	cacheWrite1h: Schema.NullOr(Schema.Number),
	/** The part of `output` spent on reasoning. */
	reasoning: Schema.NullOr(Schema.Number),
	totalTokens: Schema.Number,
});

/** The tokens of one model response, or of a tool's own work. */
export type Usage = typeof Usage.Type;

/** Pi's cost of what `Usage` counts, in the currency of its model catalog. */
export const Cost = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	total: Schema.Number,
	/** True when `total` is what the provider billed; false when it is the catalog estimate. */
	fromProvider: Schema.Boolean,
});

/** Pi's cost of what `Usage` counts. */
export type Cost = typeof Cost.Type;

/** A remark Pi or a tool attached to a tool result; `code` says what happened (`blocked`, `interrupted`, ...). */
export const Diagnostic = Schema.Struct({
	severity: Schema.Literals(["info", "warn", "error"]),
	code: Schema.NullOr(Schema.String),
	message: Schema.String,
});

/** A remark Pi or a tool attached to a tool result. */
export type Diagnostic = typeof Diagnostic.Type;

/** What every record derived from a committed entry carries. */
const committed = {
	/** `<conversation>:<entry>:<message>:<part>`: the same for every delivery of the record. */
	id: Schema.String,
	/** The id of the conversation the entry belongs to. */
	conversation: Schema.Number,
	/** The id of the entry the record was derived from. */
	entry: Schema.Number,
	/** The message's own timestamp, in epoch milliseconds. */
	time: Schema.Number,
	/** Derived from an entry Pi committed with the step: delivered at least once, never lost. */
	advisory: Schema.Literal(false),
};

/**
 * A message of the transcript: what a user or a continuation put in (`role: "user"`), or the text a model response
 * holds (`role: "assistant"`, only when it has text). `entryKind` tells user input (`pi.user`, or the kind an input
 * was submitted with) from a reset's handoff (`pi.reset`) and a compaction summary (`pi.compaction`).
 */
export const Message = Schema.TaggedStruct("Message", {
	...committed,
	role: Schema.Literals(["user", "assistant"]),
	entryKind: Schema.String,
	/** The message's text parts, joined. */
	text: Schema.String,
	images: Schema.Array(Image),
});

/** A message of the transcript. */
export type Message = typeof Message.Type;

/**
 * One model response, whatever its outcome: an answer (`stop`, `length`), a turn that calls tools (`toolUse`), a
 * failed attempt (`error`, with the provider's text in `error`) or an aborted one (`aborted`). Its usage and cost are
 * the attempt's own.
 */
export const ModelCall = Schema.TaggedStruct("ModelCall", {
	...committed,
	/** The id of the generation task that made the request; `ModelCallRequested.task` names the same task. */
	task: Schema.NullOr(Schema.Number),
	provider: Schema.String,
	model: Schema.String,
	api: Schema.String,
	/** The concrete model the provider says answered. */
	responseModel: Schema.NullOr(Schema.String),
	/** The provider's id of the response. */
	responseId: Schema.NullOr(Schema.String),
	stopReason: Schema.Literals(["stop", "length", "toolUse", "error", "aborted", "pending", "deferred"]),
	/** The error text of a failed or aborted attempt. Pi reports text only, no error class. */
	error: Schema.NullOr(Schema.String),
	usage: Usage,
	cost: Cost,
	/** Milliseconds from the request's start to the end of the response. */
	durationMs: Schema.NullOr(Schema.Number),
	/**
	 * Never on a record the recorder derives: a model message holds every field. A host sets it on a model call record
	 * it derives itself from an entry a plugin stored about a request of its own, such as a reviewer's request in a
	 * `review.verdict` entry, so that a sink gets that request in this shape too:
	 *
	 * - `from`: the id of the `Entry` record it was derived from.
	 * - `unknown`: the fields of this record that entry does not hold, by name (`api`, `cost.input`). Each of them
	 *   carries its empty value (`""`, `0`, `false`), which there means "not known", never a measurement.
	 */
	derived: Schema.optionalKey(Schema.Struct({ from: Schema.String, unknown: Schema.Array(Schema.String) })),
});

/** One model response. */
export type ModelCall = typeof ModelCall.Type;

/** A tool call a model response asks for: one record per call, in call order. */
export const ToolCallRequested = Schema.TaggedStruct("ToolCallRequested", {
	...committed,
	/** The id the model gave the call; `ToolCallResult.callId` answers it. */
	callId: Schema.String,
	name: Schema.String,
	arguments: Schema.Json,
	/** Set when the model's arguments were not a JSON object: what was wrong; `arguments` is then `{}`. */
	argumentsError: Schema.NullOr(Schema.String),
});

/** A tool call a model response asks for. */
export type ToolCallRequested = typeof ToolCallRequested.Type;

/**
 * The result of a tool call, as the model reads it. `isError` with a diagnostic code is a result Pi wrote itself,
 * among them `blocked` (a gate refused the call), `invalid_arguments`, `tool_unavailable`, `tool_error` (the tool
 * threw), `interrupted` (a close or crash cut a replay-unsafe call off) and `aborted`. An error result without a code
 * is one the tool returned.
 */
export const ToolCallResult = Schema.TaggedStruct("ToolCallResult", {
	...committed,
	callId: Schema.String,
	name: Schema.String,
	isError: Schema.Boolean,
	/** The codes of `diagnostics`, in order, without the remarks that have none. */
	codes: Schema.Array(Schema.String),
	diagnostics: Schema.Array(Diagnostic),
	/** The text parts of the output, joined, Pi's rendered diagnostics block included. */
	text: Schema.String,
	images: Schema.Array(Image),
	/** What the tool stored beside the output for UIs and hosts; the model never reads it. */
	details: Schema.NullOr(Schema.Json),
	/** What the tool's own work used, when the tool reported it. */
	usage: Schema.NullOr(Usage),
	cost: Schema.NullOr(Cost),
	/** Milliseconds from the call's start to its result. */
	durationMs: Schema.NullOr(Schema.Number),
});

/** The result of a tool call. */
export type ToolCallResult = typeof ToolCallResult.Type;

/**
 * An entry that carries no model message: what a plugin or the product stored beside the transcript, such as a
 * review's verdict or a person's decision. Derived from the committed entry like the records above, so it is
 * delivered at least once, in entry order, with the same id and content every time. Pi's own entries without a
 * message (kinds that start with `pi.`, such as a plain reset) give no record.
 */
export const Entry = Schema.TaggedStruct("Entry", {
	/** `<conversation>:<entry>:entry`: the same for every delivery of the record. */
	id: Schema.String,
	/** The id of the conversation the entry belongs to. */
	conversation: Schema.Number,
	/** The id of the entry. */
	entry: Schema.Number,
	/** The entry's kind, as its writer named it: `review.verdict`, `app.note`. */
	kind: Schema.String,
	/** The entry's data as it is stored, in the shape its writer gave it; `null` for an entry without data. */
	data: Schema.Json,
	/** The id of the task that appended the entry; `null` for one a host's commit appended. */
	task: Schema.NullOr(Schema.Number),
	/**
	 * Pi stores no time with an entry. This is the `time` field of the entry's data when that is a number (epoch
	 * milliseconds, by the convention of the kinds that carry one), and `null` otherwise. Never the time of delivery,
	 * which would differ from one delivery to the next.
	 */
	time: Schema.NullOr(Schema.Number),
	/** Derived from an entry Pi committed: delivered at least once, never lost. */
	advisory: Schema.Literal(false),
});

/** An entry that carries no model message. */
export type Entry = typeof Entry.Type;

/**
 * A model request is about to be sent. No committed entry holds this, so it is advisory: sent from a hook, once per
 * time Pi asks the hook, outside the order of the other records. It can be lost (the sink failed, the process died)
 * and repeated (Pi asks again after a close); a repeat has the same id and content.
 */
export const ModelCallRequested = Schema.TaggedStruct("ModelCallRequested", {
	/** `<conversation>:<after>:requested`. */
	id: Schema.String,
	conversation: Schema.Number,
	/**
	 * The id of the newest entry of the conversation when the request was prepared, 0 for none. The `ModelCall` that
	 * answers the request is the first one of the same `task` whose entry id is greater.
	 */
	after: Schema.Number,
	/** The id of the generation task that makes the request. */
	task: Schema.Number,
	/** The harness clock when Pi first asked for this request, in epoch milliseconds. */
	time: Schema.Number,
	/** Not derived from committed state: best effort. */
	advisory: Schema.Literal(true),
});

/** A model request is about to be sent. */
export type ModelCallRequested = typeof ModelCallRequested.Type;

/** Every record a sink receives. Type and JSON form are the same, so a record can be stored or sent as it is. */
export const Record = Schema.Union([Message, ModelCall, ToolCallRequested, ToolCallResult, Entry, ModelCallRequested]);

/** Every record a sink receives. */
export type Record = typeof Record.Type;
