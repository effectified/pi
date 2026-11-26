// Test helper: a parked approval across a close and a reopen of a SQLite file, registered once per SQLite driver by
// a platform test file. Every build of a scene's Layer is a new harness on the same file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Harness, Storage } from "@effectified/pi-durable";
import { answer, ScriptedModels } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, it } from "vitest";
import { applied, approve, decide, pending } from "../src/index.ts";
import { HOUR, ONE_WRITE, parked, results, scene, shown, status, submit } from "./scene.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

/** Registers the suite for one driver; `suite` is the runner's `describe`, or one that skips on the other runtime. */
export function registerRestart(
	suite: (name: string, body: () => void) => void,
	driver: string,
	client: ClientLayer,
): void {
	/** The scenes of one database file: the harness that parks the call, and the ones that reopen it. */
	const onFile = <A>(use: (open: typeof scene) => Promise<A>): Promise<A> =>
		withDatabaseFile((filename) => {
			const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
			return use((options) => scene({ ...options, storage }));
		});

	suite(`a parked approval across a restart (${driver})`, () => {
		it("is listed from the file with the same id and expiry, and the tool runs once when it is decided then", () =>
			onFile(async (open) => {
				const first = open({ responses: ONE_WRITE });
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						yield* TestClock.setTime(1_000_000);
						yield* submit();
						const request = yield* parked(first.published);
						return { request, listed: yield* pending };
					}).pipe(Effect.provide(first.layer), Effect.provide(TestClock.layer())),
				);
				expect(before.listed).toEqual([before.request]);
				expect(before.request.expiresAt).toBe(1_000_000 + HOUR);
				expect(first.written).toEqual([]);

				// Opened without scheduling: no hook runs, so the list comes from the file alone, without the inbox.
				const paused = open({ responses: [], harness: { resume: false } });
				const listed = await Effect.runPromise(
					Effect.gen(function* () {
						const requests = yield* pending;
						return { requests, scheduling: (yield* Harness.inspect).scheduling };
					}).pipe(Effect.provide(paused.layer)),
				);
				expect(listed).toEqual({ requests: [before.request], scheduling: "paused" });
				expect(paused.published).toEqual([]);

				const second = open({ responses: [answer("Done.")] });
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						yield* TestClock.setTime(1_000_500);
						const { root, submission } = yield* submit();
						// Pi asks the gate again after a reopen: the inbox is shown the same request, and the expiry stands.
						const again = yield* parked(second.published);
						const sleeping = Option.getOrThrow(yield* Harness.getTask(again.task)).state;
						const [request] = yield* pending;
						if (request === undefined) return yield* Effect.die("the request was expected in the list");
						const delivery = yield* decide(request, yield* approve(request, "user:ada"));
						const settled = yield* submission.wait;
						yield* root.waitForIdle;
						const [entry] = yield* results(root);
						return {
							again,
							sleeping,
							delivery,
							settled: settled.status,
							result: shown(entry),
							record: yield* applied(entry as EntryRecord),
							requests: yield* ScriptedModels.use((models) => models.callCount),
							left: yield* pending,
						};
					}).pipe(Effect.provide(second.layer), Effect.provide(TestClock.layer())),
				);
				expect(second.published).toEqual([before.request]);
				expect(after.sleeping).toMatchObject({ status: "sleeping", until: 1_000_000 + HOUR });
				expect(after.delivery).toBe("delivered");
				expect(after.settled).toBe("done");
				expect(after.result).toEqual({ isError: false, text: "wrote hi" });
				expect(after.record).toEqual(
					Option.some({
						request: before.request,
						outcome: { _tag: "Approved", digest: before.request.digest, by: "user:ada", at: 1_000_500 },
					}),
				);
				expect([first.written, second.written, after.requests, after.left]).toEqual([[], ["hi"], 1, []]);
			}));

		it("keeps a decision delivered while nothing runs, and the tool runs once at the next open", () =>
			onFile(async (open) => {
				const first = open({ responses: ONE_WRITE });
				const request = await Effect.runPromise(
					Effect.gen(function* () {
						yield* submit();
						return yield* parked(first.published);
					}).pipe(Effect.provide(first.layer)),
				);

				// A signal is a commit of an open harness: Pi has no way to deliver one into a closed storage. This harness is
				// open and runs nothing, which is the least a host needs to take a decision.
				const paused = open({ responses: [], harness: { resume: false } });
				const stored = await Effect.runPromise(
					Effect.gen(function* () {
						const delivery = yield* decide(request, yield* approve(request, "user:ada"));
						const again = yield* decide(request, yield* approve(request, "user:bob"));
						return { delivery, again, listed: yield* pending, task: yield* status(request.task) };
					}).pipe(Effect.provide(paused.layer)),
				);
				expect(stored).toEqual({ delivery: "delivered", again: "already_decided", listed: [], task: "sleeping" });
				expect([paused.written, paused.published]).toEqual([[], []]);

				const second = open({ responses: [answer("Done.")] });
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* submit();
						const settled = yield* submission.wait;
						yield* root.waitForIdle;
						const [entry] = yield* results(root);
						const record = yield* applied(entry as EntryRecord);
						return { settled: settled.status, result: shown(entry), record };
					}).pipe(Effect.provide(second.layer)),
				);
				expect(after.settled).toBe("done");
				expect(after.result).toEqual({ isError: false, text: "wrote hi" });
				expect(Option.getOrThrow(after.record)).toMatchObject({
					request,
					outcome: { _tag: "Approved", by: "user:ada" },
				});
				// The decision was there when the gate was asked again: nobody is asked twice, and the tool ran once.
				expect([first.written, second.written, second.published]).toEqual([[], ["hi"], []]);
			}));

		it("expires a request whose deadline passed while the harness was closed, without running the tool", () =>
			onFile(async (open) => {
				const first = open({ responses: ONE_WRITE });
				const request = await Effect.runPromise(
					Effect.gen(function* () {
						yield* TestClock.setTime(1_000_000);
						yield* submit();
						return yield* parked(first.published);
					}).pipe(Effect.provide(first.layer), Effect.provide(TestClock.layer())),
				);

				const second = open({ responses: [answer("Done.")] });
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						yield* TestClock.setTime(1_000_000 + HOUR);
						const { root, submission } = yield* submit();
						const settled = yield* submission.wait;
						yield* root.waitForIdle;
						const [entry] = yield* results(root);
						const late = yield* decide(request, yield* approve(request, "user:ada"));
						return {
							settled: settled.status,
							result: shown(entry),
							record: yield* applied(entry as EntryRecord),
							late,
						};
					}).pipe(Effect.provide(second.layer), Effect.provide(TestClock.layer())),
				);
				expect(after.settled).toBe("done");
				expect(after.result).toEqual({
					isError: true,
					text: "<harness>\n[error] Tool call blocked: The approval request expired without a decision\n</harness>",
				});
				expect(after.record).toEqual(Option.some({ request, outcome: { _tag: "Expired" } }));
				expect(after.late).toBe("gone");
				expect([first.written, second.written]).toEqual([[], []]);
			}));
	});
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-approvals-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
