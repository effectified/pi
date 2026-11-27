// A declared subagent: the name and description a parent's model reads, the child's whole agent, and its result.

import { type Agent, ToolName } from "@effectified/pi-durable";
import { Array as Arr, Effect, Predicate, Schema } from "effect";
import { dual } from "effect/Function";
import { ResultMismatch } from "./errors.ts";
import { Name } from "./subagent-name.ts";

export { Name } from "./subagent-name.ts";

/**
 * A schema a subagent's result may have: one that decodes and encodes without services, because a child's answer is
 * decoded inside the commit that records it.
 */
export type ResultSchema = Schema.ConstraintCodec<unknown, unknown, never, never>;

/**
 * Everything a child conversation runs with. `model` and `tools` are required, since leaving either out would give
 * the child what the host defaults to: no model at all, and every tool of every selected extension. A field left out
 * is cleared in the child, never copied from the parent. An interface, not a Schema: tools may be given as the tools
 * themselves, and the other fields are Pi's own types (`test/pi-conformance.ts`).
 */
export interface ChildAgent {
	readonly model: NonNullable<Agent.Change["model"]>;
	/** The child's tools, exactly these: none of the parent's unless named here, the subagent tools included. */
	readonly tools: Names;
	readonly thinkingLevel?: NonNullable<Agent.Change["thinkingLevel"]>;
	/** Exactly these extensions, in order. Left out: the host's selection, so guards and recorders stay selected. */
	readonly extensions?: Agent.ExactlyExtensions;
	/** Of `tools`, those the model is offered. Left out: all of them. */
	readonly modelTools?: Names;
	readonly instructions?: string;
	readonly cwd?: string;
	/** The tool rounds one run of the child takes at most. Left out: no limit. */
	readonly maxTurns?: number;
	readonly compaction?: NonNullable<Agent.Change["compaction"]>;
}

/** Tools by name, or by anything that carries one: a declaration names them as Pi stores them. */
export type Names = ReadonlyArray<string | { readonly name: string }>;

/** What `make` takes besides the subagent's name. An interface: it holds a `Schema`, which is no data. */
export interface Options<S extends ResultSchema | undefined = ResultSchema | undefined> {
	/** What the subagent is for, in words the parent's model picks it by. */
	readonly description: string;
	readonly agent: ChildAgent;
	/**
	 * What the child's final answer must be. With it, the child is told to answer with one JSON value, its answer is
	 * decoded, and the parent's tool result carries the value. Without it, the result is the answer's text.
	 */
	readonly result?: S;
	/** How often a child whose answer does not match `result` is asked again before it fails. Default: 2. */
	readonly corrections?: number;
}

/** A subagent a parent may start, named `N`. A plain value; `make` only types it and brands its name. */
export interface Subagent<
	N extends string = string,
	S extends ResultSchema | undefined = ResultSchema | undefined,
> extends Options<S> {
	readonly name: N & Name;
}

/** How often a child is asked again when a declaration does not say. */
export const DEFAULT_CORRECTIONS = 2;

/** Declares a subagent. `name` is what the parent's model passes to the tools, and what Pi's records keep. */
export function make<const N extends string, S extends ResultSchema | undefined = undefined>(
	name: N,
	options: Options<S>,
): Subagent<N, S> {
	// The brand marks the literal: `Name.make` gives `name` back as it is, typed `Name` without the literal.
	return { ...options, name: Name.make(name) as N & Name };
}

/**
 * The change that makes a conversation run with exactly `agent`. Pi starts a task-owned conversation as a copy of
 * its owner's stored agent (spec 2.2), and a change leaves absent fields as they are, so every field is named here:
 * a declared one replaces the copy, an undeclared one is `null`, which clears it. The return type lists every field
 * of Pi's change, so a field Pi adds later does not compile until it is decided here.
 */
export function exactly(agent: ChildAgent): Required<Agent.Change> {
	return {
		model: agent.model,
		tools: toolNames(agent.tools),
		thinkingLevel: agent.thinkingLevel ?? null,
		extensions: agent.extensions ?? null,
		modelTools: agent.modelTools === undefined ? null : toolNames(agent.modelTools),
		instructions: agent.instructions ?? null,
		cwd: agent.cwd ?? null,
		maxTurns: agent.maxTurns ?? null,
		compaction: agent.compaction ?? null,
	};
}

/** A declaration's tools as the names a conversation's agent takes: branded where they reach Pi Durable. */
function toolNames(names: Names): ReadonlyArray<ToolName> {
	return Arr.map(names, (item) => ToolName.make(Predicate.isString(item) ? item : item.name));
}

/**
 * A typed result as a host finds it, decoded: the `result` in the details of a tool result, or in the `Typed` state of
 * a child's document. Both hold the JSON form of the declared schema. Data-first, or data-last with what was stored.
 */
export const result: {
	(
		stored: unknown,
	): <S extends ResultSchema>(subagent: Subagent<string, S>) => Effect.Effect<S["Type"], ResultMismatch>;
	<S extends ResultSchema>(subagent: Subagent<string, S>, stored: unknown): Effect.Effect<S["Type"], ResultMismatch>;
} = dual(
	2,
	Effect.fn("Subagent.result")(function* <S extends ResultSchema>(subagent: Subagent<string, S>, stored: unknown) {
		const mismatch = (issues: string) => ResultMismatch.make({ subagent: subagent.name, issues });
		const schema = subagent.result;
		// `result` is optional in every declaration, also in one whose type names a schema.
		if (schema === undefined) return yield* mismatch("the subagent declares no result");
		const decode = yield* Effect.try({
			// Effect throws for a schema without a JSON form.
			try: () => Schema.decodeUnknownEffect(Schema.toCodecJson(schema), { errors: "all" }),
			catch: (cause) => mismatch(`the declared schema has no JSON form (${String(cause)})`),
		});
		const decoded: S["Type"] = yield* Effect.mapError(decode(stored), (error) => mismatch(error.message));
		return decoded;
	}),
);
