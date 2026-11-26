import { readFileSync } from "node:fs";
import * as PiChord from "@earendil-works/chord";
import type * as PiApp from "@earendil-works/chord/app";
import type * as PiAppFiles from "@earendil-works/chord/app/files";
import type * as PiCompression from "@earendil-works/chord/compression";
import type * as PiHttp from "@earendil-works/chord/http";
import type * as PiPlugins from "@earendil-works/chord/plugins";
import type * as PiPluginsRuntime from "@earendil-works/chord/plugins/runtime";
import type * as PiReact from "@earendil-works/chord/react";
import type * as PiSqliteCloudflare from "@earendil-works/chord/sqlite/cloudflare";
import type * as PiSurfaces from "@earendil-works/chord/surfaces";
import type * as PiSync from "@earendil-works/chord/sync";
import type * as PiTelemetryIngest from "@earendil-works/chord/telemetry-ingest";
import type * as PiTelemetrySqlite from "@earendil-works/chord/telemetry-sqlite";
import type * as PiTelemetrySqliteNode from "@earendil-works/chord/telemetry-sqlite/node";
import type * as PiTui from "@earendil-works/chord/tui";
import type * as PiTuiLauncher from "@earendil-works/chord/tui/launcher";
import type * as PiWeb from "@earendil-works/chord/web";
import type * as PiWorkers from "@earendil-works/chord/workers";
import type * as PiWorkersChild from "@earendil-works/chord/workers/child";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });
const open = (why: string): Coverage => ({ kind: "open", why });

const INTERNAL = open(
	"marked internal by Chord: the store's surface for adapters, which Pi Durable's StoreStorage uses and an " +
		"application never calls; an application reaches it as Storage.store of @effectified/pi-durable/storage/store",
);

/** What this package does with every value Chord's root exports: the list of what is left to put in Effect terms. */
const COVERAGE = {
	// Contracts and their schemas.
	memberNames: offered,
	local: offered,
	remote: offered,
	evolve: offered,
	hostKind: offered,
	arr: offered,
	bool: offered,
	bytes: offered,
	event: offered,
	int: offered,
	keyed: offered,
	lit: offered,
	map: offered,
	method: offered,
	nul: offered,
	num: offered,
	obj: offered,
	oneOf: offered,
	opt: offered,
	queries: offered,
	str: offered,
	union: offered,
	unknown: offered,
	// Errors a method declares and throws.
	ChordError: offered,
	forbidden: offered,
	invalid: offered,
	isChordError: offered,
	PluginError: offered,
	broken: offered,
	// State, registries, admission, jobs.
	mapShared: offered,
	constant: offered,
	keyedEntries: offered,
	orderedEntries: offered,
	defineRegistry: offered,
	defineState: offered,
	defineJob: offered,
	allow: offered,
	deny: offered,
	// Links.
	binaryCodec: offered,
	textCodec: offered,
	describeMessage: offered,
	ipcLink: replaced("Link.ipc: scoped"),
	memoryLinkPair: replaced("Link.memoryPair: scoped"),
	webSocketLink: replaced("Link.webSocket: scoped"),
	// Hosts and facets.
	// A facet with Effect handlers is Facet.make; defineFacet stays for one without them.
	defineFacet: offered,
	createHost: replaced("Host.make: scoped, its calls Effects, its errors a Stream"),
	LoadedFacets: replaced("Facet.loadSet"),
	evaluateRegistered: replaced("Facet.evaluate: fails with ScriptFailed"),
	localeChoiceFacet: offered,
	themeChoiceFacet: offered,
	themesFacet: offered,
	translationsFacet: offered,
	sleep: replaced("Effect.sleep on the Clock, raced with ChordContext.aborted of @effectified/pi-chord/context"),
	untilAborted: replaced("ChordContext.aborted of @effectified/pi-chord/context"),
	// Tables, queries and the store.
	sqliteBackend: offered,
	defineColumns: offered,
	defineTable: offered,
	evolveTable: offered,
	query: offered,
	host: offered,
	json: offered,
	compareText: offered,
	add: offered,
	and: offered,
	coalesce: offered,
	compile: offered,
	concat: offered,
	eq: offered,
	exists: offered,
	existsNode: offered,
	gt: offered,
	gte: offered,
	inArray: offered,
	isNull: offered,
	lt: offered,
	lte: offered,
	max: offered,
	min: offered,
	ne: offered,
	not: offered,
	or: offered,
	prefix: offered,
	replacePrefix: offered,
	sub: offered,
	when: offered,
	openStore: replaced("Store.open: scoped, closed with its scope"),
	importStore: replaced("Store.importArchive: scoped, its parts a Stream"),
	exportHostData: replaced("Store.hostArchive: a Stream of archive parts"),
	readHostArchive: replaced("Store.readHostArchive: its parts a Stream"),
	decodeJsonl: replaced("Store.decodeJsonl: Stream to Stream"),
	encodeJsonl: replaced("Store.encodeJsonl: Stream to Stream"),
	// Surfaces: clients, languages, themes, messages, scripts.
	startClient: replaced("Client.start: scoped, its callbacks Effects, its connection and errors Streams"),
	keepConnected: replaced("Client.keepConnected: scoped, on the Clock, its states a Stream"),
	followActiveLanguage: replaced("Client.activeLanguage: a Stream"),
	followActiveTheme: replaced("Client.activeTheme: a Stream"),
	hostLanguage: replaced("Client.hostLanguage, a Stream, and Client.setHostLanguage"),
	formatNumber: offered,
	formatTime: offered,
	createLanguage: offered,
	defineMessages: offered,
	MessageSchema: offered,
	LocaleChoice: offered,
	ThemeChoice: offered,
	TuiScripts: offered,
	WebScripts: offered,
	ScriptSet: offered,
	REGISTER: offered,
	registeredSource: offered,
	activeTheme: offered,
	BASE_ROLES: offered,
	FALLBACK_THEMES: offered,
	Themes: offered,
	terminalColor: offered,
	themeVariables: offered,
	Translations: offered,
	CHORD_TELEMETRY_SCHEMA: offered,
	// The store's surface for adapters, marked internal by Chord.
	OwnerTable: INTERNAL,
	StoreOwnerTables: INTERNAL,
	applyBatch: INTERNAL,
	findDocument: INTERNAL,
	findDocumentEntry: INTERNAL,
	insertDocument: INTERNAL,
	listDocumentEntries: INTERNAL,
	listDocuments: INTERNAL,
	loadContent: INTERNAL,
	loadDocument: INTERNAL,
	readDocument: INTERNAL,
	readDocumentEntry: INTERNAL,
	retireRecord: INTERNAL,
	writeContent: INTERNAL,
} satisfies Record<keyof typeof PiChord, Coverage>;

