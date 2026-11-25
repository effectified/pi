// Test helper: a harness whose tools sit behind the approvals extension, an inbox that records what it is shown, and
// the waits and reads the tests share.

import type { EntryRecord, TaskGraph, TaskId } from "@earendil-works/pi-durable";
import { type DurableError, Harness, type Hook, Tool } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseStep, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Latch, Layer, Option, Schema, Stream } from "effect";
import { extension, Inbox, type Policy, type Request } from "../src/index.ts";

// The testing kit's own types, read from its values: the type check resolves the kit to the facade's built
// declarations and the facade itself to its sources, so a type named from one side may not fit the other.
type Kit = TestHarness.Options<readonly [], never, never>;
type Root = Effect.Success<typeof TestHarness.root>;
type RootError = Effect.Error<typeof TestHarness.root>;
type RootServices = Effect.Services<typeof TestHarness.root>;
type Submitted = Effect.Success<ReturnType<Root["submit"]>>;

/** What a scene is built from. `R` is what the policy's rule needs. */
export interface SceneOptions<R> {
	/** Default: every call of `write` needs approval, for an hour. */
	readonly policy?: Policy<R>;
	/** Hooks of an extension installed before the approvals extension. */
	readonly before?: ReadonlyArray<Hook.Hook<never>>;
	/** Default: one call of `write` with the text `hi`, under the call id `call-1`, then the answer `Done.`. */
	readonly responses?: ReadonlyArray<FauxResponseStep>;
	/** Default: memory. */
	readonly storage?: Kit["storage"];
	/** Options of `Harness.layer`. */
	readonly harness?: Kit["harness"];
	/** What the inbox does with a request after recording it. Default: nothing. */
	readonly publish?: (request: Request) => Effect.Effect<void>;
}

/** A harness behind the approvals extension, and what its tools and its inbox saw. */
export interface Scene<R> {
	/** The texts `write` ran with. */
	readonly written: string[];
	/** Every request the inbox was shown, in order. */
	readonly published: Request[];
	readonly layer: Layer.Layer<TestHarness.Provided, never, R>;
	/** Makes every later `write` wait, running, until `release()`. */
	readonly hold: () => void;
	readonly release: () => void;
	/** Succeeds once `holds` is true, asked now and after every `write` and every request the inbox is shown. */
	readonly when: (holds: () => boolean) => Effect.Effect<void>;
}

/** Every call of `write` needs approval, and a request stays open for an hour. */
export const WRITES: Policy = { tools: ["write"], expiresAfter: "1 hour" };

/** An hour, the lifetime of a request under `WRITES`, in milliseconds. */
export const HOUR = 60 * 60 * 1000;

/** The model's default turns: one `write` call, then the answer. */
export const ONE_WRITE = [toolCall("write", { text: "hi" }, { id: "call-1" }), answer("Done.")];

/**
 * A harness with three tools: `write` (records what it wrote), `read` (reports object details) and `list` (reports
 * array details).
 */
export function scene<R = never>(options: SceneOptions<R> = {}): Scene<R> {
	const written: string[] = [];
	const published: Request[] = [];
	const waits: Array<{ readonly holds: () => boolean; readonly latch: Latch.Latch }> = [];
	const changed = () => {
		for (const wait of waits) if (wait.holds()) wait.latch.openUnsafe();
	};
	let held: PromiseWithResolvers<void> | undefined;
	const Write = Tool.make("write", {
		description: "Write a text.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		handler: ({ text }) =>
			Effect.gen(function* () {
				written.push(text);
				changed();
				const waiting = held;
				if (waiting !== undefined) yield* Effect.promise(() => waiting.promise);
				return `wrote ${text}`;
			}),
	});
	const Read = Tool.make("read", {
		description: "Read a file.",
		parameters: Schema.Struct({ path: Schema.String }),
		success: Schema.String,
		handler: ({ path }) => Effect.succeed(Tool.result(`read ${path}`, { details: { source: "disk" } })),
	});
	const List = Tool.make("list", {
		description: "List a directory.",
		parameters: Schema.Struct({ path: Schema.String }),
		success: Schema.String,
		handler: ({ path }) => Effect.succeed(Tool.result(`listed ${path}`, { details: ["a", "b"] })),
	});
	const layer = TestHarness.layer({
		extensions: [
			{ name: "before", hooks: options.before ?? [] },
			{ name: "app", tools: [Write, Read, List] },
			extension<R>(options.policy ?? WRITES),
		],
		responses: options.responses ?? ONE_WRITE,
		storage: options.storage,
		harness: options.harness,
	}).pipe(
		Layer.provide(
			Layer.succeed(Inbox, {
				publish: (request) =>
					Effect.suspend(() => {
						published.push(request);
						changed();
						return options.publish?.(request) ?? Effect.void;
					}),
			}),
		),
		Layer.orDie,
	);
	return {
		written,
		published,
		layer,
		hold: () => {
			held = Promise.withResolvers<void>();
		},
		release: () => held?.resolve(),
		when: (holds) =>
			Effect.suspend(() => {
				if (holds()) return Effect.void;
				const latch = Latch.makeUnsafe();
				waits.push({ holds, latch });
				return latch.await;
			}),
	};
}

/** Submits `content` to the root conversation without waiting for the run. */
export function submit(
	content = "Write hi.",
): Effect.Effect<{ readonly root: Root; readonly submission: Submitted }, RootError, RootServices> {
	return Effect.flatMap(TestHarness.root, (root) =>
		Effect.map(root.submit({ type: "input", content, requestId: "run" }), (submission) => ({ root, submission })),
	);
}

/**
 * Waits until the inbox was shown `count` requests and the call of the newest one is parked, and gives that one. It
 * follows Pi's task graph: the gate shows the inbox a request before the call's task commits its sleep.
 */
export function parked(
	published: ReadonlyArray<Request>,
	count = 1,
): Effect.Effect<Request, DurableError, Harness.Harness> {
	const parkedIn = (graph: TaskGraph): Option.Option<Request> => {
		const asked = published[count - 1];
		return asked !== undefined && graph.tasks[String(asked.task)]?.state.status === "sleeping"
			? Option.some(asked)
			: Option.none();
	};
	return Harness.taskGraph.pipe(
		Stream.map((change) => parkedIn(change.value)),
		Stream.filter(Option.isSome),
		Stream.runHead,
		Effect.flatMap((found) =>
			Option.match(Option.flatten(found), {
				onNone: () => Effect.die("the harness closed before the call was parked"),
				onSome: Effect.succeed,
			}),
		),
	);
}

/** The stored status of a task. */
export function status(task: TaskId): Effect.Effect<string, DurableError, Harness.Harness> {
	return Effect.map(Harness.getTask(task), (found) => Option.getOrThrow(found).state.status);
}

/** The tool result entries of a conversation, oldest first. */
export function results<E>(conversation: {
	readonly entries: (query: { readonly order: "ascending" }) => Stream.Stream<EntryRecord, E>;
}): Effect.Effect<ReadonlyArray<EntryRecord>, E> {
	return Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries.filter((entry) => entry.kind === "pi.tool-result"),
	);
}

/** What the model reads of a tool result entry: whether it is an error, and its text. */
export function shown(
	entry: EntryRecord | undefined,
): { readonly isError: boolean; readonly text: string } | undefined {
	const message = entry?.model?.[0];
	if (message?.role !== "toolResult") return undefined;
	return {
		isError: message.isError,
		text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
	};
}
