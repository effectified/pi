// The examples of README.md as tests. The quick start, from `Records` to `live`, and the code under each "README:"
// comment are the README's, line for line; only the imports differ (the README names the package, this file its
// sources).

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type AssistantMessage, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, Report, TaskId, Wake } from "@earendil-works/pi-durable";
import { Models } from "@gunta/pi-ai-effect";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Context, Effect, Fiber, Latch, Layer, Option, Queue, Schedule, Schema, Stream } from "effect";
import { Tool as AiTool, Toolkit } from "effect/ai";
import { describe, expect, it } from "vitest";
import {
	BuiltinDoc,
	type Conversation,
	Doc,
	Entry,
	Extension,
	Gate,
	Harness,
	Hook,
	ParentContext,
	Registry,
	Signal,
	Storage,
	Task,
	Tool,
} from "../src/index.ts";
import { answer, held, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";

// A service of your program. Handlers reach it through the Layer you provide.
class Records extends Context.Service<
	Records,
	{ readonly get: (id: string) => Effect.Effect<{ readonly title: string }> }
>()("app/Records") {}

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	replay: "safe",
	handler: ({ id }) => Records.use((records) => records.get(id)), // Effect<{ title }, never, Records>
});

const NoWrites = Hook.beforeTool((call) =>
	Effect.succeed(call.name.startsWith("write") ? Gate.block("read only") : Gate.allow),
);

const App = Extension.make({ name: "app", tools: [Lookup], hooks: [NoWrites] });

const program = Effect.gen(function* () {
	// No provider and no key: the model answers with these turns, in order.
	yield* ScriptedModels.use((models) =>
		models.setResponses([
			toolCall("lookup", { id: "42" }),
			answer("Record 42 is titled Answer."),
			answer("Record 42 is not titled Answer."),
		]),
	);
	// A conversation answers with the model its agent names.
	const root = yield* Harness.rootWith({ agent: yield* TestHarness.agent });
	yield* root.prompt("Summarise record 42.", { requestId: "summary-42" });
	yield* root.waitForIdle;
	// Fork at the newest entry: the branch sees the summary and continues alone.
	const head = Option.getOrThrow(yield* root.head);
	const branch = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
	const settled = yield* branch.prompt("Now argue the opposite.", { requestId: "opposite-42" });
	yield* branch.waitForIdle;
	const entries = yield* Stream.runCollect(branch.entries({ order: "ascending" }));
	return { settled, kinds: entries.map((entry) => entry.kind) };
});

const live = Harness.layer().pipe(
	// Does not type check until `Records`, which the lookup tool needs, is provided below.
	Layer.provide(Registry.layer([App])),
	Layer.provide(Storage.memory),
	Layer.provideMerge(ScriptedModels.layer()),
	Layer.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
);

describe("the quick start of the README", () => {
	it("runs: a prompt with a tool call, a fork at the head, and a prompt on the fork", async () => {
		const { settled, kinds } = await Effect.runPromise(Effect.provide(program, live));
		expect(settled).toMatchObject({ requestId: "opposite-42", status: "done" });
		expect(kinds).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
			"pi.user",
			"pi.assistant",
		]);
	});
});

// README: Commits.
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
const Note = Entry.make("app.note", Schema.Struct({ text: Schema.String, at: Schema.Date }));

class TooMany extends Schema.TaggedError<TooMany>()("TooMany", { max: Schema.Number }) {}

const addTodo = (item: string, at: Date) =>
	Effect.gen(function* () {
		const root = yield* Harness.root;
		return yield* root.commit((tx) =>
			Effect.gen(function* () {
				const todos = yield* tx.doc(Todos, root.id);
				const { items } = yield* todos.get;
				// A failing body fails the commit with its own error, and nothing of it is stored.
				if (items.length >= 2) return yield* new TooMany({ max: 2 });
				yield* todos.set({ items: [...items, item] });
				const note = yield* tx.append(Note, root.id, { data: { text: `added ${item}`, at } });
				return note.id;
			}),
		);
	}); // Effect<EntryId, TooMany | DurableError | SchemaDecodeError, Harness>

describe("the commit example of the README", () => {
	it("stores a document and a typed entry together, and nothing when the body fails", async () => {
		const at = new Date("2026-11-24T00:00:00.000Z");
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* addTodo("write docs", at);
				yield* addTodo("ship", at);
				const failure = yield* Effect.flip(addTodo("one too many", at));
				const notes = yield* Stream.runCollect(Stream.mapEffect(root.entries({ order: "ascending" }), Note.read));
				return {
					failure: failure._tag,
					todos: Option.getOrThrow(yield* Harness.snapshot(Todos, root.id)),
					notes: notes.flatMap((note) => Option.toArray(note)).map((note) => note.data),
				};
			}).pipe(Effect.provide(TestHarness.layer())),
		);
		expect(outcome).toEqual({
			failure: "TooMany",
			todos: { items: ["write docs", "ship"] },
			notes: [
				{ text: "added write docs", at },
				{ text: "added ship", at },
			],
		});
	});
});

