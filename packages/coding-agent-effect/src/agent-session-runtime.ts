// pi-coding-agent's session runtime in Effect: the current session and the services of its working directory as a
// scoped service, replaced by new, resumed, forked and imported sessions as Effects.

import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	type AgentSessionRuntime as PiAgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { SchemaConversionError } from "@effectified/pi-schema";
import { Context, Effect, Layer, type Scope } from "effect";
import {
	AgentSession,
	type AgentSessionHandle,
	createdFromServices,
	createdServices,
	type FromServicesOptions,
	type ServicesOptions,
} from "./agent-session.ts";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type InNewSession, inNewSession, type Replacement } from "./extension-context.ts";
import { type Fields, fields, type Reads, reads } from "./lift.ts";
import { runner } from "./runner.ts";
import { SessionManager, type SessionManagerHandle } from "./session-manager.ts";

/** The fields and getters of Pi's runtime, each an Effect that reads it when it runs. */
export const FIELDS = ["services", "cwd", "diagnostics", "modelFallbackMessage"] as const;

/** The methods of Pi's runtime that only read. */
export const READS = ["takeUnreportedDiagnostics"] as const;

/**
 * How the runtime makes each session, the first and every replacement, in the working directory of that session: the
 * options of `AgentSession.services` and of `AgentSession.fromServices`.
 */
export interface Options<R> extends Omit<ServicesOptions<R>, "cwd" | "agentDir"> {
	readonly cwd: string;
	readonly agentDir: string;
	/** The storage of the first session. */
	readonly sessionManager: SessionManagerHandle;
	/** The options of each session over its services. */
	readonly session?: Omit<FromServicesOptions<R>, "sessionManager" | "sessionStartEvent">;
}

/** A session runtime: the current session, and the replacements of it as Effects. */
export interface AgentSessionRuntimeHandle
	extends
		Fields<PiAgentSessionRuntime, (typeof FIELDS)[number]>,
		Reads<PiAgentSessionRuntime, (typeof READS)[number]> {
	/** Pi's runtime, for what takes one as it is: `runPrintMode`, `runRpcMode`. */
	readonly pi: PiAgentSessionRuntime;
	/** The current session. A replacement makes a new one: read it again after one. */
	readonly session: Effect.Effect<AgentSessionHandle>;
	/** Replaces the session with a new one; `setup` writes its first entries, `withSession` runs in it. */
	readonly newSession: <E = never>(options?: {
		readonly parentSession?: string;
		readonly setup?: (sessionManager: SessionManagerHandle) => Effect.Effect<void>;
		readonly withSession?: InNewSession<E>;
	}) => Effect.Effect<Replacement, CodingAgentFailure>;
	/** Replaces the session with the one stored in `sessionPath`. */
	readonly switchSession: <E = never>(
		sessionPath: string,
		options?: { readonly cwdOverride?: string; readonly withSession?: InNewSession<E> },
	) => Effect.Effect<Replacement, CodingAgentFailure>;
	/** Replaces the session with a fork of it at `entryId`. */
	readonly fork: <E = never>(
		entryId: string,
		options?: { readonly position?: "before" | "at"; readonly withSession?: InNewSession<E> },
	) => Effect.Effect<Awaited<ReturnType<PiAgentSessionRuntime["fork"]>>, CodingAgentFailure>;
	/** Copies the session file `inputPath` into the session directory and replaces the session with it. */
	readonly importFromJsonl: (
		inputPath: string,
		cwdOverride?: string,
	) => Effect.Effect<Replacement, CodingAgentFailure>;
	/**
	 * Runs `rebind` with each session that replaces the current one, before the replacement returns: where a host binds
	 * its extensions and subscriptions to the new session.
	 */
	readonly setRebindSession: (rebind?: (session: AgentSessionHandle) => Effect.Effect<void>) => Effect.Effect<void>;
	/**
	 * Runs `invalidate` before each session the runtime replaces is torn down. Pi calls it synchronously, so it must
	 * not wait for anything.
	 */
	readonly setBeforeSessionInvalidate: (invalidate?: Effect.Effect<void>) => Effect.Effect<void>;
}

