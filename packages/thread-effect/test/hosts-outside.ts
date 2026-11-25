// Test helper: the outside of the host processes, in the test's process: the product's lease, its sinks, its model
// labs and the world its tools change, behind one loopback HTTP server. A host process that is killed takes nothing
// of it along, and a held reply is how a test stops a host at one point.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Ask, decode, encode, type Turn } from "./hosts-wire.ts";

/** Asks of one kind. */
export type Of<Kind extends Ask["kind"]> = Extract<Ask, { readonly kind: Kind }>;

/** The outside of one test file. */
export interface Outside {
	readonly url: string;
	/** Every ask that came, in order, with when it came. */
	readonly asks: ReadonlyArray<{ readonly at: number; readonly ask: Ask }>;
	/** The asks of one kind, in order. */
	readonly of: <Kind extends Ask["kind"]>(kind: Kind) => ReadonlyArray<Of<Kind>>;
	/** Holds the reply to the next ask `matches` says yes to: what it asked is done, and the host is not told. */
	readonly holdNext: (matches: (ask: Ask) => boolean) => Held;
	/** Succeeds once the asks so far satisfy `ready`; fails after `millis`. */
	readonly until: (what: string, ready: () => boolean, millis?: number) => Promise<void>;
	readonly close: () => Promise<void>;
}

/** One held reply. */
export interface Held {
	/** Resolves with the ask once it came. */
	readonly reached: Promise<Ask>;
	readonly release: () => void;
}

/** Starts an outside on a free loopback port. `turn` is the model: it answers from what it is shown alone. */
export async function outside(turn: (ask: Of<"model">) => Turn): Promise<Outside> {
	const asks: Array<{ readonly at: number; readonly ask: Ask }> = [];
	const holds: Array<{
		readonly matches: (ask: Ask) => boolean;
		readonly reached: (ask: Ask) => void;
		readonly released: Promise<void>;
	}> = [];
	const of = <Kind extends Ask["kind"]>(kind: Kind) =>
		asks.flatMap(({ ask }) => (ask.kind === kind ? [ask as Of<Kind>] : []));
	const replyTo = (ask: Ask): unknown => {
		switch (ask.kind) {
			case "reserve":
				return `r${of("reserve").length}`;
			case "model":
				return turn(ask);
			default:
				return null;
		}
	};
	const server = createServer((request, response) => {
		const chunks: Array<Buffer> = [];
		// A killed host takes its socket along: the reply then goes nowhere.
		response.on("error", () => undefined);
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			// What `ask` of hosts-wire.ts sent, from a process this test started.
			const ask = decode(Buffer.concat(chunks).toString("utf8")) as Ask;
			asks.push({ at: performance.now(), ask });
			const reply = encode(replyTo(ask));
			const index = holds.findIndex((hold) => hold.matches(ask));
			if (index >= 0) {
				const [hold] = holds.splice(index, 1);
				hold?.reached(ask);
				await hold?.released;
			}
			response.end(reply);
		});
	});
	// A held reply outlives every default timeout.
	server.requestTimeout = 0;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// A TCP server's address is an `AddressInfo`.
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		asks,
		of,
		holdNext: (matches) => {
			const reached = Promise.withResolvers<Ask>();
			const released = Promise.withResolvers<void>();
			holds.push({ matches, reached: reached.resolve, released: released.promise });
			return { reached: reached.promise, release: () => released.resolve() };
		},
		until: async (what, ready, millis = 90_000) => {
			const end = performance.now() + millis;
			while (!ready()) {
				if (performance.now() > end) throw new Error(`Not within ${millis} ms: ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