// A web search of your program, for the tool below.
class Web extends Context.Service<
	Web,
	{
		readonly search: (
			query: string,
		) => Effect.Effect<{ readonly hits: ReadonlyArray<{ readonly title: string; readonly url: string }> }>;
	}
>()("app/Web") {}

// README: Tool.
// The model reads the titles; a host reads the raw response from the stored result.
const Search = Tool.make("search", {
	description: "Search the web.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.Struct({ titles: Schema.Array(Schema.String) }),
	handler: ({ query }) =>
		Effect.map(
			Web.use((web) => web.search(query)),
			(raw) => Tool.result({ titles: raw.hits.map((hit) => hit.title) }, { details: raw }),
		),
});

// A subagent: a conversation owned by the call's task, created in its commit. A rerun finds the same child.
const Subagent = Tool.make("subagent", {
	description: "Delegate a self-contained task to a subagent and get its answer back.",
	parameters: Schema.Struct({ task: Schema.String }),
	success: Schema.String,
	replay: "safe",
	handler: ({ task }, api) =>
		Effect.gen(function* () {
			const child = yield* api.commit((tx) =>
				Effect.gen(function* () {
					const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// It starts as a copy of this conversation's agent; without the subagent tool itself.
					yield* tx.configure(created.id, { tools: { remove: ["subagent"] } });
					return created.id;
				}),
			);
			yield* api.details({ conversationId: child }); // lets a UI attach to the child
			const handle = Option.getOrThrow(yield* api.conversation(child));
			const submission = yield* handle.submit({ type: "input", content: task, requestId: `subagent:${api.taskId}` });
			const settled = yield* submission.wait;
			return settled.status === "done" ? "The subagent answered." : Tool.error(`No answer: ${settled.reason}`);
		}),
});

describe("the tool examples of the README", () => {
	/** The tool results of the root conversation: what the model reads, and the details stored beside it. */
	const toolResults = Effect.gen(function* () {
		const root = yield* Harness.root;
		const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
		return entries.flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === "toolResult"
				? [{ content: message.content, details: message.details as unknown }]
				: [];
		});
	});

	it("search gives the model the titles and keeps the raw response in details", async () => {
		const raw = { hits: [{ title: "Effect", url: "https://effect.website" }] };
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Find Effect.");
				return yield* toolResults;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "web", tools: [Search] })],
						responses: [toolCall("search", { query: "effect" }), answer("Found it.")],
					}),
				),
				Effect.provide(Layer.succeed(Web, { search: () => Effect.succeed(raw) })),
			),
		);
		expect(results).toEqual([{ content: [{ type: "text", text: '{"titles":["Effect"]}' }], details: raw }]);
	});

	it("subagent creates a child without the subagent tool, and returns once it answered", async () => {
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Delegate.");
				const [result] = yield* toolResults;
				const child = (result?.details as { readonly conversationId: number }).conversationId;
				const conversation = Option.getOrThrow(yield* Harness.conversation(child as typeof root.id));
				return {
					content: result?.content,
					childTools: (yield* conversation.agent).tools.map((tool) => tool.name),
					rootTools: (yield* root.agent).tools.map((tool) => tool.name),
				};
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "agents", tools: [Subagent] })],
						responses: [
							toolCall("subagent", { task: "Count to three." }),
							answer("One, two, three."),
							answer("Done."),
						],
					}),
				),
			),
		);
		expect(outcome).toEqual({
			content: [{ type: "text", text: "The subagent answered." }],
			childTools: [],
			rootTools: ["subagent"],
		});
	});
});

describe("the agent example of the README", () => {
	it("restricts a conversation to the tools named, and null restores the host default", async () => {
		const offered = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const tools = Effect.map(root.agent, (agent) => agent.tools.map((tool) => tool.name));
				// README: Agent.
				// Exactly these two tools, whatever else the selected extensions bring.
				yield* root.configure({ tools: ["lookup", "read"] });
				const named = yield* tools;
				// Of those, the model is offered only `lookup`; a tool may still call `read`.
				yield* root.configure({ modelTools: [Lookup] });
				const model = yield* tools;
				yield* root.configure({ tools: null }); // back to the host default
				return { named, model, all: (yield* root.agent).callable.map((tool) => tool.name) };
			}).pipe(
				Effect.provide(TestHarness.layer({ extensions: [App, Extension.make({ name: "web", tools: [Search] })] })),
				Effect.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
				Effect.provide(Layer.succeed(Web, { search: () => Effect.succeed({ hits: [] }) })),
			),
		);
		// No tool named `read` is installed: its name is stored and offers nothing.
		expect(offered).toEqual({ named: ["lookup"], model: ["lookup"], all: ["lookup", "search"] });
	});
});

