import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type * as PiDurable from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";
import { type Conversation, Harness, Registry, Storage, Tool } from "../src/index.ts";
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
			"SessionFailed",
			"Signal",
			"Storage",
			"StorageRequestError",
			"Submission",
			"SystemEntry",
			"Task",
			"Tool",
			"ToolResultEntry",
			"ToolTask",
			"Tx",
			"UnexpectedError",
			"UserEntry",
			"Watch",
		]);
		expect(Object.keys(Package.Harness).sort()).toEqual([
			"Harness",
			"abortSubmission",
			"abortTask",
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
		expect(Object.keys(Package.BuiltinDoc).sort()).toEqual(["agent", "inbox", "live", "provider", "usage"]);
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
const open = (why: string): Coverage => ({ kind: "open", why });
const DEFAULT = open("Pi's defaults: not re-exported; `Agent` creation leaves a setting out to get it");

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
	hookTask: replaced("the tasks a Hook handler returns"),
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
	DEFAULT_COMPACTION_POLICY: DEFAULT,
	DEFAULT_PROGRESS_POLICY: DEFAULT,
	DEFAULT_RESTART_LIMIT: DEFAULT,
	DEFAULT_RETRY_POLICY: DEFAULT,
	DEFAULT_HARNESS_IDENTITY: DEFAULT,
	section: open("prompt sections: not wrapped (COMPAT.md)"),
	wrapSection: open("prompt section wrappers: not wrapped (COMPAT.md)"),
	wrapTool: open("tool wrappers: not wrapped (COMPAT.md)"),
	registryReader: open("a read-only view of a registry: not wrapped"),
	NestedCallDoc: open("the nested-call document: not wrapped"),
	ConversationTranscript: open("the transcript reader: not wrapped"),
	DURABLE_TELEMETRY_SCHEMA: open("Pi Durable's telemetry schema: not re-exported"),
} satisfies Record<keyof typeof PiDurable, Coverage>;

describe("the coverage of Pi Durable", () => {
	it("offers every value it records as offered, so the record stays true", () => {
		const ours = new Set(Object.keys(Package));
		const missing = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && !ours.has(name))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});
});
