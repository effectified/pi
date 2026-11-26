import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import * as PiDurable from "@earendil-works/pi-durable";
import * as PiCodemode from "@earendil-works/pi-durable/codemode";
import * as PiEnv from "@earendil-works/pi-durable/env";
import * as PiEnvNode from "@earendil-works/pi-durable/env/node";
import * as PiImages from "@earendil-works/pi-durable/images";
import type * as PiImagesCloudflare from "@earendil-works/pi-durable/images/cloudflare";
import * as PiImagesFit from "@earendil-works/pi-durable/images/fit";
import * as PiImagesNode from "@earendil-works/pi-durable/images/node";
import * as PiIndexedDb from "@earendil-works/pi-durable/storage/indexeddb";
import * as PiJsonl from "@earendil-works/pi-durable/storage/jsonl";
import * as PiJsonlNode from "@earendil-works/pi-durable/storage/jsonl/node";
import * as PiMemory from "@earendil-works/pi-durable/storage/memory";
import * as PiSqlite from "@earendil-works/pi-durable/storage/sqlite";
import * as PiSqliteCloudflare from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import * as PiSqliteNode from "@earendil-works/pi-durable/storage/sqlite/node";
import * as PiStore from "@earendil-works/pi-durable/storage/store";
import * as PiTesting from "@earendil-works/pi-durable/testing";
import * as PiToolSearch from "@earendil-works/pi-durable/tool-search";
import * as PiTools from "@earendil-works/pi-durable/tools";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Codemode from "../src/codemode.ts";
import * as Env from "../src/env/index.ts";
import * as EnvNode from "../src/env/node.ts";
import * as ImagesFit from "../src/images/fit.ts";
import * as Images from "../src/images/index.ts";
import * as ImagesNode from "../src/images/node.ts";
import * as Package from "../src/index.ts";
import { type Conversation, Harness, Registry, Storage, Tool } from "../src/index.ts";
import * as IndexedDb from "../src/storage/indexeddb.ts";
import * as Jsonl from "../src/storage/jsonl/index.ts";
import * as JsonlNode from "../src/storage/jsonl/node.ts";
import * as Memory from "../src/storage/memory.ts";
import * as SqliteCloudflare from "../src/storage/sqlite/cloudflare.ts";
import * as Sqlite from "../src/storage/sqlite/index.ts";
import * as SqliteNode from "../src/storage/sqlite/node.ts";
import * as StoreSubpath from "../src/storage/store.ts";
import * as Testing from "../src/testing/index.ts";
import * as ToolSearch from "../src/tool-search.ts";
import * as Tools from "../src/tools.ts";
import { AGENT, answer, scriptedModels } from "./scripted.ts";

class Records extends Context.Service<
	Records,
	{ readonly get: (id: string) => Effect.Effect<{ readonly title: string }> }
>()("test/Records") {}

describe("the target shape of the PRD (section 6.2)", () => {
	it("runs a prompt with a tool, forks at the head and prompts the fork", async () => {
		const Lookup = Tool.make("lookup", {
			description: "Look a record up by id.",
			parameters: Schema.Struct({ id: Schema.String }),
			success: Schema.Struct({ title: Schema.String }),
			replay: "safe",
			handler: ({ id }) => Records.use((records) => records.get(id)),
		});

		const kinds = (conversation: Conversation.Conversation) =>
			Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
				entries.map((entry) => entry.kind),
			);

		const program = Effect.gen(function* () {
			const root = yield* Harness.rootWith({ agent: AGENT });
			yield* root.prompt("Summarise record 42.", { requestId: "summary-42" });
			yield* root.waitForIdle;
			// Unlike the PRD's sketch, `head` is an Option: an empty conversation has none.
			const head = Option.getOrThrow(yield* root.head);
			const branch = yield* root.fork({ at: head, ownership: { kind: "ownerless" } });
			const opposite = yield* branch.prompt("Now argue the opposite.", { requestId: "opposite-42" });
			yield* branch.waitForIdle;
			return { opposite, root: yield* kinds(root), branch: yield* kinds(branch) };
		});

		const live = Harness.layer({ settings: {} }).pipe(
			Layer.provide(Registry.layer([{ name: "app", tools: [Lookup] }])),
			Layer.provide(Storage.memory),
			Layer.provide(
				scriptedModels([
					fauxAssistantMessage([fauxToolCall("lookup", { id: "42" })], { stopReason: "toolUse" }),
					answer("Record 42 is titled Answer."),
					answer("Record 42 is not titled Answer."),
				]).layer,
			),
			Layer.provide(Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) })),
		);

		const result = await Effect.runPromise(Effect.provide(program, live));
		const answered = ["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"];
		expect(result.opposite).toMatchObject({ requestId: "opposite-42", status: "done" });
		expect(result.root).toEqual(answered);
		expect(result.branch).toEqual([...answered, "pi.user", "pi.assistant"]);
	});
});

