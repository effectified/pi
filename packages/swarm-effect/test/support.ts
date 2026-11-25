// Test helper: a swarm definition, a scripted model that answers by what it is asked, and the harness both run in.

import type { TaskId } from "@earendil-works/pi-durable";
import { type Conversation, Doc, type DurableError, Harness, type Storage } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseFactory, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Latch, Layer, Schema, Stream } from "effect";
import * as Swarm from "../src/index.ts";

/** The swarm of the tests: each job measures one word. */
export const Measure = Swarm.make({
	name: "measure",
	input: Schema.Struct({ word: Schema.String }),
	result: Schema.Struct({ word: Schema.String, length: Schema.Number }),
	prompt: ({ word }) => `Measure the word ${word}.`,
});

/** The jobs of a swarm over `words`: the key of a job is `job-<word>`. */
export function jobsOf(words: ReadonlyArray<string>): Array<Swarm.PlannedJob<{ readonly word: string }>> {
	return words.map((word) => ({ key: `job-${word}`, input: { word } }));
}

/** `count` different words. */
export function words(count: number): Array<string> {
	return Array.from({ length: count }, (_, index) => `w${index}${"x".repeat(index % 7)}`);
}

/**
 * What the in-storage driver says a destroyed fork wrote, worked out apart from it: the bytes of the UTF-8 JSON of
 * every entry that is the conversation's own, which for a fork are the entries after its fork point.
 */
export function writtenBy(conversation: Conversation.Conversation): Effect.Effect<number, unknown> {
	return Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries
			.filter((entry) => entry.conversationId === conversation.id)
			.reduce((bytes, entry) => bytes + new TextEncoder().encode(JSON.stringify(entry)).length, 0),
	);
}

/** The result `Measure` has for a word. */
export function measured(word: string): { readonly word: string; readonly length: number } {
	return { word, length: word.length };
}

/** What the scripted model was asked, by the tests' own count. */
export interface Asked {
	/** Per measured word: how often the model was asked for it. */
	readonly requests: Map<string, number>;
	/** Per measured word: how many priming turns the request's context held. */
	readonly primed: Map<string, number>;
	/** The most requests for a measure that were open at once. */
	maxLive: number;
	live: number;
	/** Every request, with the text it ended in. */
	readonly all: Array<string>;
	/** Succeeds once `holds` is true, asked now and after every change of the count. */
	readonly when: (holds: () => boolean) => Effect.Effect<void>;
	/** Asks every `when` again: the model calls it after it changed the count. */
	readonly changed: () => void;
}

/** A fresh count. */
export function asked(): Asked {
	const waits: Array<{ readonly holds: () => boolean; readonly latch: Latch.Latch }> = [];
	return {
		requests: new Map(),
		primed: new Map(),
		maxLive: 0,
		live: 0,
		all: [],
		when: (holds) =>
			Effect.suspend(() => {
				if (holds()) return Effect.void;
				const latch = Latch.makeUnsafe();
				waits.push({ holds, latch });
				return latch.await;
			}),
		changed: () => {
			for (const wait of waits) if (wait.holds()) wait.latch.openUnsafe();
		},
	};
}

/** How a scripted model answers one measure request: with this text, after this many milliseconds; `Infinity` never. */
export interface Reply {
	readonly text: string;
	readonly afterMillis: number;
}

/**
 * A scripted model that answers by the request's content, so a swarm that asks in any order gets the same answers:
 * a priming turn is acknowledged, a measure is answered with its JSON, a correction with the JSON of the word its
 * context measures. `reply` may change the answer to a measure.
 */
