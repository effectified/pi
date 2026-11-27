import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentBusy, type AgentError, CannotContinue, ToolFailed, ToolName } from "../src/index.ts";

describe("the errors", () => {
	it("are tagged, carry Pi's message, and a catchTags covers the union", async () => {
		const failures: ReadonlyArray<AgentError> = [
			AgentBusy.make({ message: "Agent is already processing." }),
			CannotContinue.make({ message: "No messages to continue from" }),
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

	it("ToolFailed carries the tool's name, the text the model reads and the failure itself", () => {
		const failure = ToolFailed.make({ tool: ToolName.make("lookup"), message: "not found", cause: { id: "7" } });
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({ _tag: "ToolFailed", tool: "lookup", message: "not found", cause: { id: "7" } });
	});
});