describe("the watch example of the README", () => {
	it("streams a conversation's view and a document, decoded", async () => {
		const outcome = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* addTodo("write docs", new Date(0));
				// README: Watches.
				// A UI: one conversation's transcript window and built-in documents (`pi.live`, `pi.inbox`, `pi.usage`).
				const answers = root.changes().pipe(
					Stream.map((change) => change.value.entries.filter((entry) => entry.kind === "pi.assistant").length),
					Stream.changes,
				);
				// One of your own documents, decoded.
				const counts = Stream.map(Harness.watchDoc(Todos, root.id), (change) => change.value.items.length);

				// Each stream's first element is the value at attachment: the changes below come after it.
				const attached = { answers: yield* Latch.make(), counts: yield* Latch.make() };
				const answered = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(answers, () => attached.answers.open),
							2,
						),
					),
				);
				const counted = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(counts, () => attached.counts.open),
							2,
						),
					),
				);
				yield* attached.answers.await;
				yield* attached.counts.await;
				yield* addTodo("ship", new Date(0));
				yield* root.prompt("Hi.");
				return { answers: yield* Fiber.join(answered), counts: yield* Fiber.join(counted) };
			}).pipe(Effect.provide(TestHarness.layer({ responses: [answer("Hello.")] }))),
		);
		expect(outcome).toEqual({ answers: [0, 1], counts: [1, 2] });
	});
});

// What a host does with a report and with a wake, for the example below.
class Alerts extends Context.Service<Alerts, { readonly send: (report: Report) => Effect.Effect<void> }>()(
	"app/Alerts",
) {}
class Alarm extends Context.Service<Alarm, { readonly arm: (wake: Wake) => Effect.Effect<void> }>()("app/Alarm") {}

describe("the host example of the README", () => {
	// README: Hosts.
	const host = Effect.gen(function* () {
		// Failures that fail no call: a throwing hook, a faulted task, the error that failed the harness. Started at once,
		// it has subscribed when the fork returns, so it misses no report of what comes after.
		yield* Effect.forkScoped(
			Stream.runForEach(Harness.reports, (report) => Alerts.use((alerts) => alerts.send(report))),
			{ startImmediately: true },
		);
		// The host owns the wake-ups: arm an alarm from each value, and resume when it fires.
		yield* Effect.forkScoped(Stream.runForEach(Harness.wakes, (wake) => Alarm.use((alarm) => alarm.arm(wake))));
	});
	const onAlarm = Harness.resume;

	const live = Harness.layer({
		hostWakes: true,
		// Runs in every commit that creates or forks a conversation.
		conversationCreated: (tx, conversation) => Effect.asVoid(tx.doc(Todos, conversation.id)),
	});

	it("hands reports and wakes to the host, and gives every conversation its documents", async () => {
		const Failing = Hook.afterResponse(() => Effect.fail(new Error("refused")));
		const seen = await runTest(
			Effect.gen(function* () {
				// What the host was handed, in order: the test takes as many as it expects, then what else is there.
				const alerted = yield* Queue.unbounded<Report>();
				const armed = yield* Queue.unbounded<Wake>();
				return yield* Effect.gen(function* () {
					yield* host;
					const root = yield* TestHarness.root;
					yield* root.prompt("Hi.");
					yield* onAlarm;
					const reports = yield* Queue.takeN(alerted, 1);
					// The values of the open, then of the run: Pi gives the last after the run's last commit.
					const wakes = yield* Queue.takeN(armed, 4);
					return {
						todos: Option.getOrUndefined(yield* Harness.snapshot(Todos, root.id)),
						reports: [...reports, ...(yield* Queue.clear(alerted))],
						wakes: [...wakes, ...(yield* Queue.clear(armed))],
					};
				}).pipe(
					Effect.scoped,
					Effect.provide(live),
					Effect.provide(Registry.layer([Extension.make({ name: "app", hooks: [Failing] })])),
					Effect.provide(Storage.memory),
					Effect.provide(
						Layer.effectDiscard(ScriptedModels.use((models) => models.setResponses([answer("Hello.")]))),
					),
					Effect.provide(ScriptedModels.layer({ api: "scripted" })),
					Effect.provide(Layer.succeed(Alerts, { send: (report) => Queue.offer(alerted, report) })),
					Effect.provide(Layer.succeed(Alarm, { arm: (wake) => Queue.offer(armed, wake) })),
				);
			}),
		);
		expect(seen.todos).toEqual({ items: [] });
		expect(seen.reports.map((report) => report.kind)).toEqual(["extension_error"]);
		expect(seen.wakes).toEqual([{ active: true }, { active: false }, { active: true }, { active: false }]);
	});

	it("bounds every Pi call of a program with a parent context", async () => {
		const program = Effect.flatMap(TestHarness.root, (root) =>
			root.waitForIdle.pipe(Effect.andThen(root.prompt("Hi."))),
		);
		// README: ParentContext.
		// Every Pi call of `program` is cancelled after thirty seconds, and fails with `Cancelled`.
		const deadline = withAbortSignal(AbortSignal.timeout(30_000), BACKGROUND_CONTEXT);
		const bounded = Effect.provideService(program, ParentContext, deadline);

		const settled = await Effect.runPromise(
			bounded.pipe(Effect.provide(TestHarness.layer({ responses: [answer("Hello.")] }))),
		);
		expect(settled.status).toBe("done");
		const expired = withAbortSignal(
			AbortSignal.abort(new DOMException("Too late", "TimeoutError")),
			BACKGROUND_CONTEXT,
		);
		const failure = await Effect.runPromise(
			Effect.flip(Effect.provideService(program, ParentContext, expired)).pipe(Effect.provide(TestHarness.layer())),
		);
		expect(failure._tag).toBe("Cancelled");
	});
});