/** The session runtime of the program. */
export class AgentSessionRuntime extends Context.Service<AgentSessionRuntime, AgentSessionRuntimeHandle>()(
	"@effectified/pi-coding-agent/agent-session-runtime/AgentSessionRuntime",
) {
	/** `AgentSessionRuntime.make(options)` as a Layer. */
	static layer<R = never>(
		options: Options<R>,
	): Layer.Layer<AgentSessionRuntime, CodingAgentFailure | SchemaConversionError, R> {
		return Layer.effect(AgentSessionRuntime, AgentSessionRuntime.make(options));
	}

	/**
	 * A new runtime: Pi's `createAgentSessionRuntime` with a factory that makes each session from `options`. Its
	 * extensions and tools run with the services of the context this Effect runs in. Closing the scope disposes the
	 * runtime as Pi's quit does: aborts, emits `session_shutdown`, disposes, and waits for credential writes.
	 */
	static readonly make = Effect.fn("AgentSessionRuntime.make")(function* <R = never>(
		options: Options<R>,
	): Effect.fn.Return<AgentSessionRuntimeHandle, CodingAgentFailure | SchemaConversionError, R | Scope.Scope> {
		const context = yield* Effect.context<R>();
		const run = runner(context);
		const factory: CreateAgentSessionRuntimeFactory = (target) => run(created(options, target));
		const pi = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () =>
					createAgentSessionRuntime(factory, {
						cwd: options.cwd,
						agentDir: options.agentDir,
						sessionManager: options.sessionManager.pi,
					}),
				catch: fromPi,
			}),
			(runtime) => Effect.promise(() => runtime.dispose()),
		);
		return AgentSessionRuntime.fromPi(pi);
	});

	/** Pi's runtime as a handle. It stays the caller's. */
	static fromPi(pi: PiAgentSessionRuntime): AgentSessionRuntimeHandle {
		// Pi's asynchronous members, each a span named for it.
		const call = <A>(name: string, start: () => Promise<A>) =>
			Effect.tryPromise({ try: start, catch: fromPi }).pipe(Effect.withSpan(`AgentSessionRuntime.${name}`));
		const inNew = <E>(withSession: InNewSession<E> | undefined) =>
			withSession === undefined ? {} : { withSession: inNewSession(withSession) };
		return {
			pi,
			...fields(pi, FIELDS),
			...reads(pi, READS),
			session: Effect.sync(() => AgentSession.fromPi(pi.session)),
			newSession: (options) => {
				const setup = options?.setup;
				return call("newSession", () =>
					pi.newSession({
						...(options?.parentSession === undefined ? {} : { parentSession: options.parentSession }),
						...(setup === undefined
							? {}
							: { setup: (sessionManager) => Effect.runPromise(setup(SessionManager.fromPi(sessionManager))) }),
						...inNew(options?.withSession),
					}),
				);
			},
			switchSession: (sessionPath, options) =>
				call("switchSession", () =>
					pi.switchSession(sessionPath, {
						...(options?.cwdOverride === undefined ? {} : { cwdOverride: options.cwdOverride }),
						...inNew(options?.withSession),
					}),
				),
			fork: (entryId, options) =>
				call("fork", () =>
					pi.fork(entryId, {
						...(options?.position === undefined ? {} : { position: options.position }),
						...inNew(options?.withSession),
					}),
				),
			importFromJsonl: (inputPath, cwdOverride) =>
				call("importFromJsonl", () => pi.importFromJsonl(inputPath, cwdOverride)),
			setRebindSession: (rebind) =>
				Effect.sync(() =>
					pi.setRebindSession(
						rebind === undefined
							? undefined
							: (session) => Effect.runPromise(rebind(AgentSession.fromPi(session))),
					),
				),
			setBeforeSessionInvalidate: (invalidate) =>
				Effect.sync(() =>
					pi.setBeforeSessionInvalidate(invalidate === undefined ? undefined : () => Effect.runSync(invalidate)),
				),
		};
	}
}

/**
 * One session of the runtime for Pi's factory: the services of `target`'s directory, then the session over them. Pi
 * calls the factory for the first session and for each replacement.
 */
const created = Effect.fn("AgentSessionRuntime.createSession")(function* <R>(
	options: Options<R>,
	target: Parameters<CreateAgentSessionRuntimeFactory>[0],
): Effect.fn.Return<
	Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>,
	CodingAgentFailure | SchemaConversionError,
	R
> {
	const { cwd: _cwd, agentDir: _agentDir, sessionManager: _first, session, ...services } = options;
	const made = yield* createdServices({ ...services, cwd: target.cwd, agentDir: target.agentDir });
	const result = yield* createdFromServices(made, {
		...session,
		sessionManager: SessionManager.fromPi(target.sessionManager),
		...(target.sessionStartEvent === undefined ? {} : { sessionStartEvent: target.sessionStartEvent }),
	});
	return { ...result, services: made, diagnostics: made.diagnostics };
});
