import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentMessage } from "@effectified/pi-agent";
import type { Message } from "@effectified/pi-ai";
import { fauxAssistantMessage, fauxProvider, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentLoop, StreamFn } from "../src/index.ts";
import { model, scripted } from "./scripted.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

const LLM_ROLES: ReadonlyArray<string> = ["system", "user", "assistant", "toolResult"];

// What Pi's agent sends a model by default: its own messages, not the ones an app adds (coding-agent's, say).
const convertToLlm = (messages: AgentMessage[]) =>
	Effect.succeed(messages.filter((message): message is Message => LLM_ROLES.includes(message.role)));

describe("StreamFn.models", () => {
	it("sends the requests to the providers of Models", async () => {
		const { messages, calls } = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses([fauxAssistantMessage("from Models")]));
				const messages = yield* AgentLoop.run(
					[user("hi")],
					{ messages: [] },
					{ model: yield* model, convertToLlm },
				);
				return { messages, calls: yield* ScriptedModels.use((models) => models.callCount) };
			}).pipe(Effect.provide(scripted)),
		);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "from Models" }] });
		expect(calls).toBe(1);
	});
});

/** What the proxy server saw: each request's path and authorization header. */
interface Seen {
	readonly path: string | undefined;
	readonly authorization: string | undefined;
}

/** The events a proxy server sends for one text answer, as Pi's proxy protocol writes them. */
const ANSWER = [
	{ type: "start" },
	{ type: "text_start", contentIndex: 0 },
	{ type: "text_delta", contentIndex: 0, delta: "from the proxy" },
	{ type: "text_end", contentIndex: 0 },
	{
		type: "done",
		reason: "stop",
		usage: {
			input: 1,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
];

/** A local proxy server: its URL, what it saw, and the server itself. */
interface Proxy {
	readonly url: string;
	readonly seen: Seen[];
	readonly server: Server;
}

/** A local server that answers every request with `ANSWER`, on a free port, closed with the scope. */
const proxyServer = Effect.acquireRelease(
	Effect.callback<Proxy>((resume) => {
		const seen: Seen[] = [];
		const server = createServer((request, response) => {
			seen.push({ path: request.url, authorization: request.headers.authorization });
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(ANSWER.map((event) => `data: ${JSON.stringify(event)}\n`).join(""));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, seen, server }));
		});
	}),
	({ server }) =>
		Effect.callback<void>((resume) => {
			server.close(() => resume(Effect.void));
		}),
);

describe("StreamFn.proxy", () => {
	it("sends the requests to the proxy server with the token its Effect gives for each request", async () => {
		const { messages, seen } = await runTest(
			Effect.gen(function* () {
				const proxy = yield* proxyServer;
				let tokens = 0;
				const live = StreamFn.proxy({
					proxyUrl: proxy.url,
					authToken: Effect.sync(() => `token-${++tokens}`),
				});
				const config = { model: fauxProvider().getModel(), convertToLlm };
				const run = AgentLoop.run([user("hi")], { messages: [] }, config).pipe(Effect.provide(live));
				const first = yield* run;
				yield* run;
				return { messages: first, seen: proxy.seen };
			}),
		);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "from the proxy" }] });
		expect(seen).toEqual([
			{ path: "/api/stream", authorization: "Bearer token-1" },
			{ path: "/api/stream", authorization: "Bearer token-2" },
		]);
	});
});