// A bank of your program: what the payment task's `charge` phase needs.
class Bank extends Context.Service<Bank, { readonly charge: (card: string, key: string) => Effect.Effect<string> }>()(
	"app/Bank",
) {}

// README: Task.
// A payment: `charge` asks the bank, `confirm` completes with the receipt.
const Payment = Task.make({
	name: "app.payment",
	version: 1,
	input: Schema.Struct({ card: Schema.String }),
	// One member per phase. The `phase` picks the handler; the rest is what the phase needs to go on.
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("charge") }),
		Schema.Struct({ phase: Schema.Literal("confirm"), receipt: Schema.String }),
	]),
	result: Schema.Struct({ receipt: Schema.String }),
	initial: () => ({ phase: "charge" as const }),
	phases: {
		// Pi runs a phase again from its top after a crash: the charge is keyed by the task, so a repeat is harmless.
		charge: (task) =>
			Effect.map(
				Bank.use((bank) => bank.charge(task.input.card, `payment-${task.id}`)),
				(receipt) => Task.next({ phase: "confirm" as const, receipt }),
			),
		confirm: (task) => Effect.succeed(Task.complete({ receipt: task.state.receipt })),
	},
	// Runs instead of the phases after `Harness.abortTask`, and decides the outcome.
	abort: () => Effect.succeed(Task.aborted()),
});

// A checkout creates one payment per card as its children, in the commit that stores its wait for them.
const Checkout = Task.make({
	name: "app.checkout",
	version: 1,
	input: Schema.Struct({ cards: Schema.Array(Schema.String) }),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("pay") }),
		Schema.Struct({ phase: Schema.Literal("decide"), payments: Schema.Array(Task.Id) }),
	]),
	result: Schema.String,
	initial: () => ({ phase: "pay" as const }),
	phases: {
		pay: (task, api) =>
			api.commit((tx) =>
				Effect.gen(function* () {
					const payments = yield* Effect.forEach(task.input.cards, (card) =>
						tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }),
					);
					// Resume in `decide` once every payment ended; the first failure aborts the others.
					return Task.wait({ state: { phase: "decide" as const, payments }, on: payments, policy: "failFast" });
				}),
			),
		decide: (task, api) =>
			Effect.map(api.outcomesOf(Payment, task.state.payments), (outcomes) =>
				outcomes.every((outcome) => outcome.status === "completed")
					? Task.complete("order placed")
					: Task.fail({ message: "payment failed" }),
			),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

// Tasks are installed with an extension. The registry Layer now requires `Bank`, which `charge` needs.
const Shop = Extension.make({ name: "shop", tasks: [Payment, Checkout] });

const placeOrder = (cards: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const root = yield* Harness.root;
		const id = yield* root.commit((tx) =>
			tx.createTask(Checkout, { cards }, { ownership: { kind: "conversation" } }),
		);
		return (yield* Harness.waitForTaskOf(Checkout, id)).state.outcome;
	}); // Effect<TaskOutcome<string>, DurableError | SchemaDecodeError, Harness>

describe("the task example of the README", () => {
	it("runs a checkout that creates its payments as children, waits for them and completes", async () => {
		const charges: string[] = [];
		const bank = Layer.succeed(Bank, {
			charge: (card, key) =>
				Effect.sync(() => {
					charges.push(`${card} ${key}`);
					return `receipt-${card}`;
				}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const outcome = yield* placeOrder(["visa", "amex"]);
				const { items } = yield* Harness.commit((tx) =>
					Effect.promise(() => tx.pi.scanTasks({ kind: "app.payment" }, 10)),
				);
				const payments = yield* Effect.forEach(items, (payment) =>
					Payment.outcome(payment.state.outcome ?? { status: "aborted" }),
				);
				return { outcome, payments, ids: items.map((payment) => payment.id) };
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Shop] })), Effect.provide(bank)),
		);
		expect(seen.outcome).toEqual({ status: "completed", result: "order placed" });
		expect(seen.payments).toEqual([
			{ status: "completed", result: { receipt: "receipt-visa" } },
			{ status: "completed", result: { receipt: "receipt-amex" } },
		]);
		expect(charges).toEqual([`visa payment-${seen.ids[0]}`, `amex payment-${seen.ids[1]}`]);
	});
});

// A second opinion of your program: what the review task asks.
class Reviewer extends Context.Service<
	Reviewer,
	{ readonly judge: (answer: string) => Effect.Effect<{ approved: boolean; note: string }> }
>()("app/Reviewer") {}

const textOf = (message: AssistantMessage) =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

// README: Hook tasks.
const Verdict = Entry.make("review.verdict", Schema.Struct({ approved: Schema.Boolean, note: Schema.String }));

