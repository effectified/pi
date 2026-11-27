# @effectified/pi-codemode

Pi's code mode ([`@earendil-works/pi-codemode`](../codemode)) in Effect terms, for `effect` 4.1: model-written
JavaScript runs in a QuickJS VM (WebAssembly) whose only capability is calling the tools you give it.

- Sandboxes as scoped resources: in a worker thread (Node and Bun), on the calling thread, or on a remote such as a
  Cloudflare Durable Object.
- An execution is an `Effect`; a deterministic run reports its events as a `Stream`.
- The tools a script calls are tools of [`@effectified/pi-agent`](../agent-effect/README.md): `Schema` parameters
  and results, handlers that are Effects.
- One closed union of tagged errors, each keeping what Pi threw as its `cause`.
- Interrupting a fiber aborts the execution.

It adds no behaviour of its own: what pi-codemode does is what happens. Built for pi-codemode 1.6.1.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.2.0
npm install --allow-remote=all $R/effectified-pi-codemode-0.2.0.tgz $R/effectified-pi-agent-0.2.0.tgz $R/effectified-pi-ai-0.2.0.tgz $R/effectified-pi-schema-0.2.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Quick start

```ts
import { Context, Effect, Layer, Schema } from "effect";
import { Tool } from "@effectified/pi-agent";
import { renderDeclarations, WorkerSandbox } from "@effectified/pi-codemode";

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

Effect.runPromise(Effect.scoped(Effect.provide(program, live)));
```

`code` is the body of an async function. A script that throws is no failure of the Effect: the result has `ok: false`,
with the error's `kind` (`script`, `timeout`, `aborted`, `sandbox`), and keeps the output and calls up to the failure.
`WorkerSandbox.make` fails with `SchemaConversionError` when a tool's JSON Schema cannot be built, and with
`ToolRejected` when Pi refuses a tool or a global.

## Tools and globals

A tool of `@effectified/pi-agent` becomes the tool a script calls as `tools.<name>(args)`, in the shape Pi documents
for agent tools in code mode. A `structured` tool resolves to its success value as JSON; any other to the text a model
would read. A handler's failure and a `Tool.error` reply reject the script's call with their text. The handler runs
with the services of the context the sandbox was made in, and is interrupted when Pi aborts the call.

A global is a tool the script calls as a top-level function, not recorded in a result's `calls`. With `spread`, the
handler gets the call's arguments as a tuple:

```ts
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
```

`sandbox.register` and `sandbox.unregister` change the tools of later executions; `unregister` takes the tool's
`ToolName` (`sandbox.unregister(Lookup.name)`). `ScriptTool.fromAgent` gives Pi's
tool for a tool, for `renderDeclarations` without a sandbox. `sandbox.pi` is Pi's own sandbox, for what takes one as
it is, such as Pi Durable's code mode tool.

## Interruption

Interrupting the fiber that waits for an execution aborts it: the tools' handlers are interrupted, the VM is asked to
stop, and the interruption is done once Pi settled the execution. Each execution has a span, `Sandbox.execute`, and
each tool call one of its own, `Tool.execute`. Closing the sandbox's scope aborts every execution
that still runs; their results have `kind: "aborted"`.

```ts
const bounded = (code: string) =>
	Effect.flatMap(WorkerSandbox.make({ tools: [Lookup] }), (sandbox) =>
		sandbox.execute(code).pipe(Effect.timeout("30 seconds"), Effect.option),
	);
```

`timeoutMs` is Pi's own deadline, on Pi's timer: the result then has `kind: "timeout"`. A deadline of the `Clock`, as
above, interrupts instead.

## Source format

A code mode tool's input may start with an options line, `// @options: {"max_output_tokens": 2000, "timeout_ms":
30000}`. `Source.parse` splits it from the code, and fails with `CodemodeSourceError` for input Pi refuses. The sandbox
does not act on the options; the caller decides. `CODEMODE_SOURCE_GRAMMAR` is the Lark grammar of the format, for
providers with grammar-constrained tool input. `@effectified/pi-codemode/source` has these without a sandbox.

```ts
import { Source } from "@effectified/pi-codemode";

