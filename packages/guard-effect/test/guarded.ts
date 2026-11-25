// Test helper: a harness on scripted models whose registry is the guard's, and the tools and reads the tests share.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Models } from "@gunta/pi-ai-effect";
import {
	type Conversation,
	type DurableError,
	type Extension,
	Harness,
	type Registry,
	Storage,
	Tool,
} from "@gunta/pi-durable-effect";
import { answer, type FauxResponseStep, ScriptedModels } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option, PubSub, Schema, type Scope, Stream } from "effect";
import {
	Conversations,
	type DeniedTool,
	Guard,
	type InvalidPolicy,
	type MalformedRefusal,
	type Policy,
	type Refusal,
	Refused,
	type ReservedExtension,
	type Rule,
} from "../src/index.ts";

/** Options of `guardedHarness`. */
export interface Options<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
	E,
	R,
> {
	readonly policy: Policy.Policy;
	readonly rules?: Rules;
	readonly extensions: Extensions;
	/** The model's first responses, in order. */
	readonly responses?: ReadonlyArray<FauxResponseStep>;
	/** Default: `Storage.memory`. */
	readonly storage?: Layer.Layer<Storage.HarnessStorage, E, R>;
	/** Whether the harness runs `Conversations.created` in every creating commit. Default true. */
	readonly created?: boolean;
}

/**
 * `TestHarness.layer` with the guard's registry in place of `Registry.layer`, which `TestHarness.layer` builds itself
 * and cannot be given: an open harness on scripted models, its `Guard` and its `ScriptedModels`.
 */
export function guardedHarness<
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Rules extends ReadonlyArray<Rule.Any> = readonly [],
	E = never,
	R = never,
>(
	options: Options<Extensions, Rules, E, R>,
): Layer.Layer<
	Harness.Harness | Registry.Registry | Guard.Guard | Storage.HarnessStorage | Models | ScriptedModels,
	DurableError | DeniedTool | InvalidPolicy | ReservedExtension | Guard.RegistryError | E,
	R | Exclude<Extension.Services<Extensions[number]> | Rule.Services<Rules[number]>, Guard.Guard>
> {
	return harnessOn(
		Guard.layer({ policy: options.policy, rules: options.rules, extensions: options.extensions }),
		options,
	);
}

/**
 * An open harness on scripted models over `registry`, whatever built it: the guard's Layers composed by a test, or
 * an ordinary registry beside a guard.
 */
export function harnessOn<EG, RG, E = never, R = never>(
	registry: Layer.Layer<Registry.Registry | Guard.Guard, EG, RG>,
	options: Pick<Options<readonly [], readonly [], E, R>, "responses" | "storage" | "created"> = {},
): Layer.Layer<
	Harness.Harness | Registry.Registry | Guard.Guard | Storage.HarnessStorage | Models | ScriptedModels,
	DurableError | EG | E,
	R | RG
> {
	const scripted = Layer.effectDiscard(
		ScriptedModels.use((models) => models.setResponses(options.responses ?? [])),
	).pipe(Layer.provideMerge(ScriptedModels.layer({ api: "scripted" })));
	const harness =
		options.created === false ? Harness.layer() : Harness.layer({ conversationCreated: Conversations.created });
	return harness.pipe(Layer.provideMerge(Layer.mergeAll(scripted, registry, options.storage ?? Storage.memory)));
}

/** The arguments of every tool of the tests. */
export const Text = Schema.Struct({ text: Schema.String });

/** A tool of the tests: it takes a text and needs nothing. */
export type TextTool<Name extends string> = Tool.Tool<Name, typeof Text, typeof Schema.String, never, never>;

/** A tool that records each run of its handler in `ran`, as `<name>:<text>`. */
export function recording<const Name extends string>(name: Name, ran: Array<string>): TextTool<Name> {
	return Tool.make(name, {
		description: `The ${name} tool.`,
		parameters: Text,
		success: Schema.String,
		handler: ({ text }) =>
			Effect.sync(() => {
				ran.push(`${name}:${text}`);
				return `${name} did ${text}`;
			}),
	});
}

/** Three recording tools and what they ran. */
export function tools(): {
	readonly ran: Array<string>;
	readonly Search: TextTool<"search">;
	readonly Read: TextTool<"read">;
	readonly Write: TextTool<"write">;
} {
	const ran: string[] = [];
	return {
		ran,
		Search: recording("search", ran),
		Read: recording("read", ran),
		Write: recording("write", ran),
	};
}

/**
 * A scripted answer that records the names of the tools its request offered the model: Pi sends tool declarations
 * as positional system messages, each removing and adding tools, so the offer is their replay.
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

/** What the model read as the result of each tool call of a conversation, oldest first. */
export function toolResults(
	conversation: Conversation.Conversation,
): Effect.Effect<ReadonlyArray<ToolResult>, DurableError> {
	return Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries.flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === "toolResult" ? [toToolResult(entry, message)] : [];
		}),
	);
}

/**
 * The record of a refusal on each tool result of a conversation, oldest first, read from the stored entries: the tool,
 * and the record or `undefined` for a result without one.
 */
export function recorded(
	conversation: Conversation.Conversation,
): Effect.Effect<ReadonlyArray<readonly [string, Refused.Refused | undefined]>, DurableError | MalformedRefusal> {
	return Effect.flatMap(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		Effect.forEach(
			entries.flatMap((entry) => {
				const message = entry.model?.[0];
				return message?.role === "toolResult" ? [[message.toolName, entry] as const] : [];
			}),
			([tool, entry]) => Effect.map(Refused.of(entry), (record) => [tool, Option.getOrUndefined(record)] as const),
		),
	);
}

/** One tool result as the model reads it. */
export interface ToolResult {
	readonly tool: string;
	readonly isError: boolean;
	readonly text: string;
	readonly codes: ReadonlyArray<string>;
}

function toToolResult(
	entry: EntryRecord,
	message: { readonly toolName: string; readonly isError: boolean; readonly content: ReadonlyArray<unknown> },
): ToolResult {
	const diagnostics = (entry.data as { readonly diagnostics?: ReadonlyArray<{ readonly code?: string }> } | undefined)
		?.diagnostics;
	return {
		tool: message.toolName,
		isError: message.isError,
		text: message.content.map((part) => (part as { readonly text?: string }).text ?? "").join(""),
		codes: (diagnostics ?? []).flatMap((diagnostic) => (diagnostic.code === undefined ? [] : [diagnostic.code])),
	};
}

/** Subscribes to the guard's refusals now, and gives an Effect that takes those published since, without waiting. */
export const watching: Effect.Effect<
	Effect.Effect<ReadonlyArray<Refusal.Refusal>>,
	never,
	Guard.Guard | Scope.Scope
> = Effect.map(
	Guard.Guard.use((guard) => PubSub.subscribe(guard.refusals)),
	(subscription) => PubSub.takeUpTo(subscription, 100),
);

/** A refusal without the ids Pi mints. */
export function brief(refusal: Refusal.Refusal): Omit<Refusal.Refusal, "taskId" | "conversationId"> {
	const { taskId: _taskId, conversationId: _conversationId, ...rest } = refusal;
	return rest;
}

/** The text the model reads for a call Pi refused itself, and for one the guard blocked. */
export const UNAVAILABLE = (tool: string): string => `<harness>\n[error] Tool ${tool} is not available\n</harness>`;
export const BLOCKED = (tool: string): string =>
	`<harness>\n[error] Tool call blocked: Tool ${tool} is not available\n</harness>`;
