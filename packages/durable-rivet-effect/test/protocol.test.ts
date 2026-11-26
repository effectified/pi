// The status action without an engine: what it counts of a harness's live work, which is what `Client.fork` decides
// on. A background task of Pi's own (an automatic compaction) is not created here: it needs a context past the
// compaction threshold.

import { Extension, Harness, Task } from "@effectified/pi-durable";
import { TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Protocol from "../src/protocol.ts";
import * as WakeKeeper from "../src/wake-keeper.ts";

const LINGER_MILLIS = 600_000;

/** A task that sleeps, holding no process: live work that is no model request, no tool call and no input. */
const Linger = Task.make({
	name: "test.linger",
	version: 1,
	input: Schema.Struct({}),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("start") }),
		Schema.Struct({ phase: Schema.Literal("asleep") }),
	]),
	result: Schema.Null,
	initial: () => ({ phase: "start" as const }),
	phases: {
		start: (_task, api) =>
			Effect.map(api.now, (now) => Task.sleepUntil(now + LINGER_MILLIS, { phase: "asleep" as const })),
		asleep: () => Effect.succeed(Task.complete(null)),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

/** An actor's schedule that keeps nothing: the status action only asks the keeper to settle. */
const noAlarm: WakeKeeper.Alarm = {
	schedule: () => Effect.succeed("wake"),
	cancel: () => Effect.void,
	scheduled: Effect.succeed([]),
	stayAwake: Effect.void,
	letSleep: Effect.void,
};

const live = WakeKeeper.layer(noAlarm).pipe(
	Layer.provideMerge(
		TestHarness.layer({
			extensions: [Extension.make({ name: "test", tasks: [Linger] })],
			harness: { hostWakes: true },
		}),
	),
);

/** The status the action answers, decoded as a caller decodes it. */
const status = Effect.gen(function* () {
	const answer = yield* Protocol.status.run(null);
	if (answer._tag !== "success") return yield* Effect.die(new Error(`status answered ${answer._tag}`));
	return yield* Protocol.status.decodeOutput(answer.value);
});

/** Creates a `Linger` task of the root conversation and waits until it sleeps. */
const linger = (background: boolean) =>
	Effect.gen(function* () {
		const root = yield* Harness.root;
		const id = yield* root.commit((tx) =>
			tx.createTask(Linger, {}, { ownership: { kind: "conversation" }, background }),
		);
		yield* Harness.resume;
		yield* Effect.repeat(Harness.getTask(id), {
			until: (found) => found._tag === "Some" && found.value.state.status === "sleeping",
		});
	});

describe("the status action", () => {
	it("counts the background tasks of the product apart from the live tasks", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const empty = yield* status;
				yield* linger(true);
				const background = yield* status;
				yield* linger(false);
				return { empty, background, both: yield* status };
			}).pipe(Effect.provide(live)),
		);
		expect(seen.empty).toMatchObject({ tasks: 0, background: 0, submissions: 0 });
		// Only a background task is live: nothing is in flight, so a fork is not refused.
		expect(seen.background).toMatchObject({ tasks: 1, background: 1, submissions: 0, active: false });
		// A task that is not background is work in flight, whatever it does: a fork is refused.
		expect(seen.both).toMatchObject({ tasks: 2, background: 1, submissions: 0 });
	});
});
