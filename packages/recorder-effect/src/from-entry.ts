// Records from a committed entry: what each model message of an entry becomes, with its deterministic id.

import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import { type EntryRecord, type ToolDiagnostic, ToolResultEntry } from "@earendil-works/pi-durable";
import { absurd } from "effect/Function";
import type * as Records from "./record.ts";

/**
 * The records of one entry, in order. An entry with model messages gives the records of each message: none for a
 * system message (prompt sections and tool definitions). An entry without any gives one `Entry` record with its kind
 * and data, unless the kind is Pi's own (a plain reset): that is Pi's bookkeeping, which no record holds. The same
 * entry always gives the same records.
 */
export function fromEntry(entry: EntryRecord): ReadonlyArray<Records.Record> {
	const messages = entry.model ?? [];
	if (messages.length > 0) return messages.flatMap((message, index) => fromMessage(entry, message, index));
	return entry.kind.startsWith(PI_KINDS) ? [] : [stored(entry)];
}

/** The prefix of the entry kinds Pi writes itself; `Entry.make` refuses it for every other writer. */
const PI_KINDS = "pi.";

/** The record of an entry without model messages: what its writer stored, as it is. */
function stored(entry: EntryRecord): Records.Entry {
	return {
		_tag: "Entry",
		id: `${entry.conversationId}:${entry.id}:entry`,
		conversation: entry.conversationId,
		entry: entry.id,
		kind: entry.kind,
		data: entry.data ?? null,
		task: entry.byTaskId ?? null,
		time: timeOf(entry.data),
		advisory: false,
	};
}

/** The `time` an entry's data names, when it is a number. Stored data of any shape: a trust boundary. */
function timeOf(data: EntryRecord["data"]): number | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const time = data.time;
	return typeof time === "number" ? time : null;
}

function fromMessage(entry: EntryRecord, message: Message, index: number): ReadonlyArray<Records.Record> {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return [userMessage(entry, message, index)];
		case "assistant":
			return fromResponse(entry, message, index);
		case "toolResult":
			return [toolCallResult(entry, message, index)];
	}
}

/** What every record of the message `index` of `entry` starts with; `part` tells the message's records apart. */
function committed(entry: EntryRecord, index: number, time: number, part: string) {
	return {
		id: `${entry.conversationId}:${entry.id}:${index}:${part}`,
		conversation: entry.conversationId,
		entry: entry.id,
		time,
		advisory: false,
	} as const;
}

/** What a record decides of each field of a pi-ai type: every field, so a field pi-ai adds fails to compile. */
type Fields<T> = Record<keyof T, "recorded" | "excluded">;

/** `T` with the fields `F` records and no other, so a mapping cannot read a field it decided to leave out. */
type Recorded<T, F extends Fields<T>> = Pick<T, { [K in keyof T]: F[K] extends "recorded" ? K : never }[keyof T]>;

// The role is the record's kind; the rest of a user message is recorded.
const USER = { role: "recorded", content: "recorded", timestamp: "recorded" } as const satisfies Fields<UserMessage>;

function userMessage(entry: EntryRecord, message: Recorded<UserMessage, typeof USER>, index: number): Records.Message {
	const parts =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	return {
		_tag: "Message",
		...committed(entry, index, message.timestamp, "message"),
		role: "user",
		entryKind: entry.kind,
		text: text(parts),
		images: images(parts),
	};
}

/**
 * What the records of a model response take of pi-ai's message. Not recorded: the thinking levels asked for and used,
 * pi-ai's diagnostics of the response, a deferred response's handle, the provider's own stop reason and whether the
 * model said its turn ended: what a provider or a resumed request needs, not what was said or what it cost.
 */
const RESPONSE = {
	role: "recorded",
	content: "recorded",
	api: "recorded",
	provider: "recorded",
	model: "recorded",
	responseModel: "recorded",
	responseId: "recorded",
	stopReason: "recorded",
	errorMessage: "recorded",
	usage: "recorded",
	timestamp: "recorded",
	durationMs: "recorded",
	thinkingLevel: "excluded",
	providerThinkingLevel: "excluded",
	diagnostics: "excluded",
	deferred: "excluded",
	rawStopReason: "excluded",
	endTurn: "excluded",
} as const satisfies Fields<AssistantMessage>;

/** A model response as its records read it. */
type Response = Recorded<AssistantMessage, typeof RESPONSE>;

/** A model response: the call, its text when it has any, and the tool calls it asks for, in call order. */
function fromResponse(entry: EntryRecord, message: Response, index: number): ReadonlyArray<Records.Record> {
	const records: Array<Records.Record> = [modelCall(entry, message, index)];
	const said = text(message.content);
	if (said !== "") {
		records.push({
			_tag: "Message",
			...committed(entry, index, message.timestamp, "message"),
			role: "assistant",
			entryKind: entry.kind,
			text: said,
			images: [],
		});
	}
	const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
	for (const [call, part] of calls.entries()) {
		records.push(toolCallRequested(committed(entry, index, message.timestamp, `call:${call}`), part));
	}
	return records;
}

