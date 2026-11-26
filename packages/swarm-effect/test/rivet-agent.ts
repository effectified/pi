// Test helper: the product actor of the Rivet suite. One definition is the source of a swarm and each of its forks: a
// harness on a scripted model, the Rivet fork driver, the fork actions and the fork hygiene, with the swarm's host
// operations as product actions. The test and the actors share a process, so the model's counts are the test's.

import { Conversation, Entry, Harness, Registry, Task } from "@effectified/pi-durable";
import { type FauxResponseFactory, ScriptedModels, TestHarness } from "@effectified/pi-durable/testing";
import { Action, Actor, ActorInfo, type Fork, Self } from "@effectified/pi-durable-rivet";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as Swarm from "../src/index.ts";
import * as Records from "../src/rivet/records.ts";
import * as Rivet from "../src/rivet.ts";
import { asked, Granted, jobsOf, Measure, measured, model, noSetup, recordingSetup } from "./support.ts";

/** How often the suite's coordinators ask a fork for its job: short, so the tests do not wait on the interval. */
const POLL_MILLIS = 100;

/** What the scripted model of every actor of the suite was asked. */
export const counts = asked();

/** Per measured word: how long the model takes to answer it, in milliseconds. Default 2. */
export const delays = new Map<string, number>();

/** The key of every actor that ran the fork hygiene, in order: one element per fork that was made. */
export const forked: Array<string> = [];

/** One call of the fork setup of the suite's actors: which of its two, in which actor, about which fork. */
export interface SetUp extends Swarm.ForkSetup.Forked {
	readonly phase: "created" | "beforeStart";
	/** The actor the setup ran in: with the Rivet driver, the fork actor. */
	readonly actorId: string;
}

/** Every call of the fork setup of the suite's actors, in order. */
export const setups: Array<SetUp> = [];

/**
 * The product's fork setup of the suite: the recording one of support.ts, which writes a document for the fork's
 * conversation in its creating commit, noted here with the actor it ran in.
 */
const setup = Layer.effect(
	Swarm.ForkSetup.ForkSetup,
	ActorInfo.use(({ actorId }) =>
		Effect.sync((): Swarm.ForkSetup.ForkSetupService => {
			const { service } = recordingSetup();
			const note = (phase: SetUp["phase"], fork: Swarm.ForkSetup.Forked) =>
				Effect.sync(() => void setups.push({ phase, actorId, ...fork }));
			return {
				created: (tx, fork) => Effect.andThen(service.created(tx, fork), note("created", fork)),
				beforeStart: (fork) => Effect.andThen(service.beforeStart(fork), note("beforeStart", fork)),
			};
		}),
	),
);

/**
 * Holds every model request of the suite whose prompt starts with `Hold`, until the function it returns is called:
 * what makes a source actor busy without touching the jobs of its forks.
 */
export function holdSource(): () => void {
	const held = Promise.withResolvers<void>();
	sourceGate = held.promise;
	return () => {
		sourceGate = undefined;
		held.resolve();
	};
}

let sourceGate: Promise<void> | undefined;

/** Holds every model request of the suite from now on, until the function it returns is called. */
export function hold(): () => void {
	const held = Promise.withResolvers<void>();
	gate = held.promise;
	return () => {
		gate = undefined;
		held.resolve();
	};
}

let gate: Promise<void> | undefined;

const answered = model(counts, (word) => ({
	text: JSON.stringify(measured(word)),
	afterMillis: delays.get(word) ?? 2,
}));

/** The suite's model: the one of support.ts, behind the gate. A request the harness aborts passes the gate. */
const respond: FauxResponseFactory = async (context, options, state, asked) => {
	const last = context.messages.findLast((message) => message.role === "user");
	const held = last !== undefined && textOf(last.content).startsWith("Hold") ? (sourceGate ?? gate) : gate;
	if (held !== undefined) {
		const aborted = new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
		await Promise.race([held, aborted]);
	}
	return answered(context, options, state, asked);
};

const scripted = Layer.effectDiscard(
	ScriptedModels.use((models) => models.setResponses(Array.from({ length: 200 }, () => respond))),
).pipe(Layer.provideMerge(ScriptedModels.layer({ api: "scripted" })));

/**
 * What the harness of the actor runs on: the swarm's coordinator, the models, the Rivet driver, and Rivet's client of
 * the engine the actor runs on, which the host makes from the actor's own context.
 */
const layer = Layer.mergeAll(Registry.layer([Swarm.extension([Measure])]), scripted).pipe(
	Layer.provideMerge(Rivet.layer({ pollMillis: POLL_MILLIS })),
	Layer.provide(Self.client),
	// Every fork is an actor of this definition, and runs the product's fork setup itself.
	Layer.provideMerge(setup),
	Layer.orDie,
);

