import { configure, defineDoc, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { Cause, Context, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Doc, type DurableError, Extension, Harness, Registry, Signal, Task, ToolName, Tx } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer } from "./scripted.ts";

const Todos = Doc.make({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ items: Schema.Array(Schema.String) }),
	initial: () => ({ items: [] }),
	checkpointWhen: () => false,
});

const PiTodos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
	checkpointWhen: () => false,
});

class Rejected extends Schema.TaggedError<Rejected, { readonly brand: unique symbol }>()("Rejected", {
	why: Schema.String,
}) {}

class Limits extends Context.Service<Limits, { readonly max: number }>()("test/Limits") {}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The kinds of the root conversation's entries and the stored to-do items, read after a commit. */
const stored = Effect.gen(function* () {
	const root = yield* Harness.root;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	const todos = yield* Harness.snapshot(Todos, root.id);
	return { kinds: entries.map((entry) => entry.kind), todos: Option.getOrUndefined(todos) };
});

describe("commit", () => {
	it("stores an entry and a document together, as the same commit of plain Pi does", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				return yield* root.commit((tx) =>
					Effect.gen(function* () {
						const todos = yield* tx.doc(Todos, root.id);
						yield* todos.set({ items: ["write docs"] });
						const entry = yield* tx.appendEntry(root.id, { kind: "app.note", data: { text: "noted" } });
						return { entry: entry.id, items: (yield* todos.get).items };
					}),
				);
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				return root.commit(async (tx) => {
					const todos = await tx.doc(PiTodos, root.id);
					todos.items = ["write docs"];
					const entry = await tx.appendEntry(root.id, { kind: "app.note", data: { text: "noted" } });
					return { entry: entry.id, items: [...todos.items] };
				}, context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.entries).toEqual([
			{ id: both.effect.records.entries[0]?.id, conversationId: 1, kind: "app.note", data: { text: "noted" } },
		]);
		const todos = both.effect.records.documents.filter((document) => document.record.kind === "app.todos");
		expect(todos.map((document) => document.value)).toEqual([{ items: ["write docs"] }]);
	});

	it("fails with the body's own failure and stores nothing of the commit", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const failure = yield* Effect.flip(
					Harness.commit((tx) =>
						Effect.gen(function* () {
							yield* (yield* tx.doc(Todos, root.id)).set({ items: ["never stored"] });
							yield* tx.appendEntry(root.id, { kind: "app.note" });
							return yield* new Rejected({ why: "too late" });
						}),
					),
				);
				return { failure, after: yield* stored };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome.failure).toBeInstanceOf(Rejected);
		expect(outcome.failure).toMatchObject({ _tag: "Rejected", why: "too late" });
		expect(outcome.after).toEqual({ kinds: [], todos: undefined });
	});

	it("fails with the body's defect and stores nothing", async () => {
		const boom = new Error("boom");
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const exit = yield* Effect.exit(
					root.commit((tx) => Effect.andThen(tx.appendEntry(root.id, { kind: "app.note" }), Effect.die(boom))),
				);
				return { exit, after: yield* stored };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(Exit.isFailure(outcome.exit) && Cause.squash(outcome.exit.cause)).toBe(boom);
		expect(outcome.after).toEqual({ kinds: [], todos: undefined });
	});

	it("runs the body with the caller's services, which the commit requires", async () => {
		const capped = (items: ReadonlyArray<string>) =>
			Effect.flatMap(Harness.root, (root) =>
				Harness.commit((tx) =>
					Effect.gen(function* () {
						const { max } = yield* Limits;
						yield* (yield* tx.doc(Todos, root.id)).set({ items: items.slice(0, max) });
						return max;
					}),
				),
			);
		const requirement: Equal<
			ReturnType<typeof capped>,
			Effect.Effect<number, DurableError | SchemaDecodeError, Limits | Harness.Harness>
		> = true;
		expect(requirement).toBe(true);
		const live = harnessLayer({});
		// @ts-expect-error The body needs `Limits`, which nothing provided.
		const unprovided: Effect.Effect<number, unknown, never> = Effect.provide(capped(["a"]), live);
		expect(unprovided).toBeDefined();
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const max = yield* Effect.provideService(capped(["a", "b", "c"]), Limits, { max: 2 });
				return { max, after: yield* stored };
			}).pipe(Effect.provide(live)),
		);
		expect(outcome).toEqual({ max: 2, after: { kinds: [], todos: { items: ["a", "b"] } } });
	});

	it("interrupts the body when the caller is interrupted, and then stores nothing", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const reached = Promise.withResolvers<void>();
				let interrupted = false;
				const fiber = yield* Effect.forkChild(
					root.commit((tx) =>
						tx.appendEntry(root.id, { kind: "app.note" }).pipe(
							Effect.andThen(Effect.sync(() => reached.resolve())),
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() =>
								Effect.sync(() => {
									interrupted = true;
								}),
							),
						),
					),
				);
				yield* Effect.promise(() => reached.promise);
				const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
				return {
					interrupted,
					onlyInterrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
					after: yield* stored,
				};
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({ interrupted: true, onlyInterrupted: true, after: { kinds: [], todos: undefined } });
	});

	it("passes Pi's commit options on: a deferred document change is visible at once", async () => {
		const items = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.commit((tx) => Effect.asVoid(tx.doc(Todos, root.id)));
				yield* root.commit(
					(tx) => Effect.flatMap(tx.doc(Todos, root.id), (todos) => todos.set({ items: ["draft"] })),
					{ persistence: { kind: "deferred", withinMs: 60_000 } },
				);
				return Option.getOrThrow(yield* Harness.snapshot(Todos, root.id)).items;
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(items).toEqual(["draft"]);
	});
});

