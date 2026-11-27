// Test helper: the suites that close and reopen a harness on a SQLite file, registered once per driver by a platform
// test file: a run the budget stopped, a conversation's share, a request a close cut off, a cap set in a creating
// commit, a share without a cap, a recorded spend, and a copy of the file opened as a host opens a copied storage.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Conversation, Extension, Harness, Registry, Storage, Tool } from "@effectified/pi-durable";
import { answer, type FauxResponseStep, ScriptedModels, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Layer, Logger, Option, Schema, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { expect, it } from "vitest";
import { continueStopped, onStorageFork, refusalOf, Shares, Spend, SpentUsage, stopOf } from "../src/index.ts";
import {
	type Budgeted,
	budgetedHarness,
	expectedCost,
	root as rootConversation,
	type Step,
	TestLease,
} from "./support.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

/** A `describe` of the test runner, or one that skips its suite on the other runtime. */
export type Describe = (name: string, body: () => void) => void;

/** Registers every SQLite suite for one driver. */
export function registerSqliteSuites(describe: Describe, driver: string, client: ClientLayer): void {
	describe(`a budget across a close and a reopen (${driver})`, () => {
		it("keeps a stopped run stopped with its reason, and continues it under a new lease", () =>
			withDatabaseFile(async (filename) => {
				const open = opener(client(filename));
				const stopped = await open(
					[toolCall("lookup", { id: "42" }, { id: "call-1" }), answer("Never.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						duringTool.run = () => {
							lease.fenced = "expired";
						};
						const root = yield* rootConversation;
						const settled = yield* root.prompt("What is record 42 called?", { requestId: "run" });
						expect(settled).toMatchObject({ status: "unanswered", reason: "model_error" });
						expect(yield* ScriptedModels.use((scripted) => scripted.callCount)).toBe(1);
						return { input: settled.id, transcript: yield* transcript(root) };
					}),
				);
				expect(stopped.transcript).toEqual([
					"pi.user",
					"pi.system",
					"pi.assistant:toolUse",
					"pi.tool-result",
					"pi.assistant:error",
				]);

				// Another process, another lease: what stopped the run is read from what Pi stored.
				const continued = await open(
					[answer("It is called Answer.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const root = yield* rootConversation;
						const fromLive = Option.getOrThrow(yield* stopOf(root.id));
						const submission = Option.getOrThrow(yield* Harness.submission(stopped.input));
						const fromSubmission = yield* refusalOf((yield* submission.status).detail);
						// Nothing ran on reopen: the stopped run waits for its host.
						yield* root.waitForIdle;
						expect(lease.steps).toEqual([]);
						const again = yield* continueStopped(root, { requestId: "continued" });
						const settled = yield* again.wait;
						return {
							fromLive,
							fromSubmission,
							settled,
							steps: lease.steps.map(({ step }) => step),
							calls: yield* ScriptedModels.use((scripted) => scripted.callCount),
							transcript: yield* transcript(root),
							stop: yield* stopOf(root.id),
						};
					}),
				);
				expect(continued.fromLive.refusal).toMatchObject({ _tag: "LeaseFenced", reason: "expired" });
				expect(continued.fromLive.inputs).toEqual([stopped.input]);
				expect(continued.fromSubmission).toEqual(Option.some(continued.fromLive.refusal));
				expect(continued.settled).toMatchObject({ status: "done" });
				expect(continued.steps).toEqual(["reserve", "settle"]);
				expect(continued.calls).toBe(1);
				expect(continued.transcript).toEqual([...stopped.transcript, "pi.assistant:stop"]);
				expect(continued.stop).toEqual(Option.none());
			}));

		it("keeps a conversation's cap and what it settled", () =>
			withDatabaseFile(async (filename) => {
				const open = opener(client(filename));
				const first = await open(
					[answer("One.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const sub = yield* child;
						yield* shares.setCap(sub.id, 1n);
						expect(yield* sub.prompt("First")).toMatchObject({ status: "done" });
						const settle = lease.steps[1];
						if (settle?.step !== "settle") throw new Error("a settle");
						return { conversation: sub.id, spent: settle.settlement.cost };
					}),
				);
				expect(first.spent).toBeGreaterThan(1n);

				const second = await open(
					[answer("Hello.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const sub = Option.getOrThrow(yield* Harness.conversation(first.conversation));
						const share = yield* shares.get(sub.id);
						const refused = yield* sub.prompt("Second");
						const stop = Option.getOrThrow(yield* stopOf(sub.id));
						const calls = yield* ScriptedModels.use((scripted) => scripted.callCount);
						const steps = lease.steps.length;
						const root = yield* rootConversation;
						return { share, refused, stop, calls, steps, rootAnswer: yield* root.prompt("Hello") };
					}),
				);
				expect(second.share).toEqual(
					Option.some({ conversation: first.conversation, cap: 1n, settled: first.spent }),
				);
				expect(second.refused).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(second.stop.refusal).toMatchObject({
					_tag: "ShareExhausted",
					conversation: first.conversation,
					cap: 1n,
					settled: first.spent,
				});
				expect([second.calls, second.steps]).toEqual([0, 0]);
				expect(second.rootAnswer).toMatchObject({ status: "done" });
			}));

		it("settles a request a close cut off as aborted, and budgets it again under its key when it is sent again", () =>
			withDatabaseFile(async (filename) => {
				const open = opener(client(filename));
				const warnings: string[] = [];
				const first = await open(
					// Two hundred tokens at forty a second: the close comes while the answer streams.
					[answer("word ".repeat(160))],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const root = yield* rootConversation;
						yield* shares.setCap(root.id, 1_000_000n);
						const input = yield* root.submit({ type: "input", content: "Hello", requestId: "run" });
						yield* Effect.sleep("150 millis");
						expect(lease.steps.map(({ step }) => step)).toEqual(["reserve"]);
						return { lease, conversation: root.id, input: input.id, warnings };
					}),
					{ provider: { api: "scripted", tokensPerSecond: 40 }, warnings },
				);
				// The scope is closed: the harness, the request and its reservation with it. The provider had
				// reported the request's usage when it started to answer, so the aborted request has a cost.
				expect(first.lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
				const cut = first.lease.steps[1];
				if (cut?.step !== "settle") throw new Error("a settle");
				expect(cut).toMatchObject({ token: "r1", settlement: { outcome: "aborted" } });
				expect(cut.settlement.cost).toBeGreaterThan(0n);

				const second = await open(
					[answer("Hello.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const root = yield* rootConversation;
						const before = yield* shares.get(root.id);
						yield* root.waitForIdle;
						const submission = Option.getOrThrow(yield* Harness.submission(first.input));
						const [reserve, settle] = lease.steps;
						if (reserve?.step !== "reserve" || settle?.step !== "settle")
							throw new Error("a reserve and a settle");
						return {
							key: reserve.request.requestKey,
							before,
							status: (yield* submission.status).status,
							steps: lease.steps.map(({ step }) => step),
							spent: settle.settlement.cost,
							share: yield* shares.get(root.id),
						};
					}),
				);
				expect(second.status).toBe("done");
				expect(second.steps).toEqual(["reserve", "settle"]);
				expect(second.spent).toBeGreaterThan(0n);
				// The request sent again by the reopened harness is reserved under the key of the one the close cut
				// off, though part of its answer had arrived: Pi leaves a cut-off answer out of what it sends.
				const [cutOff] = first.lease.steps;
				expect(cutOff?.step === "reserve" && cutOff.request.requestKey).toMatch(/^[0-9a-f]{64}$/);
				expect(second.key).toBe(cutOff?.step === "reserve" ? cutOff.request.requestKey : undefined);
				// The limit of a share: the harness was closed when the cut-off request settled, so its cost reached
				// the lease and not the stored total, which holds the request sent again and nothing else.
				expect(first.warnings).toEqual(["A conversation's settled budget was not stored"]);
				const share = { conversation: first.conversation, cap: 1_000_000n };
				expect(second.before).toEqual(Option.some({ ...share, settled: 0n }));
				expect(second.share).toEqual(Option.some({ ...share, settled: second.spent }));
			}));

		it("keeps a cap set in the commit that created a conversation, in force from its first request", () =>
			withDatabaseFile(async (filename) => {
				const open = opener(client(filename));
				const first = await open(
					[],
					Effect.gen(function* () {
						const shares = yield* Shares;
						const scripted = yield* ScriptedModels;
						// The conversation and its cap are one commit: this process ends before any request.
						const sub = yield* Harness.createConversation({
							ownership: { kind: "ownerless" },
							agent: { model: { provider: scripted.model.provider, modelId: scripted.model.id } },
							init: (tx, conversation) => Effect.asVoid(shares.setCapIn(tx, conversation, 1n)),
						});
						return { conversation: sub.id };
					}),
				);

				const second = await open(
					[answer("One."), answer("Never.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const sub = Option.getOrThrow(yield* Harness.conversation(first.conversation));
						const before = yield* shares.get(sub.id);
						const served = yield* sub.prompt("First");
						const [reserve, settle] = lease.steps;
						if (reserve?.step !== "reserve" || settle?.step !== "settle")
							throw new Error("a reserve and a settle");
						const refused = yield* sub.prompt("Second");
						return {
							before,
							served,
							attributed: reserve.request.conversation,
							spent: settle.settlement.cost,
							refused,
							stop: Option.getOrThrow(yield* stopOf(sub.id)),
							calls: yield* ScriptedModels.use((scripted) => scripted.callCount),
							share: yield* shares.get(sub.id),
						};
					}),
				);
				const share = { conversation: first.conversation, cap: 1n };
				expect(second.before).toEqual(Option.some({ ...share, settled: 0n }));
				expect(second.served).toMatchObject({ status: "done" });
				expect(second.attributed).toBe(first.conversation);
				expect(second.refused).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(second.stop.refusal).toMatchObject({ _tag: "ShareExhausted", ...share, settled: second.spent });
				expect(second.calls).toBe(1);
				expect(second.share).toEqual(Option.some({ ...share, settled: second.spent }));
			}));

		it("keeps what a conversation without a cap settled, and goes on counting from it", () =>
			withDatabaseFile(async (filename) => {
				const open = opener(client(filename));
				const first = await open(
					[answer("One.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const root = yield* rootConversation;
						yield* shares.track(root.id);
						expect(yield* root.prompt("First")).toMatchObject({ status: "done" });
						const settle = lease.steps[1];
						if (settle?.step !== "settle") throw new Error("a settle");
						return { conversation: root.id, spent: settle.settlement.cost };
					}),
				);
				expect(first.spent).toBeGreaterThan(0n);

				const second = await open(
					[answer("Two.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const root = yield* rootConversation;
						const before = yield* shares.get(root.id);
						expect(yield* root.prompt("Second")).toMatchObject({ status: "done" });
						const settle = lease.steps[1];
						if (settle?.step !== "settle") throw new Error("a settle");
						return { before, spent: settle.settlement.cost, share: yield* shares.get(root.id) };
					}),
				);
				expect(second.before).toEqual(Option.some({ conversation: first.conversation, settled: first.spent }));
				expect(second.share).toEqual(
					Option.some({ conversation: first.conversation, settled: first.spent + second.spent }),
				);
			}));

		it("keeps a recorded spend in a conversation's total, and charges its key again in a new process", () =>
			withDatabaseFile(async (filename) => {
				const open = opener(client(filename));
				const usage = { input: 1200, output: 0, cacheRead: 300, cacheWrite: 0 };
				const cost = expectedCost(usage);
				const first = await open(
					[answer("One.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const spend = yield* Spend;
						const scripted = yield* ScriptedModels;
						const root = yield* rootConversation;
						yield* shares.track(root.id);
						expect(yield* root.prompt("First")).toMatchObject({ status: "done" });
						const [reserve, settle] = lease.steps;
						if (reserve?.step !== "reserve" || settle?.step !== "settle")
							throw new Error("a reserve and a settle");
						const spent = yield* Schema.decodeEffect(SpentUsage)({
							key: "lz4k2q9xw-1#1",
							provider: scripted.model.provider,
							model: scripted.model.id,
							session: reserve.request.session,
							usage,
							outcome: "failed",
						});
						const recorded = yield* spend.record(spent);
						const again = yield* spend.record(spent);
						return { conversation: root.id, served: settle.settlement.cost, spent, recorded, again };
					}),
				);
				expect(first.recorded).toEqual({
					_tag: "Settled",
					reservation: "r2",
					cost,
					conversation: first.conversation,
				});
				expect(first.again).toEqual({ _tag: "Duplicate" });

				const second = await open(
					[],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const spend = yield* Spend;
						const before = yield* shares.get(first.conversation);
						// What a restart costs: the keys recorded are kept in memory, so a product that tells an old
						// spend again charges it again. The lease is given the key, and can know that it has it.
						const recorded = yield* spend.record(first.spent);
						return { before, recorded, steps: lease.steps, share: yield* shares.get(first.conversation) };
					}),
				);
				const share = { conversation: first.conversation, settled: first.served + cost };
				expect(second.before).toEqual(Option.some(share));
				expect(second.recorded).toEqual({
					_tag: "Settled",
					reservation: "r1",
					cost,
					conversation: first.conversation,
				});
				expect(second.steps).toMatchObject([
					{ step: "reserve", estimate: cost, request: { key: "lz4k2q9xw-1#1", conversation: first.conversation } },
					{ step: "settle", settlement: { usage, cost, outcome: "failed" } },
				]);
				expect(second.share).toEqual(Option.some({ ...share, settled: first.served + cost + cost }));
			}));
	});

	describe(`a copied storage (${driver})`, () => {
		/** What the lease of one process was told in all, in micro units. */
		const toldTo = (lease: { readonly steps: ReadonlyArray<Step> }) =>
			lease.steps.reduce((sum, step) => sum + (step.step === "settle" ? step.settlement.cost : 0n), 0n);

		it("counts what it inherited against a cap and not as its own, once, also in a copy of the copy", () =>
			withDatabaseFile(async (filename) => {
				const [first, second] = [`${filename}.copy`, `${filename}.copy.copy`];
				// The original: a tracked root and a conversation capped below what one request costs.
				const original = await opener(client(filename))(
					[answer("One."), answer("Two.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const root = yield* rootConversation;
						const sub = yield* child;
						yield* shares.track(root.id);
						yield* shares.setCap(sub.id, 1n);
						expect(yield* root.prompt("First")).toMatchObject({ status: "done" });
						const ofRoot = toldTo(lease);
						expect(yield* sub.prompt("Second")).toMatchObject({ status: "done" });
						return { root: root.id, sub: sub.id, ofRoot, ofSub: toldTo(lease) - ofRoot };
					}),
				);
				expect(original.ofSub).toBeGreaterThan(1n);
				copyDatabaseFile(filename, first);
				const tracked = { conversation: original.root };
				const capped = { conversation: original.sub, cap: 1n };

				// The copy, as its host opens it: not resumed, the step, then work of its own.
				const copied = await opener(client(first), { resume: false })(
					[answer("Three."), answer("Never.")],
					Effect.gen(function* () {
						const lease = yield* TestLease;
						const shares = yield* Shares;
						const inherited = { root: yield* shares.get(original.root), sub: yield* shares.get(original.sub) };
						yield* onStorageFork("copy");
						const moved = { root: yield* shares.get(original.root), sub: yield* shares.get(original.sub) };
						const root = yield* rootConversation;
						expect(yield* root.prompt("Third")).toMatchObject({ status: "done" });
						const own = toldTo(lease);
						// The capped conversation was copied past its cap: it gets no cap of its own to spend again.
						const sub = Option.getOrThrow(yield* Harness.conversation(original.sub));
						const refused = yield* sub.prompt("Fourth");
						const stop = Option.getOrThrow(yield* stopOf(sub.id));
						// A host that was cut off runs the step again: nothing the copy settled since is moved.
						yield* onStorageFork("copy");
						return {
							inherited,
							moved,
							own,
							refused,
							refusal: stop.refusal,
							calls: yield* ScriptedModels.use((scripted) => scripted.callCount),
							told: toldTo(lease),
							after: { root: yield* shares.get(original.root), sub: yield* shares.get(original.sub) },
						};
					}),
				);
				// What a copy holds before the step: its source's totals, which is the same money in two storages.
				expect(copied.inherited).toEqual({
					root: Option.some({ ...tracked, settled: original.ofRoot }),
					sub: Option.some({ ...capped, settled: original.ofSub }),
				});
				expect(copied.moved).toEqual({
					root: Option.some({ ...tracked, settled: 0n, inherited: original.ofRoot }),
					sub: Option.some({ ...capped, settled: 0n, inherited: original.ofSub }),
				});
				expect(copied.refused).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(copied.refusal).toMatchObject({ _tag: "ShareExhausted", ...capped, settled: original.ofSub });
				expect([copied.calls, copied.told]).toEqual([1, copied.own]);
				expect(copied.after).toEqual({
					root: Option.some({ ...tracked, settled: copied.own, inherited: original.ofRoot }),
					sub: copied.moved.sub,
				});
				copyDatabaseFile(first, second);

				// A copy of the copy, under its own name: what the first copy settled is inherited there.
				const again = await opener(client(second), { resume: false })(
					[],
					Effect.gen(function* () {
						const shares = yield* Shares;
						yield* onStorageFork("copy of the copy");
						return { root: yield* shares.get(original.root), sub: yield* shares.get(original.sub) };
					}),
				);
				expect(again).toEqual({
					root: Option.some({ ...tracked, settled: 0n, inherited: original.ofRoot + copied.own }),
					sub: copied.moved.sub,
				});

				// The storage everything was copied from is as it was, and the three storages' own totals add up to
				// what the leases were told: every request is counted once.
				const source = await opener(client(filename))(
					[],
					Effect.gen(function* () {
						const shares = yield* Shares;
						return { root: yield* shares.get(original.root), sub: yield* shares.get(original.sub) };
					}),
				);
				expect(source).toEqual(copied.inherited);
				const settledIn = (storage: typeof source) =>
					[storage.root, storage.sub].reduce((sum, share) => sum + Option.getOrThrow(share).settled, 0n);
				expect(settledIn(source) + settledIn(copied.after) + settledIn(again)).toBe(
					original.ofRoot + original.ofSub + copied.own,
				);
			}));
	});
}

