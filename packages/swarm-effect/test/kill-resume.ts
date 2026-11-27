// Test helper: the kill-and-resume suite of a swarm, registered once per SQLite driver by a platform test file.
//
// One swarm of 12 jobs under a cap of 4, on a SQLite file, with the in-storage driver. A first harness is closed at
// one of three moments, a later harness on the same file lets the swarm finish, and what it left is compared with an
// uninterrupted run:
//
//   (a) the coordinator was created, and no fork exists
//   (b) three jobs have settled, four forks are live, five jobs are planned
//   (c) every job has settled, and clean-up has not begun
//
// Pi sends a model request that a close cut off again on reopen (durable-effect's README, "Interruption"), so in
// (b) the four live jobs are asked twice, and nothing else is.

import { Harness, Storage } from "@effectified/pi-durable";
import { TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { fake } from "./fake-driver.ts";
import {
	type Asked,
	asked,
	type HarnessOptions,
	harness,
	jobsOf,
	Measure,
	measured,
	model,
	primed,
	tally,
	until,
	words,
} from "./support.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

/** Runs `use` with the path of a database file that is removed afterwards. */
export type WithDatabaseFile = <A>(use: (filename: string) => Promise<A>) => Promise<A>;

/** Copies a database file as it is on disk now, with its write-ahead log: what a process that died leaves behind. */
export type CopyDatabaseFile = (from: string, to: string) => void;

const TURNS = 3;
const WORDS = words(12);
const CAP = 4;
const KEYS = WORDS.map((word) => `job-${word}`);

/** Registers the suite for one driver. */
export function registerKillResume(
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
	copyDatabaseFile: CopyDatabaseFile,
): void {
	const storageOn = (filename: string) => Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
	/** One harness on the file: `program` runs in it, and leaving it closes the harness. */
	const leg = <A, E>(
		filename: string,
		counts: Asked,
		program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver | SqlClient>,
		options: Omit<HarnessOptions, "storage"> & { readonly holdFrom?: number } = {},
	): Promise<A> => {
		const held = new Set(WORDS.slice(options.holdFrom ?? WORDS.length));
		const respond = model(counts, (word) => ({
			text: JSON.stringify(measured(word)),
			afterMillis: held.has(word) ? Infinity : 2,
		}));
		const live = harness(respond, { ...options, storage: storageOn(filename) });
		// The client a second time, for the test's own reads of the file: Pi's tables as they are stored.
		return Effect.runPromise(program.pipe(Effect.provide(Layer.merge(live, client(filename)))));
	};
	const plan = (root: { readonly id: Swarm.Plan<unknown>["source"] }): Swarm.Plan<{ readonly word: string }> => ({
		id: Swarm.SwarmId.make("resumed"),
		source: root.id,
		jobs: jobsOf(WORDS),
		cap: CAP,
		onFailure: "fail",
	});
	/** What a finished swarm left, read in the harness that finished it. */
	const left = Effect.gen(function* () {
		const result = yield* Swarm.result(Measure, Swarm.SwarmId.make("resumed"));
		const sql = yield* SqlClient;
		const driver = yield* Swarm.ForkDriver;
		const forks = yield* sql<{ parent: number | null; total: number }>`
			SELECT json_extract(record, '$.parent.conversationId') AS parent, count(*) AS total
			FROM conversations GROUP BY parent ORDER BY parent`;
		const kinds = yield* sql<{ kind: string }>`
			SELECT kind FROM documents UNION SELECT kind FROM tasks ORDER BY kind`;
		return {
			result,
			listed: yield* driver.list(Swarm.SwarmId.make("resumed")),
			forks: forks.map((row) => [row.parent, row.total]),
			// Pi stores a document's kind as JSON text and a task's as it is.
			ours: [...new Set(kinds.map((row) => row.kind.replaceAll('"', "")))].filter((kind) => !kind.startsWith("pi.")),
		};
	});
	const requests = (counts: Asked) => WORDS.map((word) => counts.requests.get(word) ?? 0);
	/** An uninterrupted run on a file of its own: what every resumed run must equal. */
	const whole = () =>
		withDatabaseFile((filename) =>
			leg(
				filename,
				asked(),
				Effect.gen(function* () {
					const root = yield* primed(TURNS);
					yield* Swarm.start(Measure, plan(root));
					return yield* left;
				}),
			),
		);
	const expectWhole = (
		resumed: Awaited<ReturnType<typeof whole>>,
		uninterrupted: Awaited<ReturnType<typeof whole>>,
	) => {
		// The same results, job by job. The forks' ids are Pi's, from the counter a request sent again also moves.
		expect(resumed.result.jobs).toEqual(uninterrupted.result.jobs);
		expect(resumed.result.ending).toBe(uninterrupted.result.ending);
		expect(resumed.result.jobs).toEqual(
			WORDS.map((word) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) })),
		);
		// No job key has two forks: the root, and one conversation forked from it per job.
		expect(resumed.forks).toEqual([
			[null, 1],
			[1, WORDS.length],
		]);
		// Clean-up completed: every fork was destroyed, and the driver lists none.
		expect(resumed.result.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual(
			KEYS.map((key) => [key, "destroyed"]),
		);
		expect(resumed.listed).toEqual([]);
	};

	it("an uninterrupted run asks each job once, and stores only kinds prefixed swarm.", async () => {
		const uninterrupted = await whole();
		expect(uninterrupted.result.ending).toBe("completed");
		expect(uninterrupted.ours).toEqual(["swarm.coordinator.measure", "swarm.forks", "swarm.jobs", "swarm.swarm"]);
	});

	it("(a) a close after the coordinator was created and before the first fork", () =>
		withDatabaseFile(async (filename) => {
			const uninterrupted = await whole();
			await leg(filename, asked(), primed(TURNS));
			// A harness that continues nothing by itself: the task is stored and no phase of it runs.
			const second = asked();
			const created = await leg(
				filename,
				second,
				Effect.gen(function* () {
					const root = yield* Harness.root;
					const started = yield* Swarm.start(Measure, plan(root));
					const stored = yield* Harness.commit((tx) => tx.scanConversations({}, 100));
					return {
						started,
						status: yield* Swarm.status(Swarm.SwarmId.make("resumed")),
						conversations: stored.items.length,
					};
				}),
				{ resume: false },
			);
			expect(created.started.created).toBe(true);
			expect(created.conversations).toBe(1);
			expect(requests(second)).toEqual(WORDS.map(() => 0));
			const third = asked();
			const resumed = await leg(
				filename,
				third,
				Effect.gen(function* () {
					// The probe after a reopen: the coordinator runs, and the jobs it planned are listed.
					const status = yield* Swarm.status(Swarm.SwarmId.make("resumed"));
					const again = yield* Swarm.start(Measure, plan(yield* Harness.root));
					return { status, again, left: yield* left };
				}),
			);
			expect(created.status).toMatchObject({ running: true, phase: "idle" });
			expect(created.status.jobs.map((job) => [job.key, job.status])).toEqual(KEYS.map((key) => [key, "planned"]));
			expect(resumed.status.running).toBe(true);
			expect(resumed.status.jobs.map((job) => job.key)).toEqual(KEYS);
			expect(resumed.again).toEqual({ ...created.started, created: false });
			expectWhole(resumed.left, uninterrupted);
			expect(requests(third)).toEqual(WORDS.map(() => 1));
		}));

	it("(b) a close with some forks live", () =>
		withDatabaseFile(async (filename) => {
			const uninterrupted = await whole();
			const first = asked();
			const before = await leg(
				filename,
				first,
				Effect.gen(function* () {
					const root = yield* primed(TURNS);
					yield* Swarm.start(Measure, plan(root));
					// Three jobs answer; every later one holds its fork, so the cap fills and stays full.
					yield* until(
						Effect.map(tally(Swarm.SwarmId.make("resumed")), (now) => now.succeeded === 3 && now.running === CAP),
					);
					yield* first.when(() => first.live === CAP);
					return yield* tally(Swarm.SwarmId.make("resumed"));
				}),
				{ holdFrom: 3 },
			);
			expect(before).toEqual({ planned: 5, running: CAP, succeeded: 3, failed: 0 });
			expect(requests(first)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
			const second = asked();
			const resumed = await leg(
				filename,
				second,
				Effect.gen(function* () {
					const status = yield* Swarm.status(Swarm.SwarmId.make("resumed"));
					return { status, left: yield* left };
				}),
			);
			expect(resumed.status.running).toBe(true);
			expect(resumed.status.jobs.map((job) => job.key)).toEqual(KEYS);
			// The results collected before the close were kept: those three jobs were not read again from the model.
			expect(resumed.status.jobs.slice(0, 3).map((job) => job.status)).toEqual([
				"succeeded",
				"succeeded",
				"succeeded",
			]);
			expectWhole(resumed.left, uninterrupted);
			// Settled jobs: never asked again. Live jobs: the request the close cut off is sent again, as Pi documents.
			// Planned jobs: asked once.
			expect(requests(second)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		}));

	it("(c) a close after all jobs settled and before clean-up", () =>
		withDatabaseFile(async (filename) => {
			const uninterrupted = await whole();
			const reached = Promise.withResolvers<void>();
			const first = asked();
			const before = await leg(
				filename,
				first,
				Effect.gen(function* () {
					const root = yield* primed(TURNS);
					yield* Swarm.start(Measure, plan(root));
					yield* Effect.promise(() => reached.promise);
					const driver = yield* Swarm.ForkDriver;
					return {
						status: yield* Swarm.status(Swarm.SwarmId.make("resumed")),
						listed: (yield* driver.list(Swarm.SwarmId.make("resumed"))).length,
					};
				}),
				// Clean-up begins with the driver's list: held there, every job has settled and no fork is destroyed.
				{
					wrap: (driver) => ({
						...driver,
						list: () => {
							reached.resolve();
							return Effect.never;
						},
					}),
				},
			);
			expect(before.status).toMatchObject({ running: true, phase: "cleanup" });
			expect(before.status.jobs.map((job) => job.status)).toEqual(WORDS.map(() => "succeeded"));
			expect(before.listed).toBe(WORDS.length);
			expect(requests(first)).toEqual(WORDS.map(() => 1));
			const second = asked();
			const resumed = await leg(filename, second, left);
			expectWhole(resumed, uninterrupted);
			// Every job had settled: the model was not asked again.
			expect(requests(second)).toEqual(WORDS.map(() => 0));
		}));

	it("a remote driver across closes at any moment: no second fork, no job started twice, the same results", () =>
		withDatabaseFile(async (filename) => {
			// The remote side outlives the harness: one fake for every leg.
			const remote = fake({
				notice: { pollMillis: 2 },
				job: (key) => ({ answer: Option.some(JSON.stringify(measured(key.slice(4)))), settlesAfterMillis: 6 }),
			});
			const on = <A, E>(program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver>) =>
				Effect.runPromise(
					program.pipe(
						Effect.provide(
							TestHarness.layer({ extensions: [Swarm.extension([Measure])], storage: storageOn(filename) }).pipe(
								Layer.provideMerge(remote.layer),
							),
						),
					),
				);
			await on(
				Effect.gen(function* () {
					const root = yield* Harness.root;
					yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
					yield* Swarm.start(Measure, plan(root));
					yield* Effect.sleep(4);
				}),
			);
			// Each of these harnesses lives a few milliseconds: the coordinator is cut off wherever it stands.
			for (const millis of [1, 3, 5, 8, 2, 13]) await on(Effect.andThen(Harness.resume, Effect.sleep(millis)));
			const result = await on(Swarm.result(Measure, Swarm.SwarmId.make("resumed")));
			expect(result.jobs).toEqual(
				WORDS.map((word) => ({ _tag: "Success", key: `job-${word}`, value: measured(word) })),
			);
			expect([...remote.created.values()]).toEqual(WORDS.map(() => 1));
			expect([...remote.accepted.values()]).toEqual(WORDS.map(() => 1));
			expect(remote.maxLive).toBeLessThanOrEqual(CAP);
			expect(remote.forks.size).toBe(0);
			expect([...remote.destroyed].sort()).toEqual([...KEYS].sort());
		}));

	it("a copied storage runs no swarm of the storage it was copied from, and its own as usual", () =>
		withDatabaseFile(async (filename) => {
			const copy = `${filename}.copy`;
			// Jobs of the first swarm never settle; those of a swarm started on the copy do.
			const remote = fake({
				notice: { pollMillis: 2 },
				job: (key, requestId) => ({
					answer: Option.some(JSON.stringify(measured(key.slice(4)))),
					settlesAfterMillis: requestId.startsWith("resumed/") ? Infinity : 0,
				}),
			});
			const on = <A, E>(
				file: string,
				program: Effect.Effect<A, E, TestHarness.Provided | Swarm.ForkDriver>,
				resume: boolean,
			) =>
				Effect.runPromise(
					program.pipe(
						Effect.provide(
							TestHarness.layer({
								extensions: [Swarm.extension([Measure])],
								storage: storageOn(file),
								harness: { resume },
							}).pipe(Layer.provideMerge(remote.layer)),
						),
					),
				);
			await on(
				filename,
				Effect.gen(function* () {
					const root = yield* Harness.root;
					yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
					yield* Swarm.start(Measure, plan(root));
					yield* remote.when(() => remote.accepted.size === CAP);
					// What an actor fork copies: the whole storage, with the live coordinator in it.
					copyDatabaseFile(filename, copy);
				}),
				true,
			);
			const calls = { fork: remote.forkCalls.size, run: remote.runCalls.size };
			const copied = await on(
				copy,
				Effect.gen(function* () {
					yield* Swarm.onStorageFork;
					yield* Harness.resume;
					const inherited = yield* Effect.flip(Swarm.result(Measure, Swarm.SwarmId.make("resumed")));
					const root = yield* Harness.root;
					yield* Swarm.start(Measure, { ...plan(root), id: Swarm.SwarmId.make("own"), jobs: jobsOf(["a", "bb"]) });
					return { inherited, own: yield* Swarm.result(Measure, Swarm.SwarmId.make("own")) };
				}),
				false,
			);
			expect(copied.inherited).toEqual(
				new Swarm.SwarmFaulted({ swarmId: Swarm.SwarmId.make("resumed"), reason: "copied" }),
			);
			// The copy asked the driver nothing for the swarm it inherited: no cancel, no destroy, no fork, no run.
			expect(remote.cancelled).toEqual([]);
			expect(remote.destroyed.filter((key) => KEYS.includes(key))).toEqual([]);
			expect([...remote.forkCalls.keys()].filter((key) => KEYS.includes(key))).toHaveLength(calls.fork);
			expect(copied.own.jobs.map((job) => job._tag)).toEqual(["Success", "Success"]);
			// The storage it was copied from goes on with its swarm: its forks are all still there.
			expect(KEYS.slice(0, CAP).every((key) => remote.forks.has(key))).toBe(true);
		}));
}