describe("Pi's rules for a commit body", () => {
	it("refuses a table read after the first table write with ReadAfterWrite, and still takes document writes", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const read = yield* root.commit((tx) =>
					Effect.gen(function* () {
						const before = yield* tx.conversation(root.id);
						const entry = yield* tx.appendEntry(root.id, { kind: "app.note" });
						const after = yield* Effect.flip(tx.entry(entry.id));
						yield* (yield* tx.doc(Todos, root.id)).set({ items: ["after the write"] });
						return { before: Option.getOrThrow(before).id, after: after._tag };
					}),
				);
				return { read, stored: yield* stored };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({
			read: { before: 1, after: "ReadAfterWrite" },
			stored: { kinds: ["app.note"], todos: { items: ["after the write"] } },
		});
	});

	it("revokes the transaction when the body ended", async () => {
		const late = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const tx = yield* root.commit((given) => Effect.succeed(given));
				return yield* Effect.flip(tx.appendEntry(root.id, { kind: "app.note" }));
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(late._tag).toBe("UnexpectedError");
	});
});

describe("conversations in a commit", () => {
	it("creates, configures and forks conversations as plain Pi does", async () => {
		const both = await runBoth({
			responses: () => [answer("Hello.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("Hi.");
				return yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const head = Option.getOrThrow(yield* tx.latestEntryId(root.id));
						const owned = (yield* tx.scanConversations({}, 10)).items.map((conversation) => conversation.id);
						const created = yield* tx.createConversation({ ownership: { kind: "ownerless" } });
						const fork = yield* tx.forkConversation(root.id, head, { ownership: { kind: "ownerless" } });
						yield* tx.configure(created.id, {
							...AGENT,
							instructions: "Be brief.",
							tools: [ToolName.make("lookup")],
						});
						return { owned, created: created.id, fork: fork.parent };
					}),
				);
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await (await root.submit({ type: "input", content: "Hi." }, context)).wait(context);
				return harness.commit(async (tx) => {
					const head = (await tx.latestEntryId(root.id))!;
					const owned = (await tx.scanConversations({}, 10)).items.map((conversation) => conversation.id);
					const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
					const fork = await tx.forkConversation(root.id, head, { ownership: { kind: "ownerless" } });
					await configure(tx, created.id, {
						...AGENT,
						instructions: "Be brief.",
						tools: [{ name: "lookup" } as never],
					});
					return { owned, created: created.id, fork: fork.parent };
				}, context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.conversations).toHaveLength(3);
		const agents = both.effect.records.documents.filter((document) => document.record.kind === "pi.agent");
		expect(agents.map((document) => document.value)).toContainEqual({
			...AGENT,
			instructions: "Be brief.",
			tools: ["lookup"],
		});
	});

	it("admits a submission in the commit that records it, as Pi's admit does", async () => {
		const both = await runBoth({
			responses: () => [answer("Welcome, Ana.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const id = yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const todos = yield* tx.doc(Todos, root.id);
						const admitted = yield* root.admit(tx, {
							type: "input",
							content: "Ana says hi.",
							requestId: "ana-1",
						});
						yield* todos.set({ items: ["ana-1"] });
						return admitted;
					}),
				);
				const submission = Option.getOrThrow(yield* Harness.submission(id));
				return (yield* submission.wait).status;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const id = await harness.commit(async (tx) => {
					const todos = await tx.doc(PiTodos, root.id);
					const admitted = await root.admit(tx, { type: "input", content: "Ana says hi.", requestId: "ana-1" });
					todos.items = ["ana-1"];
					return admitted;
				}, context);
				return (await (await harness.submission(id, context))!.wait(context)).status;
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toBe("done");
		expect(both.effect.records.submissions).toMatchObject([{ requestId: "ana-1", status: "done" }]);
	});

	it("lets the body catch a refused admission and commit the rest", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const said = yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const todos = yield* tx.doc(Todos, root.id);
						const refused = yield* Effect.flip(
							root.admit(tx, { type: "input", content: "Steer.", whenBusy: "steer", whenIdle: "reject" }),
						);
						yield* todos.set({ items: [refused._tag] });
						return refused._tag;
					}),
				);
				return { said, after: yield* stored };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({
			said: "ConversationIdle",
			after: { kinds: [], todos: { items: ["ConversationIdle"] } },
		});
	});
});

