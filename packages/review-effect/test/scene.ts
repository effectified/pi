// Test helper: a harness with two scripted providers, an author and a reviewer, behind the review extension, and the
// waits and reads the tests share.

import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	createProvider,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Models } from "@gunta/pi-ai-effect";
import { type DurableError, type Extension, Harness, type Hook } from "@gunta/pi-durable-effect";
import { answer, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option, Stream } from "effect";
import { expect } from "vitest";
import {
	type Check,
	type Correction,
	extension,
	type Finding,
	type Policy,
	ReleaseEntry,
	type State,
	state,
	VerdictEntry,
} from "../src/index.ts";

// The testing kit's own types, read from its values: the type check resolves the kit to the facade's built
// declarations and the facade itself to its sources, so a type named from one side may not fit the other.
type Kit = TestHarness.Options<readonly [], never, never>;
type Root = Effect.Success<typeof TestHarness.root>;
type RootError = Effect.Error<typeof TestHarness.root>;
type RootServices = Effect.Services<typeof TestHarness.root>;
type Submitted = Effect.Success<ReturnType<Root["submit"]>>;

/** The author's model: the one the root conversation answers with. */
export const AUTHOR = { provider: "author-lab", modelId: "writer" };

/** The reviewer's model, of a second scripted provider. */
export const REVIEWER = { provider: "reviewer-lab", modelId: "judge" };

/** The two models with their families, as the verdicts of `POLICY` name them. */
export const PARTIES = {
	author: { ...AUTHOR, family: "alpha" },
	reviewer: { ...REVIEWER, family: "beta" },
};

/** One corrective run, `block` findings block, and the two models in two families. */
export const POLICY: Policy.Policy = {
	reviewer: REVIEWER,
	families: [PARTIES.author, PARTIES.reviewer],
	maxCorrections: 1,
	blocking: "block",
};

/**
 * What a verdict keeps of a reviewer's request the scripted reviewer answered: who answered through which api, when
 * and for how long, and what it used and cost. A scripted model reports no response id, and has no catalog price.
 */
