// Test helper: the product of world.ts hosted in thread actors on a local Rivet engine. A local engine's actors run
// in the test's process, so the product's ports are the in-memory values of world.ts, shared by the test, the thread
// actors and every fork: the lease and the sink note which actor asked them.

import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "@earendil-works/pi-durable";
import { BuiltinDoc, Extension, Hook } from "@gunta/pi-durable-effect";
import { answer } from "@gunta/pi-durable-effect/testing";
import { Action, ActorDatabase, ActorInfo, type Client, type Fork } from "@gunta/pi-durable-rivet-effect";
import * as Testing from "@gunta/pi-durable-rivet-effect/testing";
import type { Records } from "@gunta/pi-recorder-effect";
import { Effect, Layer, Option, Queue, Schedule, Schema } from "effect";
import { Threads } from "../src/index.ts";
import { ThreadActor } from "../src/rivet.ts";
import { config, type Options, outside, ports, providers, REVIEW_POLICY, SAME_FAMILY_REVIEWER } from "./world.ts";

/** The outside state of the suite: one lease, one sink and one inbox for every actor of it, emptied by `reset`. */
export const state = outside();

/** The scripted providers of the suite: every actor's models. A test sets their turns. */
export const labs = providers();

/** One record stream a fork opened, by the product's own fork hygiene: the fork, and the actor it was copied from. */
export interface Stream {
	readonly actor: string;
	readonly source: string | undefined;
}

/** Every record stream a fork of the suite opened, in order. */
export const streams: Array<Stream> = [];

/** What the scripted author was shown with one job of a swarm, by the job's topic. */
export interface Shown {
	/** The model context of the request, `<role>: <text>` each, system messages left out. */
	readonly transcript: ReadonlyArray<string>;
	/** The tools the request offered the model, by name. */
	readonly tools: ReadonlyArray<string>;
}

/** What the scripted author was shown with each job, by topic. */
export const shown = new Map<string, Shown>();

/** What a job's conversation had stored of its agent when it made a request: what Pi passes to `env` and compacts by. */
export interface Configured {
	readonly cwd: string | undefined;
	readonly compaction: CompactionSettings | undefined;
}

/** What each job's conversation had stored of its agent at its newest request, by topic. */
export const configured = new Map<string, Configured>();

/** How many job requests the scripted author answered at once, at most: what a swarm's cap bounds. */
export const load = { live: 0, most: 0 };

/** Empties the outside state, the scripts and the request counts: what every test starts from. */
export function reset(): void {
	state.lease.steps.length = 0;
	state.lease.fenced = undefined;
	state.delivered.length = 0;
	state.deliveredBy.length = 0;
	state.shown.length = 0;
	Effect.runSync(Queue.clear(state.inbox));
	for (const tool of Object.keys(state.ran)) delete state.ran[tool];
	state.held = undefined;
	state.told.events.length = 0;
	state.told.offered.length = 0;
	state.told.recorded.length = 0;
	state.told.by.length = 0;
	state.told.failing = 0;
	state.told.calls = 0;
	streams.length = 0;
	opened.length = 0;
	shown.clear();
	configured.clear();
	load.live = 0;
	load.most = 0;
	for (const lab of [labs.author, labs.backup, labs.reviewer]) {
		lab.setResponses([]);
		lab.state.callCount = 0;
	}
}

/**
 * The author answers each request by what it was asked: a primed thread, or a job about one topic, of which it notes
 * the transcript and the offered tools. A job takes a few milliseconds, so jobs that run at once overlap.
 */
export const scripted: FauxResponseFactory = async (context) => {
	const spoken = context.messages.flatMap((message) =>
		message.role === "system" ? [] : [`${message.role}: ${textOf(message.content)}`],
	);
	const topic = topicIn(context.messages);
	if (topic === undefined) return answer("I have read it.");
	const tools = new Set<string>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	shown.set(topic, { transcript: spoken, tools: [...tools].sort() });
	load.live += 1;
	load.most = Math.max(load.most, load.live);
	await new Promise((resolve) => setTimeout(resolve, 5));
	load.live -= 1;
	return answer(JSON.stringify({ topic, covered: topic !== "Zig" }));
};

/** The topic of a job's request: what its newest user message asks to be covered; none for any other request. */
function topicIn(messages: ReadonlyArray<Message>): string | undefined {
	const asked = messages.findLast((message) => message.role === "user");
	return /cover (\w+)\?/.exec(asked === undefined ? "" : textOf(asked.content))?.[1];
}

