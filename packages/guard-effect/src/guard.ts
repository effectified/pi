// The guard of a program: the service that grants and reads, and the registry it checks against its policy.

import type { Hook, Section, Task, Tool, Wrap } from "@effectified/pi-durable";
import { type Extension, Registry, ToolName } from "@effectified/pi-durable";
import { Array as Arr, Context, Effect, Layer, Option, PubSub, Stream } from "effect";
import { backstopped, type Needing } from "./backstop.ts";
import * as Enforced from "./enforced.ts";
import { DeniedTool, type InvalidPolicy, ReservedExtension } from "./errors.ts";
import * as GuardExtension from "./extension.ts";
import * as Policy from "./policy.ts";
import type { Refusal } from "./refusal.ts";
import type * as Rule from "./rule.ts";

/** The name of the guard's extension: a conversation that selects extensions itself lists it first. */
export const EXTENSION: string = GuardExtension.NAME;

/** What a guard holds: its policy, and where it publishes refusals. */
export interface Service {
	readonly policy: Policy.Policy;
	/** Every refusal, for each subscriber from the moment it subscribes; `refusals` reads it as a Stream. */
	readonly refusals: PubSub.PubSub<Refusal>;
}

/**
 * The guard of this program: what every other function of this package requires. `fromPolicy` provides it without
 * a registry, so a service a registry's tools need can hold it; `registry` builds the checked registry on it, and
 * `layer` is both. A guard that built no registry grants nothing: `Conversations.grantIn` fails with `Unguarded`.
 */
export class Guard extends Context.Service<Guard, Service>()("@effectified/pi-guard/guard") {}

/** What `registry` takes. */
export interface RegistryOptions<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
> {
	/** Argument rules; those of one tool run in this order. Default: none. */
	readonly rules?: Rules;
	/** The program's extensions, other plugins' included, installed in order after the guard's own. */
	readonly extensions: Extensions;
}

/** What `layer` takes. */
export interface Options<
	Extensions extends ReadonlyArray<Extension.Extension>,
	Rules extends ReadonlyArray<Rule.Any>,
> extends RegistryOptions<Extensions, Rules> {
	/** A policy written in code or stored (`Policy.Encoded`), or a decoded one. */
	readonly policy: Policy.Encoded;
}

/** What building the facade's registry fails with: a tool whose parameters have no JSON Schema. */
export type RegistryError = Layer.Error<ReturnType<typeof Registry.layer>>;

/** An extension each of whose members needs `R`. */
type Installed<R> = Extension.Extension<
	ReadonlyArray<Needing<Tool.Any, R>>,
	ReadonlyArray<Needing<Hook.Any, R>>,
	ReadonlyArray<Needing<Task.Any, R>>,
	ReadonlyArray<Needing<Section.Any, R>>,
	ReadonlyArray<Needing<Wrap.Any, R>>
>;

/**
 * The guard of `policy`, without a registry: what grants and reads need, and nothing a registry's tools could need
 * in turn. `policy` is one written in code or stored (`Policy.Encoded`, its names plain strings), or a decoded
 * one. Building it fails with `InvalidPolicy` for a policy that contradicts itself. Give the same Layer value to
 * everything that needs the guard, so one guard is built: a second one has built no registry, and refuses to grant.
 */
export function fromPolicy(policy: Policy.Encoded): Layer.Layer<Guard, InvalidPolicy> {
	return Layer.effect(Guard, make(policy));
}

/** Builds one guard: its policy decoded and checked, and the hub of its refusals until the scope closes. */
const make = Effect.fn("Guard.make")(function* (input: Policy.Encoded) {
	const policy = yield* Policy.decode(input);
	const refusals = yield* Effect.acquireRelease(PubSub.unbounded<Refusal>(), PubSub.shutdown);
	const service: Service = { policy, refusals };
	return service;
});

/**
 * The registry of a guarded program, in place of `Registry.layer`, checked against the policy of the `Guard` it
 * requires. Building it fails, so no harness opens, with `ReservedExtension` for an extension named as the guard's
 * and `DeniedTool` for the first tool the policy's `denied` list names. Otherwise the guard's extension is installed
 * first, so its hooks are asked before those of approvals and budgets, every tool gets the backstop (see
 * `backstopped`), and the guard remembers the registry as one it built: only then does it grant. The Layer requires
 * the `Guard` and what the tools, the hooks and the rules need; a tool that needs the `Guard` gets the same one.
 */
