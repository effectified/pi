import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
	type CommitPublication,
	type ConversationId,
	createRegistry,
	type HarnessInspection,
	Harness as PiHarness,
	type Report,
	type SubmissionId,
	type TaskId,
	type Wake,
} from "@earendil-works/pi-durable";
import type { Models } from "@effectified/pi-ai";
import { runTest } from "@effectified/pi-ai/testing";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Latch,
	Layer,
	Logger,
	Option,
	Queue,
	References,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";
import {
	Doc,
	type DurableError,
	Extension,
	Gate,
	Harness,
	Hook,
	ReadOnlySession,
	Registry,
	Signal,
	Storage,
	Task,
	Tool,
	type Watch,
} from "../src/index.ts";
import { toolCall } from "../src/testing/index.ts";
import { reopenWithPendingSubmission } from "./lifecycle.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer, heldAnswer, KeptStorage, scriptedModels } from "./scripted.ts";

const MISSING_CONVERSATION = 999 as ConversationId;
const MISSING_SUBMISSION = 999 as SubmissionId;
const MISSING_TASK = 999 as TaskId;

/** The id of the one live generation task. */
function generation(inspection: HarnessInspection): TaskId {
	return inspection.tasks.filter((task) => task.record.kind === "pi.generation")[0]!.record.id;
}

