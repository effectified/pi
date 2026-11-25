// The examples of README.md as tests. The quick start, from `Covers` to `live`, and the code under each "README:"
// comment are the README's, line for line; only the imports differ (the README names the package, this file its
// sources).

import type { ModelRef } from "@earendil-works/pi-durable";
import { Harness, Registry, Storage } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseFactory, ScriptedModels, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "../src/index.ts";
import { tally, until } from "./support.ts";

// The work of one kind of swarm: what a job is given, what a fork must answer, and what a fork is asked.
const Covers = Swarm.make({
	name: "covers",
	input: Schema.Struct({ topic: Schema.String }),
	result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
	prompt: ({ topic }) => `Does the document you read cover ${topic}?`,
});

// No provider and no key: a scripted model that answers each request by what it was asked.
const scripted: FauxResponseFactory = (context) => {
	const asked = context.messages.findLast((message) => message.role === "user")?.content;
	const topic = /cover (\w+)\?/.exec(String(asked))?.[1];
	return answer(topic === undefined ? "I have read it." : JSON.stringify({ topic, covered: topic !== "Zig" }));
};

const program = Effect.gen(function* () {
	// Prime: one conversation reads the expensive context, once.
	const root = yield* TestHarness.root;
	yield* root.prompt("Read this document: ...", { requestId: "prime" });
	// Fork per job under the cap, fan the typed results in, clean up.
	yield* Swarm.start(Covers, {
		id: "covers-1", // the idempotency key: starting it twice is one swarm
		source: root.id,
		jobs: [
			{ key: "rust", input: { topic: "Rust" } },
			{ key: "go", input: { topic: "Go" } },
			{ key: "zig", input: { topic: "Zig" } },
		],
		cap: 2,
		onFailure: "collect",
	});
	return yield* Swarm.result(Covers, "covers-1");
});

// The in-storage driver needs the open harness, and the registry needs the driver: `layer` first, `attach` last.
const live = Swarm.ConversationForks.attach.pipe(
	Layer.provideMerge(
		TestHarness.layer({
			extensions: [Swarm.extension([Covers])],
			responses: Array.from({ length: 10 }, () => scripted),
		}),
	),
	Layer.provideMerge(Swarm.ConversationForks.layer),
	Layer.provide(Swarm.ForkSetup.none),
);

/** A model that holds every job's answer until its request is aborted, and answers everything else. */
const holding: FauxResponseFactory = (context, options) => {
	const asked = String(context.messages.findLast((message) => message.role === "user")?.content);
	if (!asked.includes("cover")) return answer("I have read it.");
	return new Promise((resolve) => {
		options?.signal?.addEventListener("abort", () => resolve(answer("cut off")), { once: true });
	});
};

const on = (respond: FauxResponseFactory) =>
	Swarm.ConversationForks.attach.pipe(
		Layer.provideMerge(
			TestHarness.layer({
				extensions: [Swarm.extension([Covers])],
				responses: Array.from({ length: 20 }, () => respond),
			}),
		),
		Layer.provideMerge(Swarm.ConversationForks.layer),
		Layer.provide(Swarm.ForkSetup.none),
	);

const primed = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	yield* root.prompt("Read this document: ...", { requestId: "prime" });
	return root;
});

const jobs = [
	{ key: "rust", input: { topic: "Rust" } },
	{ key: "go", input: { topic: "Go" } },
	{ key: "zig", input: { topic: "Zig" } },
];

