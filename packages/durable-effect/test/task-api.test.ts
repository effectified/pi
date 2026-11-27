import { defineExtension, defineTask, type Report, type TaskId } from "@earendil-works/pi-durable";
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Doc, Entry, Extension, Harness, type JsonValue, Registry, Task } from "../src/index.ts";
import { TestHarness } from "../src/testing/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT } from "./scripted.ts";

const Note = Entry.make("test.note", Schema.Struct({ text: Schema.String, at: Schema.Date }));

const Progress = Doc.make({
	kind: "test.progress",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ done: Schema.Array(Schema.String) }),
	initial: () => ({ done: [] }),
	checkpointWhen: () => false,
});

class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {
	why: Schema.String,
}) {}

const ProbeState = Schema.Union([
	Schema.Struct({ phase: Schema.Literal("run") }),
	Schema.Struct({ phase: Schema.Literal("after"), note: Schema.String }),
]);
type ProbeState = (typeof ProbeState)["Type"];
type ProbeApi = Task.Api<{ readonly label: string }, ProbeState, string>;
type ProbeTask = Task.Running<{ readonly label: string }, Extract<ProbeState, { readonly phase: "run" }>>;

/**
 * A task whose `run` phase is `body`, and whose `after` phase completes with the note of its state. `seen` gets what
 * `body` succeeded with besides its step.
 */
function probe<X>(
	body: (
		task: ProbeTask,
		api: ProbeApi,
	) => Effect.Effect<readonly [X, Task.Step<ProbeState, string> | Task.Committed], unknown>,
) {
	const seen: X[] = [];
	const task = Task.make({
		name: "test.probe",
		version: 1,
		input: Schema.Struct({ label: Schema.String }),
		state: ProbeState,
		result: Schema.String,
		initial: () => ({ phase: "run" as const }),
		phases: {
			run: (running, api) =>
				Effect.map(body(running, api), ([value, step]) => {
					seen.push(value);
					return step;
				}),
			after: (running) => Effect.succeed(Task.complete(running.state.note)),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	return { task, seen };
}

/** Creates `task` in the root conversation, waits for its end, and gives its id and its terminal state. */
const run = <A>(task: Task.Kind<{ readonly label: string }, A>, label = "probe") =>
	Effect.gen(function* () {
		const root = yield* TestHarness.root;
		const id = yield* root.commit((tx) => tx.createTask(task, { label }, { ownership: { kind: "conversation" } }));
		const settled = yield* Harness.waitForTaskOf(task, id);
		yield* Harness.waitForIdle;
		return { root, id, state: settled.state };
	});

const harness = <const Tasks extends ReadonlyArray<Task.Any>>(tasks: Tasks) =>
	TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks })] });

const AT = new Date("2026-11-25T00:00:00.000Z");