/** A hygiene step of the test's own: records that a fork was made, by the key of its actor. */
const recordFork: Fork.Hygiene<never> = ActorInfo.use((info) =>
	Effect.sync(() => void forked.push(JSON.stringify(info.key))),
);

const SwarmId = Schema.Struct({ id: Schema.String });

const Job = Schema.Struct({ swarmId: Schema.String, jobKey: Schema.String });

/** One job's result as it crosses the action boundary. */
const JobOutcome = Schema.Union([
	Schema.TaggedStruct("Success", {
		key: Schema.String,
		value: Schema.Struct({ word: Schema.String, length: Schema.Number }),
	}),
	Schema.TaggedStruct("Failure", { key: Schema.String, reason: Schema.String, message: Schema.String }),
]);

/** A swarm's result as it crosses the action boundary. */
const Outcome = Schema.Struct({
	ending: Schema.String,
	jobs: Schema.Array(JobOutcome),
	forks: Schema.Array(
		Schema.Struct({
			jobKey: Schema.String,
			forkId: Schema.String,
			fate: Schema.String,
			bytesWritten: Schema.Option(Schema.Number),
			ran: Schema.Option(Swarm.Place),
		}),
	),
});

/** What a driver call answered, as one line: `fork:<actor id>`, `gone:<what>`, `busy` or `later`. */
const told = (call: Effect.Effect<Swarm.Fork, Swarm.ForkRetryLater | Swarm.ForkGone>): Effect.Effect<string> =>
	Effect.match(call, {
		onSuccess: (fork) => `fork:${fork.forkId}`,
		onFailure: (error) => {
			if (error._tag === "ForkGone") return `gone:${error.what}`;
			return error.sourceBusy === true ? "busy" : "later";
		},
	});

