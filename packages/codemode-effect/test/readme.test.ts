// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the packages, this file the sources). The sandbox Worker's one export line runs in
// workerd as `fixtures/cloudflare-worker.ts` (`cloudflare.node.test.ts`).

import { Tool } from "@effectified/pi-agent";
import { runTest } from "@effectified/pi-ai/testing";
import { Context, Effect, Fiber, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { InlineSandbox, renderDeclarations, Source, Wasm, WorkerSandbox } from "../src/index.ts";
import { type CodemodeRemote, RemoteSandbox } from "../src/portable.ts";

// README: quick start
// A service of your program. Tool handlers reach it through the context the sandbox is made in.
class Records extends Context.Service<Records, { readonly title: (id: string) => Effect.Effect<string> }>()(
	"app/Records",
) {}

const Lookup = Tool.make("lookup", {
	label: "Lookup",
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	structured: true, // the script gets { title } as JSON, not the text a model reads
	handler: ({ id }) =>
		Effect.map(
			Records.use((records) => records.title(id)),
			(title) => ({ title }),
		),
});

const program = Effect.gen(function* () {
	// One worker thread and a fresh VM per execution; the sandbox closes with the scope.
	const sandbox = yield* WorkerSandbox.make({ tools: [Lookup], timeoutMs: 60_000 });
	// What the model reads about the tools, for the description of your code mode tool.
	const declarations = renderDeclarations({ tools: yield* sandbox.tools });
	const result = yield* sandbox.execute(`
		const records = await Promise.all(["1", "2"].map((id) => tools.lookup({ id })));
		text(records.length + " records");
		return records.map((record) => record.title);
	`);
	return { declarations, result }; // result: { ok: true, value: ["Record 1", "Record 2"], output: [...], calls: [...] }
});

const live = Layer.succeed(Records, { title: (id) => Effect.succeed(`Record ${id}`) });

describe("the quick start of the README", () => {
	it("runs a script that calls an Effect tool, and renders the declarations the model reads", async () => {
		const { declarations, result } = await Effect.runPromise(Effect.scoped(Effect.provide(program, live)));
		expect(declarations).toContain("lookup(args: { id: string; }): Promise<{ title: string; }>;");
		expect(result).toMatchObject({
			ok: true,
			value: ["Record 1", "Record 2"],
			output: [{ type: "text", text: "2 records" }],
			calls: [
				{ name: "lookup", status: "ok" },
				{ name: "lookup", status: "ok" },
			],
		});
	});
});

// README: tools and globals
const Add = Tool.make("add", {
	label: "Add",
	description: "Add two numbers.",
	parameters: Schema.Tuple([Schema.Number, Schema.Number]),
	success: Schema.Number,
	structured: true,
	handler: ([a, b]) => Effect.succeed(a + b),
});

const sum = Effect.gen(function* () {
	const sandbox = yield* WorkerSandbox.make({
		globals: [{ tool: Add, spread: true, signature: "(a: number, b: number): Promise<number>" }],
	});
	return yield* sandbox.execute(`return await add(2, 3);`); // { ok: true, value: 5, ... }
});

describe("the globals of the README", () => {
	it("calls a spread global with the call's arguments", async () => {
		expect(await runTest(sum)).toMatchObject({ ok: true, value: 5 });
	});
});

// README: interruption
const bounded = (code: string) =>
	Effect.flatMap(WorkerSandbox.make({ tools: [Lookup] }), (sandbox) =>
		sandbox.execute(code).pipe(Effect.timeout("30 seconds"), Effect.option),
	);

describe("the interruption of the README", () => {
	it("interrupts a script that computes once the Clock's deadline passes", async () => {
		const outcome = await runTest(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(bounded("while (true) {}"), { startImmediately: true });
				yield* TestClock.adjust("30 seconds");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(live)),
		);
		expect(Option.isNone(outcome)).toBe(true);
	});
});

