// A loopback server that answers as Azure OpenAI's Responses API, so a harness run reaches Pi's real `azure` provider
// with no network and no key: Pi takes the endpoint from `AZURE_OPENAI_BASE_URL`, which `serverEnvironment` sets.

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { Deferred, Effect, type Scope } from "effect";
import { processEnvironment } from "./fixtures.ts";

/** What the server does with a request: answer with text, or hold it open until the client goes away. */
export type Reply = { readonly kind: "text"; readonly text: string } | { readonly kind: "hold" };

/** The running server: where it listens, and when the first held request arrived and was closed by the client. */
export interface ResponsesServer {
	readonly baseUrl: string;
	readonly held: Deferred.Deferred<void>;
	readonly closed: Deferred.Deferred<void>;
}

/** A server for the scope whose `n`th request gets `replies[n]` (the last reply again after the end). */
export function responsesServer(
	replies: readonly [Reply, ...Reply[]],
): Effect.Effect<ResponsesServer, never, Scope.Scope> {
	return Effect.gen(function* () {
		const held = yield* Deferred.make<void>();
		const closed = yield* Deferred.make<void>();
		let count = 0;
		const server = createServer((request, response) => {
			const reply = replies[Math.min(count, replies.length - 1)];
			count += 1;
			request.resume();
			request.on("end", () => {
				if (reply.kind === "text") return answer(response, reply.text);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
				Deferred.doneUnsafe(held, Effect.void);
			});
		});
		yield* Effect.acquireRelease(
			Effect.callback<void>((resume) => {
				server.listen(0, "127.0.0.1", () => resume(Effect.void));
			}),
			() =>
				Effect.callback<void>((resume) => {
					server.closeAllConnections();
					server.close(() => resume(Effect.void));
				}),
		);
		const { port } = server.address() as AddressInfo; // Listening on a TCP port: the address is an AddressInfo.
		return { baseUrl: `http://127.0.0.1:${port}`, held, closed };
	});
}

/** The `azure` model of Pi's catalog that the harness runs: its first model of the Responses API. */
export const AZURE_MODEL = (() => {
	const model = azureProvider()
		.getModels()
		.find((candidate) => candidate.api === "azure-openai-responses");
	if (model === undefined) throw new Error("Pi's azure catalog has no model of the Responses API");
	return { provider: model.provider, id: model.id };
})();

/** The process environment of a run against `server` for the scope: its endpoint, a key, and Pi offline. */
export function serverEnvironment(server: ResponsesServer): Effect.Effect<void, never, Scope.Scope> {
	return processEnvironment({
		AZURE_OPENAI_BASE_URL: server.baseUrl,
		AZURE_OPENAI_API_KEY: "loopback-key",
		AZURE_OPENAI_RESOURCE_NAME: undefined,
		PI_OFFLINE: "1",
	});
}

/** The events of one Responses API answer of `text`, as server-sent events. */
function answer(response: ServerResponse, text: string): void {
	const message = { type: "message", id: "msg_1", role: "assistant", status: "completed" };
	const content = [{ type: "output_text", text, annotations: [] }];
	const usage = {
		input_tokens: 12,
		output_tokens: 3,
		total_tokens: 15,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	};
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: text },
		{ type: "response.output_item.done", output_index: 0, item: { ...message, content } },
		{
			type: "response.completed",
			response: { id: "resp_1", status: "completed", output: [{ ...message, content }], usage },
		},
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const [index, event] of events.entries()) {
		response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`);
	}
	response.end();
}
