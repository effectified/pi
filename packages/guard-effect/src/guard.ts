// The guard of a program: the service that grants and reads, and the registry it checks against its policy.

import { type Extension, Registry } from "@effectified/pi-durable";
import { Context, Effect, Layer, Option, PubSub, Stream } from "effect";
import { backstopped } from "./backstop.ts";
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
export class Guard extends Context.Service<Guard, Service>()("@effectified/pi-guard/Guard") {}

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
export interface Options<Extensions extends ReadonlyArray<Extension.Extension>, Rules extends ReadonlyArray<Rule.Any>>
	extends RegistryOptions<Extensions, Rules> {
	readonly policy: Policy.Policy;
}

/** What building the facade's registry fails with: a tool whose parameters have no JSON Schema. */
export type RegistryError = Layer.Error<ReturnType<typeof Registry.layer>>;

/**
 * The guard of `policy`, without a registry: what grants and reads need, and nothing a registry's tools could need
 * in turn. Building it fails with `InvalidPolicy` for a policy that contradicts itself. Give the same Layer value to
 * everything that needs the guard, so one guard is built: a second one has built no registry, and refuses to grant.
 */
export function fromPolicy(policy: Policy.Policy): Layer.Layer<Guard, InvalidPolicy> {
	return Layer.effect(
		Guard,
		Effect.gen(function* () {
			const valid = yield* Policy.validate(policy);
			const refusals = yield* Effect.acquireRelease(PubSub.unbounded<Refusal>(), PubSub.shutdown);
			return { policy: valid, refusals };
		}),
	);
}

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
	const build = Effect.gen(function* () {
		const guard = yield* Guard;
		for (const extension of options.extensions) {
			if (extension.name === GuardExtension.NAME) {
				return yield* new ReservedExtension({ extension: extension.name });
			}
			for (const tool of extension.tools ?? []) {
				const rule = Policy.denying(guard.policy, tool.name);
				if (Option.isSome(rule)) {
					return yield* new DeniedTool({ tool: tool.name, extension: extension.name, rule: rule.value });
				}
			}
		}
		const own = GuardExtension.make(guard.policy, options.rules ?? [], guard.refusals);
		const guarded = options.extensions.map((extension) => ({
			...extension,
			tools: (extension.tools ?? []).map((tool) => backstopped(tool, guard)),
		}));
		// Once the registry stands: the guard's own extension as Pi holds it is what a conversation is checked against.
		const bound = Registry.Registry.use((built) =>
			Effect.sync(() => {
				const installed = built.snapshot().extension(GuardExtension.NAME);
				if (installed !== undefined) Enforced.bind(guard, installed);
			}),
		);
		return Layer.provideMerge(Layer.effectDiscard(bound), Registry.layer([own, ...guarded]));
	});
	// TypeScript cannot carry each handler's requirement through the arrays, where it is `unknown`: by construction
	// the registry needs what the extensions' tools and hooks need, and the guard's hook what the rules need.
	return Layer.unwrap(build) as Layer.Layer<
		Registry.Registry,
		DeniedTool | ReservedExtension | RegistryError,
		Guard | Exclude<Extension.Services<Extensions[number]> | Rule.Services<Rules[number]>, Guard>
	>;
}

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
	Guard.use((guard) => Effect.succeed(Stream.fromPubSub(guard.refusals))),
);