/**
 * What a tool call record takes of pi-ai's tool call. Not recorded: a provider's signature of the thought behind the
 * call and the namespace the provider resolves the tool in, which only that provider reads.
 */
const TOOL_CALL = {
	type: "recorded",
	id: "recorded",
	name: "recorded",
	arguments: "recorded",
	argumentsError: "recorded",
	thoughtSignature: "excluded",
	namespace: "excluded",
} as const satisfies Fields<ToolCall>;

function toolCallRequested(
	at: ReturnType<typeof committed>,
	call: Recorded<ToolCall, typeof TOOL_CALL>,
): Records.ToolCallRequested {
	return {
		_tag: "ToolCallRequested",
		...at,
		callId: call.id,
		name: call.name,
		arguments: call.arguments,
		argumentsError: call.argumentsError ?? null,
	};
}

function modelCall(entry: EntryRecord, message: Response, index: number): Records.ModelCall {
	return {
		_tag: "ModelCall",
		...committed(entry, index, message.timestamp, "model"),
		task: entry.byTaskId ?? null,
		provider: message.provider,
		model: message.model,
		api: message.api,
		responseModel: message.responseModel ?? null,
		responseId: message.responseId ?? null,
		stopReason: message.stopReason,
		error: message.errorMessage ?? null,
		usage: tokens(message.usage),
		cost: cost(message.usage),
		durationMs: message.durationMs ?? null,
	};
}

/**
 * What a tool result record takes of pi-ai's message. Not recorded: the calls the tool made to other tools while it
 * ran, which pi-ai keeps for the session record and the model never reads.
 */
const TOOL_RESULT = {
	role: "recorded",
	toolCallId: "recorded",
	toolName: "recorded",
	content: "recorded",
	details: "recorded",
	usage: "recorded",
	isError: "recorded",
	timestamp: "recorded",
	durationMs: "recorded",
	nestedCalls: "excluded",
} as const satisfies Fields<ToolResultMessage>;

function toolCallResult(
	entry: EntryRecord,
	message: Recorded<ToolResultMessage, typeof TOOL_RESULT>,
	index: number,
): Records.ToolCallResult {
	// Pi's own result entries carry their diagnostics as data; a result message in an entry of another kind has none.
	const diagnostics: ReadonlyArray<ToolDiagnostic> = ToolResultEntry.is(entry) ? entry.data.diagnostics : [];
	return {
		_tag: "ToolCallResult",
		...committed(entry, index, message.timestamp, "result"),
		callId: message.toolCallId,
		name: message.toolName,
		isError: message.isError,
		codes: diagnostics.flatMap((diagnostic) => (diagnostic.code === undefined ? [] : [diagnostic.code])),
		diagnostics: diagnostics.map((diagnostic) => ({
			severity: diagnostic.severity,
			code: diagnostic.code ?? null,
			message: diagnostic.message,
		})),
		text: text(message.content),
		images: images(message.content),
		details: message.details ?? null,
		usage: message.usage === undefined ? null : tokens(message.usage),
		cost: message.usage === undefined ? null : cost(message.usage),
		durationMs: message.durationMs ?? null,
	};
}

function tokens(usage: Usage): Records.Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cacheWrite1h: usage.cacheWrite1h ?? null,
		reasoning: usage.reasoning ?? null,
		totalTokens: usage.totalTokens,
	};
}

function cost(usage: Usage): Records.Cost {
	return {
		input: usage.cost.input,
		output: usage.cost.output,
		cacheRead: usage.cost.cacheRead,
		cacheWrite: usage.cost.cacheWrite,
		total: usage.cost.total,
		fromProvider: usage.cost.totalFromProvider === true,
	};
}

/** A part of a user message, a model response or a tool result. */
type Part = TextContent | ImageContent | AssistantMessage["content"][number];

/** The text parts of a content list, joined as they are: pi-ai's `contentText`. A response's thinking is not text. */
function text(parts: ReadonlyArray<Part>): string {
	return contentText(parts, "");
}

/** The image parts of a content list. */
function images(parts: ReadonlyArray<Part>): ReadonlyArray<Records.Image> {
	return parts.flatMap((part) => {
		const image = imageOf(part);
		return image === undefined ? [] : [image];
	});
}

/**
 * The image a part is, if it is one. Every kind of part is decided here, so a kind pi-ai adds fails to compile until
 * it is: text goes into `text`, a tool call into its own record, and a response's thinking is not recorded.
 */
function imageOf(part: Part): Records.Image | undefined {
	switch (part.type) {
		case "image":
			return { mimeType: part.mimeType, data: part.data };
		case "text":
		case "toolCall":
		case "thinking":
			return undefined;
		default:
			return absurd(part);
	}
}