// A review: a second opinion on every answer, kept as an entry, that may send the agent back to work.
const Review = Task.make({
	name: "review.review",
	version: 1,
	input: Schema.Struct({ answer: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("review") }),
	result: Hook.YieldDecision,
	initial: () => ({ phase: "review" as const }),
	phases: {
		review: (task, api) =>
			Effect.gen(function* () {
				// A memo: a phase that runs again after a crash does not ask the reviewer twice.
				const kept = yield* api.memo<{ approved: boolean; note: string }>("review.verdict");
				const verdict = Option.isSome(kept)
					? kept.value
					: yield* Effect.flatMap(
							Reviewer.use((reviewer) => reviewer.judge(task.input.answer)),
							(given) => api.memo("review.verdict", given),
						);
				// The verdict entry and the task's decision are stored together.
				return yield* api.commit((tx) =>
					Effect.as(
						tx.append(Verdict, api.conversationId, { data: verdict }),
						Task.complete(
							verdict.approved ? Hook.stand : Hook.continueWith(`A reviewer objected: ${verdict.note}`),
						),
					),
				);
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

const Reviewed = Extension.make({
	name: "review",
	tasks: [Review],
	hooks: [
		Hook.onYield((answer) =>
			Effect.map(Hook.task(Review, { answer: textOf(answer) }), (request) =>
				Option.some({ kind: "tasks" as const, tasks: [request] }),
			),
		),
	],
});

describe("the hook task example of the README", () => {
	it("keeps each verdict as an entry, sends the agent back once, and lets the corrected answer stand", async () => {
		const judged: string[] = [];
		const reviewer = Layer.succeed(Reviewer, {
			judge: (text) =>
				Effect.sync(() => {
					judged.push(text);
					return text.includes("42")
						? { approved: true, note: "Correct." }
						: { approved: false, note: "It is 42." };
				}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				const verdicts = yield* Effect.forEach(entries, Verdict.read);
				return {
					status: settled.status,
					kinds: entries.map((entry) => entry.kind),
					verdicts: verdicts.flatMap((verdict) => Option.toArray(verdict)).map((verdict) => verdict.data),
					correction: entries[3]?.model?.[0],
				};
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [Reviewed], responses: [answer("It is 41."), answer("It is 42.")] }),
				),
				Effect.provide(reviewer),
			),
		);
		expect(seen.status).toBe("done");
		expect(seen.kinds).toEqual([
			"pi.user",
			"pi.assistant",
			"review.verdict",
			"pi.user",
			"pi.assistant",
			"review.verdict",
		]);
		expect(seen.verdicts).toEqual([
			{ approved: false, note: "It is 42." },
			{ approved: true, note: "Correct." },
		]);
		expect(seen.correction).toMatchObject({ role: "user", content: "A reviewer objected: It is 42." });
		expect(judged).toEqual(["It is 41.", "It is 42."]);
	});
});

// README: Conversation init.
const Jobs = Doc.family({
	kind: "swarm.job",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ conversationId: Schema.NullOr(Schema.Number) }),
	initial: () => ({ conversationId: null }),
	checkpointWhen: () => false,
});

class AlreadyForked extends Schema.TaggedError<AlreadyForked>()("AlreadyForked", {
	conversationId: Schema.Number,
}) {}

// One fork per job key: `init` claims the key in the commit that creates the fork.
const forkFor = (parent: Conversation.Conversation, at: EntryId, key: string) =>
	parent.fork({
		at,
		ownership: { kind: "ownerless" },
		init: (tx, conversationId) =>
			Effect.gen(function* () {
				const job = yield* tx.doc(Jobs, key, null);
				const claimed = (yield* job.get).conversationId;
				// A failing init fails the creating commit: a retried job stores no second fork.
				if (claimed !== null) return yield* new AlreadyForked({ conversationId: claimed });
				yield* job.set({ conversationId });
			}),
	}); // Effect<Conversation, AlreadyForked | DurableError | SchemaDecodeError>

// After a crash the key finds the fork again: one committed read.
const findFork = (key: string) => Harness.snapshot(Jobs, key);

describe("the conversation init example of the README", () => {
	it("claims the key in the creating commit, finds the fork by it, and stores no second fork for a retry", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const primed = yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "app.primed" }));
				const fork = yield* forkFor(root, primed.id, "job-1");
				const retried = yield* Effect.flip(forkFor(root, primed.id, "job-1"));
				const { items } = yield* Harness.commit((tx) => tx.scanConversations({}, 10));
				return {
					found: Option.getOrThrow(yield* findFork("job-1")).conversationId === fork.id,
					missing: Option.isNone(yield* findFork("job-2")),
					retried: retried._tag === "AlreadyForked" && retried.conversationId === fork.id,
					conversations: items.length,
				};
			}).pipe(Effect.provide(TestHarness.layer())),
		);
		expect(seen).toEqual({ found: true, missing: true, retried: true, conversations: 2 });
	});
});

// README: Tool.fromToolkit.
const GetWeather = AiTool.make("get_weather", {
	description: "The weather in a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number }),
});
const WeatherTools = Toolkit.make(GetWeather);

const weather = Registry.layer([Extension.make({ name: "weather", tools: Tool.fromToolkit(WeatherTools) })]).pipe(
	Layer.provide(WeatherTools.toLayer({ get_weather: ({ city }) => Effect.succeed({ temperature: city.length }) })),
);

