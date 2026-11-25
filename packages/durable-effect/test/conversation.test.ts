import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type {
	Agent,
	ConversationId,
	ConversationWatch,
	Cursor,
	EntryRecord,
	Conversation as PiConversation,
} from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect, Fiber, Latch, Option, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Conversation, ConversationBusy, ConversationIdle, Extension, Harness, Registry, Task } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer, heldAnswer } from "./scripted.ts";

/** Plain Pi's submit then wait, which `Conversation.prompt` wraps. */
async function piPrompt(conversation: PiConversation, content: string, requestId: string, context: Context) {
	const submission = await conversation.submit({ type: "input", content, requestId }, context);
	return submission.wait(context);
}

describe("parity with Pi Durable", () => {
	it("submit admits an input that a run then answers", async () => {
		const both = await runBoth({
			responses: () => [answer("Paris.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Capital of France?", requestId: "q-1" });
				return submission.id;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const submission = await root.submit(
					{ type: "input", content: "Capital of France?", requestId: "q-1" },
					context,
				);
				return submission.id;
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(both.effect.records.submissions).toEqual([
			expect.objectContaining({ id: both.effect.result, requestId: "q-1", type: "input", status: "done" }),
		]);
	});

	it("prompt is submit then wait", async () => {
		const both = await runBoth({
			responses: () => [answer("Paris.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				return yield* root.prompt("Capital of France?", { requestId: "q-1" });
			}),
			pi: async (harness, context) =>
				piPrompt(await harness.root(context, { agent: AGENT }), "Capital of France?", "q-1", context),
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toMatchObject({ type: "input", status: "done", requestId: "q-1" });
		expect(both.effect.records.submissions).toEqual([both.effect.result]);
	});

	it("fork continues alone from the parent's head", async () => {
		const both = await runBoth({
			responses: () => [answer("One."), answer("Two.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("First.", { requestId: "a" });
				yield* root.waitForIdle;
				const head = Option.getOrThrow(yield* root.head);
				const branch = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
				yield* branch.prompt("Second.", { requestId: "b" });
				return { head, branch: branch.id };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await piPrompt(root, "First.", "a", context);
				await root.waitForIdle(context);
				const head = (await root.entries({}, 1, undefined, context)).items[0]!.id;
				const branch = await root.fork(head, { ownership: { kind: "ownerless" } }, context);
				await piPrompt(branch, "Second.", "b", context);
				return { head, branch: branch.id };
			},
		});
		expect(both.effect).toEqual(both.pi);
		const { head, branch } = both.effect.result as { head: number; branch: number };
		expect(both.effect.records.conversations).toEqual([
			{ id: 1 },
			{ id: branch, parent: { conversationId: 1, at: head } },
		]);
		expect(both.effect.records.entries.map((entry) => [entry.conversationId, entry.kind])).toEqual([
			[1, "pi.user"],
			[1, "pi.assistant"],
			[branch, "pi.user"],
			[branch, "pi.assistant"],
		]);
	});

	it("configure changes the stored agent", async () => {
		const change = { ...AGENT, instructions: "Be brief.", maxTurns: 3 };
		const both = await runBoth({
			responses: () => [answer("Ok.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.root;
				yield* root.configure(change);
				yield* root.prompt("Hello.", { requestId: "a" });
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context);
				await root.configure(change, context);
				await piPrompt(root, "Hello.", "a", context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		const agent = both.effect.records.documents.find((document) => document.record.kind === "pi.agent");
		expect(agent?.value).toEqual(change);
	});

	it("agent resolves what the conversation runs with", async () => {
		const change = { ...AGENT, instructions: "Be brief.", thinkingLevel: "low" } as const;
		const resolved = (agent: Agent) => ({
			model: agent.model,
			thinkingLevel: agent.thinkingLevel,
			instructions: agent.instructions,
			extensions: agent.extensions.map((extension) => extension.name),
			tools: agent.tools.map((tool) => tool.name),
			sections: agent.sections.map((section) => section.key),
		});
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const root = yield* Harness.root;
				const unset = resolved(yield* root.agent);
				yield* root.configure(change);
				return { unset, configured: resolved(yield* root.agent) };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context);
				const unset = resolved(await root.agent(context));
				await root.configure(change, context);
				return { unset, configured: resolved(await root.agent(context)) };
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toEqual({
			unset: { thinkingLevel: "off", extensions: [], tools: [], sections: [] },
			configured: {
				model: AGENT.model,
				thinkingLevel: "low",
				instructions: "Be brief.",
				extensions: [],
				tools: [],
				sections: ["instructions"],
			},
		});
	});

	it("compact admits a manual compaction task", async () => {
		const both = await runBoth({
			responses: () => [answer("One."), answer("Summary.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("First.", { requestId: "a" });
				return yield* root.compact("Keep the names.");
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await piPrompt(root, "First.", "a", context);
				return root.compact("Keep the names.", context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.records.tasks).toContainEqual(
			expect.objectContaining({
				id: both.effect.result,
				kind: "pi.compaction",
				input: { reason: "manual", instructions: "Keep the names." },
			}),
		);
	});

	it("reset starts a new context from a handoff", async () => {
		const both = await runBoth({
			responses: () => [answer("One.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("First.", { requestId: "a" });
				yield* root.waitForIdle;
				yield* root.reset("We were counting.");
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await piPrompt(root, "First.", "a", context);
				await root.waitForIdle(context);
				await root.reset("We were counting.", context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		const reset = both.effect.records.entries.at(-1);
		expect(reset).toMatchObject({
			kind: "pi.reset",
			head: reset?.id,
			model: [{ role: "user", content: "We were counting." }],
		});
	});

	it("abort stops the run and withdraws its input", async () => {
		let held = heldAnswer("Never read.");
		const both = await runBoth({
			responses: () => {
				held = heldAnswer("Never read.");
				return [held.response];
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Long task.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				yield* root.abort();
				return yield* submission.status;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const submission = await root.submit({ type: "input", content: "Long task.", requestId: "a" }, context);
				await held.requested;
				await root.abort(context);
				return submission.status(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(both.effect.records.tasks).toEqual([
			expect.objectContaining({ kind: "pi.generation", abortRequested: true }),
		]);
	});

	it("waitForIdle succeeds once the run is over", async () => {
		const both = await runBoth({
			responses: () => [answer("Done.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "a" });
				yield* root.waitForIdle;
				return yield* submission.status;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const submission = await root.submit({ type: "input", content: "Go.", requestId: "a" }, context);
				await root.waitForIdle(context);
				return submission.status(context);
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toMatchObject({ status: "done" });
	});

	it("context reads the active transcript, now and as of an entry", async () => {
		const both = await runBoth({
			responses: () => [answer("One."), answer("Two.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("First.", { requestId: "a" });
				yield* root.waitForIdle;
				const first = Option.getOrThrow(yield* root.head);
				yield* root.prompt("Second.", { requestId: "b" });
				yield* root.waitForIdle;
				return { current: yield* root.context(), asOfFirst: yield* root.context({ at: first }) };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await piPrompt(root, "First.", "a", context);
				await root.waitForIdle(context);
				const first = (await root.entries({}, 1, undefined, context)).items[0]!.id;
				await piPrompt(root, "Second.", "b", context);
				await root.waitForIdle(context);
				return { current: await root.context(context), asOfFirst: await root.context(context, { at: first }) };
			},
		});
		expect(both.effect).toEqual(both.pi);
		const views = both.effect.result as Record<"current" | "asOfFirst", { messages: { role: string }[] }>;
		expect(views.current.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(views.asOfFirst.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("entries streams the history page by page, in the order asked for", async () => {
		const both = await runBoth({
			responses: () => [answer("One."), answer("Two."), answer("Three.")],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				for (const text of ["First.", "Second.", "Third."]) {
					yield* root.prompt(text, { requestId: text });
					yield* root.waitForIdle;
				}
				return {
					ascending: yield* Stream.runCollect(root.entries({ order: "ascending", pageSize: 2 })),
					newest: yield* Stream.runCollect(Stream.take(root.entries({ pageSize: 2 }), 3)),
				};
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				for (const text of ["First.", "Second.", "Third."]) {
					await piPrompt(root, text, text, context);
					await root.waitForIdle(context);
				}
				const ascending: EntryRecord[] = [];
				let cursor: Cursor | undefined;
				do {
					const page = await root.entries({ order: "ascending" }, 2, cursor, context);
					ascending.push(...page.items);
					cursor = page.next;
				} while (cursor !== undefined);
				return { ascending, newest: ascending.toReversed().slice(0, 3) };
			},
		});
		expect(both.effect).toEqual(both.pi);
		const { ascending } = both.effect.result as { ascending: { kind: string }[] };
		expect(ascending.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.assistant",
			"pi.user",
			"pi.assistant",
			"pi.user",
			"pi.assistant",
		]);
	});
});

describe("head", () => {
	it("is none while the conversation is empty", async () => {
		const head = await Effect.runPromise(
			Effect.flatMap(Harness.root, (root) => root.head).pipe(Effect.provide(harnessLayer({ responses: [] }))),
		);
		expect(Option.isNone(head)).toBe(true);
	});
});

describe("typed failures", () => {
	it("fails with ConversationBusy when an input rejects a busy conversation", async () => {
		const held = heldAnswer("Done.");
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.submit({ type: "input", content: "Long task." });
				yield* Effect.promise(() => held.requested);
				const refused = yield* Effect.flip(root.submit({ type: "input", content: "Now.", whenBusy: "reject" }));
				held.release();
				yield* root.waitForIdle;
				return refused;
			}).pipe(Effect.provide(harnessLayer({ responses: [held.response] }))),
		);
		expect(error).toBeInstanceOf(ConversationBusy);
		expect(error).toMatchObject({ _tag: "ConversationBusy", conversationId: 1, message: "Conversation 1 is busy" });
	});

	it("fails with ConversationIdle when an input rejects an idle conversation", async () => {
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				return yield* Effect.flip(root.submit({ type: "input", content: "Only if busy.", whenIdle: "reject" }));
			}).pipe(Effect.provide(harnessLayer({ responses: [] }))),
		);
		expect(error).toBeInstanceOf(ConversationIdle);
		expect(error).toMatchObject({ _tag: "ConversationIdle", conversationId: 1, message: "Conversation 1 is idle" });
	});
});

describe("changes", () => {
	it("gives the view now, then its changes up to the answer, and releases Pi's watch with its scope", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const harness = yield* Harness.Harness;
				const pi = yield* Effect.promise(() => harness.root(BACKGROUND_CONTEXT, { agent: AGENT }));
				// Pi's own watch, kept so the test can ask how it ended.
				const watch = vi.spyOn(pi, "watch");
				const root = Conversation.fromPi(pi);
				// The first element is the view at attachment: the run's changes come after it.
				const attached = yield* Latch.make();
				const watching = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.takeUntil(
							Stream.tap(root.changes({ min: 5 }), () => attached.open),
							(change) => change.value.entries.some((entry) => entry.kind === "pi.assistant"),
						),
					),
				);
				yield* attached.await;
				yield* root.prompt("Hi.");
				const changes = yield* Fiber.join(watching);
				const acquired = yield* Effect.promise(() => watch.mock.results[0]?.value as Promise<ConversationWatch>);
				return { changes, window: watch.mock.calls[0]?.[1], end: yield* Effect.promise(() => acquired.closed) };
			}).pipe(Effect.provide(harnessLayer({ responses: [answer("Hello.")] }))),
		);
		const [first] = outcome.changes;
		const last = outcome.changes[outcome.changes.length - 1];
		expect(first).toMatchObject({ value: { conversation: { id: 1 }, entries: [] }, ops: [], retired: false });
		expect(Object.keys(first?.value.docs ?? {}).sort()).toEqual([
			"pi.agent",
			"pi.inbox",
			"pi.live",
			"pi.provider",
			"pi.usage",
		]);
		expect(last?.value.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(last?.ops.length).toBeGreaterThan(0);
		expect(outcome.window).toEqual({ min: 5 });
		expect(outcome.end).toEqual({ kind: "stopped" });
	});

	it("ends when the harness closes", async () => {
		const changes = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const attached = yield* Latch.make();
				const collecting = yield* Effect.forkDetach(
					Stream.runCollect(Stream.tap(root.changes(), () => attached.open)),
				);
				yield* attached.await;
				return collecting;
			}).pipe(
				Effect.provide(harnessLayer({})),
				Effect.flatMap((collecting) => Fiber.join(collecting)),
			),
		);
		expect(changes.map((change) => change.value.entries)).toEqual([[]]);
	});
});

describe("record, parent and owner", () => {
	it("read the stored record of the handle's conversation: none for the root, the fork point, the owning task", async () => {
		// A task that sleeps until it is aborted: a live owner.
		const Waiting = Task.make({
			name: "test.waiting",
			version: 1,
			input: Schema.Struct({}),
			state: Schema.Struct({ phase: Schema.Literal("wait") }),
			result: Schema.Null,
			initial: () => ({ phase: "wait" as const }),
			phases: { wait: (task, api) => Effect.map(api.now, (now) => Task.sleepUntil(now + 3_600_000, task.state)) },
			abort: () => Effect.succeed(Task.aborted()),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const head = Option.getOrThrow(yield* root.head);
				const fork = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
				const task = yield* root.commit((tx) =>
					tx.createTask(Waiting, {}, { ownership: { kind: "conversation" } }),
				);
				const owned = yield* Harness.createConversation({ ownership: { kind: "task", taskId: task } });
				const pi = yield* Harness.Harness;
				yield* Effect.addFinalizer(() => Effect.ignore(Harness.abortTask(task)));
				return {
					root: [yield* root.record, yield* root.parent, yield* root.owner] as const,
					fork: [yield* fork.record, yield* fork.parent, yield* fork.owner] as const,
					owned: [yield* owned.record, yield* owned.parent, yield* owned.owner] as const,
					pi: yield* Effect.promise(() =>
						pi.commit(
							async (tx) => [await tx.conversation(fork.id), await tx.conversation(owned.id)],
							BACKGROUND_CONTEXT,
						),
					),
					ids: { root: root.id, fork: fork.id, owned: owned.id, head, task },
				};
			}).pipe(
				Effect.scoped,
				Effect.provide(
					harnessLayer({
						responses: [answer("Hello.")],
						registry: Registry.layer([Extension.make({ name: "app", tasks: [Waiting] })]),
					}),
				),
			),
		);
		const { ids } = seen;
		expect(seen.root).toEqual([{ id: ids.root }, Option.none(), Option.none()]);
		expect(seen.fork).toEqual([
			{ id: ids.fork, parent: { conversationId: ids.root, at: ids.head } },
			Option.some({ conversationId: ids.root, at: ids.head }),
			Option.none(),
		]);
		expect(seen.owned).toEqual([
			{ id: ids.owned, owner: { conversationId: ids.root, taskId: ids.task } },
			Option.none(),
			Option.some({ conversationId: ids.root, taskId: ids.task }),
		]);
		expect([seen.fork[0], seen.owned[0]]).toEqual(seen.pi);
	});
});

describe("Id", () => {
	it("is a number in stored JSON and a conversation id in the decoded value", async () => {
		const Kept = Schema.Struct({ conversation: Conversation.Id });
		const typed: Equal<(typeof Kept)["Type"]["conversation"], ConversationId> = true;
		const stored: Equal<(typeof Kept)["Encoded"]["conversation"], number> = true;
		const codec = Schema.toCodecJson(Kept);
		const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(codec)({ conversation: 3 }));
		const refused = await Effect.runPromise(Effect.exit(Schema.decodeUnknownEffect(codec)({ conversation: "3" })));
		expect([typed, stored]).toEqual([true, true]);
		expect(decoded).toEqual({ conversation: 3 });
		expect(await Effect.runPromise(Schema.encodeEffect(codec)(decoded))).toEqual({ conversation: 3 });
		expect(refused._tag).toBe("Failure");
	});
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
