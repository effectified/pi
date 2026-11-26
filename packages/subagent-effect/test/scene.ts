// Test helper: a harness with three recording tools and the subagent extension, on scripted models that answer a
// parent and its children from separate queues, and readers of what a run left behind.

import type { ConversationId, ConversationRecord, EntryRecord } from "@earendil-works/pi-durable";
import {
	type Conversation,
	type DurableError,
	Extension,
	Harness,
	type SchemaDecodeError,
	type Storage,
	Tool,
} from "@effectified/pi-durable";
import { answer, type FauxResponseFactory, type FauxResponseStep, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { Child, ChildSetup, Subagent, Subagents } from "../src/index.ts";

/** The model of a parent conversation. */
export const PARENT = { provider: "faux", modelId: "parent" } as const;

/** The model the declarations give their children: the scripted provider answers it from a queue of its own. */
export const CHILD = { provider: "faux", modelId: "child" } as const;

/** Tools `a`, `b` and `c`, each recording its calls in `ran`. */
export function tools() {
	const ran: string[] = [];
	const recording = <const Name extends string>(name: Name) =>
		Tool.make(name, {
			description: `Tool ${name}.`,
			parameters: Schema.Struct({ text: Schema.String }),
			success: Schema.String,
			handler: ({ text }) =>
				Effect.sync(() => {
					ran.push(`${name}:${text}`);
					return `${name} did ${text}`;
				}),
		});
	return { ran, app: Extension.make({ name: "app", tools: [recording("a"), recording("b"), recording("c")] }) };
}

/** A subagent on the child model with tool `c` only, unless `options` say otherwise. */
export function worker<const Name extends string, S extends Subagent.ResultSchema | undefined = undefined>(
	name: Name,
	options: Partial<Subagent.Options<S>> = {},
): Subagent.Subagent<Name, S> {
	return Subagent.make(name, {
		description: `Does ${name} work.`,
		agent: { model: CHILD, tools: ["c"] },
		...options,
	});
}

/**
 * The responses of one harness: each request takes the next turn of the queue of its model, so a parent and a child
 * that work at the same time are answered in a fixed order whichever asks first. `asked` gets the model of every
 * request, in order.
 */
export function routed(
	queues: { readonly parent?: ReadonlyArray<FauxResponseStep>; readonly child?: ReadonlyArray<FauxResponseStep> },
	asked: string[] = [],
): FauxResponseStep[] {
	const pending = new Map<string, FauxResponseStep[]>([
		[PARENT.modelId, [...(queues.parent ?? [])]],
		[CHILD.modelId, [...(queues.child ?? [])]],
	]);
	const route: FauxResponseFactory = (context, options, state, model) => {
		asked.push(model.id);
		const next = pending.get(model.id)?.shift();
		if (next === undefined) throw new Error(`No response is scripted for the ${model.id} model`);
		return typeof next === "function" ? next(context, options, state, model) : next;
	};
	return [...pending.values()].flat().map(() => route);
}

/** What `harness` takes. */
export interface Scene<E, R> {
	readonly config: Subagents.Config;
	readonly responses: ReadonlyArray<FauxResponseStep>;
	/** Default: `ChildSetup.none`. */
	readonly setup?: Layer.Layer<ChildSetup.ChildSetup>;
	readonly storage?: Layer.Layer<Storage.HarnessStorage, E, R>;
	/** Pi's settings, such as `restartLimit`. */
	readonly settings?: NonNullable<Parameters<typeof Harness.layer>[0]>["settings"];
	/** False opens the harness without resuming it, as a host opens a copied storage. Default: true. */
	readonly resume?: boolean;
}

/** A harness with the `app` tools and the subagent extension for `config`, on the two scripted models. */
export function harness<E = never, R = never>(scene: Scene<E, R>) {
	const { ran, app } = tools();
	const layer = TestHarness.layer({
		extensions: [app, Subagents.extension(scene.config)],
		responses: scene.responses,
		provider: { api: "scripted", models: [{ id: PARENT.modelId }, { id: CHILD.modelId }] },
		...(scene.storage === undefined ? {} : { storage: scene.storage }),
		harness: {
			...(scene.settings === undefined ? {} : { settings: scene.settings }),
			...(scene.resume === undefined ? {} : { resume: scene.resume }),
		},
	}).pipe(Layer.provide(scene.setup ?? ChildSetup.none));
	return { ran, layer };
}

/** The root conversation as a parent: its own tools `a` and `b`, and the three subagent tools. */
export const parent = Harness.rootWith({
	agent: {
		model: PARENT,
		tools: ["a", "b", Subagents.TOOLS.foreground, Subagents.TOOLS.background, Subagents.TOOLS.status],
	},
});

/**
 * A scripted answer that records the names of the tools its request offered the model: Pi sends tool declarations as
 * positional system messages, each removing and adding tools, so the offer is their replay.
 */
export function offering(offered: Array<ReadonlyArray<string>>, text: string): FauxResponseStep {
	return (context) => {
		let names: string[] = [];
		for (const message of context.messages) {
			if (message.role !== "system") continue;
			const removed = (message.toolsRemoved ?? []).map((tool) => tool.name);
			names = names.filter((name) => !removed.includes(name));
			names.push(...(message.toolsAdded ?? []).map((tool) => tool.name));
		}
		offered.push(names);
		return answer(text);
	};
}

/** One tool result as the model and a host read it. */
export interface ToolResult {
	readonly tool: string;
	readonly isError: boolean;
	readonly text: string;
	readonly details: unknown;
}

/** The stored entries of a conversation, oldest first. */
export function entriesOf(
	conversation: Pick<Conversation.Conversation, "entries">,
): Effect.Effect<ReadonlyArray<EntryRecord>, DurableError> {
	return Stream.runCollect(conversation.entries({ order: "ascending" }));
}

/** What the model read as the result of each tool call among `entries`, oldest first. */
export function toolResults(entries: ReadonlyArray<EntryRecord>): ReadonlyArray<ToolResult> {
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		if (message?.role !== "toolResult") return [];
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		return [{ tool: message.toolName, isError: message.isError, text, details: message.details }];
	});
}

/** The text of each user and assistant message among `entries`, oldest first, as `role: text`. */
export function said(entries: ReadonlyArray<EntryRecord>): ReadonlyArray<string> {
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		if (message?.role !== "user" && message?.role !== "assistant") return [];
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		return text === "" ? [] : [`${message.role}: ${text}`];
	});
}

/** The conversations of the session that a task owns, as Pi records them: the children, oldest first. */
export const children: Effect.Effect<ReadonlyArray<ConversationRecord>, DurableError, Harness.Harness> = Harness.commit(
	(tx) =>
		Effect.map(tx.scanConversations({}, 100), (page) => page.items.filter((record) => record.owner !== undefined)),
);

/** The conversation `id`, which exists. */
export function conversation(
	id: ConversationId,
): Effect.Effect<Conversation.Conversation, DurableError, Harness.Harness> {
	return Effect.map(Harness.conversation(id), Option.getOrThrow);
}

/** The stored `subagent.child` document of the conversation `id`. */
export function childOf(
	id: ConversationId,
): Effect.Effect<Child.Record, DurableError | SchemaDecodeError, Harness.Harness> {
	return Effect.map(Harness.snapshot(Child.Document, Child.key(id)), Option.getOrThrow);
}