describe("parity with Pi Durable", () => {
	it("root creates the root conversation once, and rootWith's agent only applies to a new root", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const created = yield* Harness.root;
				const again = yield* Harness.rootWith({ agent: AGENT });
				return [created.id, again.id];
			}),
			pi: async (harness, context) => {
				const created = await harness.root(context);
				const again = await harness.root(context, { agent: AGENT });
				return [created.id, again.id];
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toEqual([1, 1]);
		expect(both.effect.records.conversations).toEqual([{ id: 1 }]);
		const agent = both.effect.records.documents.find((document) => document.record.kind === "pi.agent");
		expect(agent?.value).toEqual({});
	});

	it("createConversation creates a conversation that conversation finds by id", async () => {
		const both = await runBoth({
			responses: () => [answer("Hello.")],
			effect: Effect.gen(function* () {
				const created = yield* Harness.createConversation({ ownership: { kind: "ownerless" }, agent: AGENT });
				const found = yield* Harness.conversation(created.id);
				const missing = yield* Harness.conversation(MISSING_CONVERSATION);
				yield* Option.getOrThrow(found).prompt("Hi.", { requestId: "a" });
				return { created: created.id, found: Option.getOrThrow(found).id, missing: Option.isNone(missing) };
			}),
			pi: async (harness, context) => {
				const created = await harness.createConversation(
					{ ownership: { kind: "ownerless" }, agent: AGENT },
					context,
				);
				const found = await harness.conversation(created.id, context);
				const missing = await harness.conversation(MISSING_CONVERSATION, context);
				await (await found!.submit({ type: "input", content: "Hi.", requestId: "a" }, context)).wait(context);
				return { created: created.id, found: found!.id, missing: missing === undefined };
			},
		});
		expect(both.effect).toEqual(both.pi);
		const { created } = both.effect.result as { created: number };
		expect(both.effect.result).toEqual({ created, found: created, missing: true });
		expect(both.effect.records.conversations).toEqual([{ id: created }]);
		expect(both.effect.records.entries.map((entry) => entry.conversationId)).toEqual([created, created]);
	});

	it("inspect, submission, waitForIdle and usage read the same live work and totals", async () => {
		let held = heldAnswer("Done.");
		const both = await runBoth({
			responses: () => {
				held = heldAnswer("Done.");
				return [held.response];
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submitted = yield* root.submit({ type: "input", content: "Go.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				const busy = yield* Harness.inspect;
				const reacquired = Option.getOrThrow(yield* Harness.submission(submitted.id));
				const missing = yield* Harness.submission(MISSING_SUBMISSION);
				held.release();
				yield* Harness.waitForIdle;
				return {
					busy,
					missing: Option.isNone(missing),
					settled: yield* reacquired.status,
					idle: yield* Harness.inspect,
					usage: yield* Harness.usage,
				};
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const submitted = await root.submit({ type: "input", content: "Go.", requestId: "a" }, context);
				await held.requested;
				const busy = await harness.inspect(context);
				const reacquired = await harness.submission(submitted.id, context);
				const missing = await harness.submission(MISSING_SUBMISSION, context);
				held.release();
				await harness.waitForIdle(context);
				return {
					busy,
					missing: missing === undefined,
					settled: await reacquired!.status(context),
					idle: await harness.inspect(context),
					usage: await harness.usage(context),
				};
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toMatchObject({
			busy: {
				scheduling: "running",
				tasks: [{ record: { kind: "pi.generation" }, state: { kind: "running" } }],
				submissions: [{ requestId: "a", status: "placed" }],
			},
			missing: true,
			settled: { requestId: "a", status: "done" },
			idle: { scheduling: "running", tasks: [], submissions: [] },
			usage: { models: { "faux/faux-1": { output: 2 } }, tools: {} },
		});
	});
});

describe("parity with Pi Durable: tasks and submissions by id", () => {
	it("getTask, abortTask and waitForTask follow a task from running to aborted", async () => {
		let held = heldAnswer("Never read.");
		const both = await runBoth({
			responses: () => {
				held = heldAnswer("Never read.");
				return [held.response];
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.submit({ type: "input", content: "Long task.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				const id = generation(yield* Harness.inspect);
				const running = Option.getOrThrow(yield* Harness.getTask(id));
				const missing = yield* Harness.getTask(MISSING_TASK);
				const marked = yield* Harness.abortTask(id);
				const settled = yield* Harness.waitForTask(id);
				const again = yield* Harness.abortTask(id);
				return { running, missing: Option.isNone(missing), marked, settled, again };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await root.submit({ type: "input", content: "Long task.", requestId: "a" }, context);
				await held.requested;
				const id = generation(await harness.inspect(context));
				const running = await harness.getTask(id, context);
				const missing = await harness.getTask(MISSING_TASK, context);
				const marked = await harness.abortTask(id, context);
				const settled = await harness.waitForTask(id, context);
				const again = await harness.abortTask(id, context);
				return { running, missing: missing === undefined, marked, settled, again };
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toMatchObject({
			running: { kind: "pi.generation", abortRequested: false, state: { status: "running" } },
			missing: true,
			marked: "marked",
			settled: {
				kind: "pi.generation",
				abortRequested: true,
				state: { status: "terminal", outcome: { status: "aborted" } },
			},
			again: "terminal",
		});
		expect(both.effect.records.submissions).toEqual([
			expect.objectContaining({ requestId: "a", status: "unanswered", reason: "aborted" }),
		]);
	});

	it("abortSubmission withdraws a queued submission and says what it found otherwise", async () => {
		let held = heldAnswer("Done.");
		const both = await runBoth({
			responses: () => {
				held = heldAnswer("Done.");
				return [held.response];
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const first = yield* root.submit({ type: "input", content: "Long task.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				const second = yield* root.submit({ type: "input", content: "Also this.", requestId: "b" });
				const results = {
					elsewhere: yield* Harness.abortSubmission(second.id, MISSING_CONVERSATION),
					queued: yield* Harness.abortSubmission(second.id, root.id),
					placed: yield* Harness.abortSubmission(first.id),
					again: yield* Harness.abortSubmission(second.id),
					missing: yield* Harness.abortSubmission(MISSING_SUBMISSION),
				};
				held.release();
				return results;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const first = await root.submit({ type: "input", content: "Long task.", requestId: "a" }, context);
				await held.requested;
				const second = await root.submit({ type: "input", content: "Also this.", requestId: "b" }, context);
				const results = {
					elsewhere: await harness.abortSubmission(second.id, context, MISSING_CONVERSATION),
					queued: await harness.abortSubmission(second.id, context, root.id),
					placed: await harness.abortSubmission(first.id, context),
					again: await harness.abortSubmission(second.id, context),
					missing: await harness.abortSubmission(MISSING_SUBMISSION, context),
				};
				held.release();
				return results;
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toEqual({
			elsewhere: "not_found",
			queued: "aborted",
			placed: "already_placed",
			again: "settled",
			missing: "not_found",
		});
		expect(both.effect.records.submissions.map((submission) => [submission.requestId, submission.status])).toEqual([
			["a", "done"],
			["b", "unanswered"],
		]);
	});
});

describe("lifecycle", () => {
	it("closes the harness and its storage once when the scope closes", async () => {
		const kept = new KeptStorage();
		const harness = await Effect.runPromise(
			Harness.Harness.use((opened) => Effect.as(Harness.root, opened)).pipe(
				Effect.provide(harnessLayer({ storage: Storage.custom(kept) })),
			),
		);
		expect(await harness.closed).toEqual({ kind: "closed" });
		expect(kept.closes).toBe(1);
	});

	it("resumes a pending submission when it reopens the same storage", async () => {
		const result = await reopenWithPendingSubmission(Storage.custom(new KeptStorage()), {});
		expect(result.unprompted).toMatchObject({ requestId: "pending", status: "done" });
		expect(result.settled).toEqual(result.unprompted);
		expect([result.firstCalls, result.secondCalls]).toEqual([1, 1]);
	});

	it("leaves pending work alone with resume off, until a call asks for progress", async () => {
		const result = await reopenWithPendingSubmission(Storage.custom(new KeptStorage()), { resume: false });
		expect(result.unprompted).toMatchObject({ requestId: "pending", status: "placed" });
		expect(result.settled).toMatchObject({ requestId: "pending", status: "done" });
		expect([result.firstCalls, result.secondCalls]).toEqual([1, 1]);
	});

	it("opens read-only: reads work, and a write fails with ReadOnlySession", async () => {
		const kept = new KeptStorage();
		const storage = Storage.custom(kept);
		await Effect.runPromise(
			Effect.flatMap(Harness.rootWith({ agent: AGENT }), (root) => root.prompt("Hi.")).pipe(
				Effect.tap(Harness.waitForIdle),
				Effect.provide(harnessLayer({ responses: [answer("Hello.")], storage })),
			),
		);
		const viewed = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.root;
				return {
					entries: yield* Stream.runCollect(root.entries({ order: "ascending" })),
					submit: yield* Effect.flip(root.submit({ type: "input", content: "More." })),
					configure: yield* Effect.flip(root.configure({ instructions: "Be brief." })),
					waitForIdle: yield* Effect.flip(Harness.waitForIdle),
				};
			}).pipe(Effect.provide(harnessLayer({ storage, harness: { readOnly: true } }))),
		);
		expect(viewed.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(viewed.submit).toBeInstanceOf(ReadOnlySession);
		expect([viewed.submit._tag, viewed.configure._tag, viewed.waitForIdle._tag]).toEqual([
			"ReadOnlySession",
			"ReadOnlySession",
			"ReadOnlySession",
		]);
		expect(viewed.configure.message).toContain("Read-only Harness");
	});
});

describe("reports", () => {
	const Failing = Hook.afterResponse(() => Effect.fail(new Error("the prompt said: launch codes 0000")));
	const failing = Registry.layer([Extension.make({ name: "app", hooks: [Failing] })]);

	it("gives every report of Pi to each subscriber, whole", async () => {
		const collected = await runTest(
			Effect.gen(function* () {
				// Started at once, each has subscribed when its fork returns.
				const first = yield* Effect.forkChild(Stream.runCollect(Stream.take(Harness.reports, 1)), {
					startImmediately: true,
				});
				const second = yield* Effect.forkChild(Stream.runCollect(Stream.take(Harness.reports, 1)), {
					startImmediately: true,
				});
				const root = yield* Harness.rootWith({ agent: AGENT });
				const settled = yield* root.prompt("Hi.");
				return { settled: settled.status, first: yield* Fiber.join(first), second: yield* Fiber.join(second) };
			}).pipe(Effect.provide(harnessLayer({ responses: [answer("Hello.")], registry: failing }))),
		);
		expect(collected.settled).toBe("done");
		expect(collected.first).toHaveLength(1);
		const report = collected.first[0] as Report;
		expect(report).toMatchObject({
			kind: "extension_error",
			extension: "app",
			task: { kind: "pi.generation", conversationId: 1 },
		});
		expect(report.error).toMatchObject({ message: "the prompt said: launch codes 0000" });
		expect(collected.second[0]).toBe(report);
	});

	it("logs each report at its level to the logger the Layer was built with, without the error's message", async () => {
		const lines: Array<{ readonly level: string; readonly message: unknown; readonly annotations: unknown }> = [];
		const capture = Logger.make((options) => {
			lines.push({
				level: options.logLevel,
				message: options.message,
				annotations: options.fiber.getRef(References.CurrentLogAnnotations),
			});
		});
		await runTest(
			Effect.gen(function* () {
				// The layer logs a report when Pi hands it on, before a subscriber gets it.
				const reported = yield* Effect.forkChild(Stream.runHead(Harness.reports), { startImmediately: true });
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("Hi.");
				yield* Fiber.join(reported);
			}).pipe(
				Effect.provide(harnessLayer({ responses: [answer("Hello.")], registry: failing })),
				Effect.provide(Logger.layer([capture])),
			),
		);
		expect(lines).toEqual([
			{
				level: "Warn",
				message: ["Pi Durable reported extension_error"],
				annotations: {
					report: "extension_error",
					taskId: expect.any(Number),
					taskKind: "pi.generation",
					conversationId: 1,
					extension: "app",
					error: "Error",
				},
			},
		]);
		expect(JSON.stringify(lines)).not.toContain("launch codes");
	});

	it("ends when the harness closes", async () => {
		const reports = await runTest(
			Effect.gen(function* () {
				return yield* Effect.forkDetach(Stream.runCollect(Harness.reports), { startImmediately: true });
			}).pipe(
				Effect.provide(harnessLayer({})),
				Effect.flatMap((collecting) => Fiber.join(collecting)),
			),
		);
		expect(reports).toEqual([]);
	});
});

describe("the wake seam for hosts", () => {
	it("gives Pi's onWake values in order with the option, and the current value as `wake`", async () => {
		const outcome = await runTest(
			Effect.gen(function* () {
				const seen: Array<Wake | "prompt"> = [];
				// Each wake the consumer took, so the test waits for the ones it expects.
				const taken = yield* Queue.unbounded<Wake>();
				const { watching, wake } = yield* Effect.gen(function* () {
					const watching = yield* Effect.forkDetach(
						Stream.runForEach(Harness.wakes, (wake) =>
							Effect.andThen(
								Effect.sync(() => seen.push(wake)),
								Queue.offer(taken, wake),
							),
						),
					);
					yield* Queue.takeN(taken, 2);
					const root = yield* Harness.rootWith({ agent: AGENT });
					seen.push("prompt");
					yield* root.prompt("Hi.");
					yield* root.waitForIdle;
					// Pi gives the idle value after the run's last commit, which can be after the wait returned.
					yield* Queue.takeN(taken, 2);
					return { watching, wake: yield* Harness.wake };
				}).pipe(Effect.provide(harnessLayer({ responses: [answer("Hello.")], harness: { hostWakes: true } })));
				// The stream ends when the harness closes, after every value Pi gave: `seen` is all of them.
				yield* Fiber.join(watching);
				return { seen, wake };
			}),
		);
		expect(outcome.seen).toEqual([
			{ active: true },
			{ active: false },
			"prompt",
			{ active: true },
			{ active: false },
		]);
		expect(outcome.wake).toEqual({ active: false });
	});

	it("has no element without the option", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const collecting = yield* Effect.forkDetach(Stream.runCollect(Harness.wakes));
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.prompt("Hi.");
				return collecting;
			}).pipe(
				Effect.provide(harnessLayer({ responses: [answer("Hello.")] })),
				Effect.flatMap((collecting) => Fiber.join(collecting)),
			),
		);
		expect(seen).toEqual([]);
	});

	it("leaves a due sleep to the host: nothing runs until `resume`", async () => {
		const Deadline = Signal.make("harness.deadline", 1, Schema.Struct({}));
		const Timed = Hook.beforeTool((call, api) =>
			Effect.gen(function* () {
				const until = yield* api.memo("timed.until", (yield* api.now) + 30);
				const state = yield* api.readSignal(Deadline, call.id);
				return Option.isNone(state) ? Gate.park({ signals: [Deadline.key(call.id)], until }) : Gate.allow;
			}),
		);
		const Noop = Tool.make("noop", {
			description: "Does nothing.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.succeed("ran"),
		});
		const outcome = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go." });
				const parked = (yield* Stream.runCollect(
					Stream.take(
						Stream.filter(Harness.wakes, (wake) => wake.at !== undefined),
						1,
					),
				))[0] as Wake;
				// Past the deadline: with Pi's own timer the call would have woken by now.
				yield* TestClock.adjust("80 millis");
				const before = (yield* submission.status).status;
				const due = yield* Harness.wake;
				yield* Harness.resume;
				const after = (yield* submission.wait).status;
				return { armedAt: typeof parked.at, due, before, after };
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [toolCall("noop", {}), answer("Done.")],
						registry: Registry.layer([Extension.make({ name: "app", tools: [Noop], hooks: [Timed] })]),
						harness: { hostWakes: true },
					}),
				),
			),
		);
		// Once the sleep is due, Pi says a process is needed now; the host's alarm is what calls `resume`.
		expect(outcome).toEqual({ armedAt: "number", due: { active: true }, before: "placed", after: "done" });
	});

	it("resume fails with ReadOnlySession on a read-only harness", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(Harness.resume).pipe(Effect.provide(harnessLayer({ harness: { readOnly: true } }))),
		);
		expect(failure._tag).toBe("ReadOnlySession");
	});
});

