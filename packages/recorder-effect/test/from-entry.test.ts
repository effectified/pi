import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { fromEntry } from "../src/from-entry.ts";

/** An entry of conversation 3 with the id 20, as Pi stores one. */
function entry(fields: Omit<EntryRecord, "id" | "conversationId">): EntryRecord {
	return { id: 20 as EntryId, conversationId: 3 as ConversationId, ...fields };
}

const usage: AssistantMessage["usage"] = {
	input: 100,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	cacheWrite1h: 5,
	reasoning: 7,
	totalTokens: 190,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37, totalFromProvider: true },
};

describe("fromEntry", () => {
	it("gives a user message its text and images, and the kind of its entry", () => {
		const records = fromEntry(
			entry({
				kind: "app.question",
				model: [
					{
						role: "user",
						content: [
							{ type: "text", text: "What is " },
							{ type: "image", mimeType: "image/png", data: "aGk=" },
							{ type: "text", text: "this?" },
						],
						timestamp: 1000,
					},
				],
			}),
		);
		expect(records).toEqual([
			{
				_tag: "Message",
				id: "3:20:0:message",
				conversation: 3,
				entry: 20,
				time: 1000,
				advisory: false,
				role: "user",
				entryKind: "app.question",
				text: "What is this?",
				images: [{ mimeType: "image/png", data: "aGk=" }],
			},
		]);
	});

	it("gives a model response its call, its text and its tool calls, in that order", () => {
		const message: AssistantMessage = {
			...fauxAssistantMessage(
				[
					fauxThinking("hidden"),
					fauxText("Looking "),
					fauxToolCall("lookup", { id: "42" }, { id: "call-a" }),
					fauxText("it up."),
					fauxToolCall("lookup", { id: "43" }, { id: "call-b" }),
				],
				{ stopReason: "toolUse", responseId: "resp-1", timestamp: 2000 },
			),
			usage,
			responseModel: "faux-1-2026",
			durationMs: 12,
		};
		const records = fromEntry(entry({ kind: "pi.assistant", model: [message], byTaskId: 9 as TaskId }));
		const base = { conversation: 3, entry: 20, time: 2000, advisory: false };
		expect(records).toEqual([
			{
				_tag: "ModelCall",
				id: "3:20:0:model",
				...base,
				task: 9,
				provider: message.provider,
				model: message.model,
				api: message.api,
				responseModel: "faux-1-2026",
				responseId: "resp-1",
				stopReason: "toolUse",
				error: null,
				usage: {
					input: 100,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					cacheWrite1h: 5,
					reasoning: 7,
					totalTokens: 190,
				},
				cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37, fromProvider: true },
				durationMs: 12,
			},
			// The thinking part is not recorded.
			{
				_tag: "Message",
				id: "3:20:0:message",
				...base,
				role: "assistant",
				entryKind: "pi.assistant",
				text: "Looking it up.",
				images: [],
			},
			{
				_tag: "ToolCallRequested",
				id: "3:20:0:call:0",
				...base,
				callId: "call-a",
				name: "lookup",
				arguments: { id: "42" },
				argumentsError: null,
			},
			{
				_tag: "ToolCallRequested",
				id: "3:20:0:call:1",
				...base,
				callId: "call-b",
				name: "lookup",
				arguments: { id: "43" },
				argumentsError: null,
			},
		]);
	});

	it("records a failed attempt as a model call with its error text and usage, and no message", () => {
		const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded", timestamp: 3000 });
		const records = fromEntry(entry({ kind: "pi.assistant", model: [failed] }));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			_tag: "ModelCall",
			id: "3:20:0:model",
			task: null,
			stopReason: "error",
			error: "529 overloaded",
			responseModel: null,
			responseId: null,
			usage: { cacheWrite1h: null, reasoning: null },
			cost: { total: 0, fromProvider: false },
			durationMs: null,
		});
	});

	it("gives a tool result its outcome, its diagnostic codes, its output and its details", () => {
		const records = fromEntry(
			entry({
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: "call-a",
						toolName: "lookup",
						content: [
							{ type: "text", text: "partial" },
							{ type: "image", mimeType: "image/png", data: "aGk=" },
						],
						details: { rows: 2 },
						isError: true,
						durationMs: 8,
						timestamp: 4000,
					},
				],
				data: {
					diagnostics: [
						{ severity: "info", message: "Output was truncated" },
						{ severity: "error", code: "interrupted", message: "Tool lookup was interrupted" },
					],
				},
			}),
		);
		expect(records).toEqual([
			{
				_tag: "ToolCallResult",
				id: "3:20:0:result",
				conversation: 3,
				entry: 20,
				time: 4000,
				advisory: false,
				callId: "call-a",
				name: "lookup",
				isError: true,
				codes: ["interrupted"],
				diagnostics: [
					{ severity: "info", code: null, message: "Output was truncated" },
					{ severity: "error", code: "interrupted", message: "Tool lookup was interrupted" },
				],
				text: "partial",
				images: [{ mimeType: "image/png", data: "aGk=" }],
				details: { rows: 2 },
				usage: null,
				cost: null,
				durationMs: 8,
			},
		]);
	});

	it("gives nothing for a system message, and for an entry of Pi's own without model messages", () => {
		const system = entry({ kind: "pi.system", model: [{ role: "system", content: "", timestamp: 1 }] });
		expect(fromEntry(system)).toEqual([]);
		expect(fromEntry(entry({ kind: "pi.reset" }))).toEqual([]);
		expect(fromEntry(entry({ kind: "pi.reset", model: [] }))).toEqual([]);
		expect(fromEntry(entry({ kind: "pi.compaction", data: { reason: "threshold" } }))).toEqual([]);
	});

	it("gives an entry of another kind without model messages one record: its kind and its data, as stored", () => {
		const verdict = { answer: 19, outcome: { _tag: "Passed" }, findings: [], time: 5000 };
		expect(fromEntry(entry({ kind: "review.verdict", data: verdict, byTaskId: 9 as TaskId }))).toEqual([
			{
				_tag: "Entry",
				id: "3:20:entry",
				conversation: 3,
				entry: 20,
				kind: "review.verdict",
				data: verdict,
				task: 9,
				time: 5000,
				advisory: false,
			},
		]);
	});

	it("takes an entry record's time from the data's `time` when that is a number, and has none otherwise", () => {
		const timed = (data?: EntryRecord["data"]) => {
			const [record] = fromEntry(entry(data === undefined ? { kind: "app.note" } : { kind: "app.note", data }));
			return record?._tag === "Entry" ? [record.data, record.task, record.time] : undefined;
		};
		expect(timed({ text: "shown", time: 7 })).toEqual([{ text: "shown", time: 7 }, null, 7]);
		// A fraction stays one, as it did before 0.3.0; the record id does not depend on it.
		expect(timed({ time: 10.5 })).toEqual([{ time: 10.5 }, null, 10.5]);
		expect(timed({ text: "shown" })).toEqual([{ text: "shown" }, null, null]);
		expect(timed({ time: "yesterday" })).toEqual([{ time: "yesterday" }, null, null]);
		expect(timed([1, 2])).toEqual([[1, 2], null, null]);
		expect(timed("plain")).toEqual(["plain", null, null]);
		// An entry without data: `null`, the form the records give an absent value.
		expect(timed()).toEqual([null, null, null]);
	});

	it("gives an entry with model messages its messages' records only, whatever its kind and data", () => {
		const records = fromEntry(
			entry({
				kind: "app.import",
				data: { source: "archive" },
				model: [{ role: "user", content: "first", timestamp: 1 }],
			}),
		);
		expect(records.map((record) => [record._tag, record.id])).toEqual([["Message", "3:20:0:message"]]);
	});

	it("numbers the messages of an entry that holds several, so each record has its own id", () => {
		const records = fromEntry(
			entry({
				kind: "app.import",
				model: [
					{ role: "user", content: "first", timestamp: 1 },
					{ role: "user", content: "second", timestamp: 2 },
				],
			}),
		);
		expect(records.map((record) => record.id)).toEqual(["3:20:0:message", "3:20:1:message"]);
	});

	it("gives the same records every time for the same entry", () => {
		const stored = entry({ kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 5 }] });
		expect(fromEntry(stored)).toEqual(fromEntry(stored));
	});
});
