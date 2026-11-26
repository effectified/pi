import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

const message = { role: "user" as const, content: "Remember this.", timestamp: 1 };

describe("SessionManager", () => {
	it("keeps a session in memory: entries appended are read back through Pi's methods as Effects", async () => {
		const entries = await runLive(
			Effect.gen(function* () {
				const sessions = yield* SessionManager.inMemory("/project");
				const id = yield* sessions.appendMessage(message);
				return {
					id,
					count: yield* sessions.getEntryCount(),
					leaf: yield* sessions.getLeafId(),
					persisted: yield* sessions.isPersisted(),
				};
			}),
		);
		expect(entries.count).toBe(1);
		expect(entries.leaf).toBe(entries.id);
		expect(entries.persisted).toBe(false);
	});

	it("writes a session to its directory, opens it again and lists it", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const created = yield* SessionManager.create(dir, dir);
				yield* created.appendMessage(message);
				yield* created.appendMessage({ role: "user", content: "Second.", timestamp: 2 });
				const file = yield* created.getSessionFile();
				const opened = yield* SessionManager.open(file ?? "", dir);
				const listed = yield* SessionManager.list(dir, dir);
				const found = yield* SessionManager.findById(dir, yield* created.getSessionId(), dir);
				return { entries: (yield* opened.getEntries()).length, listed: listed.length, found: found === file };
			}),
		);
		expect(seen).toEqual({ entries: 2, listed: 1, found: true });
	});

	it("fails with Pi's error as a CodingAgentError: a label for an entry that does not exist", async () => {
		const failure = await runLive(
			Effect.gen(function* () {
				const sessions = yield* SessionManager.inMemory("/project");
				return yield* Effect.flip(sessions.appendLabelChange("missing", "label"));
			}),
		);
		expect(failure).toMatchObject({ _tag: "CodingAgentError", message: "Entry missing not found" });
	});
});
