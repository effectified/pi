import { defineExtension, defineTask, type Report, type TaskId } from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Context, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Extension, Harness, Registry, Signal, Task } from "../src/index.ts";
import { TestHarness } from "../src/testing/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT } from "./scripted.ts";
import { untilTask } from "./until-task.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Bank extends Context.Service<Bank, { readonly charge: (card: string) => Effect.Effect<number> }>()("test/Bank") {}

class Declined extends Schema.TaggedError<Declined>()("Declined", { message: Schema.String }) {}

// Values whose type differs from their JSON form: a Date travels as an ISO string.
const PaymentState = Schema.Union([
	Schema.Struct({ phase: Schema.Literal("charge") }),
	Schema.Struct({ phase: Schema.Literal("confirm"), receipt: Schema.Number, at: Schema.Date }),
]);

/**
 * A payment: `charge` asks the bank, `confirm` completes. `ran` gets each phase as it starts, `confirming` runs when
 * `confirm` starts, and `hold` keeps it back until it resolves.
 */
function payment(
	options: { readonly hold?: Promise<void>; readonly ran?: string[]; readonly confirming?: () => void } = {},
) {
	return Task.make({
		name: "test.payment",
		version: 1,
		input: Schema.Struct({ card: Schema.String, due: Schema.Date }),
		state: PaymentState,
		result: Schema.Struct({ receipt: Schema.Number, paidAt: Schema.Date }),
		initial: () => ({ phase: "charge" as const }),
		phases: {
			charge: (task) => {
				options.ran?.push(`charge ${task.input.card}`);
				const narrowed: Equal<typeof task.state, { readonly phase: "charge" }> = true;
				return task.input.card.startsWith("expired")
					? Effect.fail(new Declined({ message: `${task.input.card} declined` }))
					: Effect.map(
							Bank.use((bank) => bank.charge(task.input.card)),
							(receipt) =>
								Task.next({ phase: "confirm" as const, receipt: narrowed ? receipt : 0, at: task.input.due }),
						);
			},
			confirm: (task) => {
				options.ran?.push(`confirm ${task.input.card}`);
				options.confirming?.();
				return Effect.as(
					Effect.promise(() => options.hold ?? Promise.resolve()),
					Task.complete({ receipt: task.state.receipt, paidAt: task.state.at }),
				);
			},
		},
		abort: () => Effect.succeed(Task.aborted("stopped")),
	});
}

const Payment = payment();

const bank = Layer.succeed(Bank, { charge: (card) => Effect.succeed(card.length * 100) });

const DUE = new Date("2026-11-25T00:00:00.000Z");

const pay = (task: Task.Kind<{ readonly card: string; readonly due: Date }, unknown>, card: string) =>
	Effect.flatMap(TestHarness.root, (root) =>
		root.commit((tx) => tx.createTask(task, { card, due: DUE }, { ownership: { kind: "conversation" } })),
	);

/** Every report of the harness from now on, collected until the scope closes. */
const collectReports = Effect.gen(function* () {
	const reports: Report[] = [];
	// Started at once, it has subscribed when the fork returns.
	yield* Effect.forkScoped(
		Stream.runForEach(Harness.reports, (report) => Effect.sync(() => reports.push(report))),
		{ startImmediately: true },
	);
	return reports;
});