// README: source format
const runInput = (input: string) =>
	Effect.gen(function* () {
		const { code, options } = yield* Source.parse(input);
		const sandbox = yield* WorkerSandbox.make({ tools: [Lookup] });
		return yield* sandbox.execute(code, { timeoutMs: options.timeoutMs });
	});

describe("the source format of the README", () => {
	it("runs the code after the options line, and fails with CodemodeSourceError for input Pi refuses", async () => {
		const [result, failure] = await runTest(
			Effect.all([
				runInput(`// @options: {"timeout_ms": 30000}\nreturn (await tools.lookup({ id: "4" })).title;`),
				Effect.flip(runInput(`// @options: {"timeout_ms": 0}\nreturn 1;`)),
			]).pipe(Effect.provide(live)),
		);
		expect(result).toMatchObject({ ok: true, value: "Record 4" });
		expect(failure._tag).toBe("CodemodeSourceError");
	});
});

// README: deterministic runs
const replayable = Effect.gen(function* () {
	const sandbox = yield* InlineSandbox.make({ wasm: yield* Wasm.load() });
	const run = yield* sandbox.start(`return await tools.read({ path: "a.txt" });`, {
		seed: 7,
		tools: [{ name: "read" }],
	});
	let seq = 0;
	yield* Effect.forkScoped(
		Stream.runForEach(run.events, (event) =>
			event._tag === "Call"
				? run.deliver({ seq: ++seq, id: event.call.id, outcome: { ok: true, value: "contents" } })
				: Effect.void,
		),
	);
	return yield* run.result; // { ok: true, value: "contents", during: { seq: 1, issued: 1 }, ... }
});

describe("the deterministic run of the README", () => {
	it("answers the script's call from the run's events", async () => {
		expect(await runTest(replayable)).toMatchObject({
			ok: true,
			value: "contents",
			during: { seq: 1, issued: 1 },
		});
	});
});

// README: worker threads
const limited = Effect.gen(function* () {
	const workers = yield* Semaphore.make(4); // shared by every sandbox given it
	return yield* WorkerSandbox.make({
		tools: [Lookup],
		acquireWorker: Effect.flatMap(workers.takeIfAvailable(1), (taken) =>
			taken ? Effect.succeed(workers.release(1)) : Effect.fail(new Error("no free worker")),
		),
	});
});

describe("the worker threads of the README", () => {
	it("admits a worker while one is free", async () => {
		const result = await runTest(
			Effect.flatMap(limited, (sandbox) => sandbox.execute(`return 1;`)).pipe(Effect.provide(live)),
		);
		expect(result).toMatchObject({ ok: true, value: 1 });
	});
});

// README: Cloudflare Workers
interface Env {
	readonly CODEMODE_SANDBOX: { readonly getByName: (name: string) => CodemodeRemote };
}

const remoteSandbox = (env: Env, sessionId: string) =>
	RemoteSandbox.make({
		tools: [Lookup],
		timeoutMs: 60_000,
		// Evaluated once per execution: one object per session keeps a session's scripts together.
		remote: Effect.sync(() => env.CODEMODE_SANDBOX.getByName(sessionId)),
	});

describe("the Cloudflare Workers of the README", () => {
	it("runs the VM on the remote a session names, the tools here", async () => {
		const [result, names] = await runTest(
			Effect.gen(function* () {
				const wasm = yield* Wasm.load();
				const names: Array<string> = [];
				// In this process, the remote end stands in for the Durable Object a stub reaches over Workers RPC.
				const env: Env = {
					CODEMODE_SANDBOX: {
						getByName: (name) => {
							names.push(name);
							return {
								execute: (request, exchange) =>
									Effect.runPromise(RemoteSandbox.serve(request, exchange, { wasm })),
							};
						},
					},
				};
				const sandbox = yield* remoteSandbox(env, "session-1");
				return [yield* sandbox.execute(`return (await tools.lookup({ id: "8" })).title;`), names] as const;
			}).pipe(Effect.provide(live)),
		);
		expect(result).toMatchObject({ ok: true, value: "Record 8" });
		expect(names).toEqual(["session-1"]);
	});
});
