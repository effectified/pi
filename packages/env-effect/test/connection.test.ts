import { nodePlatform } from "@earendil-works/pi-env";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Connection from "../src/node/connection.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

/** A failure of the command's Effect, as an application would give it. */
class NoRoute extends Schema.TaggedError<NoRoute, { readonly brand: unique symbol }>()("NoRoute", {
	message: Schema.String,
}) {}

describe.skipIf(daemon === undefined)(
	`Connection, against the daemon of this checkout (${daemon ?? NO_DAEMON})`,
	() => {
		it("starts the daemon on the first request and says what its machine is", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const connection = yield* Connection.make({ command: [daemon!] });
					const info = yield* connection.info;
					return { info, session: yield* connection.session };
				}),
			);
			expect(nodePlatform(seen.info)).toEqual({ platform: process.platform, arch: process.arch });
			expect(seen.info.features).toContain("process");
			expect(seen.session).toBe(1);
		});

		it("computes the command with an Effect at each start, with the services of the fiber that made it", async () => {
			let computed = 0;
			const protocol = await runLive(
				Effect.gen(function* () {
					const connection = yield* Connection.make({
						command: Effect.sync(() => {
							computed++;
							return [daemon!];
						}),
					});
					return (yield* connection.info).protocol;
				}),
			);
			expect({ protocol, computed }).toEqual({ protocol: 1, computed: 1 });
		});

		it("fails a start whose command Effect failed with RemoteFailed `spawn_error`, lost", async () => {
			const exit = await runLive(
				Effect.flatMap(
					Connection.make({ command: Effect.fail(NoRoute.make({ message: "no route" })) }),
					(connection) => Effect.exit(connection.info),
				),
			);
			expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
				error: { _tag: "RemoteFailed", code: "spawn_error", lost: true, message: "no route" },
			});
		});

		it("sends requests, fails a refused one with the daemon's code, streams one's start, events and reply", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const connection = yield* Connection.make({ command: [daemon!] });
					const realpath = yield* connection.request("realpath", { path: directory });
					const refused = yield* Effect.exit(connection.request("lstat", { path: `${directory}/missing` }));
					const events = yield* Stream.runCollect(
						connection.requestEvents("exec", { command: "echo hi", cwd: directory, env: {}, inheritEnv: true }),
					);
					return { realpath: realpath.json.path, refused, events };
				}),
			);
			expect(typeof seen.realpath).toBe("string");
			expect(Exit.isFailure(seen.refused) && seen.refused.cause.reasons[0]).toMatchObject({
				error: { _tag: "RemoteFailed", code: "ENOENT", lost: false },
			});
			expect(seen.events.map((event) => event.kind)).toEqual(["started", "event", "reply"]);
			const [, output, reply] = seen.events;
			expect(output?.kind === "event" && new TextDecoder().decode(output.payload)).toBe("hi\n");
			expect(reply?.kind === "reply" && reply.reply.json.exitCode).toBe(0);
		});

		it("cancels a request when its fiber is interrupted, and kills an exec without cancelling it", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const connection = yield* Connection.make({ command: [daemon!] });
					const exec = { command: "exec sleep 30", cwd: directory, env: {}, inheritEnv: true };
					const fiber = yield* Effect.forkChild(connection.request("exec", exec), { startImmediately: true });
					yield* Fiber.interrupt(fiber);
					const killed = yield* Stream.runCollect(
						connection
							.requestEvents("exec", exec)
							.pipe(
								Stream.tap((event) =>
									event.kind === "started" ? connection.kill(event.id, event.session) : Effect.void,
								),
							),
					);
					return { interrupted: Exit.hasInterrupts(yield* Fiber.await(fiber)), killed: killed.at(-1) };
				}),
			);
			expect(seen.interrupted).toBe(true);
			expect(seen.killed).toMatchObject({ kind: "reply" });
		});

		it("streams the daemon's diagnostic output and stops the daemon when the scope closes", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					// A start that writes to stderr first, as a login shell may.
					const connection = yield* Scope.provide(
						Connection.make({ command: ["sh", "-c", 'echo starting >&2; exec "$0" "$@"', daemon!] }),
						scope,
					);
					const logs = yield* Effect.forkChild(Stream.runHead(connection.logs), { startImmediately: true });
					yield* connection.info;
					const log = yield* Fiber.join(logs);
					yield* Scope.close(scope, Exit.void);
					return { log, after: yield* Effect.exit(connection.info) };
				}),
			);
			expect(seen.log).toMatchObject({ _tag: "Some", value: "starting\n" });
			expect(Exit.isFailure(seen.after) && seen.after.cause.reasons[0]).toMatchObject({
				error: { _tag: "RemoteFailed", message: "Connection closed" },
			});
		});
	},
);