describe("signal", () => {
	it("gives Pi's result for a task that does not exist", async () => {
		const Approval = Signal.make("tx.approval", 1, Schema.Struct({ allow: Schema.Boolean }));
		const result = await Effect.runPromise(
			Harness.commit((tx) => tx.signal(999 as TaskId, Approval, "call-1", { allow: true })).pipe(
				Effect.provide(harnessLayer({})),
			),
		);
		expect(result).toBe("not_found");
	});
});

describe("admit", () => {
	it("is Pi's admit on the transaction of this package", async () => {
		const calls: unknown[] = [];
		const id = await Effect.runPromise(
			Effect.flatMap(Harness.root, (root) =>
				root.commit((tx) =>
					Tx.admit(
						{
							admit: async (given, draft) => {
								calls.push(given === tx.pi, draft);
								return 7 as never;
							},
						},
						tx,
						{ type: "continue" },
					),
				),
			).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(id).toBe(7);
		expect(calls).toEqual([true, { type: "continue" }]);
	});
});

describe("createTask", () => {
	const AT = new Date("2026-11-25T00:00:00.000Z");

	const Stamp = Task.make({
		name: "test.stamp",
		version: 1,
		input: Schema.Struct({ label: Schema.String, at: Schema.Date }),
		state: Schema.Struct({ phase: Schema.Literal("stamp") }),
		result: Schema.Struct({ stamped: Schema.String }),
		initial: () => ({ phase: "stamp" as const }),
		phases: {
			stamp: (task) => Effect.succeed(Task.complete({ stamped: `${task.input.label}@${task.input.at.getTime()}` })),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});

	const PiStamp = defineTask<{ label: string; at: string }, { phase: "stamp" }, { stamped: string }>({
		name: "test.stamp",
		version: 1,
		initial: () => ({ phase: "stamp" }),
		phases: {
			stamp: (task, runtime, context) =>
				runtime.commit(
					() => ({
						status: "terminal",
						outcome: {
							status: "completed",
							result: { stamped: `${task.input.label}@${new Date(task.input.at).getTime()}` },
						},
					}),
					context,
				),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	const stamping = Registry.layer([Extension.make({ name: "app", tasks: [Stamp] })]);

	it("creates a task with Pi's options in a harness commit, as plain Pi's tx.createTask does", async () => {
		const both = await runBoth({
			responses: () => [],
			extensions: { effect: stamping, pi: [defineExtension({ name: "app", tasks: [PiStamp] })] },
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const ids = yield* Harness.commit((tx) =>
					Effect.all([
						tx.createTask(
							Stamp,
							{ label: "background", at: AT },
							{ ownership: { kind: "conversation" }, conversationId: root.id, background: true },
						),
						tx.createTask(
							Stamp,
							{ label: "foreground", at: AT },
							{ ownership: { kind: "conversation" }, conversationId: root.id },
						),
					]),
				);
				return yield* Effect.forEach(ids, (id) => Effect.map(Harness.waitForTask(id), (settled) => settled.state));
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const at = AT.toISOString();
				const ids = await harness.commit(
					async (tx) => [
						await tx.createTask(
							PiStamp,
							{ label: "background", at },
							{ ownership: { kind: "conversation" }, conversationId: root.id, background: true },
						),
						await tx.createTask(
							PiStamp,
							{ label: "foreground", at },
							{ ownership: { kind: "conversation" }, conversationId: root.id },
						),
					],
					context,
				);
				return Promise.all(ids.map(async (id) => (await harness.waitForTask(id, context)).state));
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.tasks.map((task) => [task.kind, task.input, task.background, task.state])).toEqual([
			[
				"test.stamp",
				{ label: "background", at: AT.toISOString() },
				true,
				{ status: "terminal", outcome: { status: "completed", result: { stamped: `background@${AT.getTime()}` } } },
			],
			[
				"test.stamp",
				{ label: "foreground", at: AT.toISOString() },
				false,
				{ status: "terminal", outcome: { status: "completed", result: { stamped: `foreground@${AT.getTime()}` } } },
			],
		]);
	});

	it("defaults to the conversation of a conversation's commit, and needs one in a harness commit", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const input = { label: "here", at: AT };
				const id = yield* root.commit((tx) => tx.createTask(Stamp, input, { ownership: { kind: "conversation" } }));
				const unbound = yield* Effect.flip(
					Harness.commit((tx) => tx.createTask(Stamp, input, { ownership: { kind: "conversation" } })),
				);
				const created = Option.getOrThrow(yield* Harness.getTask(id));
				return { conversationId: created.conversationId === root.id, unbound: [unbound._tag, unbound.message] };
			}).pipe(Effect.provide(harnessLayer({ registry: stamping }))),
		);
		expect(outcome).toEqual({
			conversationId: true,
			unbound: ["UnexpectedError", "Tx.createTask() requires options.conversationId"],
		});
	});

	it("is a table write: a table read after it fails with ReadAfterWrite, and nothing of that commit is stored", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const failure = yield* Effect.flip(
					root.commit((tx) =>
						Effect.andThen(
							tx.createTask(Stamp, { label: "lost", at: AT }, { ownership: { kind: "conversation" } }),
							tx.conversation(root.id),
						),
					),
				);
				return { failure: failure._tag, tasks: (yield* Harness.inspect).tasks.length };
			}).pipe(Effect.provide(harnessLayer({ registry: stamping, harness: { resume: false } }))),
		);
		expect(outcome).toEqual({ failure: "ReadAfterWrite", tasks: 0 });
	});
});