describe("make", () => {
	it("infers the input, the state and the result from the schemas", () => {
		const input: Equal<Parameters<typeof Payment.encodeInput>[0], { readonly card: string; readonly due: Date }> =
			true;
		const state: Equal<
			(typeof Payment.state)["Type"],
			{ readonly phase: "charge" } | { readonly phase: "confirm"; readonly receipt: number; readonly at: Date }
		> = true;
		const result: Equal<(typeof Payment.result)["Type"], { readonly receipt: number; readonly paidAt: Date }> = true;
		const services: Equal<Task.Services<typeof Payment>, Bank> = true;
		expect([input, state, result, services]).toEqual([true, true, true, true]);
		expect([Payment.name, Payment.version]).toEqual(["test.payment", 1]);
	});

	it("does not compile without a handler for every phase, with one for an unknown phase, or with a step outside the state", () => {
		const fields = {
			name: "test.incomplete",
			version: 1,
			input: Schema.Null,
			state: Schema.Union([
				Schema.Struct({ phase: Schema.Literal("one") }),
				Schema.Struct({ phase: Schema.Literal("two") }),
			]),
			result: Schema.String,
			initial: () => ({ phase: "one" as const }),
			abort: () => Effect.succeed(Task.aborted()),
		};
		const one = () => Effect.succeed(Task.next({ phase: "two" as const }));
		const two = () => Effect.succeed(Task.complete("done"));
		// @ts-expect-error The phase `two` has no handler.
		const missing = Task.make({ ...fields, phases: { one } });
		// @ts-expect-error `three` is no phase of the state.
		const unknown = Task.make({ ...fields, phases: { one, two, three: two } });
		const nowhere = () => Effect.succeed(Task.next({ phase: "nowhere" as const }));
		// @ts-expect-error `nowhere` is no phase of the state.
		const outside = Task.make({ ...fields, phases: { one: nowhere, two } });
		const numbered = () => Effect.succeed(Task.complete(2));
		// @ts-expect-error A number is not the result.
		const mistyped = Task.make({ ...fields, phases: { one, two: numbered } });
		const complete = Task.make({ ...fields, phases: { one, two } });
		expect([missing, unknown, outside, mistyped, complete].map((task) => task.name)).toEqual(
			Array(5).fill("test.incomplete"),
		);
	});

	it("stores the input, each state and the result as JSON, and gives the handlers decoded values", async () => {
		const hold = Promise.withResolvers<void>();
		const confirming = Promise.withResolvers<void>();
		const Held = payment({ hold: hold.promise, confirming: confirming.resolve });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const id = yield* pay(Held, "visa");
				yield* Effect.promise(() => confirming.promise);
				const live = Option.getOrThrow(yield* Harness.getTask(id));
				hold.resolve();
				const stored = yield* Harness.waitForTask(id);
				const typed = yield* Harness.waitForTaskOf(Held, id);
				return { live: { input: live.input, state: live.state }, stored: stored.state, typed: typed.state };
			}).pipe(
				Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Held] })] })),
				Effect.provide(bank),
			),
		);
		expect(seen.live).toEqual({
			input: { card: "visa", due: "2026-11-25T00:00:00.000Z" },
			state: { status: "running", checkpoint: { phase: "confirm", receipt: 400, at: "2026-11-25T00:00:00.000Z" } },
		});
		expect(seen.stored).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { receipt: 400, paidAt: "2026-11-25T00:00:00.000Z" } },
		});
		expect(seen.typed).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { receipt: 400, paidAt: DUE } },
		});
	});

	it("leaves the same records as the same task of plain Pi", async () => {
		const PiPayment = defineTask<
			{ card: string; due: string },
			{ phase: "charge" } | { phase: "confirm"; receipt: number; at: string },
			{ receipt: number; paidAt: string }
		>({
			name: "test.payment",
			version: 1,
			initial: () => ({ phase: "charge" }),
			phases: {
				charge: (task, runtime, context) =>
					runtime.commit(
						() => ({
							status: "running",
							checkpoint: { phase: "confirm", receipt: task.input.card.length * 100, at: task.input.due },
						}),
						context,
					),
				confirm: (task, runtime, context) => {
					const { receipt, at } = task.state.checkpoint;
					return runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: { receipt, paidAt: at } } }),
						context,
					);
				},
			},
			abort: (_task, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "stopped" } }), context),
		});
		const both = await runBoth({
			responses: () => [],
			extensions: {
				effect: Registry.layer([Extension.make({ name: "app", tasks: [Payment] })]).pipe(Layer.provide(bank)),
				pi: [defineExtension({ name: "app", tasks: [PiPayment] })],
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const id = yield* root.commit((tx) =>
					tx.createTask(Payment, { card: "visa", due: DUE }, { ownership: { kind: "conversation" } }),
				);
				return (yield* Harness.waitForTask(id)).state;
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const id = await root.commit(
					(tx) =>
						tx.createTask(
							PiPayment,
							{ card: "visa", due: DUE.toISOString() },
							{ ownership: { kind: "conversation" } },
						),
					context,
				);
				return (await harness.waitForTask(id, context)).state;
			},
		});
		expect(both.effect.result).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { receipt: 400, paidAt: "2026-11-25T00:00:00.000Z" } },
		});
		expect(both.effect.result).toEqual(both.pi.result);
		expect(both.effect.records.tasks).toHaveLength(1);
		expect(both.effect.records).toEqual(both.pi.records);
	});

	it("ends a task whose phase fails as faulted, at once, as Pi does a throwing phase", async () => {
		const ran: string[] = [];
		const Counted = payment({ ran });
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const reports = yield* collectReports;
					const id = yield* pay(Counted, "expired-1");
					const settled = yield* Harness.waitForTaskOf(Counted, id);
					yield* Harness.waitForIdle;
					return {
						state: settled.state,
						reports: reports.map((report) => ({
							kind: report.kind,
							reason: report.kind === "task_faulted" ? report.reason : undefined,
							extension: report.kind === "task_faulted" ? report.extension : undefined,
							error: report.error,
						})),
					};
				}),
			).pipe(
				Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Counted] })] })),
				Effect.provide(bank),
			),
		);
		expect(seen.state).toEqual({
			status: "terminal",
			outcome: { status: "faulted", error: { message: "expired-1 declined" } },
		});
		expect(seen.reports).toEqual([
			{
				kind: "task_faulted",
				reason: "threw",
				extension: "app",
				error: new Declined({ message: "expired-1 declined" }),
			},
		]);
		// No retry: the phase ran once.
		expect(ran).toEqual(["charge expired-1"]);
	});

	it("ends a task as faulted when a step does not match its schema", async () => {
		const Strict = Task.make({
			name: "test.strict",
			version: 1,
			input: Schema.Null,
			state: Schema.Struct({ phase: Schema.Literal("only") }),
			result: Schema.String.check(Schema.isMinLength(3)),
			initial: () => ({ phase: "only" as const }),
			phases: { only: () => Effect.succeed(Task.complete("no")) },
			abort: () => Effect.succeed(Task.aborted()),
		});
		const state = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) => tx.createTask(Strict, null, { ownership: { kind: "conversation" } }));
				return (yield* Harness.waitForTask(id)).state;
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Strict] })] }))),
		);
		expect(state).toMatchObject({ status: "terminal", outcome: { status: "faulted" } });
		expect(state.outcome.error?.message).toContain("length of at least 3");
	});

	it("fails the creating commit, storing nothing, when the input does not match its schema", async () => {
		const Strict = Task.make({
			name: "test.strict-input",
			version: 1,
			input: Schema.String.check(Schema.isMinLength(3)),
			state: Schema.Struct({ phase: Schema.Literal("only") }),
			result: Schema.Null,
			initial: () => ({ phase: "only" as const }),
			phases: { only: () => Effect.succeed(Task.complete(null)) },
			abort: () => Effect.succeed(Task.aborted()),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const failure = yield* Effect.flip(
					root.commit((tx) => tx.createTask(Strict, "no", { ownership: { kind: "conversation" } })),
				);
				return { tag: failure._tag, tasks: (yield* Harness.inspect).tasks.length };
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Strict] })] }))),
		);
		expect(seen).toEqual({ tag: "SchemaDecodeError", tasks: 0 });
	});

	it("interrupts the running phase when the task is aborted, then runs the abort handler", async () => {
		const events: string[] = [];
		const started = Promise.withResolvers<void>();
		const Slow = Task.make({
			name: "test.slow",
			version: 1,
			input: Schema.Struct({ job: Schema.String }),
			state: Schema.Struct({ phase: Schema.Literal("work") }),
			result: Schema.String,
			initial: () => ({ phase: "work" as const }),
			phases: {
				work: () =>
					Effect.onInterrupt(
						Effect.andThen(
							Effect.sync(() => started.resolve()),
							Effect.never,
						),
						() => Effect.sync(() => events.push("phase interrupted")),
					),
			},
			abort: (task) =>
				Effect.sync(() => {
					events.push(`abort ${task.input.job} at ${task.state.phase}`);
					return Task.aborted("user", "partial");
				}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Slow, { job: "render" }, { ownership: { kind: "conversation" } }),
				);
				yield* Effect.promise(() => started.promise);
				const marked = yield* Harness.abortTask(id);
				return { marked, state: (yield* Harness.waitForTaskOf(Slow, id)).state };
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Slow] })] }))),
		);
		expect(seen).toEqual({
			marked: "marked",
			state: { status: "terminal", outcome: { status: "aborted", reason: "user", result: "partial" } },
		});
		expect(events).toEqual(["phase interrupted", "abort render at work"]);
	});

	it("interrupts the running phase when the harness closes, and leaves the task for a reopen", async () => {
		const events: string[] = [];
		const started = Promise.withResolvers<void>();
		const Slow = Task.make({
			name: "test.slow",
			version: 1,
			input: Schema.Null,
			state: Schema.Struct({ phase: Schema.Literal("work") }),
			result: Schema.Null,
			initial: () => ({ phase: "work" as const }),
			phases: {
				work: () =>
					Effect.onInterrupt(
						Effect.andThen(
							Effect.sync(() => started.resolve()),
							Effect.never,
						),
						() => Effect.sync(() => events.push("phase interrupted")),
					),
			},
			abort: () =>
				Effect.sync(() => {
					events.push("abort");
					return Task.aborted();
				}),
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const context = yield* Layer.buildWithScope(
					TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Slow] })] }),
					scope,
				);
				yield* Effect.provide(
					Effect.flatMap(TestHarness.root, (root) =>
						root.commit((tx) => tx.createTask(Slow, null, { ownership: { kind: "conversation" } })),
					),
					context,
				);
				yield* Effect.promise(() => started.promise);
				yield* Scope.close(scope, Exit.void);
			}),
		);
		// No abort handler: a close ends no task.
		expect(events).toEqual(["phase interrupted"]);
	});

	it("runs its handlers with the services the registry was built with", () => {
		const needsBank = Registry.layer([Extension.make({ name: "app", tasks: [Payment] })]);
		const requirements: Equal<Layer.Services<typeof needsBank>, Bank> = true;
		expect(requirements).toBe(true);
	});
});

