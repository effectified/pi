// Records from a committed entry: what each model message of an entry becomes, with its deterministic id.

import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { type EntryRecord, type ToolDiagnostic, ToolResultEntry } from "@earendil-works/pi-durable";
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

function userMessage(entry: EntryRecord, message: UserMessage, index: number): Records.Message {
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

/** A model response: the call, its text when it has any, and the tool calls it asks for, in call order. */
function fromResponse(entry: EntryRecord, message: AssistantMessage, index: number): ReadonlyArray<Records.Record> {
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
	let call = 0;
	for (const part of message.content) {
		if (part.type !== "toolCall") continue;
		records.push({
			_tag: "ToolCallRequested",
			...committed(entry, index, message.timestamp, `call:${call++}`),
			callId: part.id,
			name: part.name,
			arguments: part.arguments,
			argumentsError: part.argumentsError ?? null,
		});
	}
	return records;
}

function modelCall(entry: EntryRecord, message: AssistantMessage, index: number): Records.ModelCall {
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

function toolCallResult(entry: EntryRecord, message: ToolResultMessage, index: number): Records.ToolCallResult {
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

/** The text parts of a content list, joined. A response's thinking parts are not text. */
function text(parts: ReadonlyArray<Part>): string {
	return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The image parts of a content list. */
function images(parts: ReadonlyArray<Part>): ReadonlyArray<Records.Image> {
	return parts.flatMap((part) => (part.type === "image" ? [{ mimeType: part.mimeType, data: part.data }] : []));
}