function textOf(content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

/**
 * Notes, before each request of a job, what the job's conversation stored of its agent. It runs in the actor that
 * makes the request, a fork's for a job, and changes nothing of the request.
 */
const storedAgent = Extension.make({
	name: "stored-agent",
	hooks: [
		Hook.beforeRequest((request, api) =>
			Effect.gen(function* () {
				const topic = topicIn(request.messages);
				if (topic === undefined) return Option.none();
				const agent = Option.getOrUndefined(yield* api.snapshot(BuiltinDoc.agent, api.conversationId));
				configured.set(topic, { cwd: agent?.cwd, compaction: agent?.compaction });
				return Option.none();
			}),
		),
	],
});

/** Every record the sink took, with the actor whose port took it, repeats included, in the order they came. */
export function deliveries(): ReadonlyArray<{ readonly actor: string | undefined; readonly record: Records.Record }> {
	return state.delivered.flatMap((batch, index) =>
		batch.map((record) => ({ actor: state.deliveredBy[index], record })),
	);
}

/** The product's ports, built in each actor at each wake: the values of the test, with the actor's id noted. */
const productPorts = Layer.unwrap(ActorInfo.use((info) => Effect.succeed(ports(state, { actor: info.actorId }))));

/**
 * The product's own fork hygiene: a fork opens a record stream of its own, anchored to the actor it was copied from.
 * Here it only notes that it did.
 */
const openStream: Fork.Hygiene<never> = ActorInfo.use((info) =>
	Effect.sync(() => void streams.push({ actor: info.actorId, source: info.forkChain.at(-1)?.actorId })),
);

/** How long a thread actor of the suite waits before it offers its outcome sink an event the sink refused. */
export const OUTCOME_RETRY_MILLIS = 3_000;

/** What every thread actor of the suite is made with, beside what one of them adds. */
function product(options: Pick<Options, "review"> = {}) {
	const base = config(state, labs, options);
	return {
		composition: {
			...base,
			extensions: [...base.extensions, storedAgent],
			// A failed delivery of an outcome is tried again after a time a test can sleep through.
			outcomes: { retry: Schedule.spaced(OUTCOME_RETRY_MILLIS) },
		},
		ports: productPorts,
		// Short, so the tests do not wait on the interval at which a coordinator asks its forks.
		swarm: { pollMillis: 100 },
		forkHygiene: [openStream],
		rivet: { sleepTimeout: 60_000, actionTimeout: 60_000 },
	};
}

/** The thread actor of the product of world.ts, watched and put to sleep by the host's testing entry. */
function hosted<const Name extends string>(name: Name, options: Pick<Options, "review"> = {}) {
	return Testing.observed(ThreadActor.make(name, product(options)));
}

/** The thread actor of the suite. */
export const Thread = hosted("thread");

/** The same product with a reviewer alias of the author's family: no thread that asks for a review starts in it. */
export const Cloned = hosted("cloned", { review: { ...REVIEW_POLICY, reviewer: SAME_FAMILY_REVIEWER } });

/** The one table of the product's own in a desk's actor database, beside Pi's: the brief its threads work from. */
const BRIEF = "CREATE TABLE IF NOT EXISTS desk_brief (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL)";

/**
 * The product actions of a desk: `brief` keeps a text in the actor's database, before any thread of the desk starts
 * or after; `desk` answers the actor's key, that text, and for each of the given threads whether it has unfinished
 * work, from the composition's own `Threads`.
 */
const deskActions = {
	brief: Action.make({
		input: Schema.Struct({ text: Schema.String }),
		output: Schema.Null,
		handler: ({ text }) =>
			ActorDatabase.use((database) =>
				Effect.promise(async () => {
					await database.exec(BRIEF);
					await database.run(
						"INSERT INTO desk_brief (id, text) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET text = excluded.text",
						text,
					);
					return null;
				}),
			),
	}),
	desk: Action.make({
		input: Schema.Struct({ threads: Schema.Array(Schema.String) }),
		output: Schema.Struct({
			key: Schema.Array(Schema.String),
			brief: Schema.NullOr(Schema.String),
			alive: Schema.Array(Schema.Boolean),
		}),
		handler: ({ threads }) =>
			Effect.gen(function* () {
				const info = yield* ActorInfo;
				const database = yield* ActorDatabase;
				const kept = yield* Effect.promise(async () => {
					await database.exec(BRIEF);
					return database.get<{ readonly text: string }>("SELECT text FROM desk_brief WHERE id = 1");
				});
				const service = yield* Threads.Threads;
				const alive = yield* Effect.forEach(threads, (thread) =>
					Effect.map(service.probe(thread), (probe) => probe.alive),
				);
				return { key: [...info.key], brief: kept?.text ?? null, alive };
			}).pipe(Effect.orDie),
	}),
};

/** Each time a desk's own Layer was built on its open harness: the actor, and what it read through `Threads`. */
export const opened: Array<{ readonly actor: string; readonly alive: boolean }> = [];

/**
 * The desk's own Layer on the open harness: it notes the wake, with a read through the composition's `Threads`,
 * which only an open harness answers.
 */
const deskServices = Layer.effectDiscard(
	Effect.gen(function* () {
		const info = yield* ActorInfo;
		const probe = yield* Threads.Threads.use((threads) => threads.probe("nobody"));
		opened.push({ actor: info.actorId, alive: probe.alive });
	}).pipe(Effect.orDie),
);

/**
 * A thread actor that holds several threads, with product actions and a Layer of its own on the open harness: a
 * desk, whose threads are keyed `<desk>/<name>`. A caller finds it with `deskOf`.
 */
export const Desk = Testing.observed(
	ThreadActor.make("desk", { ...product(), actions: deskActions, services: deskServices }),
);

/** The key of the desk a thread belongs to: what stands before the first slash of the thread's key. */
export function deskOf(thread: string): Client.Key {
	return [thread.slice(0, thread.indexOf("/"))];
}