// The subpaths this package does not export. Each is recorded value by value, so a value Chord adds to one fails the
// type check until it is decided; the reason is the subpath's. `/context`, `/delta`, `/json`, `/output`, `/sqlite`,
// `/sqlite/node` and `/watch` are this package's subpaths, recorded in their own test files.

const HTTP = open(
	"the HTTP component of a Chord app server: a fetch handler made of what plugins contribute to a host",
);
const HTTP_COVERAGE = {
	Authenticators: HTTP,
	Http: HTTP,
	HttpFailure: HTTP,
	HttpListener: HTTP,
	cookie: HTTP,
	createHttp: HTTP,
	fileResponse: HTTP,
	nodeRequest: HTTP,
	readCookie: HTTP,
	readSignedCookie: HTTP,
} satisfies Record<keyof typeof PiHttp, Coverage>;
const COMPRESSION_COVERAGE = { nodeCompression: HTTP } satisfies Record<keyof typeof PiCompression, Coverage>;

const WORKERS = open("the forked worker processes of a Chord app's host kinds, started and stopped by its server");
const WORKERS_COVERAGE = {
	createWorkers: WORKERS,
	nodeBaseInputs: WORKERS,
	processLock: WORKERS,
	workerMain: WORKERS,
} satisfies Record<keyof typeof PiWorkers, Coverage>;
const WORKERS_CHILD_COVERAGE = { processLock: WORKERS, workerMain: WORKERS } satisfies Record<
	keyof typeof PiWorkersChild,
	Coverage
>;

const PLUGINS = open("Chord's plugins: found, built with esbuild, evaluated and hot-reloaded into a host's facets");
const PLUGINS_COVERAGE = {
	PluginError: PLUGINS,
	buildFacet: PLUGINS,
	createPluginRuntime: PLUGINS,
	createPlugins: PLUGINS,
	discoverPlugins: PLUGINS,
	evaluateFacet: PLUGINS,
	installDependencies: PLUGINS,
	installPlugin: PLUGINS,
	mapStack: PLUGINS,
	pluginFile: PLUGINS,
	testPlugin: PLUGINS,
} satisfies Record<keyof typeof PiPlugins, Coverage>;
const PLUGINS_RUNTIME_COVERAGE = { PluginError: PLUGINS, createPluginRuntime: PLUGINS } satisfies Record<
	keyof typeof PiPluginsRuntime,
	Coverage