describe("the exports", () => {
	it("are the modules and errors of slices one to four, and Pi's built-in entry and task tokens", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"Agent",
			"AssistantEntry",
			"BuiltinDoc",
			"Cancelled",
			"CompactionEntry",
			"CompactionTask",
			"Conversation",
			"ConversationBusy",
			"ConversationIdle",
			"DEFAULT_COMPACTION_POLICY",
			"DEFAULT_HARNESS_IDENTITY",
			"DEFAULT_PROGRESS_POLICY",
			"DEFAULT_RESTART_LIMIT",
			"DEFAULT_RETRY_POLICY",
			"DURABLE_TELEMETRY_SCHEMA",
			"Doc",
			"Entry",
			"Extension",
			"Gate",
			"GenerationTask",
			"Harness",
			"Hook",
			"Idle",
			"ParentContext",
			"ReadAfterWrite",
			"ReadOnlySession",
			"Registry",
			"ResetEntry",
			"Scans",
			"SchemaConversionError",
			"SchemaDecodeError",
			"Section",
			"SessionFailed",
			"Signal",
			"Storage",
			"StorageRequestError",
			"Submission",
			"SystemEntry",
			"Task",
			"TaskHooks",
			"Tool",
			"ToolResultEntry",
			"ToolTask",
			"Transcript",
			"Tx",
			"UnexpectedError",
			"UserEntry",
			"Watch",
		]);
		expect(Object.keys(Package.Harness).sort()).toEqual([
			"Harness",
			"abortSubmission",
			"abortTask",
			"closed",
			"closing",
			"commit",
			"commits",
			"conversation",
			"conversationRecord",
			"createConversation",
			"getTask",
			"getTaskOf",
			"inspect",
			"isConversationIdle",
			"isIdle",
			"layer",
			"layerOn",
			"observeConversation",
			"observeDoc",
			"observeTaskGraph",
			"reports",
			"resume",
			"root",
			"rootWith",
			"scanConversations",
			"scanTasks",
			"signal",
			"signalState",
			"snapshot",
			"snapshotAsOf",
			"submission",
			"taskGraph",
			"usage",
			"usageEvents",
			"waitForIdle",
			"waitForTask",
			"waitForTaskOf",
			"wake",
			"wakes",
			"watchDoc",
		]);
	});

	it("hold what products reached around the package for: built-in documents, scans, idle reads, ids, the settlement signal", () => {
		expect(Object.keys(Package.BuiltinDoc).sort()).toEqual([
			"agent",
			"inbox",
			"live",
			"nestedCall",
			"provider",
			"usage",
		]);
		expect(Object.keys(Package.Scans).sort()).toEqual(["conversations", "tasks"]);
		expect(Object.keys(Package.Idle).sort()).toEqual(["quiet"]);
		expect(Object.keys(Package.Signal).sort()).toEqual(["SubmissionSettled", "make", "read", "stateIn", "toPiKey"]);
		expect(Object.keys(Package.Watch).sort()).toEqual(["commits", "observed", "stream"]);
		// Each id schema keeps the number Pi stores and refuses anything else.
		const ids = [Package.Conversation.Id, Package.Entry.Id, Package.Submission.Id, Package.Task.Id];
		expect(ids.map((id) => Schema.decodeSync(id)(7))).toEqual([7, 7, 7, 7]);
		expect(ids.map((id) => Schema.is(id)("7"))).toEqual([false, false, false, false]);
		// The types a product names without a second import: a memo function, and the JSON Pi stores.
		const memo: Equal<Package.Memo, Package.Hook.Api["memo"]> = true;
		const json: Equal<Package.JsonObject, { [key: string]: Package.JsonValue }> = true;
		expect([memo, json]).toEqual([true, true]);
	});
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What this package does with every value Pi Durable exports: the list of what is left to put in Effect terms. */
const COVERAGE = {
	defineDoc: replaced("Doc.make"),
	defineDocFamily: replaced("Doc.family"),
	defineEntry: replaced("Entry.make"),
	defineExtension: replaced("Extension.make"),
	defineSignal: replaced("Signal.make"),
	defineTask: replaced("Task.make"),
	defineTool: replaced("Tool.make"),
	hook: replaced("Hook (beforeRequest, afterResponse, onYield, ...)"),
	hookTask: replaced("Hook.task: the tasks a hook's handler returns"),
	CompactionTask: offered,
	GenerationTask: offered,
	ToolTask: offered,
	createRegistry: replaced("Registry.layer"),
	createSession: replaced("Harness.layer"),
	MemoryStorage: replaced("Storage.memory"),
	configure: replaced("Conversation.configure and tx.configure"),
	SubmissionSettled: replaced("Signal.SubmissionSettled"),
	ROOT_CONVERSATION_ID: replaced("Harness.root"),
	AgentDoc: replaced("BuiltinDoc.agent"),
	InboxDoc: replaced("BuiltinDoc.inbox"),
	LiveDoc: replaced("BuiltinDoc.live"),
	ProviderDoc: replaced("BuiltinDoc.provider"),
	UsageDoc: replaced("BuiltinDoc.usage"),
	Harness: replaced("Harness"),
	ConversationBusy: replaced("ConversationBusy"),
	ConversationIdle: replaced("ConversationIdle"),
	ReadAfterWrite: replaced("ReadAfterWrite"),
	ReadOnlySession: replaced("ReadOnlySession"),
	SessionFailed: replaced("SessionFailed"),
	StorageRequestError: replaced("StorageRequestError"),
	AssistantEntry: offered,
	CompactionEntry: offered,
	ResetEntry: offered,
	SystemEntry: offered,
	ToolResultEntry: offered,
	UserEntry: offered,
	DEFAULT_COMPACTION_POLICY: offered,
	DEFAULT_PROGRESS_POLICY: offered,
	DEFAULT_RESTART_LIMIT: offered,
	DEFAULT_RETRY_POLICY: offered,
	DEFAULT_HARNESS_IDENTITY: offered,
	DURABLE_TELEMETRY_SCHEMA: offered,
	section: replaced("Section.make"),
	wrapSection: replaced("Section.wrap"),
	wrapTool: replaced("Tool.wrap"),
	NestedCallDoc: replaced("BuiltinDoc.nestedCall"),
	ConversationTranscript: replaced("Transcript"),
	registryReader: replaced("Registry.reader, which Harness.layerOn opens on"),
} satisfies Record<keyof typeof PiDurable, Coverage>;

