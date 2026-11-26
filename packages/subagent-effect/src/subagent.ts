// A declared subagent: the name and description a parent's model reads, the child's whole agent, and its result.

import type { Agent } from "@effectified/pi-durable";
import { Effect, Schema } from "effect";
import { ResultMismatch } from "./errors.ts";

/**
 * A schema a subagent's result may have: one that decodes and encodes without services, because a child's answer is
 * decoded inside the commit that records it.
 */
export type ResultSchema = Schema.ConstraintCodec<unknown, unknown, never, never>;

/**
 * Everything a child conversation runs with. `model` and `tools` are required, since leaving either out would give
 * the child what the host defaults to: no model at all, and every tool of every selected extension. A field left out
 * is cleared in the child, never copied from the parent.
 */
export interface ChildAgent {
	readonly model: NonNullable<Agent.Change["model"]>;
	/** The child's tools, exactly these: none of the parent's unless named here, the subagent tools included. */
	readonly tools: Agent.Exactly;
	readonly thinkingLevel?: NonNullable<Agent.Change["thinkingLevel"]>;
	/** Exactly these extensions, in order. Left out: the host's selection, so guards and recorders stay selected. */
	readonly extensions?: Agent.Exactly;
	/** Of `tools`, those the model is offered. Left out: all of them. */
	readonly modelTools?: Agent.Exactly;
	readonly instructions?: string;
	readonly cwd?: string;
	/** The tool rounds one run of the child takes at most. Left out: no limit. */
	readonly maxTurns?: number;
	readonly compaction?: NonNullable<Agent.Change["compaction"]>;
}

/** What `make` takes besides the subagent's name. */
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

/** A subagent a parent may start. A plain value; `make` only types it. */
export interface Subagent<Name extends string = string, S extends ResultSchema | undefined = ResultSchema | undefined>
	extends Options<S> {
	readonly name: Name;
}

/** How often a child is asked again when a declaration does not say. */
export const DEFAULT_CORRECTIONS = 2;

/** Declares a subagent. `name` is what the parent's model passes to the tools, and what Pi's records keep. */
export function make<const Name extends string, S extends ResultSchema | undefined = undefined>(
	name: Name,
	options: Options<S>,
): Subagent<Name, S> {
	return { ...options, name };
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
		tools: agent.tools,
		thinkingLevel: agent.thinkingLevel ?? null,
		extensions: agent.extensions ?? null,
		modelTools: agent.modelTools ?? null,
		instructions: agent.instructions ?? null,
		cwd: agent.cwd ?? null,
		maxTurns: agent.maxTurns ?? null,
		compaction: agent.compaction ?? null,
	};
}

/**
 * A typed result as a host finds it, decoded: the `result` in the details of a tool result, or in the `Typed` state of
 * a child's document. Both hold the JSON form of the declared schema.
 */
export function result<S extends ResultSchema>(
	subagent: Subagent<string, S>,
	stored: unknown,
): Effect.Effect<S["Type"], ResultMismatch> {
	const mismatch = (issues: string) => new ResultMismatch({ subagent: subagent.name, issues });
	const schema = subagent.result;
	// `result` is optional in every declaration, also in one whose type names a schema.
	if (schema === undefined) return Effect.fail(mismatch("the subagent declares no result"));
	return Effect.flatMap(
		Effect.try({
			// Effect throws for a schema without a JSON form.
			try: () => Schema.decodeUnknownEffect(Schema.toCodecJson(schema), { errors: "all" }),
			catch: (cause) => mismatch(`the declared schema has no JSON form (${String(cause)})`),
		}),
		(decode) => Effect.mapError(decode(stored), (error) => mismatch(error.message)),
	);
}
