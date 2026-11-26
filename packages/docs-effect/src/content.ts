// What the pages say that no package says of itself: each package's role in one sentence, what each kind of package
// is, and what the library rules out. Everything else on the pages is read from the packages.

/** The kinds of library package, in the order the pages show them: from the product down to Pi. */
export const KINDS = ["composition", "plugin", "host", "facade"] as const;

/** A kind of library package. */
export type Kind = (typeof KINDS)[number];

/** What a kind is, for a reader who has not met the word. */
export const KIND_MEANING: Readonly<Record<Kind, { readonly plural: string; readonly meaning: string }>> = {
	composition: {
		plural: "The composition",
		meaning: "Every plugin put together in the order that makes it correct, as a product would compose them.",
	},
	plugin: {
		plural: "Plugins",
		meaning:
			"Behaviour a product needs around an agent. A plugin never imports another plugin: they meet in the composition.",
	},
	host: {
		plural: "The host",
		meaning: "Where a harness runs when one process is not enough.",
	},
	facade: {
		plural: "Facades",
		meaning: "One per Pi package. A facade adds no behaviour: it gives Pi's capability in Effect terms.",
	},
};

/**
 * Each library package's role in one sentence, by its directory name. A package without an entry fails the build, so
 * a new package is not left out of the pages.
 */
export const ROLES: Readonly<Record<string, string>> = {
	"schema-effect":
		"Turns an Effect Schema into the JSON Schema Pi shows a model, and decodes what comes back with typed errors.",
	"ai-effect": "Pi's models as a service, a Stream and an Effect, with bridges to effect/ai in both directions.",
	"telemetry-effect":
		"Pi's spans, metrics and events arrive on Effect's tracer, metrics and logger, with the trace context carried into Pi.",
	"chord-effect":
		"The Chord context every Pi call takes, cancelled by the calling fiber's scope or the Clock, and Chord's JSON, SQLite and delta values.",
	"agent-effect":
		"Pi's non-durable agent for short-lived uses: a prompt is an Effect, its events a Stream, its tools and hooks Effects.",
	"coding-agent-effect":
		"Pi's coding agent in Effect: extensions written as Effect programs, sessions whose prompts are Effects and events Streams, the built-in and MCP tools, and print and RPC modes.",
	"env-effect":
		"Local and remote execution environments in Effect: commands and files as Effects, output as Streams, and daemon connections, SSH, processes and terminals as scoped resources.",
	"durable-effect":
		"The durable harness as Layers: conversations, tools, hooks, tasks, documents and commits, with tagged errors and interruption that cancels.",
	"mcp-effect":
		"Connects to MCP servers as scoped clients whose calls are Effects, notifications are Streams and errors one tagged union, with OAuth sign-in.",
	"durable-rivet-effect":
		"Runs a harness inside a Rivet actor: the actor's SQLite is the storage, its schedule wakes sleeping work, its forks copy a conversation.",
	"router-effect":
		"One alias, several routes: fallback, a limiter with backoff, prices, and filters by region and classification.",
	"budget-effect":
		"Reserves money before every provider request, settles after it, and stops a thread cleanly when its lease is fenced.",
	"guard-effect": "Decides which tools a conversation may call and with which arguments, and fails closed.",
	"approvals-effect":
		"Parks a tool call until a person decides, across sleeps and restarts, bound to the exact arguments.",
	"recorder-effect":
		"Delivers every committed message, model call and tool call to your sink, at least once, under ids that never change.",
	"review-effect":
		"Has a model of another family read the answer before it stands, checks citations, and asks for a bounded number of corrections.",
	"subagent-effect":
		"Lets an agent start children from declared agents, in the foreground or the background, with typed results.",
	"swarm-effect": "Primes a conversation once, forks it per job under a cap, and fans typed results back in.",
	"search-effect": "Search and fetch tools behind a provider port, with an Exa adapter.",
	"thread-effect":
		"All of it composed: one call works a thread to its outcome, in one process or as one actor per thread.",
};

