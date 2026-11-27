// Test helper: a second driver, in memory, that behaves like a remote one: calls that fail and are retried, a
// creation that answers "duplicate key", jobs that settle later, and a destroy that knows the bytes written.

import { conditions } from "@effectified/pi-ai/testing";
import { Signal } from "@effectified/pi-durable";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import * as Swarm from "../src/index.ts";
import { measured } from "./support.ts";

/** The signal a fake fork's host delivers to the coordinator when a job settled: nothing but the fact. */
export const Settled = Signal.make("fake.job-settled", 1, Schema.Struct({}));

/** How the fake answers one job. */
export interface FakeJob {
	/** The answer text, or none for a job that settles without one. */
	readonly answer: Option.Option<string>;
	/** Milliseconds of the `Clock` after it was accepted until `job` reads it as settled; `Infinity` never, until a cancel. */
	readonly settlesAfterMillis: number;
}

/** What a test injects into the fake. Every function is asked with the number of the call, from 1. */
export interface FakeOptions {
	/** How `run` answers: by signal (the test delivers it with `settle`), or by polling every so many milliseconds. */
	readonly notice?: "signal" | { readonly pollMillis: number };
	/** The job a fork runs for this request; default: the measure of the job's word, at once. */
	readonly job?: (jobKey: string, requestId: string, prompt: string) => FakeJob;
	/** A `fork` call fails with "retry later" before anything happens. */
	readonly forkFails?: (jobKey: string, call: number) => boolean;
	/** A `fork` call finds the source busy: "retry later" that says so, before anything happens. */
	readonly forkBusy?: (jobKey: string, call: number) => boolean;
	/** Where the fake says a job runs, in the answer of `run`. Default: it does not say. */
	readonly place?: (jobKey: string) => Swarm.Place;
	/** A `fork` call creates the fork and then loses its answer: the caller sees "retry later". */
	readonly forkAnswerLost?: (jobKey: string, call: number) => boolean;
	/** A `fork` call finds the source gone. */
	readonly sourceGone?: (jobKey: string) => boolean;
	readonly runFails?: (jobKey: string, call: number) => boolean;
	readonly jobFails?: (jobKey: string, call: number) => boolean;
	readonly destroyFails?: (jobKey: string, call: number) => boolean;
	/** The hint of a destroy call that fails, in milliseconds. Default 1. */
	readonly destroyHint?: (jobKey: string) => number;
	readonly listFails?: (call: number) => boolean;
	/** The bytes a destroyed fork reports. Default: 1000 plus its number. */
	readonly bytes?: (jobKey: string) => Option.Option<number>;
}

/** One request of one fork. */
interface Request {
	readonly prompt: string;
	readonly notify: { readonly taskId: number; readonly key: string };
	readonly acceptedAt: number;
	readonly job: FakeJob;
	cancelled: boolean;
	settledNow: boolean;
}

/** One fork of the fake. Job keys are unique across the swarms of a test, so a fork is held under its job key. */
interface FakeFork {
	readonly swarmId: Swarm.SwarmId;
	readonly forkId: Swarm.ForkId;
	readonly requests: Map<string, Request>;
}

/** What the fake did, for assertions. */
export interface Fake {
	readonly driver: Swarm.ForkDriverService;
	/** The driver, and the fork setup that does nothing: a remote driver leaves the setup of a request. */
	readonly layer: Layer.Layer<Swarm.ForkDriver | Swarm.ForkSetup.ForkSetup>;
	/** Per job key: how often `fork` was called. */
	readonly forkCalls: Map<string, number>;
	/** Per job key: how often a fork was really created. */
	readonly created: Map<string, number>;
	/** Per job key: how often a creation answered "duplicate key". */
	readonly duplicates: Map<string, number>;
	/** Per request id: how often `run` was called, and how often it started a job. */
	readonly runCalls: Map<string, number>;
	readonly accepted: Map<string, number>;
	/** Per request id: how often `job` was called. */
	readonly jobCalls: Map<string, number>;
	readonly cancelled: Array<string>;
	readonly destroyed: Array<string>;
	readonly destroyCalls: Map<string, number>;
	/** Per job key: the time of the `Clock` at each `destroy` call, in order. */
	readonly destroyTimes: Map<string, Array<number>>;
	/** The most jobs that were accepted and not settled at once. */
	maxLive: number;
	listCalls: number;
	/** The forks that exist, by job key. */
	readonly forks: Map<string, FakeFork>;
	/** Per job key: the agent change its fork was created with, and the entry it was forked at. */
	readonly agents: Map<string, Option.Option<unknown>>;
	readonly ats: Map<string, number>;
	/** Per job key: the prompts its fork accepted, in order; kept when the fork is destroyed. */
	readonly prompts: Map<string, Array<string>>;
	/**
	 * Settles the job's open request now, for a job that settles by nothing else (`settlesAfterMillis: Infinity`); the
	 * notify it was accepted with, for a test that delivers the signal.
	 */
	readonly settle: (jobKey: string) => Option.Option<{ readonly taskId: number; readonly key: string }>;
	/** Succeeds once `holds` is true, asked now and after every call of the driver and every `settle`. */
	readonly when: (holds: () => boolean) => Effect.Effect<void>;
}

