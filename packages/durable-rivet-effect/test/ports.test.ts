// The ports of a local engine: a set is free only when every port of it is.

import { createServer, type Server } from "node:net";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Ports from "../src/node/ports.ts";

const listen = (port: number): Promise<Server> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe("Ports", () => {
	it("names the three ports an engine listens on for its port", () => {
		expect(Ports.OFFSETS).toEqual([0, 1, 10]);
	});

	it("gives a port below the ranges systems hand out, whose whole set is free and is left free", async () => {
		const port = await Effect.runPromise(Ports.free);
		expect(port).toBeGreaterThanOrEqual(20_000);
		expect(port + 10).toBeLessThan(32_768);
		// Nothing was left bound: the engine can bind all three.
		const bound = await Promise.all(Ports.OFFSETS.map((offset) => listen(port + offset)));
		await Promise.all(bound.map(close));
	});

	it("says a set is taken when any one port of it is, and free again afterwards", async () => {
		const port = await Effect.runPromise(Ports.free);
		for (const offset of Ports.OFFSETS) {
			const taken = await listen(port + offset);
			expect(await Effect.runPromise(Ports.isFree(port))).toBe(false);
			await close(taken);
		}
		expect(await Effect.runPromise(Ports.isFree(port))).toBe(true);
	});
});
