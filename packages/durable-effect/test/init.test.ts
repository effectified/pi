import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { SchemaDecodeError } from "@gunta/pi-schema-effect";
import { Context, Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Doc, type DurableError, Entry, Extension, Harness, Registry, Task } from "../src/index.ts";
import type { Init } from "../src/init.ts";
import { AlreadyForked, conversations, findByKey, findByScan, forkFor, Job } from "./keyed-fork.ts";
import { runBoth } from "./parity.ts";
import { AGENT, harnessLayer } from "./scripted.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Tenants extends Context.Service<Tenants, { readonly current: string }>()("test/Tenants") {}

class Refused extends Schema.TaggedError<Refused>()("Refused", { why: Schema.String }) {}

const Owner = Doc.make({
	kind: "test.owner",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	schema: Schema.Struct({ steps: Schema.Array(Schema.String) }),
	initial: () => ({ steps: [] }),
	checkpointWhen: () => false,
});

const Opened = Entry.make("test.opened", Schema.Struct({ by: Schema.String, at: Schema.Date }));

const AT = new Date("2026-11-25T00:00:00.000Z");

/** Notes the tenant on the new conversation: a document write and a typed entry, both in the creating commit. */
const claim: Init<DurableError | SchemaDecodeError, Tenants> = (tx, conversationId) =>
	Effect.gen(function* () {
		const { current } = yield* Tenants;
		yield* (yield* tx.doc(Owner, conversationId)).update(({ steps }) => ({ steps: [...steps, `init ${current}`] }));
		yield* tx.append(Opened, conversationId, { data: { by: current, at: AT } });
	});

const ana = Effect.provideService(Tenants, { current: "ana" });

const steps = (id: ConversationId) =>
	Effect.map(Harness.snapshot(Owner, id), (owner) => Option.getOrThrow(owner).steps);

describe("createConversation with init", () => {
	it("runs init in the creating commit, with the caller's services, as plain Pi's init does", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const created = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: AGENT,
					init: claim,
				});
				const entries = yield* Stream.runCollect(created.entries({ order: "ascending" }));
				return { steps: yield* steps(created.id), entries: entries.map((entry) => [entry.kind, entry.data]) };
			}).pipe(ana),
			pi: async (harness, context) => {
				const created = await harness.createConversation(
					{
						ownership: { kind: "ownerless" },
						agent: AGENT,
						init: async (tx, conversationId) => {
							const owner = await tx.doc(Owner.token as never, conversationId);
							Object.assign(owner, { steps: ["init ana"] });
							await tx.appendEntry(Opened.token, conversationId, { data: { by: "ana", at: AT.toISOString() } });
						},
					},
					context,
				);
				const page = await created.entries({ order: "ascending" }, 10, undefined, context);
				const owner = await harness.snapshot(Owner.token as never, created.id, context);
				return {
					steps: (owner as { steps: string[] }).steps,
					entries: page.items.map((entry) => [entry.kind, entry.data]),
				};
			},
		});
		expect(both.effect.result).toEqual({
			steps: ["init ana"],
			entries: [["test.opened", { by: "ana", at: AT.toISOString() }]],
		});
		expect(both.effect).toEqual(both.pi);
	});

	it("requires what init needs, and fails with what init fails with", () => {
		const needy = Harness.createConversation({ ownership: { kind: "ownerless" }, init: claim });
		const failing = Harness.createConversation({
			ownership: { kind: "ownerless" },
			init: () => Effect.fail(new Refused({ why: "typed" })),
		});
		const plain = Harness.createConversation({ ownership: { kind: "ownerless" } });
		const needs: Equal<Effect.Services<typeof needy>, Harness.Harness | Tenants> = true;
		const fails: Equal<Effect.Error<typeof failing>, Refused | DurableError> = true;
		const unchanged: Equal<typeof plain, ReturnType<typeof Harness.createConversation<never, never>>> = true;
		expect([needs, fails, unchanged]).toEqual([true, true, true]);
	});

	it("runs init after conversationCreated and the agent change, and stores nothing when init fails", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: AGENT,
					init: claim,
				});
				const model = (yield* created.agent).model?.provider;
				const before = (yield* conversations).length;
				const failure = yield* Effect.flip(
					Harness.createConversation({
						ownership: { kind: "ownerless" },
						init: (tx, conversationId) =>
							Effect.andThen(claim(tx, conversationId), Effect.fail(new Refused({ why: "not this one" }))),
					}),
				);
				const tableRead = yield* Effect.flip(
					Harness.createConversation({
						ownership: { kind: "ownerless" },
						init: (tx, conversationId) => Effect.asVoid(tx.conversation(conversationId)),
					}),
				);
				return {
					steps: yield* steps(created.id),
					model,
					failure,
					tableRead: tableRead._tag,
					stored: [before, (yield* conversations).length],
				};
			}).pipe(
				ana,
				Effect.provide(
					harnessLayer({
						harness: {
							conversationCreated: (tx, conversation) =>
								Effect.flatMap(tx.doc(Owner, conversation.id), (owner) => owner.set({ steps: ["created"] })),
						},
					}),
				),
			),
		);
		expect(outcome).toEqual({
			steps: ["created", "init ana"],
			model: "faux",
			failure: new Refused({ why: "not this one" }),
			tableRead: "ReadAfterWrite",
			stored: [1, 1],
		});
	});

	it("creates a task for the new conversation in the creating commit", async () => {
		const Greet = Task.make({
			name: "test.greet",
			version: 1,
			input: Schema.Struct({ name: Schema.String }),
			state: Schema.Struct({ phase: Schema.Literal("greet") }),
			result: Schema.String,
			initial: () => ({ phase: "greet" as const }),
			phases: {
				greet: (task) => Effect.succeed(Task.complete(`hello ${task.input.name} in ${task.conversationId}`)),
			},
			abort: () => Effect.succeed(Task.aborted()),
		});
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const greeting = Promise.withResolvers<TaskId>();
				const created = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					init: (tx, conversationId) =>
						Effect.map(
							tx.createTask(Greet, { name: "ana" }, { ownership: { kind: "conversation" }, conversationId }),
							greeting.resolve,
						),
				});
				const settled = yield* Harness.waitForTaskOf(Greet, yield* Effect.promise(() => greeting.promise));
				return {
					conversation: settled.conversationId === created.id,
					outcome: settled.state.outcome,
					id: created.id,
				};
			}).pipe(
				Effect.provide(
					harnessLayer({ registry: Registry.layer([Extension.make({ name: "app", tasks: [Greet] })]) }),
				),
			),
		);
		expect(outcome.conversation).toBe(true);
		expect(outcome.outcome).toEqual({ status: "completed", result: `hello ana in ${outcome.id}` });
	});
});

