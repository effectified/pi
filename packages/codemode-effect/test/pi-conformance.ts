// What codemode-effect lists of pi-codemode by hand, checked against pi-codemode's own types. Type-only: nothing here
// runs. A failure names what moved upstream.

import type {
	CodemodeExecuteOptions,
	CodemodeOutcome,
	CodemodeRun,
	CodemodeRunOptions,
	CodemodeSandboxBase,
	CodemodeSandboxBaseOptions,
	CodemodeSandboxOptions,
	CodemodeServeOptions,
	CodemodeTool,
	InlineCodemodeSandboxOptions,
	RemoteCodemodeSandboxOptions,
} from "@earendil-works/pi-codemode";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { InlineSandbox, RemoteSandbox, Run, Sandbox, ScriptTool, WorkerSandbox } from "../src/index.ts";

/** Every option every sandbox takes is one of `Sandbox.Options`. */
export type BaseOptionsCovered = Assert<Covers<CodemodeSandboxBaseOptions, Sandbox.Options<never>>>;

/** Every option of the worker-thread sandbox is one of `WorkerSandbox.Options`; its callbacks are Effects there. */
export type WorkerOptionsCovered = Assert<Covers<CodemodeSandboxOptions, WorkerSandbox.Options<never>>>;

/** Every option of the sandbox on the calling thread is one of `InlineSandbox.Options`. */
export type InlineOptionsCovered = Assert<Covers<InlineCodemodeSandboxOptions, InlineSandbox.Options<never>>>;

/** Every option of the remote sandbox is one of `RemoteSandbox.Options`; `remote` is an Effect there. */
export type RemoteOptionsCovered = Assert<Covers<RemoteCodemodeSandboxOptions, RemoteSandbox.Options<never>>>;

/** Every option of the remote end is one of `RemoteSandbox.ServeOptions`. */
export type ServeOptionsCovered = Assert<Covers<CodemodeServeOptions, RemoteSandbox.ServeOptions>>;

/** Every option of an execution is one of `Sandbox.ExecuteOptions`, or the abort signal, which the fiber owns. */
export type ExecuteOptionsCovered = Assert<Covers<CodemodeExecuteOptions, Sandbox.ExecuteOptions, "signal">>;

/**
 * Every public member of Pi's sandbox is lifted onto `Sandbox.Sandbox`, or named here. A member Pi adds fails until it
 * is wrapped or named.
 */
export type SandboxMembersCovered = Assert<
	Covers<
		CodemodeSandboxBase,
		Sandbox.Sandbox,
		// `register` and `unregister`, with Effect tools and a tagged failure.
		| "registerTool"
		| "unregisterTool"
		// The sandbox's scope closes it.
		| "close"
	>
>;

/** The keys of `T` whose values are functions: Pi's callbacks. */
type CallbackKeys<T> = {
	[K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** Every callback of a run is an event of `Run.Event`: a callback Pi adds fails here until it is one. */
export type RunCallbacksAreEvents = Assert<
	Conform<CallbackKeys<CodemodeRunOptions>, "onStarted" | "onCall" | "onIdle">
>;

/** Pi's call with its number branded, as `Run.HostCall` carries it. */
type BrandedCall = Omit<Parameters<CodemodeRunOptions["onCall"]>[0], "id"> & { readonly id: Run.CallId };

/** Each event carries its callback's arguments, the call's number branded. */
export type RunEventsCarryArguments = Assert<
	Conform<
		[[Run.Started["fingerprint"]], [Run.Call["call"]], [Run.Idle["seq"], Run.Idle["issued"]]],
		[
			Parameters<NonNullable<CodemodeRunOptions["onStarted"]>>,
			[BrandedCall],
			Parameters<NonNullable<CodemodeRunOptions["onIdle"]>>,
		]
	>
>;

/** `Run.Outcome` mirrors Pi's outcome of a call. */
export type OutcomeConforms = Assert<Conform<Run.Outcome, CodemodeOutcome>>;

/** Every option of a run is one of `Run.Options`, or the abort signal (the scope owns the run), or an event. */
export type RunOptionsCovered = Assert<
	Covers<CodemodeRunOptions, Run.Options, "signal" | "onStarted" | "onCall" | "onIdle">
>;

/** Every member of Pi's run is one of `Run.Run`. */
export type RunMembersCovered = Assert<Covers<CodemodeRun, Run.Run>>;

/** What Pi's `deliver` takes. */
type Deliver = Parameters<CodemodeRun["deliver"]>;

/** An answer carries what Pi's `deliver` takes, `now` defaulting to the `Clock` and the call's number branded. */
export type AnswerConforms = Assert<
	Conform<
		[Run.Answer["seq"], NonNullable<Run.Answer["now"]>, Run.Answer["id"], Run.Answer["outcome"]],
		[Deliver[0], Deliver[1], Run.CallId, Deliver[3]]
	>
>;

/**
 * Every field of Pi's tool is set from a tool of `@effectified/pi-agent` (its name, description, schemas and handler)
 * or from a global's own `spread` and `signature`.
 */
export type ToolCovered = Assert<
	Covers<CodemodeTool, ScriptTool.Global<never>, "name" | "description" | "inputSchema" | "outputSchema" | "execute">
>;
