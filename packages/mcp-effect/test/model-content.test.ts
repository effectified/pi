// The model-facing content of MCP results as Pi builds it, with what saves the rest written as an Effect.

import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type CallToolResult,
	limitMcpContent,
	MCP_OUTPUT_MAX_BYTES,
	McpServerName,
	McpUnexpectedError,
	type OutputSaver,
	toMcpModelContent,
} from "../src/index.ts";

const FILES = McpServerName.make("files");

class Saved extends Context.Service<Saved, Array<{ data: string | Uint8Array; extension: string }>>()("test/Saved") {}

/** Saves into the `Saved` service and answers with a path made of the count. */
const save: OutputSaver<Saved> = (data, extension) =>
	Effect.map(
		Effect.gen(function* () {
			return yield* Saved;
		}),
		(saved) => {
			saved.push({ data, extension });
			return `/tmp/out-${saved.length}${extension}`;
		},
	);

const BINARY: CallToolResult = {
	content: [
		{ type: "text", text: "report:" },
		{ type: "resource", resource: { uri: "file:///r/data.zip", mimeType: "application/zip", blob: "AAEC" } },
		{ type: "resource_link", uri: "file:///r/log.txt", name: "log" },
	],
};

describe("toMcpModelContent", () => {
	it("saves binary resources with the Effect, and names the tool that reads resource links", async () => {
		const saved: Array<{ data: string | Uint8Array; extension: string }> = [];
		const content = await Effect.runPromise(
			toMcpModelContent(FILES, BINARY, { saveOutput: save, readResourceTool: "read_mcp_resource" }).pipe(
				Effect.provideService(Saved, saved),
			),
		);
		expect(content).toEqual([
			{ type: "text", text: "report:" },
			{ type: "text", text: "[Binary resource file:///r/data.zip (application/zip, 3B) saved to /tmp/out-1.zip]" },
			{ type: "text", text: '[Resource file:///r/log.txt "log". Read it with read_mcp_resource (server "files")]' },
		]);
		expect(saved.map((entry) => entry.extension)).toEqual([".zip"]);
	});

	it("says why when the save fails, as Pi does", async () => {
		const failing: OutputSaver = () => Effect.fail(new McpUnexpectedError({ cause: new Error("disk full") }));
		const content = await Effect.runPromise(toMcpModelContent(FILES, BINARY, { saveOutput: failing }));
		expect(content[1]).toEqual({
			type: "text",
			text: "[Binary resource file:///r/data.zip (application/zip, 3B) could not be saved: disk full]",
		});
	});
});

describe("limitMcpContent", () => {
	it("cuts long text in the middle and saves the full text with the Effect", async () => {
		const saved: Array<{ data: string | Uint8Array; extension: string }> = [];
		const long = "x".repeat(MCP_OUTPUT_MAX_BYTES + 100);
		const limited = await Effect.runPromise(
			limitMcpContent([{ type: "text", text: long }], save).pipe(Effect.provideService(Saved, saved)),
		);
		expect(limited.fullOutputPath).toBe("/tmp/out-1.txt");
		expect(saved).toEqual([{ data: long, extension: ".txt" }]);
		const [first] = limited.content;
		expect(first?.type === "text" && first.text).toContain("chars truncated");
	});

	it("returns content within the limit as it is, saving nothing", async () => {
		const content = [{ type: "text" as const, text: "short" }];
		expect(await Effect.runPromise(limitMcpContent(content))).toEqual({ content });
	});
});