export function model(counts: Asked, reply?: (word: string, attempt: number) => Reply): FauxResponseFactory {
	return async (context, options) => {
		const texts = context.messages.flatMap((message) => (message.role === "user" ? [textOf(message.content)] : []));
		const last = texts.at(-1) ?? "";
		counts.all.push(last);
		const measures = texts.flatMap((text) => {
			const match = /Measure the word (\S+)\./.exec(text);
			return match?.[1] === undefined ? [] : [match[1]];
		});
		const word = measures.at(-1);
		if (word === undefined) return answer(`Noted: ${last}`);
		const attempt = (counts.requests.get(word) ?? 0) + 1;
		counts.requests.set(word, attempt);
		counts.primed.set(word, texts.filter((text) => text.startsWith("Prime ")).length);
		const given = reply?.(word, attempt) ?? { text: JSON.stringify(measured(word)), afterMillis: 2 };
		counts.live += 1;
		counts.maxLive = Math.max(counts.maxLive, counts.live);
		counts.changed();
		await new Promise<void>((resolve) => {
			if (Number.isFinite(given.afterMillis)) setTimeout(resolve, given.afterMillis);
			// A request the harness aborts (a close, a cancel) answers by itself, so nothing hangs.
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		counts.live -= 1;
		counts.changed();
		return answer(given.text);
	};
}

function textOf(content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

/** What a test changes about the harness of `harness`. */
export interface HarnessOptions {
	/** Default: memory. Give a SQLite storage to close and reopen. */
	readonly storage?: Layer.Layer<Storage.HarnessStorage>;
	/** False: the harness continues nothing by itself (Pi's scheduling stays paused until a call asks for progress). */
	readonly resume?: boolean;
	/** The driver the coordinators get, made of the in-storage one: for a test that holds one of its operations. */
	readonly wrap?: (driver: Swarm.ForkDriverService) => Swarm.ForkDriverService;
	/** The product's fork setup. Default: the one that does nothing. */
	readonly setup?: Layer.Layer<Swarm.ForkSetup.ForkSetup>;
}

/** What the recording setup writes for a fork in the commit that creates its conversation, by the conversation's id. */
export const Granted = Doc.family({
	kind: "test.granted",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ jobKey: Schema.String }),
	initial: () => ({ jobKey: "" }),
	checkpointWhen: () => false,
});

/** What a recording setup was asked, in order. */
export interface Recorded {
	readonly created: Array<Swarm.ForkSetup.Forked>;
	readonly beforeStart: Array<Swarm.ForkSetup.Forked>;
}

/**
 * A product's fork setup for the tests. `created` writes `Granted` for the fork's conversation through the creating
 * commit; both record what they were asked, and refuse the jobs `refuse` names, as a product without an allowance
 * for them would.
 */
export function recordingSetup(
	refuse: {
		readonly created?: (jobKey: string) => boolean;
		readonly beforeStart?: (jobKey: string) => boolean;
	} = {},
	recorded: Recorded = { created: [], beforeStart: [] },
) {
	const refused = (fork: Swarm.ForkSetup.Forked) =>
		new Swarm.ForkSetupFailed({ reason: `The job ${fork.jobKey} has no allowance.` });
	const service: Swarm.ForkSetup.ForkSetupService = {
		created: (tx, fork) =>
			Effect.gen(function* () {
				if (refuse.created?.(fork.jobKey) === true) return yield* refused(fork);
				const granted = yield* tx.doc(Granted, String(fork.conversationId), null);
				yield* granted.set({ jobKey: fork.jobKey });
				recorded.created.push(fork);
			}).pipe(
				Effect.catch((cause) =>
					cause._tag === "ForkSetupFailed"
						? Effect.fail(cause)
						: Effect.fail(new Swarm.ForkSetupFailed({ reason: "The grant could not be stored.", cause })),
				),
			),
		beforeStart: (fork) =>
			Effect.suspend(() => {
				if (refuse.beforeStart?.(fork.jobKey) === true) return Effect.fail(refused(fork));
				recorded.beforeStart.push(fork);
				return Effect.void;
			}),
	};
	return { recorded, service, layer: Layer.succeed(Swarm.ForkSetup.ForkSetup, service) };
}

/** A fork setup that does nothing, as a value: what a test's own fork request carries. */
export const noSetup: Swarm.ForkSetup.ForkSetupService = {
	created: () => Effect.void,
	beforeStart: () => Effect.void,
};

/** A harness with the in-storage driver and the `Measure` swarm, answered by `respond` for every request. */
export function harness(respond: FauxResponseFactory, options: HarnessOptions = {}) {
	const inStorage = Swarm.ConversationForks.layer;
	// Layers are shared by reference within one build: the wrapped driver and `attach` get the same in-storage driver.
	const forCoordinators =
		options.wrap === undefined
			? inStorage
			: Layer.effect(Swarm.ForkDriver, Swarm.ForkDriver.useSync(options.wrap)).pipe(Layer.provide(inStorage));
	return Swarm.ConversationForks.attach.pipe(
		Layer.provideMerge(
			TestHarness.layer({
				extensions: [Swarm.extension([Measure])],
				// The scripted provider takes one queued response per request: the same one, as often as a test asks.
				responses: Array.from({ length: 2000 }, () => respond),
				...(options.storage === undefined ? {} : { storage: options.storage }),
				...(options.resume === undefined ? {} : { harness: { resume: options.resume } }),
			}).pipe(Layer.provide(forCoordinators), Layer.provide(options.setup ?? Swarm.ForkSetup.none)),
		),
		Layer.provideMerge(inStorage),
	);
}

/** The root conversation, primed with `turns` turns and idle. */
export function primed(turns: number): Effect.Effect<Conversation.Conversation, unknown, TestHarness.Provided> {
	return Effect.gen(function* () {
		const root = yield* TestHarness.root;
		for (let turn = 1; turn <= turns; turn++) yield* root.prompt(`Prime ${turn}`, { requestId: `prime-${turn}` });
		yield* root.waitForIdle;
		return root;
	});
}

/**
 * Waits until `ready` holds, for what only a commit changes (a swarm's status, a job's stored state). It is asked
 * now and after every commit; the observer is attached before the first look, so no commit falls between two.
 */
export function until<E, R>(ready: Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R | Harness.Harness> {
	return Effect.scoped(
		Effect.gen(function* () {
			const commits = yield* Stream.toPull(Harness.commits);
			while (!(yield* ready)) yield* Effect.orDie(commits);
		}),
	);
}

/** Waits until the task sleeps in `phase`: what Pi's task graph says, now or at a later change. */
export function sleeping(task: TaskId, phase: string): Effect.Effect<void, DurableError, Harness.Harness> {
	return Effect.asVoid(
		Stream.runHead(
			Stream.filter(Harness.taskGraph, (change) => {
				const state = change.value.tasks[String(task)]?.state;
				return state?.status === "sleeping" && state.phase === phase;
			}),
		),
	);
}

/** How many jobs of a swarm have each status. */
export interface Tally {
	readonly planned: number;
	readonly running: number;
	readonly succeeded: number;
	readonly failed: number;
}

/** How many jobs of a swarm have each status now. */
export function tally(swarmId: string): Effect.Effect<Tally, unknown, Harness.Harness> {
	return Effect.map(Swarm.status(swarmId), (status) => {
		const count = (wanted: string) => status.jobs.filter((job) => job.status === wanted).length;
		return {
			planned: count("planned"),
			running: count("running"),
			succeeded: count("succeeded"),
			failed: count("failed"),
		};
	});
}
