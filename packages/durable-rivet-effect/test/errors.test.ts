// The typed failures of the host: their tags, and messages that name what failed without quoting content.

import { describe, expect, it } from "vitest";
import {
	ActionFailed,
	ActorDefect,
	ActorGone,
	EngineUnavailable,
	ForkKeyHeld,
	ForkTooDeep,
	NotIdle,
} from "../src/errors.ts";
import { ActorId } from "../src/ids.ts";

describe("the host's errors", () => {
	it("are tagged, and say what failed", () => {
		const errors = [
			NotIdle.make({ actorId: ActorId.make("a1"), tasks: 2, submissions: 1 }),
			ActorGone.make({ actor: "agent", actorId: ActorId.make("a1") }),
			EngineUnavailable.make({ code: "actor.fork_unavailable", message: "Forks are paused.", retryable: true }),
			ActionFailed.make({ action: "ask", error: { secret: "content" } }),
			ActorDefect.make({ action: "ask", message: "the handler broke" }),
			ForkKeyHeld.make({ actor: "agent", key: ["job", "7"], heldBy: ActorId.make("a2") }),
			ForkTooDeep.make({ actor: "agent", actorId: ActorId.make("a1"), reason: "16 forks deep." }),
		];
		expect(errors.map((error) => [error._tag, error.message])).toEqual([
			["NotIdle", "Actor a1 is not idle: 2 live tasks, 1 unsettled submissions"],
			["ActorGone", "Actor agent a1 does not exist or was destroyed"],
			["EngineUnavailable", "Forks are paused."],
			["ActionFailed", "Action ask failed"],
			["ActorDefect", "the handler broke"],
			["ForkKeyHeld", 'Key ["job","7"] of agent is held by actor a2, which is not a fork of the source'],
			["ForkTooDeep", "Actor agent a1 cannot be forked: 16 forks deep."],
		]);
	});
});