describe("usageEvents", () => {
	it("is one element per commit that changed the ledger: an answer, and a failed attempt too", async () => {
		const outcome = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				// The first element is the ledger at attachment: every later commit is an element.
				const attached = yield* Latch.make();
				const collecting = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(Harness.usageEvents(root.id), () => attached.open),
							3,
						),
					),
				);
				yield* attached.await;
				const answered = yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const failed = yield* root.prompt("Again.");
				yield* root.waitForIdle;
				return {
					statuses: [answered.status, failed.status, failed.reason],
					events: yield* Fiber.join(collecting),
					total: yield* Harness.usage,
				};
			}).pipe(
				Effect.provide(
					harnessLayer({
						responses: [
							answer("Hello."),
							fauxAssistantMessage([fauxText("partial")], { stopReason: "error", errorMessage: "overloaded" }),
						],
						// One attempt per run: Pi's retries would sleep.
						harness: { settings: { retry: { enabled: false } } },
					}),
				),
			),
		);
		expect(outcome.statuses).toEqual(["done", "unanswered", "model_error"]);
		const [attached, answer1, failure] = outcome.events;
		expect(attached).toEqual({ value: { models: {}, tools: {} }, ops: [], retired: false });
		const key = Object.keys(answer1?.value.models ?? {})[0] as string;
		// The first use of a model sets its whole entry; later ones set the counters that changed.
		expect(answer1?.ops).toEqual([["s", ["models", key], answer1?.value.models[key]]]);
		expect(failure?.ops.every((op) => op[0] === "s" && op[1][0] === "models" && op[1][1] === key)).toBe(true);
		expect(failure?.ops.length).toBeGreaterThan(0);
		expect(failure?.value.models[key]?.output).toBeGreaterThan(answer1?.value.models[key]?.output ?? 0);
		expect(failure?.value).toEqual(outcome.total);
	});

	it("has no element for a conversation that does not exist", async () => {
		const events = await Effect.runPromise(
			Stream.runCollect(Harness.usageEvents(MISSING_CONVERSATION)).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(events).toEqual([]);
	});
});