describe("what a handler may use", () => {
	it("gives the task's ids, the clock, the agent, memos and committed documents", async () => {
		const { task, seen } = probe((running, api) =>
			Effect.gen(function* () {
				const before = yield* api.memo<string>("probe.choice");
				const first = yield* api.memo("probe.choice", "first");
				const second = yield* api.memo("probe.choice", "second");
				return [
					{
						task: {
							id: running.id,
							conversationId: running.conversationId,
							input: running.input,
							state: running.state,
						},
						wake: Option.isNone(running.wake),
						record: [running.record.kind, running.record.input, running.record.state.checkpoint],
						ids: [
							api.taskId === running.id,
							api.conversationId === running.conversationId,
							api.pi.taskId === running.id,
						],
						now: yield* api.now,
						model: (yield* api.agent).model?.provider,
						memos: [
							Option.isNone(before),
							first,
							second,
							Option.getOrNull(yield* api.memo<string>("probe.choice")),
						],
						progress: Option.getOrNull(yield* api.snapshot(Progress, running.conversationId)),
					},
					Task.next({ phase: "after" as const, note: "done" }),
				] as const;
			}),
		);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(5_000);
				const root = yield* TestHarness.root;
				yield* root.commit((tx) =>
					Effect.flatMap(tx.doc(Progress, root.id), (progress) => progress.set({ done: ["setup"] })),
				);
				const ran = yield* run(task);
				return { id: ran.id, conversationId: root.id, state: ran.state };
			}).pipe(Effect.provide(harness([task])), Effect.provide(TestClock.layer())),
		);
		expect(seen).toEqual([
			{
				task: {
					id: outcome.id,
					conversationId: outcome.conversationId,
					input: { label: "probe" },
					state: { phase: "run" },
				},
				wake: true,
				record: ["test.probe", { label: "probe" }, { phase: "run" }],
				ids: [true, true, true],
				now: 5_000,
				model: "faux",
				memos: [true, "first", "first", "first"],
				progress: { done: ["setup"] },
			},
		]);
		expect(outcome.state).toEqual({ status: "terminal", outcome: { status: "completed", result: "done" } });
	});

	it("reads entries, typed entries, the history and the context of its conversation", async () => {
		const { task, seen } = probe((_running, api) =>
			Effect.gen(function* () {
				const history = yield* Stream.runCollect(api.entries({ order: "ascending" }));
				const noted = history.find((entry) => entry.kind === "test.note");
				const id = Option.getOrThrow(Option.fromUndefinedOr(noted)).id;
				const context = yield* api.context(api.conversationId);
				return [
					{
						kinds: history.map((entry) => entry.kind),
						entry: Option.map(yield* api.entry(id), (entry) => entry.kind),
						typed: Option.map(yield* api.entryOf(Note, id), (entry) => entry.data),
						missing: Option.isNone(yield* api.entry((id + 1_000) as typeof id)),
						active: context.entries.map((entry) => entry.kind),
					},
					Task.next({ phase: "after" as const, note: "read" }),
				] as const;
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.commit((tx) => tx.append(Note, root.id, { data: { text: "before the task", at: AT } }));
				yield* run(task);
			}).pipe(Effect.provide(harness([task]))),
		);
		expect(seen).toEqual([
			{
				kinds: ["test.note"],
				entry: Option.some("test.note"),
				typed: Option.some({ text: "before the task", at: AT }),
				missing: true,
				active: ["test.note"],
			},
		]);
	});

	it("hands a failure that does not fail the task to the harness's reports", async () => {
		const { task } = probe((_running, api) =>
			Effect.as(api.report(new Error("the mail server is down")), [
				null,
				Task.next({ phase: "after" as const, note: "reported" }),
			] as const),
		);
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const reports: Report[] = [];
					// Started at once, it has subscribed when the fork returns.
					yield* Effect.forkScoped(
						Stream.runForEach(Harness.reports, (report) => Effect.sync(() => reports.push(report))),
						{ startImmediately: true },
					);
					const ran = yield* run(task);
					return { state: ran.state, reports: reports.map((report) => [report.kind, String(report.error)]) };
				}),
			).pipe(Effect.provide(harness([task]))),
		);
		expect(seen.state.outcome).toEqual({ status: "completed", result: "reported" });
		expect(seen.reports).toEqual([["task_error", "Error: the mail server is down"]]);
	});
});