export const CALL = {
	provider: REVIEWER.provider,
	model: REVIEWER.modelId,
	api: expect.any(String),
	stopReason: "stop",
	timestamp: expect.any(Number),
	durationMs: expect.any(Number),
	usage: {
		input: expect.any(Number),
		output: expect.any(Number),
		cacheRead: expect.any(Number),
		cacheWrite: expect.any(Number),
		totalTokens: expect.any(Number),
		cost: 0,
		costs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

/** What every verdict of a review the scripted reviewer answered holds besides its count, findings and outcome. */
export const REVIEWED = {
	answer: expect.any(Number),
	inputs: [expect.any(Number)],
	...PARTIES,
	call: CALL,
	time: expect.any(Number),
};

/** An extension of hooks that need nothing. */
export type Hooks = Extension.Extension<readonly [], ReadonlyArray<Hook.Hook<never>>, readonly []>;

/** What a scene is built from. `R` is what the product's checks need. */
export interface SceneOptions<R> {
	/** Default: `POLICY`. */
	readonly policy?: Policy.Policy;
	readonly checks?: ReadonlyArray<Check.Check<R>>;
	readonly correction?: Correction.Writer;
	/** The author's turns, in order. */
	readonly author?: ReadonlyArray<FauxResponseStep>;
	/** The reviewer's turns, in order. */
	readonly reviewer?: ReadonlyArray<FauxResponseStep>;
	/** False leaves the reviewer's provider out of the harness's models. Default: true. */
	readonly reviewerInstalled?: boolean;
	/** Providers added to the harness's models besides the author's and the reviewer's, such as an alias. */
	readonly providers?: ReadonlyArray<Provider>;
	/** Extensions of hooks installed before the review extension. */
	readonly before?: ReadonlyArray<Hooks>;
	/** Extensions of hooks installed after it. */
	readonly after?: ReadonlyArray<Hooks>;
	/** Default: memory. */
	readonly storage?: Kit["storage"];
	/** True leaves the harness open without scheduling: nothing runs, and what is stored can be read and signalled. */
	readonly paused?: boolean;
}

/** A harness behind the review extension, and what its two models were asked. */
export interface Scene<R> {
	readonly layer: Layer.Layer<TestHarness.Provided, never, R>;
	/** The messages of every request the author's model got, in order. */
	readonly authorRequests: Message[][];
	/** The messages of every request the reviewer's model got, with the session id it was sent under. */
	readonly reviewerRequests: { readonly messages: Message[]; readonly sessionId: string | undefined }[];
	/** The reviewer's scripted provider. */
	readonly reviewer: FauxProviderHandle;
}

/**
 * A harness whose root conversation answers with the author's model, reviewed by the reviewer's. The harness is
 * opened without scheduling, the reviewer's provider is added to its models, and then it resumes: a reopened harness
 * never runs a review task before the reviewer exists.
 */
export function scene<R = never>(options: SceneOptions<R> = {}): Scene<R> {
	const authorRequests: Message[][] = [];
	const reviewerRequests: { messages: Message[]; sessionId: string | undefined }[] = [];
	const reviewer = fauxProvider({
		api: "scripted-reviewer",
		provider: REVIEWER.provider,
		models: [{ id: REVIEWER.modelId }],
	});
	reviewer.setResponses(
		(options.reviewer ?? []).map(
			(step): FauxResponseStep =>
				(context, given, state, model) => {
					reviewerRequests.push({ messages: [...context.messages], sessionId: given?.sessionId });
					return typeof step === "function" ? step(context, given, state, model) : dated(step);
				},
		),
	);
	const harness = TestHarness.layer({
		extensions: [
			...(options.before ?? []),
			extension({
				policy: options.policy ?? POLICY,
				checks: options.checks ?? [],
				correction: options.correction,
			}),
			...(options.after ?? []),
		],
		responses: (options.author ?? []).map(
			(step): FauxResponseStep =>
				(context, given, state, model) => {
					authorRequests.push([...context.messages]);
					return typeof step === "function" ? step(context, given, state, model) : step;
				},
		),
		provider: { api: "scripted", provider: AUTHOR.provider, models: [{ id: AUTHOR.modelId }] },
		storage: options.storage,
		harness: { resume: false },
	});
	const started = Layer.effectDiscard(
		Effect.gen(function* () {
			const models = yield* Models;
			if (options.reviewerInstalled !== false) models.setProvider(reviewer.provider);
			for (const provider of options.providers ?? []) models.setProvider(provider);
			if (options.paused !== true) yield* Harness.resume;
		}),
	);
	return {
		layer: Layer.orDie(Layer.provideMerge(started, harness)),
		authorRequests,
		reviewerRequests,
		reviewer,
	};
}

/**
 * `message` as a provider sends it now: dated when the scripted provider takes it, after the request's stream
 * started, so pi-ai measures its duration as for a live response. A message dated when it was scripted is older than
 * the stream, and pi-ai leaves such a response untimed, unless both fell into the same millisecond.
 */
export function dated(message: AssistantMessage): AssistantMessage {
	return { ...message, timestamp: Date.now() };
}

/** `steps` with every scripted message `dated` when it is taken. */
export function live(steps: ReadonlyArray<FauxResponseStep>): FauxResponseStep[] {
	return steps.map((step) => (typeof step === "function" ? step : () => dated(step)));
}

/**
 * A scripted provider of one model that no harness installs: a route an alias sends its requests to. Its responses
 * are `dated` when it takes them.
 */
export function route(model: { readonly provider: string; readonly modelId: string }): FauxProviderHandle {
	const handle = fauxProvider({
		api: `scripted-${model.provider}`,
		provider: model.provider,
		models: [{ id: model.modelId }],
	});
	return { ...handle, setResponses: (steps) => handle.setResponses(live(steps)) };
}

/**
 * A provider of one model, `alias`, that stands in for a router alias: a request goes to `routes` in order until one
 * does not answer with an error, and the message is that route's own, so its `provider` and `model` name the route.
 */
export function aliasProvider(
	alias: { readonly provider: string; readonly modelId: string },
	routes: readonly [FauxProviderHandle, ...FauxProviderHandle[]],
): Provider {
	const request = (
		_model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): ReturnType<typeof createAssistantMessageEventStream> => {
		const events = createAssistantMessageEventStream();
		const served = async (): Promise<AssistantMessage> => {
			let reply = await routes[0].provider.streamSimple(routes[0].getModel(), context, options).result();
			for (const next of routes.slice(1)) {
				if (reply.stopReason !== "error") break;
				reply = await next.provider.streamSimple(next.getModel(), context, options).result();
			}
			return reply;
		};
		void served().then((reply) => {
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				events.push({ type: "error", reason: reply.stopReason, error: reply });
			} else if (reply.stopReason !== "pending") {
				events.push({ type: "done", reason: reply.stopReason, message: reply });
			}
			events.end();
		});
		return events;
	};
	return createProvider({
		id: alias.provider,
		auth: { apiKey: { name: "Alias", resolve: () => Promise.resolve({ auth: {} }) } },
		models: [{ ...routes[0].getModel(), id: alias.modelId, provider: alias.provider, api: "scripted-alias" }],
		api: { stream: request, streamSimple: request },
	});
}

/** The reviewer's answer with `findings`: the JSON object it is asked for. */
export function findings(...found: ReadonlyArray<Finding>): AssistantMessage {
	return answer(JSON.stringify({ findings: found }));
}

/** One millisecond of real time: lets Pi's promises and commits run. */
export const tick: Effect.Effect<void> = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));