/** Copies a database file as it is on disk now, with its write-ahead log: what a storage fork copies. */
function copyDatabaseFile(from: string, to: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
	}
}

/** What a test does when the model's tool call runs: between the first request of a run and the second. */
const duringTool = { run: () => {} };

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	replay: "safe",
	handler: () =>
		Effect.sync(() => {
			duringTool.run();
			return { title: "Answer" };
		}),
});

const App = Extension.make({ name: "app", tools: [Lookup] });

/**
 * Opens a budgeted harness on the database file, scripts the model, runs `body`, and closes everything: each call is
 * one process, with a lease, a provider and budgeted models of its own, on the same stored data.
 */
function opener(client: Layer.Layer<SqlClient, SqlError>, harness?: Harness.Options) {
	const storage = Storage.sql().pipe(Layer.provide(client), Layer.orDie);
	const registry = Layer.orDie(Registry.layer([App]));
	return <A, E>(
		responses: ReadonlyArray<FauxResponseStep>,
		body: Effect.Effect<A, E, Harness.Harness | Budgeted>,
		options?: {
			readonly provider?: Parameters<typeof ScriptedModels.layer>[0];
			/** Takes the text of every warning logged while the harness is open and while it closes. */
			readonly warnings?: string[];
		},
	) => {
		const capture = Logger.make((entry) => {
			if (entry.logLevel === "Warn")
				options?.warnings?.push(String(Array.isArray(entry.message) ? entry.message[0] : entry.message));
		});
		return Effect.runPromise(
			Effect.andThen(
				ScriptedModels.use((scripted) => scripted.setResponses(responses)),
				body,
			).pipe(
				Effect.provide(budgetedHarness({ storage, registry, provider: options?.provider, harness })),
				Effect.provide(Logger.layer(options?.warnings === undefined ? [] : [capture])),
			),
		);
	};
}

/** A second conversation on the scripted model. */
const child = ScriptedModels.use(({ model }) =>
	Harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: { model: { provider: model.provider, modelId: model.id } },
	}),
);

/** The kinds of a conversation's entries, oldest first, and for each assistant entry how it ended. */
const transcript = (conversation: Conversation.Conversation) =>
	Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries.map((entry) => {
			const [message] = entry.model ?? [];
			return message?.role === "assistant" ? `${entry.kind}:${message.stopReason}` : entry.kind;
		}),
	);

/** Runs `use` with the path of a database file that is removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-budget-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