/** Something the library rules out, how, and the packages that do it (directory names). */
export interface Guarantee {
	readonly claim: string;
	readonly how: string;
	readonly by: ReadonlyArray<string>;
}

/** What a product gets from the composition, each as a thing that cannot happen and the mechanism behind it. */
export const GUARANTEES: ReadonlyArray<Guarantee> = [
	{
		claim: "No request reaches a provider unreserved.",
		how: "The budget reserves before each model request and settles after the response. One request to an alias is one reservation, whichever route serves it. When the lease is fenced, the thread stops with a typed outcome.",
		by: ["budget-effect", "router-effect"],
	},
	{
		claim: "No tool runs that the thread was not granted.",
		how: "A conversation gets its allow-list in the commit that creates it. The guard's hook decides before any other, every tool is wrapped in a backstop, and a failure of the guard blocks the call.",
		by: ["guard-effect"],
	},
	{
		claim: "A thread starts once.",
		how: "The product's key is the idempotency key. Work is admitted under request keys stored with the thread, so a second start under another key finds the thread and admits nothing.",
		by: ["thread-effect"],
	},
	{
		claim: "A killed process loses no committed work.",
		how: "Pi stores every step. Reopening the storage resumes it: a model request a stop cut off is sent again, and a tool marked unsafe to replay never runs twice.",
		by: ["durable-effect", "durable-rivet-effect"],
	},
	{
		claim: "Nothing committed goes unrecorded, and no outcome goes untold.",
		how: "Records and outcome events are derived from stored entries and delivered at least once, in order, under deterministic ids, until the product's sink has taken them. That holds across a sleep and a restart.",
		by: ["recorder-effect", "thread-effect"],
	},
	{
		claim: "An answer does not stand on one model's word.",
		how: "When a thread asks for review, a model of another family reads the answer, citations are checked, and a blocking verdict asks for a bounded number of corrective runs or holds the answer for a person.",
		by: ["review-effect"],
	},
	{
		claim: "A call you named waits for a person.",
		how: "The call parks as durable work, bound to its exact arguments. The decision can come after a sleep, a deploy or a restart.",
		by: ["approvals-effect"],
	},
	{
		claim: "A change in Pi fails the build, not production.",
		how: "Types are derived from Pi's. Every choice over a Pi type is exhaustive. What stays hand-written is asserted against Pi in each package, and tests pin the behaviour no type shows.",
		by: ["durable-effect", "ai-effect"],
	},
];

/** One step of a request's way through the composition. */
export interface Step {
	readonly title: string;
	readonly text: string;
	readonly by: ReadonlyArray<string>;
}

/** The way of one piece of work through the composition, in the order it happens. */
export const STEPS: ReadonlyArray<Step> = [
	{
		title: "The product gives the work",
		text: "Threads.work creates the conversation with its grant, its cap and its routing limits in one commit, and admits the task under the thread's key.",
		by: ["thread-effect"],
	},
	{
		title: "The harness asks a model",
		text: "The request passes the budget first, which reserves for it. Then the router picks a route the thread's classification, regions and labels allow, and falls back when a route fails. A failed attempt is charged before the next route is tried.",
		by: ["budget-effect", "router-effect", "ai-effect"],
	},
	{
		title: "The model calls a tool",
		text: "The guard decides first. A call the product named for approval then parks until a person decides. A subagent or a swarm is a tool call like any other, with its own grant and cap.",
		by: ["guard-effect", "approvals-effect", "subagent-effect", "swarm-effect"],
	},
	{
		title: "The model answers",
		text: "If the thread asked for review, a model of another family reads the answer. It passes, is corrected, or is held for a person.",
		by: ["review-effect"],
	},
	{
		title: "The product is told",
		text: "The recorder delivers every committed entry to the product's RecordSink. Then the thread's courier tells the OutcomeSink where the thread stands: reviewed, answered, held, stopped by the budget, errored or cancelled.",
		by: ["recorder-effect", "thread-effect"],
	},
];
