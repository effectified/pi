// Test helper: the kill-and-resume suite for tasks (PRD section 10), registered once per SQLite driver by a platform
// test file.
//
// One task with three phases and a child, on a SQLite file. Each phase does one outside effect, which the test
// counts, before it commits its step:
//
//   prepare   decides the child's key and goes on to `spawn`
//   spawn     creates the child in its commit and waits for it
//   child     the child's one phase, while the parent waits
//   finish    reads the child's outcome and completes
//
// A first harness is closed while the task stands at one boundary: the phase did its effect and did not commit. A
// second harness on the same file lets the task finish. Pi runs a phase again from its top when a close or a crash
// came before its step was stored (spec 5.2, 5.6), so the effect of the phase that was cut off runs twice and every
// other once. A close counts no restart; a crash does (spec 5.4), which the last two tests show on a copy of the
// file taken while the phase ran: what a process that died leaves behind.

import type { JsonValue } from "@earendil-works/chord/json";
import type { TaskId, TaskOutcome } from "@earendil-works/pi-durable";
import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Effect, Layer, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Extension, Harness, Storage, Task } from "../src/index.ts";
import { TestHarness } from "../src/testing/index.ts";
import type { ClientLayer, CopyDatabaseFile, WithDatabaseFile } from "./sqlite-suites.ts";

/** Everything an uninterrupted task reaches, in order. */
const RUN = ["prepare", "spawn", "child", "finish"] as const;

/** A place where the task can be stopped: a phase that did its outside effect and has not committed. */
type Boundary = (typeof RUN)[number];

/** Registers the suite for one driver. */
export function registerTaskKillResume(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
	copyDatabaseFile: CopyDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);
	const play = (stopAt: Boundary | undefined) =>
		withDatabaseFile(async (filename) => {
			const first = stopAt === undefined ? undefined : await start(client(filename), stopAt);
			return { first: first?.reached ?? [], ...(await finish(client(filename), first?.id)) };
		});
	const count = (reached: ReadonlyArray<Boundary>, boundary: Boundary) =>
		reached.filter((at) => at === boundary).length;

	describe(`kill and resume of a task (${driver})`, () => {
		it("an uninterrupted task runs each phase once, creates one child and completes with its result", async () => {
			const whole = await play(undefined);
			assert.deepEqual(whole.second, RUN);
			assert.deepEqual(whole.children, [{ word: "key-a" }]);
			assert.deepEqual(whole.outcome, { status: "completed", result: "KEY-A" });
			assert.deepEqual(whole.restarts, []);
		});

		for (const stopAt of RUN) {
			it(`a close at ${stopAt} runs that phase again, every other once, and creates the child once`, async () => {
				const whole = await play(undefined);
				const resumed = await play(stopAt);
				const at = RUN.indexOf(stopAt);
				assert.deepEqual(resumed.first, RUN.slice(0, at + 1));
				assert.deepEqual(resumed.second, RUN.slice(at));
				for (const boundary of RUN) {
					assert.strictEqual(count([...resumed.first, ...resumed.second], boundary), boundary === stopAt ? 2 : 1);
				}
				assert.deepEqual(resumed.children, whole.children);
				assert.deepEqual(resumed.outcome, whole.outcome);
				// A close is not a crash: no phase read a restart count.
				assert.deepEqual(resumed.restarts, []);
			});
		}

		it("a crash while a phase runs counts a restart, and the phase runs again", () =>
			withDatabaseFile(async (filename) => {
				const crashed = `${filename}.crashed`;
				const first = await start(client(filename), "prepare", () => copyDatabaseFile(filename, crashed));
				const resumed = await finish(client(crashed), first.id);
				assert.deepEqual(resumed.second, RUN);
				assert.deepEqual(resumed.restarts, [["prepare", 1]]);
				assert.deepEqual(resumed.outcome, { status: "completed", result: "KEY-A" });
			}));

		it("at the restart limit Pi ends a task a crash cut off as faulted, without running it again", () =>
			withDatabaseFile(async (filename) => {
				const crashed = `${filename}.crashed`;
				const first = await start(client(filename), "prepare", () => copyDatabaseFile(filename, crashed));
				const resumed = await finish(client(crashed), first.id, { restartLimit: 1 });
				assert.deepEqual(resumed.second, []);
				assert.deepEqual(resumed.outcome, {
					status: "faulted",
					error: {
						message: `Task ${first.id} (test.kill-resume) was cut off 1 times without progress`,
						detail: { reason: "restart_limit" },
					},
				});
			}));
	});
}

/**
 * Creates the task on the database of `client`, waits until it stands at `stopAt`, runs `whileStopped`, and closes
 * the harness.
 */