/** `@earendil-works/pi-durable/env`: the environment contract. */
const ENV_COVERAGE = {
	ok: offered,
	err: offered,
	getOrUndefined: offered,
	toError: offered,
	startsWithBom: offered,
	FileError: offered,
	ExecutionError: offered,
	getOrThrow: replaced("fromResult"),
	rangeDecoder: replaced("decodeRange"),
	StreamDecoder: replaced("decodeText"),
	LineScanner: replaced("scanLines"),
} satisfies Record<keyof typeof PiEnv, Coverage>;

/** `@earendil-works/pi-durable/env/node`. */
const ENV_NODE_COVERAGE = {
	NodeExecutionEnv: replaced("make: the environment, cleaned up with its scope"),
} satisfies Record<keyof typeof PiEnvNode, Coverage>;

/** `@earendil-works/pi-durable/codemode`. */
const CODEMODE_COVERAGE = {
	CODEMODE_MODULE_VERSION: offered,
	CODEMODE_TOOL_NAME: offered,
	DEFAULT_CODEMODE_INLINE_BUDGET: offered,
	namespacesOf: offered,
	CodemodeStoreDoc: replaced("store"),
	createCodemodeTool: replaced("tool: on a sandbox of @effectified/pi-codemode"),
	createCodemodeExtension: replaced("extension: on a sandbox of @effectified/pi-codemode"),
} satisfies Record<keyof typeof PiCodemode, Coverage>;

/** `@earendil-works/pi-durable/tool-search`. */
const TOOL_SEARCH_COVERAGE = {
	DEFAULT_TOOL_SEARCH_LIMIT: offered,
	TOOL_SEARCH_TOOL_NAME: offered,
	createToolSearchTool: replaced("tool"),
	createToolSearchExtension: replaced("extension"),
} satisfies Record<keyof typeof PiToolSearch, Coverage>;

