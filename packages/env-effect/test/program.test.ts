import { RemoteError } from "@earendil-works/pi-env";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Program from "../src/node/program.ts";

/** A stand-in of pi-env's program handles: an exit to settle by hand, and a close that rejects it as Pi does. */
function standIn() {
	const exit = Promise.withResolvers<number>();
	let closed = 0;
	return {
		program: {
			pid: 7,
			exited: exit.promise,
			close: () => {
				closed++;
				exit.reject(new RemoteError({ code: "aborted", message: "aborted" }));
			},
		},
		exit,
		closed: () => closed,
	};
}

describe("Program.acquire", () => {
	it("keeps each channel's output until read, and ends the streams when the program exits", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const program = standIn();
				const opened = yield* Program.acquire(["out", "err"] as const, async (write) => {
					write("out", new Uint8Array([1]));
					write("err", new Uint8Array([2]));
					write("out", new Uint8Array([3]));
					return program.program;
				});
				program.exit.resolve(0);
				return {
					out: yield* Stream.runCollect(opened.output("out")),
					err: yield* Stream.runCollect(opened.output("err")),
					exited: yield* opened.exited,
					pid: opened.pi.pid,
				};
			}),
		);
		expect(seen).toEqual({
			out: [new Uint8Array([1]), new Uint8Array([3])],
			err: [new Uint8Array([2])],
			exited: 0,
			pid: 7,
		});
	});

	it("kills the program when the scope closes, after which `exited` fails with `aborted`", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const program = standIn();
				const scope = yield* Scope.make();
				const opened = yield* Scope.provide(
					Program.acquire(["out"] as const, async () => program.program),
					scope,
				);
				yield* Scope.close(scope, Exit.void);
				return {
					closed: program.closed(),
					exited: yield* Effect.exit(opened.exited),
					out: yield* Stream.runCollect(opened.output("out")),
				};
			}),
		);
		expect(seen.closed).toBe(1);
		expect(seen.out).toEqual([]);
		expect(Exit.isFailure(seen.exited) && seen.exited.cause.reasons[0]).toMatchObject({
			error: { _tag: "RemoteFailed", code: "aborted" },
		});
	});

	it("fails the open with RemoteFailed when the program does not start", async () => {
		const exit = await runLive(
			Effect.exit(
				Program.acquire(["out"] as const, () =>
					Promise.reject(new RemoteError({ code: "not_supported", message: "update the daemon" })),
				),
			),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({ error: { code: "not_supported" } });
	});
});