describe("taskGraph", () => {
	it("starts with the live tasks now and shows a run's generation task", async () => {
		const changes = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const attached = yield* Latch.make();
				const collecting = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(Harness.taskGraph, () => attached.open),
							2,
						),
					),
				);
				yield* attached.await;
				yield* root.prompt("Hi.");
				return yield* Fiber.join(collecting);
			}).pipe(Effect.provide(harnessLayer({ responses: [answer("Hello.")] }))),
		);
		expect(changes[0]).toEqual({ value: { tasks: {} }, ops: [], retired: false });
		expect(Object.values(changes[1]?.value.tasks ?? {})).toMatchObject([
			{ kind: "pi.generation", conversationId: 1 },
		]);
	});
});

describe("host options", () => {
	class Defaults extends Context.Service<Defaults, { readonly owner: string }>()("test/Defaults") {}

	const Owner = Doc.make({
		kind: "app.owner",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		schema: Schema.Struct({ owner: Schema.String }),
		initial: () => ({ owner: "nobody" }),
		checkpointWhen: () => false,
	});

	const created: Harness.Options<Defaults> = {
		conversationCreated: (tx, conversation) =>
			Effect.gen(function* () {
				const { owner } = yield* Defaults;
				yield* (yield* tx.doc(Owner, conversation.id)).set({ owner });
			}),
	};

	type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

	it("layerOn opens on a registry given as a value, without the Registry service", async () => {
		const registry = createRegistry();
		const live = Harness.layerOn(registry);
		const requires: Equal<
			typeof live,
			Layer.Layer<Harness.Harness, DurableError, Storage.HarnessStorage | Models>
		> = true;
		expect(requires).toBe(true);
		const root = await Effect.runPromise(
			Effect.map(Harness.rootWith({ agent: AGENT }), (conversation) => conversation.id).pipe(
				Effect.provide(live),
				Effect.provide(Storage.memory),
				Effect.provide(scriptedModels([]).layer),
			),
		);
		expect(root).toBeDefined();
	});

	it("conversationCreated runs as an Effect in every creating commit, with a service the Layer requires", async () => {
		const live = Harness.layer(created);
		const requires: Equal<
			typeof live,
			Layer.Layer<Harness.Harness, DurableError, Storage.HarnessStorage | Models | Registry.Registry | Defaults>
		> = true;
		expect(requires).toBe(true);
		const owners = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const other = yield* Harness.createConversation({ ownership: { kind: "ownerless" } });
				const raw = yield* Harness.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }));
				return yield* Effect.forEach([root.id, other.id, raw.id], (id) =>
					Effect.map(Harness.snapshot(Owner, id), Option.getOrUndefined),
				);
			}).pipe(Effect.provide(harnessLayer({ harness: created })), Effect.provideService(Defaults, { owner: "ana" })),
		);
		expect(owners).toEqual([{ owner: "ana" }, { owner: "ana" }, { owner: "ana" }]);
	});

	it("a failing conversationCreated fails the creating commit, and no conversation is stored", async () => {
		const refused = new Error("no more conversations");
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const failure = yield* Effect.flip(Harness.createConversation({ ownership: { kind: "ownerless" } }));
				return { failure, conversations: (yield* Harness.commit((tx) => tx.scanConversations({}, 10))).items };
			}).pipe(Effect.provide(harnessLayer({ harness: { conversationCreated: () => Effect.fail(refused) } }))),
		);
		expect(outcome.failure).toMatchObject({ _tag: "UnexpectedError", cause: refused });
		expect(outcome.conversations).toEqual([]);
	});

	it("passes telemetry, identity and env on to Pi unchanged", async () => {
		const open = vi.spyOn(PiHarness, "open");
		const options = {
			telemetry: BACKGROUND_CONTEXT.telemetry,
			identity: { attribution: null },
			env: () => undefined,
		} satisfies Harness.Options;
		await Effect.runPromise(Effect.asVoid(Harness.root).pipe(Effect.provide(harnessLayer({ harness: options }))));
		const given = open.mock.calls[0]?.[1];
		open.mockRestore();
		expect(given?.identity).toBe(options.identity);
		expect(given?.env).toBe(options.env);
		expect(given?.telemetry).toBe(options.telemetry);
		expect(Object.hasOwn(given ?? {}, "onWake")).toBe(false);
		expect(Object.hasOwn(given ?? {}, "conversationCreated")).toBe(false);
	});
});

