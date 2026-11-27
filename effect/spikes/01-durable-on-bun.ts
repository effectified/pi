// Spike for PRD section 12: does Pi Durable run under Bun? A scripted two-turn run with one tool call, on memory
// storage and on Pi's own SQLite storage (node:sqlite), closed and reopened once.
// Run from the repository root after `npm run build`:
//   bun effect/spikes/01-durable-on-bun.ts        node effect/spikes/01-durable-on-bun.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";

const context = BACKGROUND_CONTEXT;
const runtime = "Bun" in globalThis ? "bun" : "node";

/** One scripted run; with `reopen`, the storage is opened a second time (a closed memory storage keeps nothing). */
async function run(label: string, open: () => Promise<Storage>, mode: "reopen" | "no reopen"): Promise<void> {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("lookup", { id: "42" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Record 42 is titled Answer.")]),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	let calls = 0;
	const lookup = defineTool({
		name: "lookup",
		description: "Look a record up by id.",
		parameters: obj({ id: str() }),
		execute: async (args) => {
			calls += 1;
			return { output: [{ type: "text", text: `title of ${args.id}: Answer` }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "app", tools: [lookup] }));

	let harness = await Harness.open(await open(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
	const submission = await root.submit({ type: "input", content: "Summarise record 42.", requestId: "s-42" }, context);
	const settled = await submission.wait(context);
	await root.waitForIdle(context);
	const answered = settled.status === "done" && settled.type === "input";
	const counts = `toolCalls=${calls} modelCalls=${faux.state.callCount}`;
	const summary = `${runtime} ${label}: status=${settled.status} ${counts}`;
	if (mode === "no reopen") {
		await harness.close(context);
		console.log(summary);
		return;
	}
	await harness.close(context);

	// Reopen: the same request id finds the same submission, the answer is still there, and nothing runs again.
	harness = await Harness.open(await open(), { models, registry }, context);
	const again = await (
		await harness.root(context)
	).submit({ type: "input", content: "Summarise record 42.", requestId: "s-42" }, context);
	const answer = answered
		? await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
		: undefined;
	await harness.close(context);
	console.log(
		summary,
		`afterReopen: sameSubmission=${again.id === submission.id} modelCalls=${faux.state.callCount}`,
		`answer=${JSON.stringify(answer?.model?.[0])?.slice(0, 70)}`,
	);
}

await run("memory", async () => new MemoryStorage(), "no reopen");
const directory = mkdtempSync(join(tmpdir(), "pi-effect-spike-"));
try {
	await run("sqlite", () => openNodeSqliteStorage(join(directory, "session.sqlite")), "reopen");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