describe("commit", () => {
	it("stores the step with the body's entry and document in one commit, as plain Pi's runtime.commit does", async () => {
		const { task, seen } = probe((_running, api) =>
			Effect.map(
				api.commit((tx, current) =>
					Effect.gen(function* () {
						const note = yield* tx.append(Note, current.conversationId, {
							data: { text: current.input.label, at: AT },
						});
						const progress = yield* tx.doc(Progress, current.conversationId);
						yield* progress.set({ done: [current.state.phase] });
						return Task.next({ phase: "after" as const, note: `noted ${note.id}` });
					}),
				),
				(committed) => [committed, committed] as const,
			),
		);
		const PiProbe = defineTask<{ label: string }, { phase: "run" } | { phase: "after"; note: string }, string>({
			name: "test.probe",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: (_running, runtime, context) =>
					runtime.commit(async (tx, current) => {
						const note = await tx.appendEntry(Note.token, current.conversationId, {
							data: { text: current.input.label, at: AT.toISOString() },
						});
						const progress = await tx.doc(Progress.token as never, current.conversationId);
						Object.assign(progress, { done: [current.state.checkpoint.phase] });
						return { status: "running", checkpoint: { phase: "after", note: `noted ${note.id}` } };
					}, context),
				after: (running, runtime, context) =>
					runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "completed", result: running.state.checkpoint.note },
						}),
						context,
					),
			},
			abort: (_running, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		const both = await runBoth({
			responses: () => [],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tasks: [task] })]),
				pi: [defineExtension({ name: "app", tasks: [PiProbe] })],
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const id = yield* root.commit((tx) =>
					tx.createTask(task, { label: "probe" }, { ownership: { kind: "conversation" } }),
				);
				return (yield* Harness.waitForTask(id)).state;
			}),
			pi: async (piHarness, context) => {
				const root = await piHarness.root(context, { agent: AGENT });
				const id = await root.commit(
					(tx) => tx.createTask(PiProbe, { label: "probe" }, { ownership: { kind: "conversation" } }),
					context,
				);
				return (await piHarness.waitForTask(id, context)).state;
			},
		});
		expect(seen).toEqual([{ _tag: "Committed" }]);
		expect(both.effect.records).toEqual(both.pi.records);
		expect(both.effect.result).toEqual(both.pi.result);
		const [note] = both.effect.records.entries;
		const [stored] = both.effect.records.tasks;
		// The entry carries the task that wrote it, and the step names the entry: one commit stored both.
		expect(note).toMatchObject({
			kind: "test.note",
			byTaskId: stored?.id,
			data: { text: "probe", at: AT.toISOString() },
		});
		expect(both.effect.result).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: `noted ${String(note?.id)}` },
		});
		expect(both.effect.records.documents.find(({ record }) => record.kind === "test.progress")?.value).toEqual({
			done: ["run"],
		});
	});

	it("stores only the body's writes for Task.unchanged, and nothing when the body fails, with its own failure", async () => {
		const { task, seen } = probe((running, api) =>
			Effect.gen(function* () {
				const unchanged = yield* api.commit((tx) =>
					Effect.as(tx.append(Note, running.conversationId, { data: { text: "kept", at: AT } }), Task.unchanged),
				);
				const failure = yield* Effect.flip(
					api.commit((tx) =>
						Effect.andThen(
							tx.append(Note, running.conversationId, { data: { text: "dropped", at: AT } }),
							Effect.fail(new Refused({ why: "not today" })),
						),
					),
				);
				const state = Option.getOrThrow(yield* api.getTask(running.id)).state;
				return [{ unchanged, failure, state }, Task.next({ phase: "after" as const, note: "went on" })] as const;
			}),
		);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const ran = yield* run(task);
				const entries = yield* Stream.runCollect(ran.root.entries({ order: "ascending" }));
				return { state: ran.state, texts: entries.map((entry) => entry.data) };
			}).pipe(Effect.provide(harness([task]))),
		);
		expect(seen).toEqual([
			{
				unchanged: { _tag: "Committed" },
				failure: new Refused({ why: "not today" }),
				state: { status: "running", checkpoint: { phase: "run" } },
			},
		]);
		expect(outcome.texts).toEqual([{ text: "kept", at: AT.toISOString() }]);
		expect(outcome.state).toEqual({ status: "terminal", outcome: { status: "completed", result: "went on" } });
	});

	it("faults a task whose phase returns without progress, as Pi does", async () => {
		const { task } = probe((_running, api) =>
			Effect.map(
				api.commit(() => Effect.succeed(Task.unchanged)),
				(committed) => [null, committed] as const,
			),
		);
		const state = await Effect.runPromise(
			Effect.map(run(task), (ran) => ran.state).pipe(Effect.provide(harness([task]))),
		);
		expect(state).toMatchObject({ status: "terminal", outcome: { status: "faulted" } });
	});
});

