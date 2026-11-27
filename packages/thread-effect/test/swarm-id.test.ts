import { Array as Arr, Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Swarm from "@effectified/pi-swarm";
import { ThreadKey } from "../src/index.ts";
import { SwarmId } from "../src/rivet.ts";

const refused = (swarmId: Swarm.SwarmId) => Effect.runPromise(Effect.flip(SwarmId.threadOf(swarmId)));

describe("a swarm id that names its thread", () => {
	it("is the thread's key, a slash and the swarm's own name, and gives the thread back", async () => {
		expect(SwarmId.of(ThreadKey.make("thread-42"), "covers-1")).toBe("thread-42/covers-1");
		expect(await Effect.runPromise(SwarmId.threadOf(Swarm.SwarmId.make("thread-42/covers-1")))).toBe("thread-42");
		// A thread's key may hold a slash itself: the name is what follows the last one.
		expect(await Effect.runPromise(SwarmId.threadOf(SwarmId.of(ThreadKey.make("group/7/thread"), "covers-1")))).toBe(
			"group/7/thread",
		);
	});

	it("names no thread without a slash, without a name, or without a thread", async () => {
		for (const swarmId of Arr.map(["covers-1", "thread-42/", "/covers-1", ""], (id) => Swarm.SwarmId.make(id))) {
			expect(await refused(swarmId)).toEqual(new SwarmId.SwarmIdNotOfThread({ swarmId }));
		}
	});

	it("is checked against the thread a swarm is to run on, and says what an id must be", async () => {
		await Effect.runPromise(SwarmId.ofThread(ThreadKey.make("thread-42"), Swarm.SwarmId.make("thread-42/covers-1")));
		const other = await Effect.runPromise(
			Effect.flip(SwarmId.ofThread(ThreadKey.make("thread-42"), Swarm.SwarmId.make("thread-7/covers-1"))),
		);
		expect(other).toEqual(
			new SwarmId.SwarmIdNotOfThread({
				swarmId: Swarm.SwarmId.make("thread-7/covers-1"),
				thread: ThreadKey.make("thread-42"),
			}),
		);
		expect(other.message).toBe(
			'Swarm id thread-7/covers-1 is not the id of a swarm of thread thread-42: it must be <thread>/<name>, the name without "/"',
		);
		expect(
			await Effect.runPromise(
				Effect.flip(SwarmId.ofThread(ThreadKey.make("thread-42"), Swarm.SwarmId.make("covers-1"))),
			),
		).toEqual(
			new SwarmId.SwarmIdNotOfThread({
				swarmId: Swarm.SwarmId.make("covers-1"),
				thread: ThreadKey.make("thread-42"),
			}),
		);
	});
});