export function registry<
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Rules extends ReadonlyArray<Rule.Any> = readonly [],
>(
	options: RegistryOptions<Extensions, Rules>,
): Layer.Layer<
	Registry.Registry,
	DeniedTool | ReservedExtension | RegistryError,
	Guard | Exclude<Extension.Services<Extensions[number]> | Rule.Services<Rules[number]>, Guard>
> {
	type Needed = Guard | Exclude<Extension.Services<Extensions[number]> | Rule.Services<Rules[number]>, Guard>;
	// TypeScript reads each member of a generic tuple through its constraint, where a registration needs `unknown`: by
	// construction the members need the union `Extension.Services` and `Rule.Services` read from the tuples.
	const extensions = options.extensions as ReadonlyArray<Installed<Needed>>;
	const rules = (options.rules ?? []) as ReadonlyArray<Rule.Rule<Needed, unknown>>;
	return Layer.unwrap(
		Effect.gen(function* () {
			const guard = yield* Guard;
			yield* checked(extensions, guard.policy);
			const own = GuardExtension.make(guard.policy, rules, guard.refusals);
			const guarded = Arr.map(extensions, (extension) => ({
				...extension,
				tools: Arr.map(extension.tools ?? [], (tool) => backstopped(tool, guard)),
			}));
			// Once the registry stands: the guard's own extension as Pi holds it is what a conversation is checked against.
			const bound = Registry.Registry.useSync((built) => {
				const installed = built.snapshot().extension(GuardExtension.NAME);
				if (installed !== undefined) Enforced.bind(guard, installed);
			});
			return Layer.provideMerge(Layer.effectDiscard(bound), Registry.layer([own, ...guarded]));
		}),
	);
}

/**
 * Succeeds when no extension has the guard's name and no tool has a name the policy denies; fails with the first
 * offence, in the order of the extensions and their tools.
 */
const checked = Effect.fn("Guard.checked")(function* (
	extensions: ReadonlyArray<Extension.Extension>,
	policy: Policy.Policy,
) {
	for (const extension of extensions) {
		if (extension.name === GuardExtension.NAME) return yield* ReservedExtension.make({ extension: extension.name });
		for (const tool of extension.tools ?? []) {
			const rule = Policy.denying(policy, tool.name);
			if (Option.isSome(rule)) {
				const name = ToolName.make(tool.name);
				return yield* DeniedTool.make({ tool: name, extension: extension.name, rule: rule.value });
			}
		}
	}
});

/**
 * `registry` on the guard of `options.policy`, in one Layer: for a program whose tools need nothing that needs the
 * guard. It fails with what either part fails with, `InvalidPolicy` first, and requires what the tools, the hooks and
 * the rules need, except the `Guard` itself, which it gives them: a tool that creates a conversation can grant in its
 * commit.
 */
export function layer<
	const Extensions extends ReadonlyArray<Extension.Extension>,
	const Rules extends ReadonlyArray<Rule.Any> = readonly [],
>(
	options: Options<Extensions, Rules>,
): Layer.Layer<
	Registry.Registry | Guard,
	DeniedTool | InvalidPolicy | ReservedExtension | RegistryError,
	Exclude<Extension.Services<Extensions[number]> | Rule.Services<Rules[number]>, Guard>
> {
	return Layer.provideMerge(
		registry<Extensions, Rules>({ rules: options.rules, extensions: options.extensions }),
		fromPolicy(options.policy),
	);
}

/**
 * Every refusal of the guard from the moment the stream runs: one element per call it kept from running, with the
 * conversation, the tool and the rule, never the arguments. A subscriber that runs later misses the earlier ones,
 * and nothing is kept for a process that stopped: the durable trace of a refusal is the record in the result's
 * details (`Refused.of`). Pi asks a hook again after a crash, so a call may be published twice across a restart.
 */
export const refusals: Stream.Stream<Refusal, never, Guard> = Stream.unwrap(
	Guard.useSync((guard) => Stream.fromPubSub(guard.refusals)),
);