const runInput = (input: string) =>
	Effect.gen(function* () {
		const { code, options } = yield* Source.parse(input);
		const sandbox = yield* WorkerSandbox.make({ tools: [Lookup] });
		return yield* sandbox.execute(code, { timeoutMs: options.timeoutMs });
	});
```

## Deterministic runs

`sandbox.start` runs a script so that a host can run it again after a restart and get the same behaviour, for
example to resume it from a durable log of its calls' results (Pi's `start`). The run declares its own tools, and its
events are a `Stream`: the VM's fingerprint, each call, and each time the VM waits again. The host answers every
call with `deliver`, numbering the results 1, 2, ... The VM's clock reads `startedAt` and then each answer's `now`,
both from the `Clock` unless given; its randomness comes from `seed`.

```ts
import { Stream } from "effect";
import { InlineSandbox, Run, Wasm } from "@effectified/pi-codemode";

const replayable = Effect.gen(function* () {
	const sandbox = yield* InlineSandbox.make({ wasm: yield* Wasm.load() });
	const run = yield* sandbox.start(`return await tools.read({ path: "a.txt" });`, {
		seed: 7,
		tools: [{ name: "read" }],
	});
				const wasm = yield* Wasm.load();
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				const names: Array<string> = [];
	return yield* run.result; // { ok: true, value: "contents", during: { seq: 1, issued: 1 }, ... }
});
```

A run belongs to the scope it was started in: closing it aborts the run. `deliver` fails with `DeliveryRejected` when
Pi refuses an answer; `start` with `RunRejected` for options Pi refuses. The events (`Run.Event`, a tagged union with
`match` and `guards`) and the answers (`Run.Answer`) are Schemas, so a host can keep them in a durable log. A call's
number is a `Run.CallId`, branded so that a result number is never passed for it. The events wait in an unbounded
buffer: Pi reports them without waiting for the consumer.

## Worker threads

`WorkerSandbox.make` takes Pi's worker options as Effects. `acquireWorker` reserves a worker right before it starts
and succeeds with its release, which runs when the worker exits; failing with `AdmissionDenied` denies admission.
`onWorkerStarted` gets an Effect that waits until the worker exits.

```ts
import { Semaphore } from "effect";
import { AdmissionDenied } from "@effectified/pi-codemode";

const limited = Effect.gen(function* () {
	const workers = yield* Semaphore.make(4); // shared by every sandbox given it
	return yield* WorkerSandbox.make({
		tools: [Lookup],
		acquireWorker: Effect.flatMap(workers.takeIfAvailable(1), (taken) =>
			taken
				? Effect.succeed(workers.release(1))
				: Effect.fail(AdmissionDenied.make({ message: "no free worker" })),
		),
	});
});
```

Pi calls both synchronously, so neither may suspend. A bundled host passes `wasm` (from `Wasm.load(path)`) and
`workerUrl`: a file of its build that imports `@effectified/pi-codemode/worker`. `Sandbox.layer` gives any sandbox as
the service `Sandbox.Current`.

## Cloudflare Workers

`@effectified/pi-codemode/portable` has the sandboxes that need no Node built-ins: `InlineSandbox` (the VM on the
calling thread, stopped by an interrupt budget) and `RemoteSandbox` (the VM on a remote, the tools here).
`@effectified/pi-codemode/cloudflare` adds Wrangler's compiled QuickJS module, `cloudflareQuickJSWasm`, and
`CodemodeSandboxDurableObject`, which a separately deployed sandbox Worker exports, as Pi describes:

```ts
// sandbox/src/index.ts
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@effectified/pi-codemode/cloudflare";
```

The agent's Worker binds it with `script_name` and runs its scripts there:

```ts
import { type CodemodeRemote, RemoteSandbox } from "@effectified/pi-codemode/portable";

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
```

`RemoteSandbox.serve` is the remote end, for a remote of your own. This package's tests run both sandboxes in workerd
(through Miniflare).

## License

MIT