/** `@earendil-works/pi-durable/tools`. */
const TOOLS_COVERAGE = {
	DEFAULT_IMAGE_LIMITS: offered,
	imageLimits: offered,
	createReadTool: replaced("read: images prepared by an Effect processor"),
	createWriteTool: replaced("write"),
	createEditTool: replaced("edit"),
	createBashTool: replaced("bash: a command's preparation as an Effect"),
	createPowerShellTool: replaced("powershell: a command's preparation as an Effect"),
	createCodingTools: replaced("coding"),
	CodingTools: replaced("coding"),
} satisfies Record<keyof typeof PiTools, Coverage>;

/** `@earendil-works/pi-durable/images`. */
const IMAGES_COVERAGE = {
	createPhotonImages: replaced("photon"),
} satisfies Record<keyof typeof PiImages, Coverage>;

/** `@earendil-works/pi-durable/images/fit`. */
const IMAGES_FIT_COVERAGE = {
	fitImage: replaced("fitImage"),
	fitImages: replaced("fitImages"),
	createFitImagesExtension: replaced("extension"),
} satisfies Record<keyof typeof PiImagesFit, Coverage>;

/** `@earendil-works/pi-durable/images/node`. */
const IMAGES_NODE_COVERAGE = {
	createNodePhotonImages: replaced("nodePhoton"),
} satisfies Record<keyof typeof PiImagesNode, Coverage>;

/**
 * `@earendil-works/pi-durable/images/cloudflare`, which imports a module only Wrangler provides: recorded by type here
 * (`ImagesCloudflareReplaced` of `pi-conformance.ts` checks the replacement), run in workerd by
 * `test/images/cloudflare.node.test.ts`.
 */
const IMAGES_CLOUDFLARE_COVERAGE = {
	createCloudflarePhotonImages: replaced("cloudflarePhoton"),
} satisfies Record<keyof typeof PiImagesCloudflare, Coverage>;

/** `@earendil-works/pi-durable/storage/memory`. */
const MEMORY_COVERAGE = {
	MemoryStorage: replaced("memory"),
} satisfies Record<keyof typeof PiMemory, Coverage>;

/** `@earendil-works/pi-durable/storage/indexeddb`. */
const INDEXEDDB_COVERAGE = {
	IndexedDbStorage: replaced("indexedDb"),
} satisfies Record<keyof typeof PiIndexedDb, Coverage>;

/** `@earendil-works/pi-durable/storage/jsonl`. */
const JSONL_COVERAGE = {
	JsonlStorage: replaced("jsonl"),
	JsonlCorruptionError: replaced("JsonlCorrupted"),
	JsonlStorageReadOnlyError: replaced("JsonlReadOnly"),
	JsonlStoragePoisonedError: replaced("JsonlPoisoned"),
} satisfies Record<keyof typeof PiJsonl, Coverage>;

/** `@earendil-works/pi-durable/storage/jsonl/node`. */
const JSONL_NODE_COVERAGE = {
	openNodeJsonlStorage: replaced("nodeJsonl"),
	JsonlStorage: replaced("nodeJsonl"),
	JsonlStorageReadOnlyError: replaced("JsonlReadOnly"),
} satisfies Record<keyof typeof PiJsonlNode, Coverage>;

/** `@earendil-works/pi-durable/storage/store`. */
const STORE_COVERAGE = {
	StoreStorage: replaced("store: on a store of @effectified/pi-chord's Store.open"),
} satisfies Record<keyof typeof PiStore, Coverage>;

/** `@earendil-works/pi-durable/storage/sqlite`. */
const SQLITE_COVERAGE = {
	CURRENT_SQLITE_SCHEMA_VERSION: offered,
	SQLITE_MIGRATIONS: offered,
	SqliteStorage: replaced("sqlite"),
	applySqliteMigrations: replaced("applyMigrations"),
} satisfies Record<keyof typeof PiSqlite, Coverage>;

/** `@earendil-works/pi-durable/storage/sqlite/cloudflare`, run in workerd by its test. */
const SQLITE_CLOUDFLARE_COVERAGE = {
	openDurableObjectSqliteStorage: replaced("durableObject"),
	DurableObjectSqliteDatabase: replaced("database"),
} satisfies Record<keyof typeof PiSqliteCloudflare, Coverage>;

/** `@earendil-works/pi-durable/storage/sqlite/node`. */
const SQLITE_NODE_COVERAGE = {
	openNodeSqliteStorage: replaced("nodeSqlite"),
	openNodeSqliteDatabase: replaced("openNodeSqliteDatabase: @effectified/pi-chord's scoped database"),
	NodeSqliteDatabase: replaced("openNodeSqliteDatabase"),
} satisfies Record<keyof typeof PiSqliteNode, Coverage>;

