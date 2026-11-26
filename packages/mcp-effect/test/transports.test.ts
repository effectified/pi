// The transports as scoped resources against local servers only: a stdio server process, a Streamable HTTP server
// on loopback, and the same process behind a pipe the test runs itself.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Queue, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
	type JsonRpcRequest,
	McpClient,
	pipeTransport,
	stdioTransport,
	streamableHttpTransport,
} from "../src/index.ts";
import { json, listen, readBody } from "./http-server.ts";

const CLIENT = { name: "test-client", version: "1.0.0" };
const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

/** Whether the process `pid` still runs. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("stdioTransport", () => {
	it("talks to a local server process, sends its stderr to the queue, and ends it with the scope", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const stderr = yield* Queue.unbounded<string>();
				const inside = yield* Effect.scoped(
					Effect.gen(function* () {
						const transport = yield* stdioTransport({
							command: process.execPath,
							args: [FIXTURE],
							stderrChunks: stderr,
						});
						const client = yield* McpClient.connect(transport, CLIENT);
						const tools = yield* client.listTools();
						const result = yield* client.callTool("echo", { text: "over stdio" });
						return { pid: transport.pid ?? 0, server: client.initialize.serverInfo, tools, result };
					}),
				);
				return { ...inside, stderr: yield* Queue.take(stderr), alive: running(inside.pid) };
			}),
		);
		expect(seen.server).toEqual({ name: "stdio-fixture", version: "1.0.0" });
		expect(seen.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(seen.result.content).toEqual([{ type: "text", text: "over stdio" }]);
		expect(seen.stderr).toContain("stdio fixture ready");
		expect(seen.alive).toBe(false);
	});

	it("fails the connection with McpUnexpectedError when the command cannot start", async () => {
		const error = await runLive(
			Effect.gen(function* () {
				const transport = yield* stdioTransport({ command: "pi-effect-no-such-command" });
				return yield* Effect.flip(McpClient.connect(transport, CLIENT));
			}),
		);
		expect(error._tag).toBe("McpUnexpectedError");
		// The code depends on the machine's PATH: ENOENT, or EACCES for an unreadable directory on it.
		expect(error.message).toContain("pi-effect-no-such-command");
	});
});

describe("streamableHttpTransport", () => {
	/** A local MCP server over Streamable HTTP with JSON responses; it records every request and refuses `old`. */
	const mcpServer = (log: Array<{ method: string; authorization?: string; body?: JsonRpcRequest }>) =>
		listen(async (request, response) => {
			const authorization = request.headers.authorization;
			if (request.method !== "POST") {
				log.push({ method: request.method ?? "" });
				response.writeHead(request.method === "DELETE" ? 200 : 405).end();
				return;
			}
			const body = JSON.parse(await readBody(request)) as JsonRpcRequest;
			log.push({ method: "POST", authorization, body });
			if (authorization === "Bearer old") return json(response, 401, { error: "invalid_token" });
			if (!("id" in body)) return void response.writeHead(202).end();
			if (body.method === "tools/call") return json(response, 500, { error: "broken" });
			const result =
				body.method === "initialize"
					? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http", version: "1.0.0" } }
					: { tools: [{ name: "search", inputSchema: { type: "object" } }] };
			json(response, 200, { jsonrpc: "2.0", id: body.id, result }, { "mcp-session-id": "session-1" });
		});

	it("sends the token of its Auth, retries once after onUnauthorized, and ends the session with the scope", async () => {
		const log: Array<{ method: string; authorization?: string; body?: JsonRpcRequest }> = [];
		const tools = await runLive(
			Effect.gen(function* () {
				const origin = yield* mcpServer(log);
				const token = yield* Ref.make("old");
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const transport = yield* streamableHttpTransport({
							url: `${origin}/mcp`,
							openGetStream: false,
							auth: { token: Ref.get(token), onUnauthorized: () => Ref.set(token, "new") },
						});
						const client = yield* McpClient.connect(transport, CLIENT);
						return yield* client.listTools();
					}),
				);
			}),
		);
		expect(tools.map((tool) => tool.name)).toEqual(["search"]);
		expect(log.map((entry) => [entry.method, entry.authorization, entry.body?.method])).toEqual([
			["POST", "Bearer old", "initialize"],
			["POST", "Bearer new", "initialize"],
			["POST", "Bearer new", "notifications/initialized"],
			["POST", "Bearer new", "tools/list"],
			["DELETE", undefined, undefined],
		]);
	});

	it("fails a request the server answers with 500 as McpHttpError", async () => {
		const error = await runLive(
			Effect.gen(function* () {
				const origin = yield* mcpServer([]);
				const transport = yield* streamableHttpTransport({ url: `${origin}/mcp`, openGetStream: false });
				const client = yield* McpClient.connect(transport, CLIENT);
				return yield* Effect.flip(client.callTool("search"));
			}),
		);
		expect(error).toMatchObject({ _tag: "McpHttpError", status: 500 });
	});
});

describe("pipeTransport", () => {
	it("speaks MCP over a program the application runs, and closes its stdin with the scope", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const stderr = yield* Queue.unbounded<string>();
				const exits: number[] = [];
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						const transport = yield* pipeTransport({
							stderrChunks: stderr,
							open: (handlers) =>
								Effect.sync(() => {
									const child = spawn(process.execPath, [FIXTURE], { stdio: "pipe" });
									child.stdout.on("data", (chunk: Buffer) => handlers.onStdout(chunk));
									child.stderr.on("data", (chunk: Buffer) => handlers.onStderr(chunk));
									const exited = new Promise<number>((resolve) =>
										child.once("close", (code) => {
											exits.push(code ?? -1);
											resolve(code ?? -1);
										}),
									);
									return {
										write: (data) => void child.stdin.write(data),
										closeStdin: () => child.stdin.end(),
										close: () => void child.kill(),
										exited: Effect.promise(() => exited),
									};
								}),
						});
						const client = yield* McpClient.connect(transport, CLIENT);
						return yield* client.callTool("echo", { text: "over a pipe" });
					}),
				);
				return { result, stderr: yield* Queue.take(stderr), exits };
			}),
		);
		expect(seen.result.content).toEqual([{ type: "text", text: "over a pipe" }]);
		expect(seen.stderr).toContain("stdio fixture ready");
		// The program ended by itself once its stdin closed, as MCP's shutdown asks.
		expect(seen.exits).toEqual([0]);
	});
});