describe("rootWith with init", () => {
	it("runs init in the commit that creates the root, and never for a root that exists", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT, init: claim });
				const again = yield* Harness.rootWith({ init: () => Effect.fail(new Refused({ why: "the root exists" })) });
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return {
					same: again.id === root.id,
					steps: yield* steps(root.id),
					kinds: entries.map((entry) => entry.kind),
				};
			}).pipe(ana, Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({ same: true, steps: ["init ana"], kinds: ["test.opened"] });
	});

	it("stores no root when init fails, so the next call creates it", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const failure = yield* Effect.flip(
					Harness.rootWith({ init: () => Effect.fail(new Refused({ why: "not yet" })) }),
				);
				const none = (yield* conversations).length;
				const root = yield* Harness.rootWith({ init: claim });
				return { failure, none, steps: yield* steps(root.id) };
			}).pipe(ana, Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({ failure: new Refused({ why: "not yet" }), none: 0, steps: ["init ana"] });
	});
});

describe("fork with init", () => {
	it("runs init in the commit that creates the fork, as plain Pi's fork does", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const note = yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.note" }));
				const fork = yield* root.fork({ at: note.id, ownership: { kind: "ownerless" }, init: claim });
				const entries = yield* Stream.runCollect(fork.entries({ order: "ascending" }));
				return { steps: yield* steps(fork.id), kinds: entries.map((entry) => entry.kind) };
			}).pipe(ana),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const note = await root.commit((tx) => tx.appendEntry(root.id, { kind: "test.note" }), context);
				const fork = await root.fork(
					note.id,
					{
						ownership: { kind: "ownerless" },
						init: async (tx, conversationId) => {
							const owner = await tx.doc(Owner.token as never, conversationId);
							Object.assign(owner, { steps: ["init ana"] });
							await tx.appendEntry(Opened.token, conversationId, { data: { by: "ana", at: AT.toISOString() } });
						},
					},
					context,
				);
				const page = await fork.entries({ order: "ascending" }, 10, undefined, context);
				const owner = await harness.snapshot(Owner.token as never, fork.id, context);
				return { steps: (owner as { steps: string[] }).steps, kinds: page.items.map((entry) => entry.kind) };
			},
		});
		expect(both.effect.result).toEqual({ steps: ["init ana"], kinds: ["test.note", "test.opened"] });
		expect(both.effect).toEqual(both.pi);
	});

	it("claims a job key in init, so the key finds the fork again and a retry makes no second copy", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.note" }));
				const before = yield* findByKey("job-1");
				const fork = yield* forkFor(root, "job-1");
				const retried = yield* Effect.flip(forkFor(root, "job-1"));
				const other = yield* forkFor(root, "job-2");
				return {
					before: Option.isNone(before),
					byKey: Option.getOrNull(yield* findByKey("job-1")) === fork.id,
					byScan: (yield* findByScan("job-1")).map((id) => id === fork.id),
					retried,
					forkId: fork.id,
					job: Option.getOrNull(yield* Harness.snapshot(Job, other.id)),
					conversations: (yield* conversations).length,
				};
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome).toEqual({
			before: true,
			byKey: true,
			byScan: [true],
			retried: new AlreadyForked({ key: "job-1", conversationId: outcome.forkId }),
			forkId: outcome.forkId,
			job: { key: "job-2" },
			// The root and one fork per key: the retry stored nothing.
			conversations: 3,
		});
	});
});
