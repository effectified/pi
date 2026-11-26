import { createRegistry, defineExtension, GenerationTask, hook, section, wrapTool } from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Registry } from "../src/index.ts";
import { extension } from "../src/pi-made.ts";

describe("an extension Pi made", () => {
	it("installs as Pi's own: its namespace, tools, hooks, sections and wrappers, each Pi's object", async () => {
		const write = createWriteTool();
		const made = defineExtension({
			name: "made",
			namespace: { name: "files", description: "Files." },
			tools: [write],
			hooks: [hook(GenerationTask, {})],
			sections: [section("files", () => "Write files.")],
			wraps: [wrapTool(write, (tool) => tool)],
		});
		const pi = createRegistry();
		pi.install(made);
		const ours = await Effect.runPromise(
			Registry.Registry.use((registry) => Effect.sync(() => registry.snapshot())).pipe(
				Effect.provide(Registry.layer([extension(made)])),
			),
		);
		const [installed] = ours.installed();
		// The registry of this package installs every list, an empty one of tasks too.
		expect(installed).toEqual({ ...pi.snapshot().installed()[0], tasks: [] });
		expect(installed?.tools?.[0]).toBe(write);
	});
});