describe("during", () => {
	it("runs each body Pi calls back with inside the commit, and succeeds with what the Pi call resolved with", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const limits = yield* Limits;
				const harness = yield* Harness.Harness;
				const resolved = yield* Tx.during<string, DurableError, Limits>((inside, context) =>
					harness.commit(async (tx) => {
						const first = await inside(tx, (transaction) =>
							Effect.map(transaction.appendEntry(root.id, { kind: "app.note" }), (entry) => entry.kind),
						);
						const max = await inside(tx, () => Limits.use((service) => Effect.succeed(service.max)));
						return `${first} within ${max}`;
					}, context),
				);
				const failure = yield* Effect.flip(
					Tx.during<void, Rejected | DurableError, never>((inside, context) =>
						harness.commit(async (tx) => {
							await inside(tx, (transaction) => transaction.appendEntry(root.id, { kind: "app.dropped" }));
							await inside(tx, () => Effect.fail(new Rejected({ why: "second body" })));
						}, context),
					),
				);
				return { resolved, max: limits.max, failure, after: yield* stored };
			}).pipe(Effect.provide(harnessLayer({})), Effect.provideService(Limits, { max: 3 })),
		);
		expect(outcome.resolved).toBe("app.note within 3");
		expect(outcome.failure).toEqual(new Rejected({ why: "second body" }));
		expect(outcome.after.kinds).toEqual(["app.note"]);
	});
});

