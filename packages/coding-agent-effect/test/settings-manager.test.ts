import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

describe("SettingsManager", () => {
	it("keeps settings in memory, read and changed through Pi's methods as Effects", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const settings = yield* SettingsManager.inMemory({ defaultThinkingLevel: "low" });
				yield* settings.setSteeringMode("all");
				return { thinking: yield* settings.getDefaultThinkingLevel(), steering: yield* settings.getSteeringMode() };
			}),
		);
		expect(seen).toEqual({ thinking: "low", steering: "all" });
	});

	it("saves what was changed in the agent directory's settings by the time its scope closes", async () => {
		const saved = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const settings = yield* SettingsManager.create(dir, dir);
						yield* settings.setDefaultModelAndProvider("faux", "faux-1");
					}),
				);
				return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
			}),
		);
		expect(saved).toMatchObject({ defaultProvider: "faux", defaultModel: "faux-1" });
	});
});