/** Submits `content` to the root conversation without waiting for the run; the same request id finds it again. */
export function ask(
	content = "What is six times seven?",
): Effect.Effect<{ readonly root: Root; readonly submission: Submitted }, RootError, RootServices> {
	return Effect.flatMap(TestHarness.root, (root) =>
		Effect.map(root.submit({ type: "input", content, requestId: "question" }), (submission) => ({
			root,
			submission,
		})),
	);
}

/** Waits until the review state of `root` has the tag `tag`, and gives that state. */
export function reached<T extends State["_tag"]>(
	root: Root,
	tag: T,
): Effect.Effect<Extract<State, { readonly _tag: T }>, DurableError, Harness.Harness> {
	return Effect.gen(function* () {
		for (;;) {
			const current = yield* Effect.orDie(state(root));
			if (current._tag === tag) return current as Extract<State, { readonly _tag: T }>;
			yield* tick;
		}
	});
}

/** The entries of a conversation, oldest first, each as its kind and what it says: a message's text, or this package's data. */
export function transcript<E>(conversation: {
	readonly entries: (query: { readonly order: "ascending" }) => Stream.Stream<EntryRecord, E>;
}): Effect.Effect<ReadonlyArray<readonly [string, unknown]>, E> {
	return Effect.flatMap(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		Effect.forEach(entries, (entry) =>
			Effect.gen(function* () {
				const verdict = yield* Effect.orDie(VerdictEntry.read(entry));
				if (Option.isSome(verdict)) return [entry.kind, verdict.value.data] as const;
				const release = yield* Effect.orDie(ReleaseEntry.read(entry));
				if (Option.isSome(release)) return [entry.kind, release.value.data] as const;
				return [entry.kind, textOf(entry.model?.[0])] as const;
			}),
		),
	);
}

/** The text of a message: a user's content, an assistant's text parts. */
export function textOf(message: Message | undefined): string | undefined {
	if (message?.role === "user") return typeof message.content === "string" ? message.content : undefined;
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
