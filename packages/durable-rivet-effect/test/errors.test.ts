// The typed failures of the host: their tags, and messages that name what failed without quoting content.

import { describe, expect, it } from "vitest";
import { ActionFailed, ActorDefect, ActorGone, EngineUnavailable, ForkKeyHeld, NotIdle } from "../src/errors.ts";

describe("the host's errors", () => {
	it("are tagged, and say what failed", () => {
		const errors = [
			new NotIdle({ actorId: "a1", tasks: 2, submissions: 1 }),
			new ActorGone({ actor: "agent", actorId: "a1" }),
			new EngineUnavailable({ code: "actor.fork_unavailable", message: "Forks are paused.", retryable: true }),
			new ActionFailed({ action: "ask", error: { secret: "content" } }),
			new ActorDefect({ action: "ask", message: "the handler broke" }),
			new ForkKeyHeld({ actor: "agent", key: ["job", "7"], heldBy: "a2" }),
		];
		expect(errors.map((error) => [error._tag, error.message])).toEqual([
			["NotIdle", "Actor a1 is not idle: 2 live tasks, 1 unsettled submissions"],
			["ActorGone", "Actor agent a1 does not exist or was destroyed"],
			["EngineUnavailable", "Forks are paused."],
			["ActionFailed", "Action ask failed"],
			["ActorDefect", "the handler broke"],
			["ForkKeyHeld", 'Key ["job","7"] of agent is held by actor a2, which is not a fork of the source'],
		]);
	});
});