>;

const APP = open(
	"Chord's app kit: a server and its workers, sign-ins, files, export and import, built on the host runtime",
);
const APP_COVERAGE = {
	ARCHIVE_FORMAT: APP,
	AppInfo: APP,
	Files: APP,
	FilesFolder: APP,
	SIGN_IN_COOKIE: APP,
	Server: APP,
	SignIns: APP,
	WorkerInfo: APP,
	appInfoFacet: APP,
	copyFiles: APP,
	defineUsers: APP,
	ephemeralLoginFacet: APP,
	filesFacet: APP,
	inviteFacet: APP,
	privateDirectory: APP,
	privateStore: APP,
	startServer: APP,
	startWorker: APP,
	workerInfoFacet: APP,
} satisfies Record<keyof typeof PiApp, Coverage>;
const APP_FILES_COVERAGE = {
	Files: APP,
	FilesFolder: APP,
	copyFiles: APP,
	filesFacet: APP,
	privateDirectory: APP,
	privateStore: APP,
} satisfies Record<keyof typeof PiAppFiles, Coverage>;

const WEB = open("the browser side of Chord's web surface: a page that follows its host");
const WEB_COVERAGE = {
	followLanguage: WEB,
	followThemes: WEB,
	pageEnvironment: WEB,
	startPage: WEB,
} satisfies Record<keyof typeof PiWeb, Coverage>;

const SURFACES = open("the server side of Chord's client surfaces: bundles and scripts built for pages and terminals");
const SURFACES_COVERAGE = {
	TUI_PREFIX: SURFACES,
	WEB_PREFIX: SURFACES,
	buildBase: SURFACES,
	pageBootstrap: SURFACES,
	pageScripts: SURFACES,
	processConditions: SURFACES,
	tuiSurface: SURFACES,
	webSurface: SURFACES,
} satisfies Record<keyof typeof PiSurfaces, Coverage>;

const REACT = open("React bindings: components and hooks are React's model of state, which Effect does not replace");
const REACT_COVERAGE = {
	HostProvider: REACT,
	useEvents: REACT,
	useHold: REACT,
	useHost: REACT,
	useMessages: REACT,
	usePageState: REACT,
	useRefState: REACT,
	useRegistry: REACT,
	useVariant: REACT,
	useWatch: REACT,
	watchStore: REACT,
} satisfies Record<keyof typeof PiReact, Coverage>;

const TUI = open("the terminal surface of a Chord app: its sandboxed runtime and the launcher that starts it");
const TUI_COVERAGE = {
	BridgeTerminal: TUI,
	TerminalTheme: TUI,
	TuiScope: TUI,
	startTerminalRuntime: TUI,
} satisfies Record<keyof typeof PiTui, Coverage>;
const TUI_LAUNCHER_COVERAGE = {
	filterOutput: TUI,
	requireSandboxNode: TUI,
	startTerminal: TUI,
	terminalFile: TUI,
} satisfies Record<keyof typeof PiTuiLauncher, Coverage>;

const SYNC = open("session sync over the outbox of Chord's store, which is not wrapped");
const SYNC_COVERAGE = {
	APPLY_BYTES: SYNC,
	BATCH_BYTES: SYNC,
	FileSyncStateStore: SYNC,
	FileSystemSyncRemote: SYNC,
	FlushScheduler: SYNC,
	HistoryUnavailableError: SYNC,
	LOG_START: SYNC,
	LOG_VERSION: SYNC,
	LogFormatError: SYNC,
	OutboxUnavailableError: SYNC,
	SYNC_PROTOCOL: SYNC,
	UnsyncedCommitsError: SYNC,
	checkSessionId: SYNC,
	decodeBatch: SYNC,
	decodeBatchLines: SYNC,
	decodeLogLine: SYNC,
	decodeSnapshot: SYNC,
	encodeBatch: SYNC,
	encodeLogLine: SYNC,
	encodeSnapshot: SYNC,
	foldSession: SYNC,
	pullSession: SYNC,
	readOutbox: SYNC,
	remoteHead: SYNC,
	remoteHistory: SYNC,
	storeHead: SYNC,
	uploadSession: SYNC,
} satisfies Record<keyof typeof PiSync, Coverage>;

