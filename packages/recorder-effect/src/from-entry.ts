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
} from "@effectified/pi-ai";
import { contentText, reported, ToolCallId } from "@effectified/pi-ai";
import { type EntryRecord, type ToolDiagnostic, ToolName, ToolResultEntry } from "@effectified/pi-durable";
import { Array as Arr, Match, Option, Schema, String as Str } from "effect";
import * as Records from "./record.ts";

/**
 * The records of one entry, in order. An entry with model messages gives the records of each message: none for a
 * system message (prompt sections and tool definitions). An entry without any gives one `Entry` record with its kind
 * and data, unless the kind is Pi's own (a plain reset): that is Pi's bookkeeping, which no record holds. The same
 * entry always gives the same records.
 */
export function fromEntry(entry: EntryRecord): ReadonlyArray<Records.Record> {
	const messages = entry.model ?? [];
	if (Arr.isReadonlyArrayNonEmpty(messages)) {
		return Arr.flatMap(messages, (message, index) => fromMessage(entry, message, index));
	}
	return Str.startsWith(PI_KINDS)(entry.kind) ? [] : [stored(entry)];
}

/** The prefix of the entry kinds Pi writes itself; `Entry.make` refuses it for every other writer. */
const PI_KINDS = "pi.";

/** The record of an entry without model messages: what its writer stored, as it is. */
function stored(entry: EntryRecord): Records.Entry {
	return {
		_tag: "Entry",
		id: Records.Id.make(`${entry.conversationId}:${entry.id}:entry`),
		conversation: entry.conversationId,
		entry: entry.id,
		kind: entry.kind,
		data: entry.data ?? null,
		task: entry.byTaskId ?? null,
		time: timeOf(entry.data),
		advisory: false,
	};
}

/** What an entry's data may say of its time: a `time` field in epoch milliseconds, any finite number. */
const Timed = Schema.Struct({ time: Schema.Finite });

/** Stored data of any shape: a trust boundary, read through `Timed`. */
const decodeTimed = Schema.decodeUnknownOption(Timed);

/** The `time` an entry's data names, when it is a finite number of milliseconds. */
function timeOf(data: EntryRecord["data"]): number | null {
	return Option.getOrNull(Option.map(decodeTimed(data), ({ time }) => time));
}

/** The records of the message `index` of `entry`, by its role. */
function fromMessage(entry: EntryRecord, message: Message, index: number): ReadonlyArray<Records.Record> {
	return Match.value(message).pipe(
		Match.discriminatorsExhaustive("role")({
			system: () => [],
			user: (user) => [userMessage(entry, user, index)],
			assistant: (response) => fromResponse(entry, response, index),
			toolResult: (result) => [toolCallResult(entry, result, index)],
		}),
	);
}

/** What every record of the message `index` of `entry` starts with; `part` tells the message's records apart. */
function committed(entry: EntryRecord, index: number, time: number, part: string) {
	return {
		id: Records.Id.make(`${entry.conversationId}:${entry.id}:${index}:${part}`),
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
	const said = text(message.content);
	const saying: ReadonlyArray<Records.Record> =
		said === ""
			? []
			: [
					{
						_tag: "Message",
						...committed(entry, index, message.timestamp, "message"),
						role: "assistant",
						entryKind: entry.kind,
						text: said,
						images: [],
					},
				];
	const calls = Arr.filter(message.content, (part): part is ToolCall => part.type === "toolCall");
	const requested = Arr.map(calls, (part, call) =>
		toolCallRequested(committed(entry, index, message.timestamp, `call:${call}`), part),
	);
	return [modelCall(entry, message, index), ...saying, ...requested];
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
		// pi-ai's ids and names are plain strings: branded where they enter a record.
		callId: ToolCallId.make(call.id),
		name: ToolName.make(call.name),
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
		callId: ToolCallId.make(message.toolCallId),
		name: ToolName.make(message.toolName),
		isError: message.isError,
		codes: Arr.flatMap(diagnostics, (diagnostic) => (diagnostic.code === undefined ? [] : [diagnostic.code])),
		diagnostics: Arr.map(diagnostics, (diagnostic) => ({
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
		input: reported(usage.input),
		output: reported(usage.output),
		cacheRead: reported(usage.cacheRead),
		cacheWrite: reported(usage.cacheWrite),
		cacheWrite1h: usage.cacheWrite1h === undefined ? null : reported(usage.cacheWrite1h),
		reasoning: usage.reasoning === undefined ? null : reported(usage.reasoning),
		totalTokens: reported(usage.totalTokens),
	};
}

function cost(usage: Usage): Records.Cost {
	return {
		input: reported(usage.cost.input),
		output: reported(usage.cost.output),
		cacheRead: reported(usage.cost.cacheRead),
		cacheWrite: reported(usage.cost.cacheWrite),
		total: reported(usage.cost.total),
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
	return Arr.getSomes(Arr.map(parts, imageOf));
}

/**
 * The image a part is, if it is one. Every kind of part is decided here, so a kind pi-ai adds fails to compile until
 * it is: text goes into `text`, a tool call into its own record, and a response's thinking is not recorded.
 */
function imageOf(part: Part): Option.Option<Records.Image> {
	return Match.value(part).pipe(
		Match.discriminatorsExhaustive("type")({
			image: (image) => Option.some({ mimeType: image.mimeType, data: image.data }),
			text: () => Option.none(),
			toolCall: () => Option.none(),
			thinking: () => Option.none(),
		}),
	);
}