describe("getTaskOf and waitForTaskOf", () => {
	const AT = new Date("2026-11-25T00:00:00.000Z");
	const released = Promise.withResolvers<void>();
	const Stamp = Task.make({
		name: "test.stamp",
		version: 1,
		input: Schema.Struct({ label: Schema.String }),
		state: Schema.Struct({ phase: Schema.Literal("stamp") }),
		result: Schema.Struct({ label: Schema.String, at: Schema.Date }),
		initial: () => ({ phase: "stamp" as const }),
		phases: {
			stamp: (task) =>
				Effect.as(
					Effect.promise(() => released.promise),
					task.input.label === "bad"
						? Task.fail({ message: "a bad label" }, { label: "bad", at: AT })
						: Task.complete({ label: task.input.label, at: AT }),
				),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	const Other = Task.make({
		name: "test.other",
		version: 1,
		input: Schema.Null,
		state: Schema.Struct({ phase: Schema.Literal("only") }),
		result: Schema.Number,
		initial: () => ({ phase: "only" as const }),
		phases: { only: () => Effect.succeed(Task.complete(1)) },
		abort: () => Effect.succeed(Task.aborted()),
	});

	it("decode the result with the task's schema, where the untyped reads give the stored JSON", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const [good, bad] = yield* root.commit((tx) =>
					Effect.all([
						tx.createTask(Stamp, { label: "good" }, { ownership: { kind: "conversation" } }),
						tx.createTask(Stamp, { label: "bad" }, { ownership: { kind: "conversation" } }),
					]),
				);
				const live = Option.getOrThrow(yield* Harness.getTaskOf(Stamp, good));
				released.resolve();
				const typed = yield* Harness.waitForTaskOf(Stamp, good);
				const stored = yield* Harness.waitForTask(good);
				const failed = yield* Harness.waitForTaskOf(Stamp, bad);
				const read = Option.getOrThrow(yield* Harness.getTaskOf(Stamp, good));
				const missing = yield* Harness.getTaskOf(Stamp, MISSING_TASK);
				// Another task's schema does not fit the stored result.
				const mismatch = yield* Effect.flip(Harness.waitForTaskOf(Other, good));
				return {
					live: live.state.status,
					typed: [typed.kind, typed.input, typed.state],
					stored: stored.state,
					failed: failed.state,
					read: read.state,
					missing: Option.isNone(missing),
					mismatch: mismatch._tag,
				};
			}).pipe(
				Effect.provide(
					harnessLayer({ registry: Registry.layer([Extension.make({ name: "app", tasks: [Stamp, Other] })]) }),
				),
			),
		);
		const completed = { status: "terminal", outcome: { status: "completed", result: { label: "good", at: AT } } };
		expect(seen).toEqual({
			live: "running",
			typed: ["test.stamp", { label: "good" }, completed],
			stored: {
				status: "terminal",
				outcome: { status: "completed", result: { label: "good", at: AT.toISOString() } },
			},
			failed: {
				status: "terminal",
				outcome: { status: "failed", error: { message: "a bad label" }, result: { label: "bad", at: AT } },
			},
			read: completed,
			missing: true,
			mismatch: "SchemaDecodeError",
		});
	});
});