const SQLITE_CLOUDFLARE_COVERAGE = {
	DurableObjectSqliteDatabase: open(
		"needs a Durable Object's SQL storage, which only workerd provides; these tests run on Node and Bun",
	),
} satisfies Record<keyof typeof PiSqliteCloudflare, Coverage>;

const TELEMETRY = open(
	"Chord's own telemetry store and ingest; @effectified/pi-telemetry sends Pi telemetry to Effect's exporters instead",
);
const TELEMETRY_SQLITE_COVERAGE = { createSqliteTelemetry: TELEMETRY } satisfies Record<
	keyof typeof PiTelemetrySqlite,
	Coverage
>;
const TELEMETRY_SQLITE_NODE_COVERAGE = { openTelemetryStore: TELEMETRY } satisfies Record<
	keyof typeof PiTelemetrySqliteNode,
	Coverage
>;
const TELEMETRY_INGEST_COVERAGE = {
	PAGE_BATCH_SPANS: TELEMETRY,
	PAGE_SPANS_PER_MINUTE: TELEMETRY,
	PageBatch: TELEMETRY,
	PageTelemetry: TELEMETRY,
	TelemetryRecorder: TELEMETRY,
	WORKER_BATCH_ROWS: TELEMETRY,
	WorkerBatch: TELEMETRY,
	WorkerTelemetry: TELEMETRY,
	sendPageTelemetry: TELEMETRY,
	sendWorkerTelemetry: TELEMETRY,
	telemetryIngestFacet: TELEMETRY,
} satisfies Record<keyof typeof PiTelemetryIngest, Coverage>;

/** Every subpath this package does not export, by its name in Chord's `exports`. */
const SUBPATHS: Record<string, Record<string, Coverage>> = {
	"./http": HTTP_COVERAGE,
	"./compression": COMPRESSION_COVERAGE,
	"./workers": WORKERS_COVERAGE,
	"./workers/child": WORKERS_CHILD_COVERAGE,
	"./plugins": PLUGINS_COVERAGE,
	"./plugins/runtime": PLUGINS_RUNTIME_COVERAGE,
	"./app": APP_COVERAGE,
	"./app/files": APP_FILES_COVERAGE,
	"./web": WEB_COVERAGE,
	"./surfaces": SURFACES_COVERAGE,
	"./react": REACT_COVERAGE,
	"./tui": TUI_COVERAGE,
	"./tui/launcher": TUI_LAUNCHER_COVERAGE,
	"./sync": SYNC_COVERAGE,
	"./sqlite/cloudflare": SQLITE_CLOUDFLARE_COVERAGE,
	"./telemetry-sqlite": TELEMETRY_SQLITE_COVERAGE,
	"./telemetry-sqlite/node": TELEMETRY_SQLITE_NODE_COVERAGE,
	"./telemetry-ingest": TELEMETRY_INGEST_COVERAGE,
};

/** The subpaths this package exports, each recorded in the test file of its source. */
const WRAPPED = ["./context", "./delta", "./json", "./output", "./sqlite", "./sqlite/node", "./watch"];

describe("the coverage of Chord", () => {
	it("offers every value of Chord's root it records as offered, Chord's own and not copies", () => {
		const ours: Record<string, unknown> = Package;
		const pi: Record<string, unknown> = PiChord;
		const wrong = Object.entries(COVERAGE)
			.filter(([name, coverage]) => coverage === offered && ours[name] !== pi[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});

	it("records every subpath of Chord, wrapped or open, and exports each wrapped one", () => {
		expect([...WRAPPED, ...Object.keys(SUBPATHS)].sort()).toEqual(subpathsOf("../../chord/package.json"));
		expect(WRAPPED).toEqual(subpathsOf("../package.json"));
	});
});

/** The subpaths a manifest exports, sorted, without the root and the manifest itself. */
function subpathsOf(manifest: string): string[] {
	// Trust boundary: a manifest is a file, read as untyped JSON.
	const exports: Record<string, unknown> = JSON.parse(
		readFileSync(new URL(manifest, import.meta.url), "utf8"),
	).exports;
	return Object.keys(exports)
		.filter((name) => name !== "." && name !== "./package.json")
		.sort();
}
