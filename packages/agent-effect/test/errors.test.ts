import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentBusy, type AgentError, CannotContinue } from "../src/index.ts";

describe("the errors", () => {
	it("are tagged, carry Pi's message, and a catchTags covers the union", async () => {
		const failures: ReadonlyArray<AgentError> = [
			new AgentBusy({ message: "Agent is already processing." }),
			new CannotContinue({ message: "No messages to continue from" }),
		];
		const handled = await Effect.runPromise(
			Effect.forEach(failures, (failure) =>
				Effect.fail(failure).pipe(
					Effect.catchTags({
						AgentBusy: (error) => Effect.succeed(`busy: ${error.message}`),
						CannotContinue: (error) => Effect.succeed(`cannot: ${error.message}`),
					}),
				),
			),
		);
		expect(handled).toEqual(["busy: Agent is already processing.", "cannot: No messages to continue from"]);
	});
});