describe("child tasks", () => {
	const Child = Task.make({
		name: "test.child",
		version: 1,
		input: Schema.Struct({ word: Schema.String, at: Schema.Date }),
		state: Schema.Struct({ phase: Schema.Literal("work") }),
		result: Schema.Struct({ shouted: Schema.String, at: Schema.Date }),
		initial: () => ({ phase: "work" as const }),
		phases: {
			work: (task) =>
				task.input.word === "hang"
					? Effect.never
					: task.input.word === "bad"
						? Effect.succeed(Task.fail({ message: "a bad word" }))
						: Effect.succeed(Task.complete({ shouted: task.input.word.toUpperCase(), at: task.input.at })),
		},
		abort: () => Effect.succeed(Task.aborted("stopped")),
	});

	/** A parent that creates one child per word in one commit, waits for them with `policy`, and reads their outcomes. */
	function parent(policy: "allSettled" | "failFast" | "any") {
		const seen: unknown[] = [];
		const task = Task.make({
			name: "test.parent",
			version: 1,
			input: Schema.Struct({ label: Schema.String }),
			state: Schema.Union([
				Schema.Struct({ phase: Schema.Literal("spawn") }),
				Schema.Struct({ phase: Schema.Literal("join"), children: Schema.Array(Task.Id) }),
			]),
			result: Schema.Array(Schema.String),
			initial: () => ({ phase: "spawn" as const }),
			phases: {
				spawn: (running, api) =>
					api.commit((tx) =>
						Effect.gen(function* () {
							const children = yield* Effect.forEach(running.input.label.split(" "), (word) =>
								tx.createTask(Child, { word, at: AT }, { ownership: { kind: "task", taskId: running.id } }),
							);
							return Task.wait({ state: { phase: "join" as const, children }, on: children, policy });
						}),
					),
				join: (running, api) =>
					Effect.gen(function* () {
						const live = yield* api.ownedTasks;
						// With `any` the others still run: the parent ends them before it reads every outcome.
						yield* Effect.forEach(live, (child) => api.abortOwned(child.id));
						const typed = yield* api.outcomesOf(Child, running.state.children);
						const stored = yield* api.outcomes(running.state.children);
						const first = yield* api.waitForTask(
							Option.getOrThrow(Option.fromUndefinedOr(running.state.children[0])),
						);
						seen.push({
							wake: Option.getOrNull(running.wake),
							live: live.map((child) => child.input),
							typed,
							stored,
							first: first.state.outcome.status,
						});
						return Task.complete(typed.map((outcome) => outcome.status));
					}),
			},
			abort: () => Effect.succeed(Task.aborted()),
		});
		return { task, seen };
	}

	const done = (word: string) => ({ status: "completed", result: { shouted: word.toUpperCase(), at: AT } });
	const storedDone = (word: string) => ({
		status: "completed",
		result: { shouted: word.toUpperCase(), at: AT.toISOString() },
	});

	it("waits with allSettled for every child, and reads their outcomes typed and as stored", async () => {
		const { task, seen } = parent("allSettled");
		const ran = await Effect.runPromise(run(task, "one bad two").pipe(Effect.provide(harness([task, Child]))));
		const children = [ran.id + 1, ran.id + 2, ran.id + 3];
		expect(seen).toEqual([
			{
				wake: { reason: "tasks", ended: children },
				live: [],
				typed: [done("one"), { status: "failed", error: { message: "a bad word" } }, done("two")],
				stored: [storedDone("one"), { status: "failed", error: { message: "a bad word" } }, storedDone("two")],
				first: "completed",
			},
		]);
		expect(ran.state.outcome).toEqual({ status: "completed", result: ["completed", "failed", "completed"] });
	});

	it("aborts the other children once one fails, with failFast", async () => {
		const { task, seen } = parent("failFast");
		const ran = await Effect.runPromise(run(task, "hang bad").pipe(Effect.provide(harness([task, Child]))));
		expect(seen).toMatchObject([
			{
				live: [],
				typed: [
					{ status: "aborted", reason: "stopped" },
					{ status: "failed", error: { message: "a bad word" } },
				],
			},
		]);
		expect(ran.state.outcome).toEqual({ status: "completed", result: ["aborted", "failed"] });
	});

	it("resumes at the first ended child with any, the others still live, and aborts those it owns", async () => {
		const { task, seen } = parent("any");
		const ran = await Effect.runPromise(run(task, "hang one").pipe(Effect.provide(harness([task, Child]))));
		const second = (ran.id + 2) as TaskId;
		expect(seen).toMatchObject([
			{
				wake: { reason: "tasks", ended: [second] },
				live: [{ word: "hang", at: AT.toISOString() }],
				typed: [{ status: "aborted", reason: "stopped" }, done("one")],
			},
		]);
		expect(ran.state.outcome).toEqual({ status: "completed", result: ["aborted", "completed"] });
	});

	it("leaves the same records as a parent and children of plain Pi", async () => {
		const { task } = parent("allSettled");
		const PiChild = defineTask<{ word: string; at: string }, { phase: "work" }, { shouted: string; at: string }>({
			name: "test.child",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: (running, runtime, context) =>
					runtime.commit(
						() => ({
							status: "terminal",
							outcome:
								running.input.word === "bad"
									? { status: "failed", error: { message: "a bad word" } }
									: {
											status: "completed",
											result: { shouted: running.input.word.toUpperCase(), at: running.input.at },
										},
						}),
						context,
					),
			},
			abort: (_running, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "stopped" } }), context),
		});
		type PiState = { phase: "spawn" } | { phase: "join"; children: TaskId<{ shouted: string; at: string }>[] };
		const PiParent = defineTask<{ label: string }, PiState, string[]>({
			name: "test.parent",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: (running, runtime, context) =>
					runtime.commit(async (tx) => {
						const children: TaskId<{ shouted: string; at: string }>[] = [];
						for (const word of running.input.label.split(" ")) {
							children.push(
								await tx.createTask(
									PiChild,
									{ word, at: AT.toISOString() },
									{ ownership: { kind: "task", taskId: running.id } },
								),
							);
						}
						return {
							status: "waiting",
							checkpoint: { phase: "join", children },
							on: children,
							policy: "allSettled",
						};
					}, context),
				join: async (running, runtime, context) => {
					const outcomes = await runtime.outcomes(running.state.checkpoint.children, context);
					const result = outcomes.map((outcome) => outcome.status);
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
				},
			},
			abort: (_running, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		const both = await runBoth({
			responses: () => [],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tasks: [task, Child] })]),
				pi: [defineExtension({ name: "app", tasks: [PiParent, PiChild] })],
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const id = yield* root.commit((tx) =>
					tx.createTask(task, { label: "one bad" }, { ownership: { kind: "conversation" } }),
				);
				return (yield* Harness.waitForTask(id)).state;
			}),
			pi: async (piHarness, context) => {
				const root = await piHarness.root(context, { agent: AGENT });
				const id = await root.commit(
					(tx) => tx.createTask(PiParent, { label: "one bad" }, { ownership: { kind: "conversation" } }),
					context,
				);
				return (await piHarness.waitForTask(id, context)).state;
			},
		});
		expect(both.effect.result).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: ["completed", "failed"] },
		});
		expect(both.effect.records.tasks.map((stored) => [stored.kind, stored.owner])).toEqual([
			["test.parent", undefined],
			["test.child", both.effect.records.tasks[0]?.id],
			["test.child", both.effect.records.tasks[0]?.id],
		]);
		expect(both.effect).toEqual(both.pi);
	});
});

