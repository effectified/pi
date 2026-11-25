// Test helper: thread actors on host processes that die, against a real Rivet engine, registered once per runtime by
// hosts.node.test.ts and hosts.bun.test.ts. The engine is the host's local one, started by the test; every host is a
// child process of the test that serves the same engine, and is killed for real. What the hosts change outside (the
// lease, the sinks, the models, the tools' effects) is in the test's process and outlives them.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@gunta/pi-durable-rivet-effect";
import type * as LocalEngine from "@gunta/pi-durable-rivet-effect/node";
import { Context, Effect, Exit, Layer, Option, Schedule, Scope } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Remote, SwarmId } from "../src/rivet.ts";
import { type Of, type Outside, outside } from "./hosts-outside.ts";
import { HOST_POOL, threadOn } from "./hosts-thread.ts";
import type { Ask, Turn } from "./hosts-wire.ts";
import { Covers, FORK, work } from "./world.ts";

/** Registers the suite on the local engine of one runtime: the host's `node` or `bun` entry. */
export function registerHostsSuite(runtime: string, engines: typeof LocalEngine): void {
	const available = Effect.runSync(engines.available);
	if (!available) {
		console.warn(
			`Skipping the host process suite: no Rivet engine binary. Install @rivetkit/engine-cli-${process.platform}-${process.arch} or set RIVET_ENGINE_BINARY_PATH.`,
		);
	}
	describe.skipIf(!available)(`threads on host processes, on a local engine (${runtime})`, () => suite(engines));
}

/** The model: it calls the tool its prompt names once, then answers; the reviewer finds nothing. */
const turn = (ask: Of<"model">): Turn => {
	const topic = /cover (\w+)\?/.exec(ask.prompt)?.[1];
	if (ask.lab !== "reviewer-lab" && topic !== undefined) {
		return { kind: "answer", text: JSON.stringify({ topic, covered: true }) };
	}
	if (ask.lab === "reviewer-lab") return { kind: "answer", text: '{"findings":[]}' };
	const tool = /^use (\w+)/.exec(ask.prompt)?.[1];
	if (tool === undefined || ask.toolResults.length > 0) return { kind: "answer", text: "Done." };
	return { kind: "call", tool, note: ask.prompt };
};

interface HostProcess {
	readonly name: string;
	readonly child: ChildProcess;
	readonly ended: Promise<void>;
}