async function start(client: Layer.Layer<SqlClient, SqlError>, stopAt: Boundary, whileStopped?: () => void) {
	const first = leg(stopAt);
	const id = await Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const created = yield* root.commit((tx) =>
				tx.createTask(first.Parent, { label: "a" }, { ownership: { kind: "conversation" } }),
			);
			yield* Effect.promise(() => first.stopped);
			whileStopped?.();
			return created;
			// Leaving the scope closes the harness while the task stands at `stopAt`.
		}).pipe(Effect.provide(harness(client, first))),
	);
	return { id, reached: first.reached };
}

/** Lets the task `id` finish on the database of `client`, or runs a whole one, and reads what it left. */
async function finish(
	client: Layer.Layer<SqlClient, SqlError>,
	id: TaskId | undefined,
	settings?: { readonly restartLimit: number },
) {
	const second = leg(undefined);
	const finished = await Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const taskId =
				id ??
				(yield* root.commit((tx) =>
					tx.createTask(second.Parent, { label: "a" }, { ownership: { kind: "conversation" } }),
				));
			const settled = yield* Harness.waitForTaskOf(second.Parent, taskId);
			yield* Harness.waitForIdle;
			const children = yield* Harness.commit((tx) =>
				Effect.promise(() => tx.pi.scanTasks({ kind: "test.kill-resume-child" }, 100)),
			);
			return { outcome: settled.state.outcome, children: children.items.map((child) => child.input) };
		}).pipe(Effect.provide(harness(client, second, settings))),
	);
	const outcome: TaskOutcome<string> = finished.outcome;
	const children: ReadonlyArray<JsonValue> = finished.children;
	return { second: second.reached, restarts: second.restarts, outcome, children };
}

function harness(client: Layer.Layer<SqlClient, SqlError>, of: Leg, settings?: { readonly restartLimit: number }) {
	return TestHarness.layer({
		extensions: [of.extension],
		storage: Storage.sql().pipe(Layer.provide(client), Layer.orDie),
		...(settings === undefined ? {} : { harness: { settings } }),
	});
}

/** One harness of the scenario. */
type Leg = ReturnType<typeof leg>;

/** The tasks of one harness: they record what the task reaches, and hold it at `stopAt`. */
function leg(stopAt: Boundary | undefined) {
	const reached: Boundary[] = [];
	const restarts: Array<readonly [Boundary, number]> = [];
	const stopped = Promise.withResolvers<void>();
	/** The outside effect of a phase: at the stop it never returns, until the closing harness interrupts it. */
	const effect = (boundary: Boundary, cutOff: number | undefined): Effect.Effect<void> =>
		Effect.suspend(() => {
			reached.push(boundary);
			if (cutOff !== undefined) restarts.push([boundary, cutOff]);
			if (boundary !== stopAt) return Effect.void;
			stopped.resolve();
			return Effect.never;
		});
	const Child = Task.make({
		name: "test.kill-resume-child",
		version: 1,
		input: Schema.Struct({ word: Schema.String }),
		state: Schema.Struct({ phase: Schema.Literal("work") }),
		result: Schema.String,
		initial: () => ({ phase: "work" as const }),
		phases: {
			work: (task) => Effect.as(effect("child", task.record.restarts), Task.complete(task.input.word.toUpperCase())),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	const Parent = Task.make({
		name: "test.kill-resume",
		version: 1,
		input: Schema.Struct({ label: Schema.String }),
		state: Schema.Union([
			Schema.Struct({ phase: Schema.Literal("prepare") }),
			Schema.Struct({ phase: Schema.Literal("spawn"), word: Schema.String }),
			Schema.Struct({ phase: Schema.Literal("finish"), child: Task.Id }),
		]),
		result: Schema.String,
		initial: () => ({ phase: "prepare" as const }),
		phases: {
			prepare: (task) =>
				Effect.as(
					effect("prepare", task.record.restarts),
					Task.next({ phase: "spawn" as const, word: `key-${task.input.label}` }),
				),
			spawn: (task, api) =>
				Effect.andThen(
					effect("spawn", task.record.restarts),
					api.commit((tx) =>
						Effect.map(
							tx.createTask(Child, { word: task.state.word }, { ownership: { kind: "task", taskId: task.id } }),
							(child) =>
								Task.wait({ state: { phase: "finish" as const, child }, on: [child], policy: "allSettled" }),
						),
					),
				),
			finish: (task, api) =>
				Effect.gen(function* () {
					yield* effect("finish", task.record.restarts);
					const [outcome] = yield* api.outcomesOf(Child, [task.state.child]);
					const word = Option.fromUndefinedOr(outcome?.status === "completed" ? outcome.result : undefined);
					return Option.match(word, { onNone: () => Task.fail({ message: "no child" }), onSome: Task.complete });
				}),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	return {
		reached,
		restarts,
		stopped: stopped.promise,
		Parent,
		extension: Extension.make({ name: "app", tasks: [Parent, Child] }),
	};
}