/** `@earendil-works/pi-durable/testing`. */
const TESTING_COVERAGE = {
	createExpectAssertions: offered,
	STORAGE_MEMORY_SCALES: offered,
	TIMING_SCALE: offered,
	storageBenchmarkPrimaryRecordCount: offered,
	commitWrites: replaced("Benchmark.commitWrites"),
	createStorageConformance: replaced("storageConformance: each case an Effect"),
	registerStorageConformance: replaced("storageConformance"),
	createEnvConformance: replaced("envConformance: each case an Effect"),
	registerEnvConformance: replaced("envConformance"),
	seedStorageBenchmark: replaced("Benchmark.seed"),
	seedStorageWriteBenchmark: replaced("Benchmark.seedWrites"),
	STORAGE_READ_BENCHMARKS: replaced("Benchmark.reads"),
	STORAGE_WRITE_BENCHMARKS: replaced("Benchmark.writes"),
} satisfies Record<keyof typeof PiTesting, Coverage>;

/** Each ledger: its Pi entry point, its record, Pi's module and this package's entry. */
const LEDGERS = [
	["pi-durable", COVERAGE, PiDurable, Package],
	["pi-durable/env", ENV_COVERAGE, PiEnv, Env],
	["pi-durable/env/node", ENV_NODE_COVERAGE, PiEnvNode, EnvNode],
	["pi-durable/codemode", CODEMODE_COVERAGE, PiCodemode, Codemode],
	["pi-durable/tool-search", TOOL_SEARCH_COVERAGE, PiToolSearch, ToolSearch],
	["pi-durable/tools", TOOLS_COVERAGE, PiTools, Tools],
	["pi-durable/images", IMAGES_COVERAGE, PiImages, Images],
	["pi-durable/images/fit", IMAGES_FIT_COVERAGE, PiImagesFit, ImagesFit],
	["pi-durable/images/node", IMAGES_NODE_COVERAGE, PiImagesNode, ImagesNode],
	["pi-durable/storage/memory", MEMORY_COVERAGE, PiMemory, Memory],
	["pi-durable/storage/indexeddb", INDEXEDDB_COVERAGE, PiIndexedDb, IndexedDb],
	["pi-durable/storage/jsonl", JSONL_COVERAGE, PiJsonl, Jsonl],
	["pi-durable/storage/jsonl/node", JSONL_NODE_COVERAGE, PiJsonlNode, JsonlNode],
	["pi-durable/storage/store", STORE_COVERAGE, PiStore, StoreSubpath],
	["pi-durable/storage/sqlite", SQLITE_COVERAGE, PiSqlite, Sqlite],
	["pi-durable/storage/sqlite/cloudflare", SQLITE_CLOUDFLARE_COVERAGE, PiSqliteCloudflare, SqliteCloudflare],
	["pi-durable/storage/sqlite/node", SQLITE_NODE_COVERAGE, PiSqliteNode, SqliteNode],
	["pi-durable/testing", TESTING_COVERAGE, PiTesting, Testing],
] as const;

describe.each(LEDGERS)("the coverage of %s", (_name, coverage, pi, ours) => {
	const entries: ReadonlyArray<readonly [string, Coverage]> = Object.entries(coverage);

	it("offers Pi's own value for every entry it records as offered", () => {
		const exported: Record<string, unknown> = ours;
		const piValues: Record<string, unknown> = pi;
		const wrong = entries
			.filter(([name, entry]) => entry.kind === "offered" && exported[name] !== piValues[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});

	it("exports the Effect form every replaced entry names first", () => {
		const names = new Set(Object.keys(ours));
		const missing = entries.flatMap(([name, entry]) => {
			if (entry.kind !== "replaced") return [];
			const first = /^[A-Za-z_$][\w$]*/.exec(entry.by)?.[0] ?? "";
			return names.has(first) ? [] : [`${name}: ${entry.by}`];
		});
		expect(missing).toEqual([]);
	});
});

describe("the open entries", () => {
	it("are none", () => {
		const records: ReadonlyArray<readonly [string, Record<string, Coverage>]> = [
			...LEDGERS.map(([name, coverage]) => [name, coverage] as const),
			["pi-durable/images/cloudflare", IMAGES_CLOUDFLARE_COVERAGE],
		];
		const opened = records.flatMap(([name, coverage]) =>
			Object.entries(coverage).flatMap(([entry, record]: readonly [string, Coverage]) =>
				record.kind === "open" ? [`${name} ${entry}`] : [],
			),
		);
		expect(opened).toEqual([]);
	});
});