describe("conversation", () => {
	it("admits a follow-up for the task's conversation inside the task's own commit", async () => {
		const { task, seen } = probe((running, api) =>
			Effect.gen(function* () {
				const handle = Option.getOrThrow(yield* api.conversation(running.conversationId));
				const missing = yield* api.conversation((running.conversationId + 1_000) as typeof running.conversationId);
				const committed = yield* api.commit((tx) =>
					Effect.as(
						handle.admit(tx, { type: "write", entry: { kind: "test.verdict", data: { ok: true } } }),
						Task.next({ phase: "after" as const, note: "admitted" }),
					),
				);
				return [
					{ handle: handle.id === running.conversationId, missing: Option.isNone(missing) },
					committed,
				] as const;
			}),
		);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const ran = yield* run(task);
				const entries = yield* Stream.runCollect(ran.root.entries({ order: "ascending" }));
				return { state: ran.state, entries: entries.map((entry) => [entry.kind, entry.data]) };
			}).pipe(Effect.provide(harness([task]))),
		);
		expect(seen).toEqual([{ handle: true, missing: true }]);
		expect(outcome.entries).toEqual([["test.verdict", { ok: true }]]);
		expect(outcome.state.outcome).toEqual({ status: "completed", result: "admitted" });
	});
});

describe("commitReturning", () => {
	it("gives the body's value once the commit stored the step with the body's writes, as plain Pi stores them", async () => {
		const { task, seen } = probe((_running, api) =>
			Effect.map(
				api.commitReturning((tx, current) =>
					Effect.map(
						tx.append(Note, current.conversationId, { data: { text: current.input.label, at: AT } }),
						(note) => ({ step: Task.next({ phase: "after" as const, note: "noted" }), value: note.id }),
					),
				),
				(id) => [id, Task.committed] as const,
			),
		);
		const PiProbe = defineTask<{ label: string }, { phase: "run" } | { phase: "after"; note: string }, string>({
			name: "test.probe",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: (_running, runtime, context) =>
					runtime.commit(async (tx, current) => {
						await tx.appendEntry(Note.token, current.conversationId, {
							data: { text: current.input.label, at: AT.toISOString() },
						});
						return { status: "running", checkpoint: { phase: "after", note: "noted" } };
					}, context),
				after: (running, runtime, context) =>
					runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "completed", result: running.state.checkpoint.note },
						}),
						context,
					),
			},
			abort: (_running, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		const both = await runBoth({
			responses: () => [],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tasks: [task] })]),
				pi: [defineExtension({ name: "app", tasks: [PiProbe] })],
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const id = yield* root.commit((tx) =>
					tx.createTask(task, { label: "probe" }, { ownership: { kind: "conversation" } }),
				);
				return (yield* Harness.waitForTask(id)).state;
			}),
			pi: async (piHarness, context) => {
				const root = await piHarness.root(context, { agent: AGENT });
				const id = await root.commit(
					(tx) => tx.createTask(PiProbe, { label: "probe" }, { ownership: { kind: "conversation" } }),
					context,
				);
				return (await piHarness.waitForTask(id, context)).state;
			},
		});
		expect(both.effect).toEqual(both.pi);
		// The value is the id of the entry that commit appended.
		expect(seen).toEqual([both.effect.records.entries[0]?.id]);
		expect(both.effect.result).toEqual({ status: "terminal", outcome: { status: "completed", result: "noted" } });
	});

	it("gives what the body read with Task.unchanged, and fails with the body's own failure, storing nothing", async () => {
		const { task, seen } = probe((running, api) =>
			Effect.gen(function* () {
				const live = yield* api.commitReturning((tx) =>
					Effect.map(tx.scanTasks({ kind: "test.probe", status: "running" }, 10), (page) => ({
						step: Task.unchanged,
						value: page.items.map((found) => found.id),
					})),
				);
				const typed: Equal<typeof live, Array<TaskId<JsonValue>>> = true;
				const failure = yield* Effect.flip(
					api.commitReturning((tx) =>
						Effect.andThen(
							tx.append(Note, running.conversationId, { data: { text: "dropped", at: AT } }),
							Effect.fail(new Refused({ why: "not today" })),
						),
					),
				);
				const state = Option.getOrThrow(yield* api.getTask(running.id)).state;
				return [
					{ live: live.length === 1 && live[0] === running.id, typed, failure, state },
					Task.next({ phase: "after" as const, note: "went on" }),
				] as const;
			}),
		);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const ran = yield* run(task);
				const entries = yield* Stream.runCollect(ran.root.entries({ order: "ascending" }));
				return { state: ran.state, entries: entries.length };
			}).pipe(Effect.provide(harness([task]))),
		);
		expect(seen).toEqual([
			{
				live: true,
				typed: true,
				failure: new Refused({ why: "not today" }),
				state: { status: "running", checkpoint: { phase: "run" } },
			},
		]);
		expect(outcome).toEqual({
			state: { status: "terminal", outcome: { status: "completed", result: "went on" } },
			entries: 0,
		});
	});
});

