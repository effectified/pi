// A loopback HTTP server for the tests, open for the scope: a local MCP server over Streamable HTTP, or an
// authorization server. Never a remote one.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect, type Scope } from "effect";

/** Answers one request; `origin` is the server's own, `http://127.0.0.1:<port>`. */
export type HttpHandler = (request: IncomingMessage, response: ServerResponse, origin: string) => Promise<void>;

/** Listens on a free loopback port until the scope closes, and succeeds with the origin. */
export function listen(handler: HttpHandler): Effect.Effect<string, never, Scope.Scope> {
	return Effect.gen(function* () {
		let origin = "";
		const server = yield* Effect.acquireRelease(
			Effect.promise(
				() =>
					new Promise<ReturnType<typeof createServer>>((resolve) => {
						const server = createServer((request, response) => {
							handler(request, response, origin).catch((error: unknown) => {
								response.statusCode = 500;
								response.end(String(error));
							});
						});
						server.listen(0, "127.0.0.1", () => resolve(server));
					}),
			),
			(server) =>
				Effect.promise(
					() =>
						new Promise<void>((resolve) => {
							server.closeAllConnections();
							server.close(() => resolve());
						}),
				),
		);
		const address = server.address();
		origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
		return origin;
	});
}

/** The body of `request` as text. */
export async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

/** Answers with `body` as JSON. */
export function json(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}
