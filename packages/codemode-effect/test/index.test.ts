import * as PiCodemode from "@earendil-works/pi-codemode";
import type * as PiCloudflare from "@earendil-works/pi-codemode/cloudflare";
import * as PiDeclarations from "@earendil-works/pi-codemode/declarations";
import * as PiPortable from "@earendil-works/pi-codemode/portable";
import * as PiSource from "@earendil-works/pi-codemode/source";
import type * as PiWorker from "@earendil-works/pi-codemode/worker";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Declarations from "../src/declarations.ts";
import * as Package from "../src/index.ts";
import * as Portable from "../src/portable.ts";
import * as Source from "../src/source.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What this package does with every value pi-codemode's root exports. */
const COVERAGE = {
	CODEMODE_OPTIONS_PREFIX: offered,
	CODEMODE_SOURCE_GRAMMAR: offered,
	DEFAULT_INPUT_SCHEMA_MAX_CHARS: offered,
	DEFAULT_INTERRUPT_BUDGET: offered,
	MAX_OUTPUT_CHARS: offered,
	MAX_OUTPUT_ITEMS: offered,
	MAX_STORE_TOTAL_CHARS: offered,
	MAX_STORE_VALUE_CHARS: offered,
	renderDeclarations: offered,
	renderToolOutputType: offered,
	renderToolSample: offered,
	renderToolSignature: offered,
	resolveSchemaRef: offered,
	schemaToType: offered,
	toCodemodeIdentifier: offered,
	CodemodeSandboxBase: replaced("Sandbox.Sandbox: a scoped handle whose executions are Effects; Sandbox.layer"),
	CodemodeSandbox: replaced("WorkerSandbox.make: a scoped worker-thread sandbox with Effect tools and callbacks"),
	InlineCodemodeSandbox: replaced("InlineSandbox.make: a scoped sandbox on the calling thread"),
	RemoteCodemodeSandbox: replaced("RemoteSandbox.make: a scoped sandbox whose remote is an Effect"),
	serveCodemodeRemote: replaced("RemoteSandbox.serve"),
	parseCodemodeSource: replaced("Source.parse: an Effect that fails with CodemodeSourceError"),
	CodemodeSourceError: replaced("CodemodeSourceError: a Schema.TaggedError of the same name"),
	loadQuickJSWasm: replaced("Wasm.load: an Effect that fails with WasmLoadFailed"),
} satisfies Record<keyof typeof PiCodemode, Coverage>;

/** What `@effectified/pi-codemode/portable` does with every value of Pi's `/portable`. */
const PORTABLE_COVERAGE = {
	DEFAULT_INTERRUPT_BUDGET: offered,
	MAX_OUTPUT_CHARS: offered,
	MAX_OUTPUT_ITEMS: offered,
	MAX_STORE_TOTAL_CHARS: offered,
	MAX_STORE_VALUE_CHARS: offered,
	toCodemodeIdentifier: offered,
	CodemodeSandboxBase: COVERAGE.CodemodeSandboxBase,
	InlineCodemodeSandbox: COVERAGE.InlineCodemodeSandbox,
	RemoteCodemodeSandbox: COVERAGE.RemoteCodemodeSandbox,
	serveCodemodeRemote: COVERAGE.serveCodemodeRemote,
} satisfies Record<keyof typeof PiPortable, Coverage>;

/** What `@effectified/pi-codemode/declarations` does with every value of Pi's `/declarations`: pure functions. */
const DECLARATIONS_COVERAGE = {
	DEFAULT_INPUT_SCHEMA_MAX_CHARS: offered,
	renderDeclarations: offered,
	renderToolOutputType: offered,
	renderToolSample: offered,
	renderToolSignature: offered,
	resolveSchemaRef: offered,
	schemaToType: offered,
	toCodemodeIdentifier: offered,
} satisfies Record<keyof typeof PiDeclarations, Coverage>;

/** What `@effectified/pi-codemode/source` does with every value of Pi's `/source`. */
const SOURCE_COVERAGE = {
	CODEMODE_OPTIONS_PREFIX: offered,
	CODEMODE_SOURCE_GRAMMAR: offered,
	CodemodeSourceError: COVERAGE.CodemodeSourceError,
	parseCodemodeSource: replaced("parse"),
} satisfies Record<keyof typeof PiSource, Coverage>;

/**
 * What `@effectified/pi-codemode/cloudflare` does with every value of Pi's `/cloudflare`, which only a Worker built
 * with Wrangler can load: `test/cloudflare.node.test.ts` checks it in workerd.
 */
