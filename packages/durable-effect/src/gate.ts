// Gates: what a `beforeTool` hook decides about one tool call, as a tagged union.

import type { JsonObject, ToolHooks } from "@earendil-works/pi-durable";
import type { SchemaConversionError } from "@gunta/pi-schema-effect";
import { Effect } from "effect";
import * as Signal from "./signal.ts";

/** A hook's decision about one call. */
export type Gate = Allow | Block | Rewrite | Park;

/** The call goes on to the next hook, and runs when no hook stops it. */
export interface Allow {
	readonly _tag: "Allow";
}

/** The call does not run: the model gets an error result with `reason`. No later hook is asked. */
export interface Block {
	readonly _tag: "Block";
	readonly reason: string;
}

/** The call goes on with `arguments`, which Pi validates again before the tool runs. */
export interface Rewrite {
	readonly _tag: "Rewrite";
	readonly arguments: JsonObject;
}

/**
 * The call sleeps before it runs, holding no process, until one of `signals` holds a value or the harness clock
 * reaches `until`, whichever comes first. Every wake asks every `beforeTool` hook again from the first.
 */
export interface Park {
	readonly _tag: "Park";
	readonly signals?: ReadonlyArray<Signal.Key>;
	/** Epoch milliseconds on the harness clock. Fix it once (a memo): a hook runs again on every wake. */
	readonly until?: number;
}

/** What Pi's `beforeTool` hook returns: replaced arguments, a block, a sleep, or nothing. */
export type Decision = Awaited<ReturnType<ToolHooks["beforeTool"]>>;

/** Lets the call go on. */
export const allow: Gate = { _tag: "Allow" };

/** Stops the call with an error result that tells the model `reason`. */
export function block(reason: string): Gate {
	return { _tag: "Block", reason };
}

/** Replaces the call's arguments. */
export function rewrite(args: JsonObject): Gate {
	return { _tag: "Rewrite", arguments: args };
}

/** Parks the call until a signal or a deadline; Pi ends a park with neither as `invalid_park`. */
export function park(options: { readonly signals?: ReadonlyArray<Signal.Key>; readonly until?: number }): Gate {
	return { _tag: "Park", ...options };
}

/** The decision Pi's `beforeTool` hook returns for `gate`. Fails when a signal's definition does. */
export function toPi(gate: Gate): Effect.Effect<Decision, SchemaConversionError> {
	switch (gate._tag) {
		case "Allow":
			return Effect.succeed(undefined);
		case "Block":
			return Effect.succeed({ block: gate.reason });
		case "Rewrite":
			return Effect.succeed({ arguments: gate.arguments });
		case "Park":
			return Effect.map(Effect.forEach(gate.signals ?? [], Signal.toPiKey), (signals) => ({
				sleep: {
					...(gate.signals === undefined ? {} : { signals }),
					...(gate.until === undefined ? {} : { until: gate.until }),
				},
			}));
	}
}