describe("timer", () => {
	it("succeeds once the time passed on the harness clock, which a TestClock drives", async () => {
		const armed = Deferred.makeUnsafe<void>();
		const { task, seen } = probe((_running, api) =>
			Effect.gen(function* () {
				const start = yield* api.now;
				yield* Deferred.succeed(armed, undefined);
				yield* api.timer(60_000);
				return [(yield* api.now) - start, Task.next({ phase: "after" as const, note: "paced" })] as const;
			}),
		);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const ran = yield* Effect.forkChild(run(task), { startImmediately: true });
				yield* Deferred.await(armed);
				// The phase arms the timer right after it signalled: let its fiber reach it.
				yield* Effect.yieldNow;
				yield* TestClock.adjust(59_999);
				const early = ran.pollUnsafe() === undefined;
				yield* TestClock.adjust(1);
				return { early, state: (yield* Fiber.join(ran)).state };
			}).pipe(Effect.provide(harness([task])), Effect.provide(TestClock.layer())),
		);
		expect(seen).toEqual([60_000]);
		expect(outcome).toEqual({
			early: true,
			state: { status: "terminal", outcome: { status: "completed", result: "paced" } },
		});
	});
});

describe("watchDoc", () => {
	it("streams a document's value from inside the task, decoded", async () => {
		const { task, seen } = probe((running, api) =>
			Effect.gen(function* () {
				yield* api.commit((tx) =>
					Effect.as(
						Effect.flatMap(tx.doc(Progress, running.conversationId), (progress) => progress.set({ done: ["a"] })),
						Task.unchanged,
					),
				);
				const first = yield* Stream.runHead(api.watchDoc(Progress, running.conversationId));
				return [
					Option.map(first, (change) => change.value),
					Task.next({ phase: "after" as const, note: "seen" }),
				] as const;
			}),
		);
		await Effect.runPromise(run(task).pipe(Effect.provide(harness([task]))));
		expect(seen).toEqual([Option.some({ done: ["a"] })]);
	});
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