const CLOUDFLARE_COVERAGE = {
	...PORTABLE_COVERAGE,
	cloudflareQuickJSWasm: offered,
	DEFAULT_REMOTE_MEMORY_LIMIT_BYTES: offered,
	// The class a sandbox Worker exports for Cloudflare to run, the remote end of RemoteSandbox; nothing calls it.
	CodemodeSandboxDurableObject: offered,
	createInlineCodemodeSandbox: replaced("InlineSandbox.make({ wasm: cloudflareQuickJSWasm, ... })"),
} satisfies Record<keyof typeof PiCloudflare, Coverage>;

/** Pi's `/worker` exports nothing: importing it starts a worker, and so does importing `@effectified/pi-codemode/worker`. */
const WORKER_COVERAGE = {} satisfies Record<keyof typeof PiWorker, Coverage>;

/** The names of `ledger`'s entries that are offered. */
function offeredNames(ledger: Record<string, Coverage>): ReadonlyArray<string> {
	return Object.entries(ledger)
		.filter(([, coverage]) => coverage.kind === "offered")
		.map(([name]) => name);
}

describe("the coverage of pi-codemode", () => {
	it("offers every value it records as offered, Pi's own and not copies", () => {
		const entries: ReadonlyArray<readonly [Record<string, Coverage>, object, object]> = [
			[COVERAGE, Package, PiCodemode],
			[PORTABLE_COVERAGE, Portable, PiPortable],
			[DECLARATIONS_COVERAGE, Declarations, PiDeclarations],
			[SOURCE_COVERAGE, Source, PiSource],
		];
		for (const [ledger, ours, pi] of entries) {
			for (const name of offeredNames(ledger)) {
				expect([name, Reflect.get(ours, name)]).toEqual([name, Reflect.get(pi, name)]);
			}
		}
	});

	it("leaves nothing open", () => {
		const ledgers: ReadonlyArray<Record<string, Coverage>> = [
			COVERAGE,
			PORTABLE_COVERAGE,
			DECLARATIONS_COVERAGE,
			SOURCE_COVERAGE,
			CLOUDFLARE_COVERAGE,
			WORKER_COVERAGE,
		];
		expect(ledgers.flatMap((ledger) => Object.values(ledger)).filter((coverage) => coverage.kind === "open")).toEqual(
			[],
		);
	});
});

describe("the exports", () => {
	it("have every Effect form the ledger names", () => {
		expect(Object.keys(Package).sort()).toEqual(
			[
				...offeredNames(COVERAGE),
				"AdmissionDenied",
				"CodemodeSourceError",
				"DeliveryRejected",
				"InlineSandbox",
				"RemoteSandbox",
				"Run",
				"RunRejected",
				"Sandbox",
				"SandboxClosed",
				"SchemaConversionError",
				"ScriptTool",
				"Source",
				"ToolRejected",
				"Wasm",
				"WasmLoadFailed",
				"WorkerSandbox",
			].sort(),
		);
		expect(Object.keys(Package.Sandbox).sort()).toEqual(["Current", "layer"]);
		expect(Object.keys(Package.WorkerSandbox)).toEqual(["make"]);
		expect(Object.keys(Package.InlineSandbox)).toEqual(["make"]);
		expect(Object.keys(Package.RemoteSandbox).sort()).toEqual(["make", "serve"]);
		expect(Object.keys(Package.ScriptTool).sort()).toEqual(["fromAgent", "global"]);
		expect(Object.keys(Package.Source).sort()).toEqual([
			"CODEMODE_OPTIONS_PREFIX",
			"CODEMODE_SOURCE_GRAMMAR",
			"CodemodeSourceError",
			"parse",
		]);
		expect(Object.keys(Package.Wasm)).toEqual(["load"]);
		expect(Object.keys(Package.Run).sort()).toEqual(["Answer", "CallId", "Event", "HostCall", "Outcome"]);
	});

	it("are Pi's functions alone in the declarations entry", () => {
		expect(Object.keys(Declarations).sort()).toEqual(Object.keys(DECLARATIONS_COVERAGE).sort());
	});

	it("keep the portable entry free of the worker-thread sandbox and the file loader", () => {
		expect(Object.keys(Portable).sort()).toEqual(
			[
				...offeredNames(PORTABLE_COVERAGE),
				"AdmissionDenied",
				"CodemodeSourceError",
				"DeliveryRejected",
				"InlineSandbox",
				"RemoteSandbox",
				"Run",
				"RunRejected",
				"Sandbox",
				"SandboxClosed",
				"ScriptTool",
				"ToolRejected",
				"WasmLoadFailed",
			].sort(),
		);
	});
});
