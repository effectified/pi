// A local gateway for pi-ai's Radius provider, on loopback for the scope: the OAuth device-code login, the token
// refresh and the model catalog. Never a remote one.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect, type Scope } from "effect";

/** How the gateway answers, and what it saw. */
export interface Gateway {
	/** `http://127.0.0.1:<port>`: the `gateway` of `radiusProvider`. */
	readonly origin: string;
	/** The form of each token request, in order. */
	readonly tokenRequests: Array<URLSearchParams>;
	/** The Authorization header of each catalog request. */
	readonly configAuthorizations: Array<string | undefined>;
	/** Set to an OAuth error code (`access_denied`) to refuse the device login's token request. */
	deviceError: string | undefined;
}

/** Starts the gateway; it stops when the scope closes. Each token it issues is numbered: `access-1`, `refresh-1`. */
export function gateway(): Effect.Effect<Gateway, never, Scope.Scope> {
	return Effect.gen(function* () {
		let issued = 0;
		const state: { -readonly [K in keyof Gateway]: Gateway[K] } = {
			origin: "",
			tokenRequests: [],
			configAuthorizations: [],
			deviceError: undefined,
		};
		const tokens = () => {
			issued++;
			return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 };
		};
		const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			const url = new URL(request.url ?? "/", state.origin);
			switch (url.pathname) {
				case "/v1/oauth/device":
					return json(response, 200, {
						device_code: "device-1",
						user_code: "ABCD-EFGH",
						verification_uri: `${state.origin}/device`,
						expires_in: 600,
						interval: 1,
					});
				case "/v1/oauth/token": {
					const form = new URLSearchParams(await readBody(request));
					state.tokenRequests.push(form);
					const deviceError = state.deviceError;
					if (form.get("grant_type")?.endsWith("device_code") && deviceError !== undefined) {
						return json(response, 400, { error: deviceError });
					}
					if (form.get("grant_type") === "refresh_token" && !form.get("refresh_token")?.startsWith("refresh-")) {
						return json(response, 400, { error: "invalid_grant" });
					}
					return json(response, 200, tokens());
				}
				case "/v1/config":
					state.configAuthorizations.push(request.headers.authorization);
					return json(response, 200, {
						baseUrl: `${state.origin}/v1`,
						models: [
							{
								id: "gateway-model",
								name: "Gateway model",
								reasoning: false,
								input: ["text"],
								cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					});
				default:
					return json(response, 404, { error: "not_found" });
			}
		};
		const server = yield* Effect.acquireRelease(
			Effect.promise(
				() =>
					new Promise<ReturnType<typeof createServer>>((resolve) => {
						const server = createServer((request, response) => {
							handle(request, response).catch((error: unknown) => json(response, 500, { error: String(error) }));
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
		state.origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
		return state;
	});
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