describe("commits", () => {
	it("is Pi's observeCommits as a stream: the same publications, in order, each with what its commit stored", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const own: CommitPublication[] = [];
				const elements: Watch.Commit[] = [];
				const { collecting, root } = yield* Effect.gen(function* () {
					const root = yield* Harness.rootWith({ agent: AGENT });
					const pi = yield* Harness.Harness;
					pi.observeCommits({ advance: (publication) => void own.push(publication), end: () => {} });
					// Started at once, the stream has attached when its fork returns.
					const collecting = yield* Effect.forkDetach(
						Stream.runForEach(Harness.commits, (element) => Effect.sync(() => elements.push(element))),
						{ startImmediately: true },
					);
					yield* root.prompt("Hi.");
					yield* root.waitForIdle;
					return { collecting, root: root.id };
				}).pipe(Effect.provide(harnessLayer({ responses: [answer("Hello.")] })));
				// The harness closed, which ends the stream after every publication: both observers saw all of them.
				yield* Fiber.await(collecting);
				return { own, elements, root };
			}),
		);
		expect(seen.elements.length).toBeGreaterThan(1);
		expect(seen.elements).toHaveLength(seen.own.length);
		// The very objects Pi published: nothing is copied.
		expect(seen.elements.every((element, index) => element === seen.own[index])).toBe(true);
		const seqs = seen.elements.map((element) => element.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		const changes = seen.elements.flatMap((element) => element.changes);
		expect(changes.flatMap((change) => (change.type === "entry" ? [change.value.kind] : []))).toEqual([
			"pi.user",
			"pi.assistant",
		]);
		expect(changes.flatMap((change) => (change.type === "submission" ? [change.value.status] : []))).toContain(
			"done",
		);
		expect(
			changes.some(
				(change) =>
					change.type === "document" &&
					change.kind === "change" &&
					change.record.kind === "pi.usage" &&
					change.conversationId === seen.root,
			),
		).toBe(true);
	});

	it("has no element for a commit that wrote nothing, nor for one stored before the stream ran", async () => {
		const elements = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.configure({ instructions: "Before." });
				const collecting = yield* Effect.forkChild(Stream.runCollect(Stream.take(Harness.commits, 1)), {
					startImmediately: true,
				});
				// Commits that only read: scans, a record, an empty body. Pi hands on publications in commit order.
				yield* Stream.runCollect(Harness.scanConversations());
				yield* root.record;
				yield* Harness.commit(() => Effect.void);
				yield* root.configure({ instructions: "After." });
				return yield* Fiber.join(collecting);
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(elements).toHaveLength(1);
		expect(elements[0]?.changes).toMatchObject([
			{ type: "document", kind: "change", record: { kind: "pi.agent" }, value: { instructions: "After." } },
		]);
	});

	it("fails with Pi's session closed when the harness closes", async () => {
		const exit = await runTest(
			Effect.gen(function* () {
				return yield* Effect.forkDetach(Stream.runCollect(Harness.commits), { startImmediately: true });
			}).pipe(
				Effect.provide(harnessLayer({})),
				Effect.flatMap((collecting) => Fiber.await(collecting)),
			),
		);
		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
			_tag: "UnexpectedError",
			message: "session closed",
		});
	});
});