describe("sleeping and waiting", () => {
	const Answer = Signal.make("test.task-answer", 1, Schema.Struct({ text: Schema.String, at: Schema.Date }));

	const Reminder = Task.make({
		name: "test.reminder",
		version: 1,
		input: Schema.Struct({ after: Schema.Number }),
		state: Schema.Union([
			Schema.Struct({ phase: Schema.Literal("wait") }),
			Schema.Struct({ phase: Schema.Literal("deliver") }),
		]),
		result: Schema.Struct({ wake: Schema.String, at: Schema.Number }),
		initial: () => ({ phase: "wait" as const }),
		phases: {
			wait: (task, api) =>
				Effect.map(api.now, (now) => Task.sleepUntil(now + task.input.after, { phase: "deliver" as const })),
			deliver: (task, api) =>
				Effect.map(api.now, (at) =>
					Task.complete({
						wake: Option.match(task.wake, { onNone: () => "none", onSome: (wake) => wake.reason }),
						at,
					}),
				),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});

	const Ask = Task.make({
		name: "test.ask",
		version: 1,
		input: Schema.Null,
		state: Schema.Union([
			Schema.Struct({ phase: Schema.Literal("ask") }),
			Schema.Struct({ phase: Schema.Literal("answered") }),
		]),
		result: Schema.Struct({ wake: Schema.Unknown, text: Schema.String, at: Schema.Date }),
		initial: () => ({ phase: "ask" as const }),
		phases: {
			ask: () =>
				Effect.succeed(Task.sleep({ state: { phase: "answered" as const }, signals: [Answer.key("answer")] })),
			answered: (task, api) =>
				Effect.map(api.readSignal(Answer, "answer"), (state) => {
					const value = Option.getOrThrow(state);
					return value.kind === "value"
						? Task.complete({ wake: Option.getOrNull(task.wake), text: value.value.text, at: value.value.at })
						: Task.fail({ message: "expired" });
				}),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});

	it("sleeps until the harness clock reaches the time, on a TestClock, and wakes with the reason `time`", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				yield* TestClock.setTime(1_000);
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Reminder, { after: 60_000 }, { ownership: { kind: "conversation" } }),
				);
				yield* untilTask("sleeping", id);
				const asleep = Option.getOrThrow(yield* Harness.getTask(id)).state;
				// One millisecond early, once Pi had a turn to wake it, it still sleeps.
				yield* TestClock.adjust(59_999);
				yield* Effect.yieldNow;
				const early = Option.getOrThrow(yield* Harness.getTask(id)).state.status;
				yield* TestClock.adjust(1);
				return { asleep, early, state: (yield* Harness.waitForTaskOf(Reminder, id)).state };
			}).pipe(
				Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Reminder] })] })),
			),
		);
		expect(seen.asleep).toEqual({ status: "sleeping", checkpoint: { phase: "deliver" }, until: 61_000 });
		expect(seen.early).toBe("sleeping");
		expect(seen.state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { wake: "time", at: 61_000 } },
		});
	});

	it("sleeps on a signal, wakes when it is delivered, and reads its value decoded", async () => {
		const at = new Date("2026-11-25T08:00:00.000Z");
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) => tx.createTask(Ask, null, { ownership: { kind: "conversation" } }));
				yield* untilTask("sleeping", id);
				const asleep = Option.getOrThrow(yield* Harness.getTask(id)).state;
				const delivered = yield* Harness.signal(id, Answer, "answer", { text: "yes", at });
				return { asleep, delivered, state: (yield* Harness.waitForTaskOf(Ask, id)).state };
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Ask] })] }))),
		);
		expect(seen.asleep).toEqual({
			status: "sleeping",
			checkpoint: { phase: "answered" },
			signals: [{ signal: "test.task-answer", key: "answer" }],
		});
		expect(seen.delivered).toBe("delivered");
		expect(seen.state).toEqual({
			status: "terminal",
			outcome: {
				status: "completed",
				result: { wake: { reason: "signal", signal: "test.task-answer", key: "answer" }, text: "yes", at },
			},
		});
	});
});