describe("the toolkit example of the README", () => {
	it("installs the toolkit's tool, and the model reads its encoded result", async () => {
		const content = await Effect.runPromise(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) =>
					models.setResponses([toolCall("get_weather", { city: "Paris" }), answer("It is mild.")]),
				);
				const root = yield* Harness.rootWith({ agent: yield* TestHarness.agent });
				const settled = yield* root.prompt("How warm is Paris?");
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				const message = entries.find((entry) => entry.kind === "pi.tool-result")?.model?.[0];
				return { status: settled.status, read: message?.role === "toolResult" ? message.content : [] };
			}).pipe(
				Effect.provide(
					Harness.layer().pipe(
						Layer.provide(weather),
						Layer.provide(Storage.memory),
						Layer.provideMerge(ScriptedModels.layer()),
					),
				),
			),
		);
		expect(content).toEqual({ status: "done", read: [{ type: "text", text: '{"temperature":5}' }] });
	});
});

// README: Built-in documents.
// Whether a conversation is busy with a run, and why its newest run ended without an answer.
const runOf = (conversationId: ConversationId) =>
	Effect.map(Harness.snapshot(BuiltinDoc.live, conversationId), (live) => {
		const state = Option.getOrUndefined(live);
		return { busy: state?.run !== undefined, failure: state?.runFailure?.reason };
	});

// In a commit the document is read at the point the commit holds, so a check and a write go together.
const noteWhenIdle = (conversation: Conversation.Conversation, text: string, at: Date) =>
	conversation.commit((tx) =>
		Effect.gen(function* () {
			const live = yield* (yield* tx.doc(BuiltinDoc.live, conversation.id)).get;
			if (live.run !== undefined) return false;
			yield* tx.append(Note, conversation.id, { data: { text, at } });
			return true;
		}),
	);

describe("the built-in documents example of the README", () => {
	it("reads the run from pi.live, outside a commit and inside one", async () => {
		const pending = held(answer("Hello."));
		const failing = fauxAssistantMessage([fauxText("partial")], { stopReason: "error", errorMessage: "overloaded" });
		const at = new Date("2026-11-25T00:00:00.000Z");
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Hi." });
				yield* pending.requested;
				const during = [yield* runOf(root.id), yield* noteWhenIdle(root, "during", at)] as const;
				yield* pending.release;
				yield* submission.wait;
				yield* root.waitForIdle;
				const after = [yield* runOf(root.id), yield* noteWhenIdle(root, "after", at)] as const;
				yield* root.prompt("Again.");
				yield* root.waitForIdle;
				return { during, after, failed: yield* runOf(root.id) };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						responses: [pending.response, failing],
						// One attempt per run: Pi's retries would sleep.
						harness: { settings: { retry: { enabled: false } } },
					}),
				),
			),
		);
		expect(seen.during).toEqual([{ busy: true, failure: undefined }, false]);
		expect(seen.after).toEqual([{ busy: false, failure: undefined }, true]);
		expect(seen.failed).toEqual({ busy: false, failure: "model_error" });
	});
});

// README: SubmissionSettled.
// A subagent that holds no process while the child works: the call parks until the child's submission settled.
const Delegate = Tool.make("delegate", {
	description: "Delegate a self-contained task to a subagent and get its answer back.",
	parameters: Schema.Struct({ task: Schema.String }),
	success: Schema.String,
	handler: ({ task }, api) =>
		Effect.gen(function* () {
			// After the wake the settled record is here: what `Submission.wait` would have given.
			const settled = yield* api.readSignal(Signal.SubmissionSettled, api.callId);
			if (Option.isSome(settled)) {
				return settled.value.kind === "value" && settled.value.value.status === "done"
					? "The subagent answered."
					: Tool.error("The subagent gave no answer.");
			}
			const child = yield* api.commit((tx) =>
				Effect.gen(function* () {
					const existing = (yield* tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = yield* tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					yield* tx.configure(created.id, { tools: { remove: ["delegate"] } });
					return created.id;
				}),
			);
			const handle = Option.getOrThrow(yield* api.conversation(child));
			// `notify` delivers the settlement to this call's task, under the key the call parks on.
			yield* handle.submit({
				type: "input",
				content: task,
				requestId: api.callId,
				notify: { taskId: api.taskId, key: api.callId },
			});
			return Tool.sleep({ signals: [Signal.SubmissionSettled.key(api.callId)] });
		}),
});

describe("the SubmissionSettled example of the README", () => {
	it("parks the call until the child's submission settled, and then answers", async () => {
		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("Delegate it.");
				yield* root.waitForIdle;
				const context = yield* root.context();
				const results = context.messages.flatMap((message) =>
					message.role === "toolResult"
						? message.content.map((part) => (part.type === "text" ? part.text : ""))
						: [],
				);
				return { status: settled.status, results };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Delegate] })],
						responses: [
							toolCall("delegate", { task: "Six times seven?" }),
							answer("Forty-two."),
							answer("It is forty-two."),
						],
					}),
				),
			),
		);
		expect(read).toEqual({ status: "done", results: ["The subagent answered."] });
	});
});

// README: Signal.
const Approval = Signal.make("approvals.decision", 1, Schema.Struct({ allow: Schema.Boolean }));

