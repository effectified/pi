// pi-mcp's in-memory pair as a scoped resource: Pi's client end, and the server's end as an Effect peer.

import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { inMemoryTransportPair } from "../src/testing/index.ts";

describe("inMemoryTransportPair", () => {
	it("hands what the client end sends to the peer's Stream, and what the peer sends to the client end", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const delivered: JsonRpcMessage[] = [];
				pair.client.onMessage((message) => delivered.push(message));
				yield* Effect.promise(() => pair.client.start());
				yield* Effect.promise(() => pair.client.send({ jsonrpc: "2.0", id: 1, method: "ping" }));
				const [received] = yield* Stream.runCollect(Stream.take(pair.server.messages, 1));
				yield* pair.server.send({ jsonrpc: "2.0", id: 1, result: {} });
				yield* Effect.yieldNow;
				return { received, delivered };
			}),
		);
		expect(seen.received).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
		expect(seen.delivered).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
	});

	it("closes both ends with the scope: the peer's Stream ends and its sends fail as closed", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* Effect.scoped(inMemoryTransportPair());
				const rest = yield* Stream.runCollect(pair.server.messages);
				const sent = yield* Effect.exit(pair.server.send({ jsonrpc: "2.0", method: "late" }));
				return { rest, sent };
			}),
		);
		expect(seen.rest).toEqual([]);
		expect(Exit.isFailure(seen.sent)).toBe(true);
		if (Exit.isFailure(seen.sent)) expect(String(seen.sent.cause)).toContain("McpConnectionClosedError");
	});
});