describe("signalState", () => {
	const Approval = Signal.make("test.outside", 1, Schema.Struct({ allow: Schema.Boolean, at: Schema.Date }));
	const AT = new Date("2026-11-25T00:00:00.000Z");
	const seenInside: Array<unknown> = [];
	const Gated = Extension.make({
		name: "gated",
		tools: [
			Tool.make("write", {
				description: "Writes.",
				parameters: Schema.Struct({}),
				success: Schema.String,
				handler: () => Effect.succeed("written"),
			}),
		],
		hooks: [
			Hook.beforeTool((call, api) =>
				Effect.gen(function* () {
					const state = yield* api.readSignal(Approval, call.id);
					if (Option.isNone(state)) return Gate.park({ signals: [Approval.key(call.id)] });
					seenInside.push(state.value);
					return Gate.allow;
				}),
			),
		],
	});

	it("reads from outside what the task's own readSignal reads: none, then the value delivered, none once it ended", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Write." });
				const parked = yield* Effect.repeat(
					Effect.map(Harness.inspect, ({ tasks }) => tasks.find((task) => task.record.kind === "pi.tool")),
					{ until: (task) => task?.state.kind === "sleeping", schedule: Schedule.spaced("5 millis") },
				);
				const call = parked!.record.id;
				const before = yield* Harness.signalState(call, Approval, "call-1");
				yield* Harness.signal(call, Approval, "call-1", { allow: true, at: AT });
				const delivered = yield* Harness.signalState(call, Approval, "call-1");
				const other = yield* Harness.signalState(call, Approval, "call-2");
				yield* submission.wait;
				yield* root.waitForIdle;
				return {
					before,
					delivered,
					other,
					ended: yield* Harness.signalState(call, Approval, "call-1"),
					missing: yield* Harness.signalState(MISSING_TASK, Approval, "call-1"),
				};
			}).pipe(
				Effect.provide(
					harnessLayer({
						registry: Registry.layer([Gated]),
						responses: [toolCall("write", {}, { id: "call-1" }), answer("Written.")],
					}),
				),
			),
		);
		expect(Option.isNone(seen.before)).toBe(true);
		expect(Option.getOrThrow(seen.delivered)).toEqual({ kind: "value", value: { allow: true, at: AT } });
		// Decoded as inside the task: the date is a Date again.
		expect(seenInside).toEqual([Option.getOrThrow(seen.delivered)]);
		expect([Option.isNone(seen.other), Option.isNone(seen.ended), Option.isNone(seen.missing)]).toEqual([
			true,
			true,
			true,
		]);
	});
});