const Approvals = Hook.beforeTool((call, api) =>
	Effect.gen(function* () {
		if (call.name !== "write") return Gate.allow;
		const until = yield* api.memo("approvals.until", (yield* api.now) + 24 * 60 * 60 * 1000);
		const state = yield* api.readSignal(Approval, call.id);
		// Nothing came yet: show the question somewhere, with `api.taskId` and the key, and park.
		if (Option.isNone(state)) return Gate.park({ signals: [Approval.key(call.id)], until });
		if (state.value.kind === "expired") return Gate.block("No approval within a day");
		return state.value.value.allow ? Gate.allow : Gate.block("Not approved");
	}),
);

// Whatever shows the question delivers the answer: "delivered", "duplicate", "invalid", "closed" or "not_found".
const decide = (taskId: TaskId, callId: string) => Harness.signal(taskId, Approval, callId, { allow: true });

// From outside the task: none while the call waits for its decision, and once the call ended.
const decision = (taskId: TaskId, callId: string) => Harness.signalState(taskId, Approval, callId);

describe("the signal example of the README", () => {
	it("parks a write until it is decided, and reads the decision and the idle state from outside", async () => {
		const Write = Tool.make("write", {
			description: "Write a text.",
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			handler: ({ text }) => Effect.succeed(`wrote ${text}`),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Write hi." });
				const parked = yield* Effect.repeat(
					Effect.map(Harness.inspect, ({ tasks }) => tasks.find((task) => task.record.kind === "pi.tool")),
					{ until: (task) => task?.state.kind === "sleeping", schedule: Schedule.spaced("5 millis") },
				);
				const call = Option.getOrThrow(Option.fromUndefinedOr(parked)).record.id;
				// README: Without waiting.
				const waiting = {
					harness: yield* Harness.isIdle,
					conversation: yield* Harness.isConversationIdle(root.id),
				};
				// README: end
				const before = yield* decision(call, "call-1");
				const delivered = yield* decide(call, "call-1");
				const after = yield* decision(call, "call-1");
				const settled = yield* submission.wait;
				yield* Harness.waitForIdle;
				return { waiting, before, delivered, after, settled: settled.status, idle: yield* Harness.isIdle };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "approvals", tools: [Write], hooks: [Approvals] })],
						responses: [toolCall("write", { text: "hi" }, { id: "call-1" }), answer("Written.")],
					}),
				),
			),
		);
		expect(seen.waiting).toEqual({ harness: false, conversation: false });
		expect(Option.isNone(seen.before)).toBe(true);
		expect(seen.delivered).toBe("delivered");
		expect(Option.getOrThrow(seen.after)).toEqual({ kind: "value", value: { allow: true } });
		expect([seen.settled, seen.idle]).toEqual(["done", true]);
	});
});

// README: Scans.
// The conversations a task owns, the sleeping tasks of one kind, and where a conversation came from.
const ownedBy = (taskId: TaskId) => Stream.runCollect(Harness.scanConversations({ ownerTaskId: taskId }));
const sleeping = (kind: string) => Stream.runCollect(Harness.scanTasks({ kind, status: "sleeping" }));
const origin = (conversation: Conversation.Conversation) =>
	Effect.all({ parent: conversation.parent, owner: conversation.owner });

describe("the scans example of the README", () => {
	it("scans by owner and by status, and reads a fork's parent and a child's owner from their handles", async () => {
		const Nap = Task.make({
			name: "app.nap",
			version: 1,
			input: Schema.Struct({}),
			state: Schema.Struct({ phase: Schema.Literal("sleep") }),
			result: Schema.Null,
			initial: () => ({ phase: "sleep" as const }),
			phases: { sleep: (task, api) => Effect.map(api.now, (now) => Task.sleepUntil(now + 60_000, task.state)) },
			abort: () => Effect.succeed(Task.aborted()),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Hi.");
				yield* root.waitForIdle;
				const fork = yield* root.fork({
					at: Option.getOrThrow(yield* root.head),
					ownership: { kind: "ownerless" },
				});
				const nap = yield* root.commit((tx) => tx.createTask(Nap, {}, { ownership: { kind: "conversation" } }));
				const child = yield* Harness.createConversation({ ownership: { kind: "task", taskId: nap } });
				yield* Effect.repeat(sleeping("app.nap"), {
					until: (tasks) => tasks.length === 1,
					schedule: Schedule.spaced("5 millis"),
				});
				const result = {
					owned: (yield* ownedBy(nap)).map((conversation) => conversation.id),
					sleeping: (yield* sleeping("app.nap")).map((task) => task.id),
					fork: yield* origin(fork),
					child: yield* origin(child),
					ids: { root: root.id, child: child.id, nap },
				};
				yield* Harness.abortTask(nap);
				return result;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tasks: [Nap] })],
						responses: [answer("Hello.")],
					}),
				),
			),
		);
		expect(seen.owned).toEqual([seen.ids.child]);
		expect(seen.sleeping).toEqual([seen.ids.nap]);
		expect(Option.getOrThrow(seen.fork.parent).conversationId).toBe(seen.ids.root);
		expect(Option.isNone(seen.fork.owner)).toBe(true);
		expect(Option.getOrThrow(seen.child.owner)).toEqual({ conversationId: seen.ids.root, taskId: seen.ids.nap });
	});
});