describe("migrate", () => {
	it("gives Pi the migrated input and state encoded, when a task of an older version is taken up", async () => {
		const Counter = (version: number) =>
			Task.make({
				name: "test.counter",
				version,
				input: Schema.Struct({ until: Schema.Date }),
				state: Schema.Struct({ phase: Schema.Literal("count"), from: Schema.Date }),
				result: Schema.Struct({ from: Schema.Date, until: Schema.Date }),
				initial: (input) => ({ phase: "count" as const, from: input.until }),
				phases: {
					count: (task) => Effect.succeed(Task.complete({ from: task.state.from, until: task.input.until })),
				},
				abort: () => Effect.succeed(Task.aborted()),
				migrate: (input, state, fromVersion) => ({
					input: { until: new Date(2_000 + fromVersion) },
					state: { phase: "count" as const, from: new Date(JSON.stringify([input, state]).length) },
				}),
			});
		const Old = Counter(1);
		const New = Counter(2);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Old, { until: new Date(1_000) }, { ownership: { kind: "conversation" } }),
				);
				// Nothing ran yet: scheduling is off. The registry now holds version 2 under the same name.
				const registry = yield* Registry.Registry;
				registry.install(defineExtension({ name: "app", tasks: [yield* New.registration] }));
				yield* Harness.resume;
				return (yield* Harness.waitForTaskOf(New, id)).state;
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tasks: [Old] })],
						harness: { resume: false },
					}),
				),
			),
		);
		const stored = JSON.stringify([
			{ until: "1970-01-01T00:00:01.000Z" },
			{ phase: "count", from: "1970-01-01T00:00:01.000Z" },
		]);
		expect(seen).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { from: new Date(stored.length), until: new Date(2_001) } },
		});
	});
});