describe("synchronous observers", () => {
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

	it("observeDoc gives the document now, then every commit that changed it, unfolded", async () => {
		const changes = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				// An address without a document has nothing to observe: the first commit creates it.
				yield* root.commit((tx) =>
					Effect.flatMap(tx.doc(Progress, root.id), (progress) => progress.set({ done: [] })),
				);
				const attached = yield* Latch.make();
				const collecting = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(Harness.observeDoc(Progress, root.id), () => attached.open),
							3,
						),
					),
				);
				yield* attached.await;
				for (const done of [["a"], ["a", "b"]]) {
					yield* root.commit((tx) =>
						Effect.flatMap(tx.doc(Progress, root.id), (progress) => progress.set({ done })),
					);
				}
				return yield* Fiber.join(collecting);
			}).pipe(Effect.provide(harnessLayer({ registry: Registry.layer([]) }))),
		);
		expect(changes.map((change) => change.value)).toEqual([{ done: [] }, { done: ["a"] }, { done: ["a", "b"] }]);
	});

	it("observeConversation gives the view now and each change; observeTaskGraph the task graph", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const attached = yield* Latch.make();
				const views = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.takeUntil(
							Stream.tap(Harness.observeConversation(root.id), () => attached.open),
							(change) => change.value.entries.some((entry) => entry.kind === "pi.assistant"),
						),
					),
				);
				yield* attached.await;
				const graph = yield* Stream.runHead(Harness.observeTaskGraph);
				yield* root.prompt("Hi.");
				return { views: yield* Fiber.join(views), graph };
			}).pipe(Effect.provide(harnessLayer({ responses: [answer("Hello.")] }))),
		);
		expect(seen.views[0]?.value.entries).toEqual([]);
		expect(seen.views.at(-1)?.value.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(Option.map(seen.graph, (change) => change.value)).toEqual(Option.some({ tasks: {} }));
	});

	it("observeConversation fails for a conversation that does not exist, as Pi rejects", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(Stream.runCollect(Harness.observeConversation(MISSING_CONVERSATION))).pipe(
				Effect.provide(harnessLayer({})),
			),
		);
		expect([failure._tag, failure.message]).toEqual(["UnexpectedError", "Conversation 999 does not exist"]);
	});

	it("closing and closed succeed when the Layer's scope closes the harness", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const context = yield* Layer.buildWithScope(harnessLayer({}), scope);
				const closing = yield* Effect.forkChild(Effect.provide(Harness.closing, context), {
					startImmediately: true,
				});
				const closed = yield* Effect.forkChild(Effect.provide(Harness.closed, context), { startImmediately: true });
				const before = closing.pollUnsafe() === undefined && closed.pollUnsafe() === undefined;
				yield* Scope.close(scope, Exit.void);
				return { before, closing: yield* Fiber.join(closing), closed: yield* Fiber.join(closed) };
			}),
		);
		expect(seen).toEqual({ before: true, closing: undefined, closed: { kind: "closed" } });
	});
});
