import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Link } from "../src/index.ts";
import { run } from "./run.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (message: Uint8Array) => new TextDecoder().decode(message);

describe("Link.memoryPair", () => {
	it("carries messages from one end to the other, in order, and ends their Stream when an end closes", async () => {
		const received = await run(
			Effect.gen(function* () {
				const [a, b] = yield* Link.memoryPair;
				yield* Link.send(a, bytes("one"));
				yield* Link.send(a, bytes("two"));
				const messages = yield* Effect.forkChild(Stream.runCollect(Link.messages(b)), { startImmediately: true });
				// The peer end closes a microtask after the messages sent before were delivered.
				yield* Link.close(a);
				return yield* Fiber.join(messages);
			}),
		);
		expect(received.map(text)).toEqual(["one", "two"]);
	});

	it("closes both ends when its scope closes", async () => {
		const ended = await run(
			Effect.gen(function* () {
				const [, b] = yield* Effect.scoped(Link.memoryPair);
				return yield* Stream.runCollect(Link.messages(b));
			}),
		);
		expect(ended).toEqual([]);
	});
});

describe("Link.ipc", () => {
	it("gives a closed link for a port that is not connected", async () => {
		const port = {
			connected: false,
			send: () => true,
			on: () => undefined,
			removeListener: () => undefined,
			disconnect: () => {},
		};
		const messages = await run(Effect.flatMap(Link.ipc(port), (link) => Stream.runCollect(Link.messages(link))));
		expect(messages).toEqual([]);
	});
});

describe("Link.webSocket", () => {
	it("gives a closed link for a socket that is closed", async () => {
		const socket = {
			readyState: 3,
			binaryType: "blob",
			send: () => {},
			close: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const messages = await run(
			Effect.flatMap(Link.webSocket(socket), (link) => Stream.runCollect(Link.messages(link))),
		);
		expect(messages).toEqual([]);
	});
});
