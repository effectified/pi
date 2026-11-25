// The exit guard without an engine: whose calls of `process.exit` it drops, which it passes on, and that it puts the
// function back.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as ExitGuard from "../src/node/exit-guard.ts";

describe("ExitGuard", () => {
	let directory = "";
	/** Calls its argument with 1 from a file under `rivetkit/dist`, as rivetkit calls `process.exit`. */
	let asRivetkit: (exit: (code: number) => void) => void = () => {};
	const exit = process.exit;
	const codes: Array<unknown> = [];

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-rivet-test-guard-"));
		mkdirSync(join(directory, "rivetkit", "dist"), { recursive: true });
		const caller = join(directory, "rivetkit", "dist", "caller.cjs");
		writeFileSync(caller, "module.exports = (exit) => exit(1);\n");
		asRivetkit = createRequire(import.meta.url)(caller);
		// What the guard finds and passes other calls on to, in place of the real exit.
		process.exit = ((code?: unknown) => void codes.push(code)) as typeof process.exit;
	});

	afterAll(() => {
		process.exit = exit;
		rmSync(directory, { recursive: true, force: true });
	});

	it("takes a stack with a frame of rivetkit's built files or sources for rivetkit's, and no other", () => {
		const built = "Error\n    at file:///app/node_modules/rivetkit/dist/tsup/mod.js:8000:19";
		const source = "Error\n    at serve (/repo/rivetkit/src/registry/index.ts:719:5)";
		const native = "Error\n    at x (/app/node_modules/@rivetkit/rivetkit-napi/index.js:1:1)";
		const product = "Error\n    at main (/home/me/my-rivetkit-app/server.ts:10:3)";
		expect([built, source, native, product].map(ExitGuard.fromRivetkit)).toEqual([true, true, false, false]);
	});

	it("replaces process.exit while a start is held, and puts it back when the last start is ready", async () => {
		const stub = process.exit;
		const first = await Effect.runPromise(ExitGuard.hold);
		const second = await Effect.runPromise(ExitGuard.hold);
		expect(process.exit).not.toBe(stub);
		await Effect.runPromise(first.ready);
		expect(process.exit).not.toBe(stub);
		await Effect.runPromise(second.ready);
		expect(process.exit).toBe(stub);
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(0);
	});

	it("drops rivetkit's exit for a failed start once, and passes every other call on", async () => {
		const stub = process.exit;
		const hold = await Effect.runPromise(ExitGuard.hold);
		await Effect.runPromise(hold.failed);
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(1);
		// A call that is not rivetkit's exits as it would.
		process.exit(7);
		expect(codes).toEqual([7]);
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(1);
		// rivetkit's call is dropped, and the hold ends with it.
		asRivetkit(process.exit);
		expect(codes).toEqual([7]);
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(0);
		expect(process.exit).toBe(stub);
		// With no start held, rivetkit's exit is rivetkit's again: a running engine was lost.
		asRivetkit(process.exit);
		expect(codes).toEqual([7, 1]);
	});

	it("drops rivetkit's exit that comes before the start's failure, and waits for no second one", async () => {
		const stub = process.exit;
		codes.length = 0;
		const hold = await Effect.runPromise(ExitGuard.hold);
		asRivetkit(process.exit);
		expect(codes).toEqual([]);
		await Effect.runPromise(hold.failed);
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(0);
		expect(process.exit).toBe(stub);
	});
});