function suite(engines: typeof LocalEngine): void {
	const scope = Effect.runSync(Scope.make());
	let endpoint = "";
	let world: Outside;
	let remote: Remote.Service;
	let client: Context.Context<Client.RivetClient>;
	let hosts: Array<HostProcess> = [];
	let started = 0;
	const Thread = threadOn("", "test");

	beforeAll(async () => {
		const built = await Effect.runPromise(
			Effect.gen(function* () {
				// No actor is hosted here: the registry that comes with the engine serves another pool.
				const engine = yield* engines.serve({ actors: [], logging: { level: "error" } });
				const context = yield* Layer.build(Client.layer({ endpoint: engine.endpoint, poolName: HOST_POOL }));
				const services = yield* Effect.provideContext(Layer.build(Remote.layer(Thread)), context);
				return { endpoint: engine.endpoint, client: context, remote: Context.get(services, Remote.Remote) };
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		);
		({ endpoint, client, remote } = built);
	}, 90_000);

	afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)), 60_000);

	beforeEach(async () => {
		world = await outside(turn);
	});

	afterEach(async () => {
		for (const { child } of hosts) child.kill("SIGKILL");
		await Promise.all(hosts.map(({ ended }) => ended));
		hosts = [];
		await world.close();
	}, 30_000);

	const run = <A, E>(effect: Effect.Effect<A, E, Client.RivetClient>): Promise<A> =>
		Effect.runPromise(Effect.provideContext(effect, client));

	/** Starts one more host process, and succeeds once it has registered with the engine. */
	const host = async (): Promise<HostProcess> => {
		const name = `host-${++started}`;
		const entry = fileURLToPath(new URL("./hosts-process.ts", import.meta.url));
		// The same runtime as the test. rivetkit's storage path is inherited, so nothing is kept under the home.
		const child = spawn(process.execPath, ["--conditions=source", entry, endpoint, world.url, name], {
			stdio: ["pipe", "ignore", "inherit"],
			env: process.env,
		});
		const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		hosts.push({ name, child, ended });
		await world.until(`${name} is ready`, () => world.of("ready").some((ask) => ask.host === name), 45_000);
		return { name, child, ended };
	};

	const signal = async ({ child, ended }: HostProcess, how: "SIGKILL" | "SIGTERM"): Promise<void> => {
		child.kill(how);
		await ended;
	};

	/** The outcome events the sink took for `thread`: what each says, with its id. */
	const told = (thread: string) => world.of("outcome").filter((event) => event.thread === thread);

	const ended = (thread: string, millis?: number) =>
		world.until(`${thread} is reviewed`, () => told(thread).some((event) => event.says === "Reviewed"), millis);

	const start = (thread: string, task: string) =>
		run(remote.threads.start(work(thread, task, ["note_once", "note_again"]), `job-${thread}`));

	const authorAsks = (prompt: string) =>
		world.of("model").filter((ask) => ask.lab === "author-lab" && ask.prompt === prompt);

	const toolRuns = (note: string) => world.of("tool").filter((ask) => ask.note === note);

	/** The host that ran the actor of the newest wake. */
	const hostOf = (actor: string): HostProcess => {
		const name = world.of("woke").findLast((ask) => ask.actor === actor)?.host;
		const found = hosts.find((one) => one.name === name);
		if (found === undefined) throw new Error(`No host runs ${actor}`);
		return found;
	};

	const actorOf = async (thread: string): Promise<string> => {
		const found = await run(Client.find(Thread, [thread]));
		if (found._tag === "None") throw new Error(`No actor for ${thread}`);
		return found.value.actorId;
	};

	/** Pairs of wakes of one actor whose signs of life overlap: the same actor in two places at once. */
	const overlaps = (): ReadonlyArray<string> => {
		const spans = new Map<string, { actor: string; host: string; from: number; to: number }>();
		for (const { at, ask } of world.asks) {
			if (ask.kind !== "woke" && ask.kind !== "beat") continue;
			const span = spans.get(ask.wake);
			if (span === undefined) spans.set(ask.wake, { actor: ask.actor, host: ask.host, from: at, to: at });
			else span.to = at;
		}
		const all = [...spans.values()];
		return all.flatMap((one, index) =>
			all
				.slice(index + 1)
				.filter((other) => other.actor === one.actor && other.from < one.to && one.from < other.to)
				.map((other) => `${one.actor} on ${one.host} and ${other.host}`),
		);
	};

	/** The lease after a thread: what was reserved and not settled, and what was settled more than once. */
	const lease = () => {
		const settled = world.of("settle").map((ask) => ask.token);
		const reserved = world.of("reserve").map((_, index) => `r${index + 1}`);
		return {
			open: reserved.filter((token) => !settled.includes(token)),
			twice: settled.filter((token, index) => settled.indexOf(token) !== index),
			total: world.of("settle").reduce((sum, ask) => sum + ask.settlement.cost, 0n),
		};
	};

	/** The ids the sink took with two contents, and the ids of the outcome events it took. */
	const expectOutcomes = (thread: string) => {
		const byId = new Map(told(thread).map((event) => [event.id, event]));
		expect([...byId.values()].map((event) => event.says)).toEqual(["Started", "Reviewed"]);
		for (const event of told(thread)) {
			const first = byId.get(event.id);
			expect([event.says, event.settledMicros]).toEqual([first?.says, first?.settledMicros]);
		}
	};

	it("goes on in a second host process after the first was killed in a model request", async () => {
		const prompt = "use note_once in a killed request";
		const first = await host();
		const request = world.holdNext((ask) => ask.kind === "model" && ask.prompt === prompt);
		await start("request", prompt);
		await request.reached;
		await signal(first, "SIGKILL");
		const second = await host();
		await ended("request");
		expect(overlaps()).toEqual([]);
		expect(hostOf(await actorOf("request")).name).toBe(second.name);
		// The request that was cut off was sent again, with the conversation's session: the one key Pi sends.
		const asked = authorAsks(prompt);
		expect(asked.map((ask) => [ask.host, ask.toolResults.length])).toEqual([
			[first.name, 0],
			[second.name, 0],
			[second.name, 1],
		]);
		expect(new Set(asked.map((ask) => ask.session)).size).toBe(1);
		expect(asked[0]?.session).not.toBeNull();
		// Its advisory record carries the same id in both processes.
		const advisories = world
			.of("records")
			.flatMap((ask) => ask.batch)
			.filter((record) => record._tag === "ModelCallRequested");
		expect(advisories.length).toBe(3);
		expect(advisories[0]?.id).toBe(advisories[1]?.id);
		expect(toolRuns(prompt)).toHaveLength(1);
		expectOutcomes("request");
		expect(told("request").filter((event) => event.says === "Reviewed")).toHaveLength(1);
		// The killed request's reservation is settled by nobody: the product's lease expires it. Nothing is twice.
		expect(world.of("reserve")).toHaveLength(4);
		const { open, twice, total } = lease();
		expect([open, twice]).toEqual([["r1"], []]);
		// The request sent again is reserved under the key of the one that was killed, whose reservation is still
		// open: the lease can tell the resend from a new request. The request after the tool's result asks more.
		const [killed, resent, next] = world.of("reserve");
		expect([killed?.host, killed?.requestKey]).toEqual([first.name, expect.stringMatching(/^[0-9a-f]{64}$/)]);
		expect([resent?.host, resent?.requestKey]).toEqual([second.name, killed?.requestKey]);
		expect([next?.session, next?.requestKey === killed?.requestKey]).toEqual([killed?.session, false]);
		expect(told("request").at(-1)?.settledMicros).toBe(total);
	}, 150_000);

	it("never runs an unsafe tool twice: killed between its effect and its commit, the call reads interrupted", async () => {
		const prompt = "use note_once in a killed call";
		const first = await host();
		const call = world.holdNext((ask) => ask.kind === "tool" && ask.note === prompt);
		await start("unsafe", prompt);
		await call.reached;
		await signal(first, "SIGKILL");
		const second = await host();
		await ended("unsafe");
		expect(overlaps()).toEqual([]);
		expect(toolRuns(prompt).map((ask) => ask.host)).toEqual([first.name]);
		// The model is shown that the call was interrupted, and the turn that asked for it is not asked again.
		const asked = authorAsks(prompt);
		expect(asked.map((ask) => [ask.host, ask.toolResults.length])).toEqual([
			[first.name, 0],
			[second.name, 1],
		]);
		const [result] = world
			.of("records")
			.flatMap((ask) => ask.batch)
			.filter((record) => record._tag === "ToolCallResult");
		expect(result).toMatchObject({ isError: true });
		expect(asked[1]?.toolResults[0]).toMatch(/interrupt/i);
		expectOutcomes("unsafe");
		expect(lease()).toMatchObject({ open: [], twice: [], total: told("unsafe").at(-1)?.settledMicros });
	}, 150_000);

	it("runs a safe tool again, also when no host was there at the time of the recovery wake", async () => {
		const prompt = "use note_again in a killed call";
		const first = await host();
		const call = world.holdNext((ask) => ask.kind === "tool" && ask.note === prompt);
		await start("safe", prompt);
		await call.reached;
		await signal(first, "SIGKILL");
		// With no host at all a call finds nobody to answer, and says so: worth sending again.
		const hurried = await run(Layer.build(Remote.layer(Thread, { timeout: "2 seconds" })).pipe(Effect.scoped));
		const unanswered = await run(Effect.flip(Context.get(hurried, Remote.Remote).threads.probe("safe")));
		expect(unanswered).toMatchObject({ _tag: "HostUnavailable", operation: "probe" });
		// Longer than the recovery wake is ahead (15 seconds): it comes due with nobody to run it.
		await new Promise((resolve) => setTimeout(resolve, 18_000));
		const second = await host();
		await ended("safe");
		expect(overlaps()).toEqual([]);
		expect(toolRuns(prompt).map((ask) => ask.host)).toEqual([first.name, second.name]);
		expect(authorAsks(prompt)).toHaveLength(2);
		expectOutcomes("safe");
		expect(lease()).toMatchObject({ open: [], twice: [], total: told("safe").at(-1)?.settledMicros });
	}, 180_000);

	it("tells an outcome again under its id when the host died after the sink took it", async () => {
		const prompt = "no tool, and a killed delivery";
		const first = await host();
		const event = world.holdNext((ask) => ask.kind === "outcome" && ask.says === "Reviewed");
		await start("told", prompt);
		await event.reached;
		await signal(first, "SIGKILL");
		const second = await host();
		await world.until("it is told again", () => told("told").filter(({ says }) => says === "Reviewed").length === 2);
		// At least once, which is what the port promises: two deliveries of one id and one content.
		expect(
			told("told")
				.filter(({ says }) => says === "Reviewed")
				.map(({ host: by }) => by),
		).toEqual([first.name, second.name]);
		expectOutcomes("told");
		expect(authorAsks(prompt)).toHaveLength(1);
		expect(lease()).toMatchObject({ open: [], twice: [] });
		expect(overlaps()).toEqual([]);
	}, 150_000);

	it("serves threads from two hosts, each actor in one of them, and reaches every actor wherever it runs", async () => {
		await host();
		await host();
		const threads = Array.from({ length: 12 }, (_, index) => `many-${index}`);
		await Promise.all(threads.map((thread) => start(thread, `use note_once for ${thread}`)));
		await Promise.all(threads.map((thread) => ended(thread)));
		// Every call goes through one client, and each answers from the actor's own storage.
		const probes = await Promise.all(threads.map((thread) => run(remote.threads.outcome(thread))));
		expect(probes.map((outcome) => outcome._tag)).toEqual(threads.map(() => "Some"));
		const actors = await Promise.all(threads.map(actorOf));
		// An actor an earlier test left with a wake scheduled may wake here too: only this test's are counted.
		const woke = world.of("woke").filter((ask) => actors.includes(ask.actor));
		expect(new Set(woke.map((ask) => ask.host)).size).toBe(2);
		expect(woke.map((ask) => ask.actor).sort()).toEqual([...actors].sort());
		expect(overlaps()).toEqual([]);
		for (const thread of threads) {
			expect(toolRuns(`use note_once for ${thread}`)).toHaveLength(1);
			expectOutcomes(thread);
		}
		expect(lease()).toMatchObject({ open: [], twice: [] });
		// The same key from many callers at once is one actor.
		const same = await Promise.all(Array.from({ length: 8 }, () => run(Client.getOrCreate(Thread, ["one-key"]))));
		expect(new Set(same.map((handle) => handle.actorId)).size).toBe(1);
	}, 150_000);

	for (const how of ["SIGKILL", "SIGTERM"] as const) {
		it(`loses no thread when one of two hosts leaves by ${how}`, async () => {
			const hostA = await host();
			const hostB = await host();
			const threads = Array.from({ length: 6 }, (_, index) => `leave-${how}-${index}`);
			const holds = threads.map((thread) =>
				world.holdNext((ask) => ask.kind === "model" && ask.prompt === `use note_once for ${thread}`),
			);
			await Promise.all(threads.map((thread) => start(thread, `use note_once for ${thread}`)));
			await Promise.all(holds.map((held) => held.reached));
			const actors = await Promise.all(threads.map(actorOf));
			// The host that has work leaves; the other one stays.
			const leaving = hostOf(actors[0] ?? "");
			const staying = leaving.name === hostA.name ? hostB : hostA;
			const moved = threads.filter((_, index) => hostOf(actors[index] ?? "").name === leaving.name);
			await signal(leaving, how);
			for (const held of holds) held.release();
			// A call reaches an actor whose host left, in the host that stayed.
			const probe = await run(remote.threads.probe(threads[0] ?? ""));
			expect(probe).toEqual({ alive: true });
			await Promise.all(threads.map((thread) => ended(thread)));
			expect(overlaps()).toEqual([]);
			for (const thread of threads) {
				const prompt = `use note_once for ${thread}`;
				expect(toolRuns(prompt)).toHaveLength(1);
				expect(authorAsks(prompt)).toHaveLength(moved.includes(thread) ? 3 : 2);
				expectOutcomes(thread);
			}
			for (const actor of actors) expect(hostOf(actor).name).toBe(staying.name);
			// A killed host leaves the reservations of its requests open; one that left in order settled them.
			expect(lease()).toMatchObject({ twice: [] });
			expect(lease().open).toHaveLength(how === "SIGKILL" ? moved.length : 0);
		}, 150_000);
	}

	it("fences a host that was frozen until its actor moved: thawed with the model's reply in hand, it changes nothing", async () => {
		const prompt = "use note_once while frozen";
		const frozen = await host();
		const held = world.holdNext((ask) => ask.kind === "model" && ask.prompt === prompt);
		await start("frozen", prompt);
		await held.reached;
		const actor = await actorOf("frozen");
		const second = await host();
		frozen.child.kill("SIGSTOP");
		// The reply is in the frozen process's socket: it reads it the moment it runs again.
		held.release();
		await ended("frozen", 120_000);
		const thawedAt = world.asks.length;
		frozen.child.kill("SIGCONT");
		// It is told to stop, and closes the actor it still holds in memory.
		await world.until("the thawed host closed its actor", () =>
			world.of("closed").some((ask) => ask.host === frozen.name && ask.actor === actor),
		);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		// What it did between: at most it settled the request it had sent. No tool, no request, no outcome, no record.
		const late = world.asks.slice(thawedAt).filter(({ ask }) => ask.host === frozen.name && ask.kind !== "beat");
		expect(late.map(({ ask }) => ask.kind).filter((kind) => kind !== "settle" && kind !== "closed")).toEqual([]);
		expect(toolRuns(prompt).map((ask) => ask.host)).toEqual([second.name]);
		expect(authorAsks(prompt).map((ask) => ask.host)).toEqual([frozen.name, second.name, second.name]);
		expectOutcomes("frozen");
		expect(lease().twice).toEqual([]);
	}, 200_000);

	it("finishes a swarm whose coordinator's host was killed while its forks worked", async () => {
		const hostA = await host();
		const hostB = await host();
		await start("swarm", "no tool, prime");
		await ended("swarm");
		const source = await actorOf("swarm");
		const topics = ["Rust", "Go", "Zig", "Ada"];
		const asking = (topic: string) => (ask: Ask) =>
			ask.kind === "model" && ask.prompt.startsWith(`Does the record you read cover ${topic}?`);
		const holds = topics.map((topic) => world.holdNext(asking(topic)));
		const id = SwarmId.of("swarm", "covers");
		await run(
			remote.swarms.run(Covers, {
				id,
				thread: "swarm",
				jobs: topics.map((topic) => ({ key: topic.toLowerCase(), input: { topic } })),
				cap: topics.length,
				onFailure: "collect",
				fork: FORK,
			}),
		);
		await Promise.all(holds.map((held) => held.reached));
		const leaving = hostOf(source);
		const staying = leaving.name === hostA.name ? hostB : hostA;
		await signal(leaving, "SIGKILL");
		for (const held of holds) held.release();
		const result = await run(
			Effect.map(
				Effect.repeat(remote.swarms.result(Covers, id), {
					until: Option.isSome,
					schedule: Schedule.spaced("500 millis"),
				}),
				Option.getOrThrow,
			),
		);
		expect(result.jobs).toEqual(
			topics.map((topic) => ({ _tag: "Success", key: topic.toLowerCase(), value: { topic, covered: true } })),
		);
		// One fork per job, none made twice; a job whose host was killed was asked again, with the same session.
		expect(result.forks.map((fork) => [fork.jobKey, fork.fate])).toEqual(
			topics.map((topic) => [topic.toLowerCase(), "destroyed"]),
		);
		for (const topic of topics) {
			const asked = world.of("model").filter(asking(topic));
			expect(asked.map((ask) => ask.host)).toEqual(
				asked[0]?.host === leaving.name ? [leaving.name, staying.name] : [staying.name],
			);
			expect(new Set(asked.map((ask) => ask.session)).size).toBe(1);
		}
		expect(overlaps()).toEqual([]);
		expect(lease().twice).toEqual([]);
		const asked = world.of("model").filter((ask) => ask.lab === "author-lab" && ask.host === leaving.name);
		expect(lease().open).toHaveLength(asked.filter((ask) => ask.prompt.startsWith("Does")).length);
	}, 200_000);
}