/** The actions of the suite's actors: the fork's own, and the swarm's host operations as a product has them. */
const actions = {
	...Rivet.actions,
	/** Primes the root conversation with `turns` turns, and says where a fork of it starts. */
	prime: Action.make({
		input: Schema.Struct({ turns: Schema.Number }),
		output: Schema.Struct({ conversationId: Conversation.Id, at: Entry.Id }),
		handler: ({ turns }) =>
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				for (let turn = 1; turn <= turns; turn++) {
					yield* root.prompt(`Prime ${turn}`, { requestId: `prime-${turn}` });
				}
				return { conversationId: root.id, at: Option.getOrThrow(yield* root.head) };
			}).pipe(Effect.orDie),
	}),
	/** `Swarm.start` of a swarm that measures `words`, on the root conversation or on the actor's job conversation. */
	start: Action.make({
		input: Schema.Struct({
			id: Schema.String,
			words: Schema.Array(Schema.String),
			cap: Schema.Number,
			onFailure: Schema.Literals(["fail", "collect"]),
			pins: Schema.Array(Schema.String),
			from: Schema.Literals(["root", "job"]),
		}),
		output: Schema.Struct({ taskId: Schema.Number, created: Schema.Boolean }),
		handler: ({ id, words, cap, onFailure, pins, from }) =>
			Effect.gen(function* () {
				const source = from === "root" ? yield* TestHarness.root : Option.getOrThrow(yield* Rivet.jobConversation);
				const plan = { id, source: source.id, jobs: jobsOf(words), cap, onFailure, pins };
				const started = yield* Swarm.start(Measure, plan);
				return { taskId: started.taskId, created: started.created };
			}).pipe(Effect.orDie),
	}),
	/** `Swarm.status`. */
	status: Action.make({
		input: SwarmId,
		output: Schema.Struct({
			running: Schema.Boolean,
			phase: Schema.String,
			jobs: Schema.Array(Schema.Struct({ key: Schema.String, status: Schema.String })),
		}),
		handler: ({ id }) =>
			Effect.orDie(
				Effect.map(Swarm.status(id), ({ running, phase, jobs }) => ({
					running,
					phase,
					jobs: jobs.map(({ key, status }) => ({ key, status })),
				})),
			),
	}),
	/** Where each job of a swarm runs or ran, from `Swarm.status`. */
	places: Action.make({
		input: SwarmId,
		output: Schema.Array(Schema.Struct({ key: Schema.String, ran: Schema.Option(Swarm.Place) })),
		handler: ({ id }) =>
			Effect.orDie(Effect.map(Swarm.status(id), ({ jobs }) => jobs.map(({ key, ran }) => ({ key, ran })))),
	}),
	/** Admits an input to the root conversation that the model holds (`holdSource`), and returns: the actor is busy. */
	holdOn: Action.make({
		input: Schema.Struct({ requestId: Schema.String }),
		output: Schema.Null,
		handler: ({ requestId }) =>
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.submit({ type: "input", content: "Hold on", requestId });
				return null;
			}).pipe(Effect.orDie),
	}),
	/** In a fork: what the fork setup wrote for the job conversation in the commit that created it, if anything. */
	granted: Action.make({
		input: Schema.Null,
		output: Schema.Option(Schema.Struct({ conversationId: Conversation.Id, jobKey: Schema.String })),
		handler: () =>
			Effect.gen(function* () {
				const job = yield* Rivet.jobConversation;
				if (Option.isNone(job)) return Option.none();
				const written = yield* Harness.snapshot(Granted, String(job.value.id));
				return Option.map(written, ({ jobKey }) => ({ conversationId: job.value.id, jobKey }));
			}).pipe(Effect.orDie),
	}),
	/** `Swarm.cancel`. */
	cancel: Action.make({
		input: SwarmId,
		output: Schema.String,
		handler: ({ id }) => Effect.orDie(Swarm.cancel(id)),
	}),
	/** `Swarm.result`: it waits for the coordinator's end, so a test calls it for a swarm that has ended. */
	result: Action.make({
		input: SwarmId,
		output: Outcome,
		error: Swarm.SwarmFaulted,
		handler: ({ id }) =>
			Effect.catch(Swarm.result(Measure, id), (error) =>
				error._tag === "SwarmFaulted" ? Effect.fail(error) : Effect.die(error),
			),
	}),
	/** `Swarm.destroyFork`. */
	destroyFork: Action.make({
		input: Schema.Struct({ id: Schema.String, jobKey: Schema.String }),
		output: Schema.Struct({ bytesWritten: Schema.Option(Schema.Number) }),
		handler: ({ id, jobKey }) => Effect.orDie(Swarm.destroyFork(id, jobKey)),
	}),
	/** `Swarm.events`, collected: `<tag>:<job key>` each. */
	events: Action.make({
		input: SwarmId,
		output: Schema.Array(Schema.String),
		handler: ({ id }) =>
			Effect.orDie(Stream.runCollect(Stream.map(Swarm.events(id), (event) => `${event._tag}:${event.key}`))),
	}),
	/** The driver's `list`: the forks of a swarm that exist, as the actor's own driver knows them. */
	forks: Action.make({
		input: SwarmId,
		output: Schema.Array(Swarm.Fork),
		handler: ({ id }) => Effect.orDie(Swarm.ForkDriver.use((driver) => driver.list(id))),
	}),
	/** The driver's `fork` for a job of the root conversation at its newest entry, as `told` says it. */
	fork: Action.make({
		input: Job,
		output: Schema.String,
		handler: ({ swarmId, jobKey }) =>
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const at = Option.getOrThrow(yield* root.head);
				const driver = yield* Swarm.ForkDriver;
				return yield* told(
					driver.fork({
						swarmId,
						jobKey,
						coordinatorTaskId: Task.Id.make(0),
						sourceConversationId: root.id,
						at,
						agent: Option.none(),
						// The Rivet driver leaves it: the fork actor runs the setup of its own layer.
						setup: noSetup,
					}),
				);
			}).pipe(Effect.orDie),
	}),
	/** The driver's `destroy`, by the actor id a `fork` answered. `destroy` itself is the host's own action. */
	drop: Action.make({
		input: Schema.Struct({ swarmId: Schema.String, jobKey: Schema.String, forkId: Schema.String }),
		output: Schema.Struct({ bytesWritten: Schema.Option(Schema.Number) }),
		handler: (fork) => Effect.orDie(Swarm.ForkDriver.use((driver) => driver.destroy(fork))),
	}),
	/** Writes the driver's intent record of a fork and asks the engine for nothing: a fork call that never returned. */
	intend: Action.make({
		input: Job,
		output: Schema.Null,
		handler: ({ swarmId, jobKey }) => Effect.as(Effect.orDie(Records.intend(swarmId, jobKey)), null),
	}),
	/** The model context of the actor's job conversation, `<role>: <text>` each; empty when it has none. */
	jobTranscript: Action.make({
		input: Schema.Null,
		output: Schema.Array(Schema.String),
		handler: () => jobTranscript,
	}),
};

/** The actor of the suite: the Rivet driver's fork hygiene, then the test's own step. */
export const Swarmer = swarmer("swarmer", [Rivet.forkHygiene, recordFork]);

/** The same actor without the driver's fork hygiene: what a product that forgot it has. */
export const Careless = swarmer("careless", [recordFork]);

function swarmer(name: string, forkHygiene: ReadonlyArray<Fork.Hygiene<never>>) {
	return Actor.make(name, {
		layer,
		forkHygiene,
		options: { sleepTimeout: 60_000, actionTimeout: 60_000 },
		actions,
	});
}

const jobTranscript: Effect.Effect<Array<string>, never, Harness.Harness> = Effect.gen(function* () {
	const job = yield* Rivet.jobConversation;
	if (Option.isNone(job)) return [];
	const view = yield* job.value.context();
	return view.messages.map((message) => `${message.role}: ${textOf(message.content)}`);
}).pipe(Effect.orDie);

function textOf(content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}
