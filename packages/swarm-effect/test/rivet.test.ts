// The Rivet subpath without an engine: what it exports, where the host package may be imported, and the data a fork
// is made with. Everything that needs an actor is in rivet-suite.ts.

import { readdirSync, readFileSync } from "node:fs";
import { Conversation, Entry, Task } from "@effectified/pi-durable";
import { ActorId, ActorInfo, type Identity } from "@effectified/pi-durable-rivet";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Package from "../src/index.ts";
import * as Assignment from "../src/rivet/assignment.ts";
import * as Rivet from "../src/rivet.ts";
import { noSetup } from "./support.ts";
import { JobKey, SwarmId } from "../src/ids.ts";

const identity = (forkInput: Option.Option<Schema.Json>): Identity => ({
	actorId: ActorId.make("a1"),
	name: "agent",
	key: ["primed"],
	namespace: "default",
	forkChain: [],
	forkInput,
});

describe("the Rivet subpath", () => {
	it("exports the driver's Layer, the fork's actions and the fork hygiene", () => {
		expect(Object.keys(Rivet).sort()).toEqual([
			"Assignment",
			"JobRefused",
			"Options",
			"actions",
			"forkHygiene",
			"forkKey",
			"jobConversation",
			"layer",
		]);
		expect(Object.keys(Rivet.actions).sort()).toEqual(["swarmCancel", "swarmJob", "swarmRun"]);
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.exports["./rivet"]).toEqual({
			source: "./src/rivet.ts",
			types: "./dist/rivet.d.ts",
			import: "./dist/rivet.js",
		});
		// The main entry has nothing of it: a product without Rivet never loads the host.
		expect(Object.keys(Package).filter((name) => name.toLowerCase().includes("rivet"))).toEqual([]);
	});

	it("is the only place of the package that imports the Rivet host, and nothing imports rivetkit", () => {
		const source = new URL("../src/", import.meta.url);
		const files = readdirSync(source, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
		const importing = (specifier: string) =>
			files.filter((file) => readFileSync(new URL(file, source), "utf8").includes(`from "${specifier}`)).sort();
		expect(importing("@effectified/pi-durable-rivet")).toEqual([
			"rivet/actions.ts",
			"rivet/assignment.ts",
			"rivet/driver.ts",
			"rivet/hygiene.ts",
			"rivet/job.ts",
			"rivet/records.ts",
		]);
		expect(importing("rivetkit")).toEqual([]);
	});

	it("derives a fork's key from its source's key, the swarm id and the job key", () => {
		expect(Rivet.forkKey(["tenant", "primed"], SwarmId.make("covers-1"), JobKey.make("rust"))).toEqual([
			"tenant",
			"primed",
			"swarm",
			"covers-1",
			"rust",
		]);
	});

	it("gives a fork its job as the fork input, and reads it back as nothing else", async () => {
		const input = Assignment.of({
			swarmId: SwarmId.make("covers-1"),
			jobKey: JobKey.make("rust"),
			coordinatorTaskId: Task.Id.make(7),
			sourceConversationId: Conversation.Id.make(1),
			at: Entry.Id.make(12),
			agent: Option.some({ modelTools: [] }),
			setup: noSetup,
		});
		expect(input).toEqual({
			_tag: "swarm.rivet.job",
			swarmId: "covers-1",
			jobKey: "rust",
			sourceConversationId: 1,
			at: 12,
			agent: { modelTools: [] },
		});
		const assigned = (forkInput: Option.Option<Schema.Json>) =>
			Effect.runPromise(Effect.provideService(Assignment.assigned, ActorInfo, identity(forkInput)));
		expect(await assigned(Option.some(input))).toEqual(Option.some(input));
		// An actor that is no fork, and one a product forked for a purpose of its own, have no job.
		expect(await assigned(Option.none())).toEqual(Option.none());
		expect(await assigned(Option.some({ reason: "what if" }))).toEqual(Option.none());
		expect(await assigned(Option.some({ _tag: "swarm.rivet.job", swarmId: "covers-1" }))).toEqual(Option.none());
	});

	it("reads a fork input and a run's answer written when their ids were plain numbers and the agent plain JSON", async () => {
		// A fork input as the driver wrote it before: every field of an agent change, by name.
		const input = {
			_tag: "swarm.rivet.job",
			swarmId: "covers-1",
			jobKey: "rust",
			sourceConversationId: 1,
			at: 12,
			agent: {
				model: { provider: "anthropic", modelId: "claude-haiku" },
				thinkingLevel: "low",
				extensions: { remove: ["review"] },
				tools: ["read", "write"],
				modelTools: [],
				instructions: "Be brief.",
				cwd: null,
				maxTurns: 3,
				compaction: { enabled: true, reserveTokens: 1000 },
			},
		};
		const assigned = await Effect.runPromise(
			Effect.provideService(Assignment.assigned, ActorInfo, identity(Option.some(input))),
		);
		expect(Option.map(assigned, Schema.encodeSync(Assignment.Assignment))).toEqual(Option.some(input));
		// What `swarmRun` answers across the wire.
		const { output } = Rivet.actions.swarmRun;
		expect(Schema.encodeSync(output)(Schema.decodeUnknownSync(output)({ conversationId: 4 }))).toEqual({
			conversationId: 4,
		});
	});
});