describe("README", () => {
	it("a swarm from start to result", async () => {
		const outcome = await Effect.runPromise(Effect.provide(program, live));
		expect(outcome.jobs).toEqual([
			{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } },
			{ _tag: "Success", key: "go", value: { topic: "Go", covered: true } },
			{ _tag: "Success", key: "zig", value: { topic: "Zig", covered: false } },
		]);
		expect(outcome.ending).toBe("completed");
		expect(outcome.forks.map((fork) => fork.fate)).toEqual(["destroyed", "destroyed", "destroyed"]);
	});

	it("the same wiring from the parts", async () => {
		// README: with real providers `Models.layer([anthropicProvider()])`, and `Storage.sql()` over a SQLite client.
		const live = Swarm.ConversationForks.attach.pipe(
			Layer.provideMerge(Harness.layer()),
			Layer.provide(Registry.layer([Swarm.extension([Covers])])),
			Layer.provideMerge(Swarm.ConversationForks.layer),
			Layer.provide(Swarm.ForkSetup.none),
			Layer.provide(Storage.memory),
			Layer.provideMerge(ScriptedModels.layer()),
		);
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses(Array.from({ length: 10 }, () => scripted)));
				const root = yield* Harness.rootWith({ agent: yield* TestHarness.agent });
				yield* root.prompt("Read this document: ...", { requestId: "prime" });
				yield* Swarm.start(Covers, { id: "parts", source: root.id, jobs, cap: 3, onFailure: "collect" });
				return yield* Swarm.result(Covers, "parts");
			}).pipe(Effect.provide(live)),
		);
		expect(outcome.jobs.map((job) => job._tag)).toEqual(["Success", "Success", "Success"]);
	});

	it("the plan: an agent change for every fork", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				const models = yield* ScriptedModels;
				const cheap: ModelRef = { provider: models.models[1].provider, modelId: models.models[1].id };
				// README:
				yield* Swarm.start(Covers, {
					id: "covers-cheap",
					source: root.id,
					jobs: [{ key: "rust", input: { topic: "Rust" } }],
					cap: 1,
					onFailure: "fail",
					// Every fork answers with the other model and is offered no tool. The source keeps what it has.
					agent: { model: cheap, modelTools: [] },
				});
				const outcome = yield* Swarm.result(Covers, "covers-cheap");
				const stored = yield* Harness.commit((tx) => tx.scanConversations({}, 10));
				const fork = Option.getOrThrow(yield* Harness.conversation(stored.items[1].id));
				return { outcome, cheap, fork: (yield* fork.agent).model, source: (yield* root.agent).model };
			}).pipe(
				Effect.provide(
					Swarm.ConversationForks.attach.pipe(
						Layer.provideMerge(
							TestHarness.layer({
								extensions: [Swarm.extension([Covers])],
								responses: Array.from({ length: 10 }, () => scripted),
								provider: { api: "scripted", models: [{ id: "large" }, { id: "small" }] },
							}),
						),
						Layer.provideMerge(Swarm.ConversationForks.layer),
						Layer.provide(Swarm.ForkSetup.none),
					),
				),
			),
		);
		expect(seen.outcome.jobs).toEqual([{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } }]);
		expect(seen.fork).toEqual(seen.cheap);
		expect(seen.source?.modelId).toBe("large");
	});

	it("status, the probe of a reconciliation job; cancel; and the result of a cancelled swarm", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				yield* Swarm.start(Covers, { id: "covers-1", source: root.id, jobs, cap: 2, onFailure: "collect" });
				yield* until(Effect.map(tally("covers-1"), (now) => now.running === 2));
				// README:
				// A reconciliation job after a crash: is the coordinator there, and what did it plan?
				const probe = yield* Swarm.status("covers-1");
				const alive = probe.running;
				const jobKeys = probe.jobs.map((job) => job.key);
				const open = probe.jobs.filter((job) => job.status !== "succeeded" && job.status !== "failed");
				// README:
				// Cancel: nothing new starts, live forks are cancelled, unpinned forks are destroyed, collected results are kept.
				const cancelling = yield* Swarm.cancel("covers-1"); // "cancelling"
				const outcome = yield* Swarm.result(Covers, "covers-1");
				return { alive, jobKeys, open: open.map((job) => job.status), phase: probe.phase, cancelling, outcome };
			}).pipe(Effect.provide(on(holding))),
		);
		expect(seen.alive).toBe(true);
		expect(seen.phase).toBe("run");
		expect(seen.jobKeys).toEqual(["rust", "go", "zig"]);
		expect(seen.open).toEqual(["running", "running", "planned"]);
		expect(seen.cancelling).toBe("cancelling");
		expect(seen.outcome.ending).toBe("cancelled");
		expect(seen.outcome.jobs.map((job) => (job._tag === "Failure" ? job.reason : "success"))).toEqual([
			"cancelled",
			"cancelled",
			"cancelled",
		]);
		expect(seen.outcome.forks.map((fork) => fork.fate)).toEqual(["destroyed", "destroyed"]);
	});

	it("a pinned fork, released later", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				yield* Swarm.start(Covers, {
					id: "covers-pinned",
					source: root.id,
					jobs,
					cap: 3,
					onFailure: "collect",
					pins: ["rust"],
				});
				const outcome = yield* Swarm.result(Covers, "covers-pinned");
				// README:
				// A pinned fork is kept, as a conversation the product goes on with, until a janitor releases it.
				const kept = yield* Swarm.ForkDriver.use((driver) => driver.list("covers-pinned"));
				const released = yield* Swarm.destroyFork("covers-pinned", "rust"); // { bytesWritten: Option<number> }
				const after = yield* Swarm.ForkDriver.use((driver) => driver.list("covers-pinned"));
				return { outcome, kept, released, after };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.outcome.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual([
			["rust", "pinned"],
			["go", "destroyed"],
			["zig", "destroyed"],
		]);
		expect(seen.kept.map((fork) => fork.jobKey)).toEqual(["rust"]);
		expect(Option.getOrThrow(seen.released.bytesWritten)).toBeGreaterThan(0);
		expect(seen.after).toEqual([]);
	});

	it("events, for a host that shows progress", async () => {
		const logged: Array<string> = [];
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				yield* Swarm.start(Covers, { id: "covers-1", source: root.id, jobs, cap: 2, onFailure: "collect" });
				const log = (tag: string, key: string) => Effect.sync(() => logged.push(`${tag} ${key}`));
				// README: (with `Effect.log` for `log`)
				// Progress: one element when a job's fork was asked for, one when it settled or failed.
				yield* Stream.runForEach(Swarm.events("covers-1"), (event) => log(event._tag, event.key));
			}).pipe(Effect.provide(live)),
		);
		expect([...logged].sort()).toEqual(
			["Settled go", "Settled rust", "Settled zig", "Started go", "Started rust", "Started zig"].sort(),
		);
		expect(logged.indexOf("Started zig")).toBeGreaterThan(
			Math.min(logged.indexOf("Settled rust"), logged.indexOf("Settled go")),
		);
	});

	it("the result, read from the coordinator's task", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				const started = yield* Swarm.start(Covers, {
					id: "covers-1",
					source: root.id,
					jobs,
					cap: 2,
					onFailure: "collect",
				});
				const direct = yield* Swarm.result(Covers, "covers-1");
				// README:
				const settled = yield* Harness.waitForTaskOf(Covers.task, started.taskId);
				if (settled.state.outcome.status === "completed") {
					const outcome = yield* Swarm.typed(Covers.work, settled.state.outcome.result);
					return { direct, outcome: Option.some(outcome) };
				}
				return { direct, outcome: Option.none() };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.outcome).toEqual(Option.some(seen.direct));
	});

	it("a typed result: a wrong answer is sent back, unless the definition allows no correction", async () => {
		// README:
		const Strict = Swarm.make({
			name: "strict",
			input: Schema.Struct({ topic: Schema.String }),
			result: Schema.Struct({ topic: Schema.String, covered: Schema.Boolean }),
			prompt: ({ topic }) => `Does the document you read cover ${topic}?`,
			corrections: 0, // the first answer decides
		});
		let asked = 0;
		// Its first answer to a job is prose; asked again, it answers with the JSON.
		const sloppy: FauxResponseFactory = (context) => {
			const texts = context.messages.flatMap((message) =>
				message.role === "user" ? [String(message.content)] : [],
			);
			if (!texts.some((text) => text.includes("cover"))) return answer("I have read it.");
			asked += 1;
			return answer(texts.at(-1)?.includes("not accepted") ? '{"topic":"Rust","covered":true}' : "Yes, it does.");
		};
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				const plan = { source: root.id, jobs: [jobs[0]], cap: 1, onFailure: "collect" as const };
				yield* Swarm.start(Covers, { ...plan, id: "lenient" });
				const lenient = yield* Swarm.result(Covers, "lenient");
				const afterLenient = asked;
				yield* Swarm.start(Strict, { ...plan, id: "strict" });
				return { lenient, afterLenient, strict: yield* Swarm.result(Strict, "strict") };
			}).pipe(
				Effect.provide(
					Swarm.ConversationForks.attach.pipe(
						Layer.provideMerge(
							TestHarness.layer({
								extensions: [Swarm.extension([Covers, Strict])],
								responses: Array.from({ length: 10 }, () => sloppy),
							}),
						),
						Layer.provideMerge(Swarm.ConversationForks.layer),
						Layer.provide(Swarm.ForkSetup.none),
					),
				),
			),
		);
		expect(seen.lenient.jobs).toEqual([{ _tag: "Success", key: "rust", value: { topic: "Rust", covered: true } }]);
		expect(seen.afterLenient).toBe(2);
		expect(seen.strict.jobs).toEqual([
			{ _tag: "Failure", key: "rust", reason: "invalid-result", message: "The answer holds no JSON value" },
		]);
		expect(asked).toBe(3);
	});

	it("a copied storage: what its host runs first", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* primed;
				yield* Swarm.start(Covers, { id: "covers-1", source: root.id, jobs, cap: 2, onFailure: "collect" });
				yield* Effect.sleep(20);
				// README:
				// In the host of the copy, on a harness opened with `resume: false`, before anything else:
				yield* Swarm.onStorageFork;
				yield* Harness.resume;
				return yield* Effect.flip(Swarm.result(Covers, "covers-1"));
			}).pipe(Effect.provide(on(holding))),
		);
		expect(seen).toEqual(new Swarm.SwarmFaulted({ swarmId: "covers-1", reason: "copied" }));
	});
});
