// Effects handed to Pi as callbacks: run in their context, failing with Pi's own error classes, interrupted by Pi's
// abort signal.

import { McpError as PiMcpError } from "@earendil-works/pi-mcp";
import { McpRefreshLockBusyError as PiMcpRefreshLockBusyError } from "@earendil-works/pi-mcp/oauth";
import { Context, Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { McpError, McpRefreshLockBusyError } from "../src/index.ts";
import { currentRunner, currentSyncRunner } from "../src/run-in-pi.ts";

class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}

describe("currentRunner", () => {
	it("runs with the services of the Effect that made the runner", async () => {
		const run = await Effect.runPromise(currentRunner<Greeting>().pipe(Effect.provideService(Greeting, "hello")));
		await expect(
			run(
				Effect.gen(function* () {
					return yield* Greeting;
				}),
			),
		).resolves.toBe("hello");
	});

	it("rejects with Pi's class of the failure, which Pi's own checks recognize", async () => {
		const run = await Effect.runPromise(currentRunner());
		const busy = await run(Effect.fail(new McpRefreshLockBusyError({ message: "busy" }))).catch((error) => error);
		expect(busy).toBeInstanceOf(PiMcpRefreshLockBusyError);
		const coded = await run(Effect.fail(new McpError({ code: -32001, message: "no", data: 1 }))).catch((e) => e);
		expect(coded).toBeInstanceOf(PiMcpError);
		expect(coded).toMatchObject({ code: -32001, message: "no", data: 1 });
	});

	it("rejects with a defect as it is", async () => {
		const run = await Effect.runPromise(currentRunner());
		const defect = new Error("broken");
		await expect(run(Effect.die(defect))).rejects.toBe(defect);
	});

	it("interrupts the Effect when Pi aborts the signal", async () => {
		const run = await Effect.runPromise(currentRunner());
		const interrupted = Effect.runSync(Deferred.make<void>());
		const controller = new AbortController();
		const running = run(
			Effect.onInterrupt(Effect.never, () => Deferred.succeed(interrupted, undefined)),
			controller.signal,
		);
		controller.abort();
		await running.catch(() => undefined);
		await Effect.runPromise(Deferred.await(interrupted));
	});
});

describe("currentSyncRunner", () => {
	it("runs at once, and throws Pi's class of the failure", async () => {
		const run = await Effect.runPromise(currentSyncRunner());
		expect(run(Effect.succeed(3))).toBe(3);
		expect(() => run(Effect.fail(new McpRefreshLockBusyError({ message: "busy" })))).toThrow(
			PiMcpRefreshLockBusyError,
		);
	});
});