/** A task that sleeps until it is aborted: live work to scan for. */
const Idle = Task.make({
	name: "test.idle",
	version: 1,
	input: Schema.Struct({ label: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("wait") }),
	result: Schema.Null,
	initial: () => ({ phase: "wait" as const }),
	phases: { wait: (task, api) => Effect.map(api.now, (now) => Task.sleepUntil(now + 3_600_000, task.state)) },
	abort: () => Effect.succeed(Task.aborted()),
});

describe("scanTasks", () => {
	it("gives the pages Pi's own scan gives in the same commit, and is a table read", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const ids = yield* root.commit((tx) =>
					Effect.forEach(["a", "b", "c"], (label) =>
						tx.createTask(Idle, { label }, { ownership: { kind: "conversation" } }),
					),
				);
				const scanned = yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const query = { conversationId: root.id, kind: "test.idle" } as const;
						const first = yield* tx.scanTasks(query, 2);
						const rest = yield* tx.scanTasks(query, 2, first.next);
						const own = yield* Effect.promise(() => tx.pi.scanTasks(query, 2));
						const newest = yield* tx.scanTasks({ order: "descending" }, 1);
						return { first, rest, own, newest };
					}),
				);
				const afterWrite = yield* Effect.flip(
					root.commit((tx) =>
						Effect.andThen(
							tx.createTask(Idle, { label: "d" }, { ownership: { kind: "conversation" } }),
							tx.scanTasks({}, 1),
						),
					),
				);
				yield* Effect.forEach(ids, (id) => Harness.abortTask(id));
				return { ids, scanned, afterWrite: afterWrite._tag };
			}).pipe(
				Effect.provide(
					harnessLayer({ registry: Registry.layer([Extension.make({ name: "app", tasks: [Idle] })]) }),
				),
			),
		);
		expect(seen.scanned.first).toEqual(seen.scanned.own);
		expect(seen.scanned.first.items.map((task) => task.id)).toEqual(seen.ids.slice(0, 2));
		expect(seen.scanned.rest.items.map((task) => task.id)).toEqual(seen.ids.slice(2));
		expect(seen.scanned.rest.next).toBeUndefined();
		expect(seen.scanned.newest.items.map((task) => task.id)).toEqual(seen.ids.slice(2));
		expect(seen.afterWrite).toBe("ReadAfterWrite");
	});
});

describe("tasks and conversations", () => {
	it("stream every page of Pi's scan inside the commit, as Pi's own scan gives them, and are table reads", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const ids = yield* root.commit((tx) =>
					Effect.forEach(["a", "b", "c"], (label) =>
						tx.createTask(Idle, { label }, { ownership: { kind: "conversation" } }),
					),
				);
				const owned = yield* Harness.commit((tx) =>
					Effect.forEach(ids, (taskId) => tx.createConversation({ ownership: { kind: "task", taskId } })),
				);
				const scanned = yield* Harness.commit((tx) =>
					Effect.all({
						tasks: Stream.runCollect(tx.tasks({ kind: "test.idle", pageSize: 2 })),
						descending: Stream.runCollect(tx.tasks({ kind: "test.idle", order: "descending", pageSize: 1 })),
						own: Effect.promise(() => tx.pi.scanTasks({ kind: "test.idle" }, 100)),
						conversations: Stream.runCollect(tx.conversations({ ownerConversationId: root.id, pageSize: 2 })),
					}),
				);
				const afterWrite = yield* Effect.flip(
					root.commit((tx) =>
						Effect.andThen(
							tx.createTask(Idle, { label: "d" }, { ownership: { kind: "conversation" } }),
							Stream.runCollect(tx.tasks()),
						),
					),
				);
				yield* Effect.forEach(ids, (id) => Harness.abortTask(id));
				return { ids, owned, scanned, afterWrite: afterWrite._tag };
			}).pipe(
				Effect.provide(
					harnessLayer({ registry: Registry.layer([Extension.make({ name: "app", tasks: [Idle] })]) }),
				),
			),
		);
		expect(seen.scanned.tasks).toEqual(seen.scanned.own.items);
		expect(seen.scanned.tasks.map((task) => task.id)).toEqual(seen.ids);
		expect(seen.scanned.descending.map((task) => task.id)).toEqual([...seen.ids].reverse());
		expect(seen.scanned.conversations).toEqual(seen.owned);
		expect(seen.afterWrite).toBe("ReadAfterWrite");
	});
});