describe("the commits example of the README", () => {
	it("streams every entry as it is stored, in commit order", async () => {
		const kinds = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				// README: Commits as a stream.
				// An outbox: every entry of every conversation as it is stored, in commit order.
				const storedEntries = Stream.flatMap(Harness.commits, (commit) =>
					Stream.fromIterable(commit.changes.flatMap((change) => (change.type === "entry" ? [change.value] : []))),
				);
				// README: end
				// Started at once, the stream has attached when its fork returns.
				const collecting = yield* Effect.forkChild(Stream.runCollect(Stream.take(storedEntries, 2)), {
					startImmediately: true,
				});
				yield* root.prompt("Hi.");
				return (yield* Fiber.join(collecting)).map((entry) => [entry.conversationId, entry.kind]);
			}).pipe(Effect.provide(TestHarness.layer({ responses: [answer("Hello.")] }))),
		);
		expect(kinds).toEqual([
			[1, "pi.user"],
			[1, "pi.assistant"],
		]);
	});
});

// README: commitReturning.
// Starts a payment unless two are already under way. The count is read in the commit that acts on it, and the phase
// has it afterwards.
const Throttled = Task.make({
	name: "app.throttled",
	version: 1,
	input: Schema.Struct({ card: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("start") }),
	result: Schema.Struct({ started: Schema.Boolean }),
	initial: () => ({ phase: "start" as const }),
	phases: {
		start: (task, api) =>
			Effect.gen(function* () {
				const underWay = yield* api.commitReturning((tx) =>
					Effect.gen(function* () {
						// Table reads come before the first table write.
						const query = { conversationId: api.conversationId, kind: Payment.name, status: "pending" } as const;
						const { items } = yield* tx.scanTasks(query, 2);
						const started = items.length < 2;
						if (started) {
							yield* tx.createTask(Payment, { card: task.input.card }, { ownership: { kind: "conversation" } });
						}
						return { step: Task.complete({ started }), value: items.length };
					}),
				);
				yield* Effect.logDebug(`payments under way: ${underWay}`);
				return Task.committed;
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

describe("the commitReturning example of the README", () => {
	it("stores the step with the payment it created, and gives the phase what the commit read", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Throttled, { card: "visa" }, { ownership: { kind: "conversation" } }),
				);
				const outcome = (yield* Harness.waitForTaskOf(Throttled, id)).state.outcome;
				yield* Harness.waitForIdle;
				const payments = yield* Stream.runCollect(Harness.scanTasks({ kind: Payment.name }));
				return { outcome, payments: payments.map((payment) => payment.state.status) };
			}).pipe(
				Effect.provide(
					TestHarness.layer({ extensions: [Extension.make({ name: "shop", tasks: [Payment, Throttled] })] }),
				),
				Effect.provide(Layer.succeed(Bank, { charge: (card) => Effect.succeed(`receipt-${card}`) })),
			),
		);
		expect(seen.outcome).toEqual({ status: "completed", result: { started: true } });
		expect(seen.payments).toEqual(["terminal"]);
	});
});

// What a product adds to the model requests of its program, for the example below.
class Meter extends Context.Service<Meter, { readonly requests: Effect.Effect<number> }>()("app/Meter") {}

// A Layer of a product that wraps the `Models` it requires, as a budget or a router does.
const Metered: Layer.Layer<Models | Meter, never, Models> = Layer.effectContext(
	Effect.gen(function* () {
		const inner = yield* Models;
		let requests = 0;
		const metered = new Proxy(inner, {
			get: (target, property) => {
				const member: unknown = Reflect.get(target, property, target);
				if (typeof member !== "function") return member;
				if (typeof property === "string" && property.startsWith("stream")) requests += 1;
				return member.bind(target);
			},
		});
		return Context.make(Models, metered).pipe(Context.add(Meter, { requests: Effect.sync(() => requests) }));
	}),
);

describe("the testing example of the README with a product's own layers", () => {
	it("opens the harness on the product's registry and models, over the scripted provider", async () => {
		// README: Testing with your own layers.
		const test = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const settled = yield* root.prompt("What is record 42 called?");
			return {
				settled,
				reached: yield* ScriptedModels.use((models) => models.callCount), // what reached the provider
				metered: yield* Meter.use((meter) => meter.requests), // what the product's own Models saw
			};
		}).pipe(
			Effect.provide(
				TestHarness.layerWith({
					registry: Registry.layer([App]), // or the Layer of a guard, which builds the registry itself
					models: Metered, // a Layer<Models | Meter, never, Models>: it wraps the scripted Models
					responses: [toolCall("lookup", { id: "42" }), answer("It is called Answer.")],
				}),
			),
			Effect.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
		);
		// README: end
		const result = await Effect.runPromise(test);
		expect(result.settled.status).toBe("done");
		expect(result.reached).toBe(2);
		expect(result.metered).toBeGreaterThanOrEqual(2);
	});
});