/** A fresh fake driver. */
export function fake(options: FakeOptions = {}): Fake {
	const { when, changed } = conditions();
	/** A call of the driver, after which every wait is asked again. */
	const told = <A, E>(call: Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.ensuring(call, Effect.sync(changed));
	const count = (calls: Map<string, number>, key: string): number => {
		const next = (calls.get(key) ?? 0) + 1;
		calls.set(key, next);
		return next;
	};
	const later = (operation: Swarm.ForkRetryLater["operation"], reason: string) =>
		new Swarm.ForkRetryLater({ operation, reason, afterMillis: 1 });
	const isSettled = (request: Request, now: number): boolean =>
		request.cancelled || request.settledNow || now - request.acceptedAt >= request.job.settlesAfterMillis;
	const live = (now: number): number =>
		[...state.forks.values()].reduce(
			(sum, fork) => sum + [...fork.requests.values()].filter((request) => !isSettled(request, now)).length,
			0,
		);
	/** The remote creation: it refuses a key that is held, as an actor host does. */
	const create = (request: Swarm.ForkRequest): "created" | "duplicate" => {
		if (state.forks.has(request.jobKey)) {
			count(state.duplicates, request.jobKey);
			return "duplicate";
		}
		count(state.created, request.jobKey);
		state.agents.set(request.jobKey, request.agent);
		state.ats.set(request.jobKey, request.at);
		state.forks.set(request.jobKey, {
			swarmId: request.swarmId,
			forkId: Swarm.ForkId.make(`fake-${state.created.size}-${request.jobKey}`),
			requests: new Map(),
		});
		return "created";
	};
	const forkOf = (swarmId: Swarm.SwarmId, jobKey: string, fork: FakeFork): Swarm.Fork => ({
		swarmId,
		jobKey: Swarm.JobKey.make(jobKey),
		forkId: fork.forkId,
	});
	const found = (fork: Swarm.Fork): Effect.Effect<FakeFork, Swarm.ForkGone> =>
		Option.match(Option.fromUndefinedOr(state.forks.get(fork.jobKey)), {
			onNone: () =>
				Effect.fail(
					new Swarm.ForkGone({ what: "fork", swarmId: fork.swarmId, jobKey: fork.jobKey, reason: "No such fork" }),
				),
			onSome: (held) => Effect.succeed(held),
		});
	const driver: Swarm.ForkDriverService = {
		fork: (request) =>
			told(
				Effect.suspend((): Effect.Effect<Swarm.Fork, Swarm.ForkRetryLater | Swarm.ForkGone> => {
					const call = count(state.forkCalls, request.jobKey);
					if (options.sourceGone?.(request.jobKey) === true) {
						return Effect.fail(
							new Swarm.ForkGone({
								what: "source",
								swarmId: request.swarmId,
								jobKey: request.jobKey,
								reason: "The source actor was destroyed",
							}),
						);
					}
					if (options.forkBusy?.(request.jobKey, call) === true) {
						return Effect.fail(
							new Swarm.ForkRetryLater({ operation: "fork", reason: "busy", afterMillis: 1, sourceBusy: true }),
						);
					}
					if (options.forkFails?.(request.jobKey, call) === true) return Effect.fail(later("fork", "timed out"));
					// Find or create: a duplicate key is the fork that is asked for.
					create(request);
					if (options.forkAnswerLost?.(request.jobKey, call) === true) {
						return Effect.fail(later("fork", "the answer was lost"));
					}
					return found({ swarmId: request.swarmId, jobKey: request.jobKey, forkId: Swarm.ForkId.make("") }).pipe(
						Effect.map((fork) => forkOf(request.swarmId, request.jobKey, fork)),
					);
				}),
			),
		run: (request) =>
			told(
				Effect.flatMap(found(request.fork), (fork) =>
					Effect.flatMap(Clock.currentTimeMillis, (now) => {
						const call = count(state.runCalls, request.requestId);
						if (options.runFails?.(request.fork.jobKey, call) === true)
							return Effect.fail(later("run", "timed out"));
						if (!fork.requests.has(request.requestId)) {
							count(state.accepted, request.requestId);
							state.prompts.set(request.fork.jobKey, [
								...(state.prompts.get(request.fork.jobKey) ?? []),
								request.prompt,
							]);
							fork.requests.set(request.requestId, {
								prompt: request.prompt,
								notify: request.notify,
								acceptedAt: now,
								job:
									options.job?.(request.fork.jobKey, request.requestId, request.prompt) ?? defaultJob(request),
								cancelled: false,
								settledNow: false,
							});
							state.maxLive = Math.max(state.maxLive, live(now));
						}
						const place = options.place?.(request.fork.jobKey);
						const where = place === undefined ? {} : { place };
						const notice: Swarm.Notice =
							options.notice === "signal"
								? { _tag: "Signal", signal: Settled.name, ...where }
								: { _tag: "Poll", afterMillis: options.notice?.pollMillis ?? 2, ...where };
						return Effect.succeed(notice);
					}),
				),
			),
		job: (fork, requestId) =>
			told(
				Effect.flatMap(found(fork), (held) =>
					Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<Swarm.JobStatus, Swarm.ForkRetryLater> => {
						const call = count(state.jobCalls, requestId);
						if (options.jobFails?.(fork.jobKey, call) === true) return Effect.fail(later("job", "timed out"));
						const request = held.requests.get(requestId);
						if (request === undefined) return Effect.succeed({ _tag: "Unknown" });
						if (request.cancelled) return Effect.succeed({ _tag: "Unanswered", reason: "cancelled" });
						if (!isSettled(request, now)) return Effect.succeed({ _tag: "Running" });
						return Effect.succeed(
							Option.match(request.job.answer, {
								onNone: (): Swarm.JobStatus => ({ _tag: "Unanswered", reason: "model_error" }),
								onSome: (text): Swarm.JobStatus => ({ _tag: "Answered", text }),
							}),
						);
					}),
				),
			),
		cancel: (fork) =>
			told(
				Effect.map(Clock.currentTimeMillis, (now) => {
					state.cancelled.push(fork.jobKey);
					for (const request of state.forks.get(fork.jobKey)?.requests.values() ?? []) {
						if (!isSettled(request, now)) request.cancelled = true;
					}
				}),
			),
		destroy: (fork) =>
			told(
				Effect.flatMap(Clock.currentTimeMillis, (now) => {
					const call = count(state.destroyCalls, fork.jobKey);
					state.destroyTimes.set(fork.jobKey, [...(state.destroyTimes.get(fork.jobKey) ?? []), now]);
					if (options.destroyFails?.(fork.jobKey, call) === true) {
						const afterMillis = options.destroyHint?.(fork.jobKey) ?? 1;
						return Effect.fail(
							new Swarm.ForkRetryLater({ operation: "destroy", reason: "timed out", afterMillis }),
						);
					}
					const existed = state.forks.delete(fork.jobKey);
					if (existed) state.destroyed.push(fork.jobKey);
					const bytes = options.bytes?.(fork.jobKey) ?? Option.some(1000 + state.destroyed.length);
					return Effect.succeed({ bytesWritten: existed ? bytes : Option.none() });
				}),
			),
		list: (swarmId) =>
			told(
				Effect.suspend(() => {
					state.listCalls += 1;
					if (options.listFails?.(state.listCalls) === true) return Effect.fail(later("list", "timed out"));
					return Effect.succeed(
						[...state.forks].flatMap(([jobKey, fork]) =>
							fork.swarmId === swarmId ? [forkOf(swarmId, jobKey, fork)] : [],
						),
					);
				}),
			),
	};
	const state: Fake = {
		driver,
		layer: Layer.merge(Layer.succeed(Swarm.ForkDriver, driver), Swarm.ForkSetup.none),
		forkCalls: new Map(),
		created: new Map(),
		duplicates: new Map(),
		runCalls: new Map(),
		accepted: new Map(),
		jobCalls: new Map(),
		cancelled: [],
		destroyed: [],
		destroyCalls: new Map(),
		destroyTimes: new Map(),
		maxLive: 0,
		listCalls: 0,
		forks: new Map(),
		agents: new Map(),
		ats: new Map(),
		prompts: new Map(),
		settle: (jobKey) => {
			const open = [...(state.forks.get(jobKey)?.requests.values() ?? [])].find(
				(request) => !request.cancelled && !request.settledNow,
			);
			if (open === undefined) return Option.none();
			open.settledNow = true;
			changed();
			return Option.some(open.notify);
		},
		when,
	};
	return state;
}

function defaultJob(request: Swarm.RunRequest): FakeJob {
	const word = /Measure the word (\S+)\./.exec(request.prompt)?.[1] ?? "";
	return { answer: Option.some(JSON.stringify(measured(word))), settlesAfterMillis: 0 };
}