describe("token", () => {
	it("creates a task through Pi's own transaction, which then runs under the installed definition", async () => {
		const state = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					Effect.promise(() =>
						tx.pi.createTask(
							Payment.token,
							{ card: "amex", due: DUE.toISOString() },
							{ ownership: { kind: "conversation" } },
						),
					),
				);
				return (yield* Harness.waitForTaskOf(Payment, id)).state;
			}).pipe(
				Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "app", tasks: [Payment] })] })),
				Effect.provide(bank),
			),
		);
		expect(state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { receipt: 400, paidAt: DUE } },
		});
	});

	it("faults a task that Pi runs under the token itself, saying how to install it", async () => {
		const state = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* Registry.Registry;
				registry.install(defineExtension({ name: "raw", tasks: [Payment.token] }));
				const id = yield* pay(Payment, "visa");
				return (yield* Harness.waitForTask(id)).state;
			}).pipe(Effect.provide(TestHarness.layer())),
		);
		expect(state).toEqual({
			status: "terminal",
			outcome: {
				status: "faulted",
				error: {
					message: "Task test.payment was installed from its token: install it with Registry.layer instead",
				},
			},
		});
	});
});

describe("outcome, settled and record", () => {
	const paid = { receipt: 400, paidAt: "2026-11-25T00:00:00.000Z" };

	it("decodes the result of each outcome that has one, and leaves the others as they are", async () => {
		const decoded = await Effect.runPromise(
			Effect.all([
				Payment.outcome({ status: "completed", result: paid }),
				Payment.outcome({ status: "failed", error: { message: "late" }, result: paid }),
				Payment.outcome({ status: "failed", error: { message: "late" } }),
				Payment.outcome({ status: "aborted", reason: "user" }),
				Payment.outcome({ status: "orphaned", reason: "missing_task" }),
				Payment.outcome({ status: "faulted", error: { message: "threw" } }),
			]),
		);
		expect(decoded).toEqual([
			{ status: "completed", result: { receipt: 400, paidAt: DUE } },
			{ status: "failed", error: { message: "late" }, result: { receipt: 400, paidAt: DUE } },
			{ status: "failed", error: { message: "late" } },
			{ status: "aborted", reason: "user" },
			{ status: "orphaned", reason: "missing_task" },
			{ status: "faulted", error: { message: "threw" } },
		]);
	});

	it("fails with SchemaDecodeError for a result of another shape", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(Payment.outcome({ status: "completed", result: { receipt: "x" } })),
		);
		expect(failure._tag).toBe("SchemaDecodeError");
	});

	it("gives a live record as it is, and a terminal one with its result decoded", async () => {
		const hold = Promise.withResolvers<void>();
		const Held = payment({ hold: hold.promise });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const id = yield* pay(Held, "visa");
				const live = yield* Task.record(Held, Option.getOrThrow(yield* Harness.getTask(id)));
				hold.resolve();
				const ended = yield* Harness.waitForTask(id);
				return {
					live: live.state.status,
					record: (yield* Task.record(Held, ended)).state,
					settled: (yield* Task.settled(Held, ended)).state,
				};
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tasks: [Held] })],
						harness: { resume: false },
					}),
				),
				Effect.provide(bank),
			),
		);
		const terminal = { status: "terminal", outcome: { status: "completed", result: { receipt: 400, paidAt: DUE } } };
		expect(seen).toEqual({ live: "pending", record: terminal, settled: terminal });
	});
});

describe("ended", () => {
	it("holds for completing and terminal, the states that hold an outcome, and for no live state", () => {
		const statuses = ["pending", "running", "waiting", "sleeping", "completing", "terminal"] as const;
		expect(statuses.filter(Task.ended)).toEqual(["completing", "terminal"]);
	});
});

describe("Id", () => {
	it("is a number in the stored state and a task id in the decoded one", async () => {
		const State = Schema.Struct({ phase: Schema.Literal("wait"), children: Schema.Array(Task.Id) });
		const typed: Equal<(typeof State)["Type"]["children"], ReadonlyArray<TaskId>> = true;
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(Schema.toCodecJson(State))({ phase: "wait", children: [3, 4] }),
		);
		expect(typed).toBe(true);
		expect(decoded).toEqual({ phase: "wait", children: [3, 4] });
	});
});
