// Test helper for parity (PRD section 10): runs one scripted scenario through the facade and through plain Pi
// Durable, and reads what each left in its storage, so a test can assert that both left the same records.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
	type Cursor,
	createRegistry,
	type Page,
	type Extension as PiExtension,
	Harness as PiHarness,
	type Storage as PiStorage,
} from "@earendil-works/pi-durable";
import type { SchemaConversionError, SchemaDecodeError } from "@gunta/pi-schema-effect";
import { Effect, type Layer } from "effect";
import { type DurableError, Harness, type Registry, Storage } from "../src/index.ts";
import { harnessLayer, KeptStorage, scriptedModels } from "./scripted.ts";

/** One scenario, written twice: for the facade and for plain Pi Durable. */
export interface Scenario {
	/** The model's answers, in order; called once per side, so each side gets its own. */
	readonly responses: () => FauxResponseStep[];
	/** The same extensions, defined for each side: a registry Layer, and what plain Pi installs. */
	readonly extensions?: {
		readonly effect: Layer.Layer<Registry.Registry, SchemaConversionError>;
		readonly pi: readonly PiExtension[];
	};
	/** What each side returns is compared too. */
	readonly effect: Effect.Effect<unknown, DurableError | SchemaDecodeError | SchemaConversionError, Harness.Harness>;
	readonly pi: (harness: PiHarness, context: Context) => Promise<unknown>;
}

/** What one side of a scenario left: its storage's records and what the scenario returned, both normalised. */
export interface Side {
	readonly records: Records;
	readonly result: unknown;
}

/**
 * Runs `scenario` on both sides, each on a fresh memory storage, waits until each harness is idle, closes it, and
 * returns what each side left, normalised (see `normalise`).
 */
export async function runBoth(scenario: Scenario): Promise<{ readonly effect: Side; readonly pi: Side }> {
	const effectStorage = new KeptStorage();
	const live = harnessLayer({
		responses: scenario.responses(),
		registry: scenario.extensions?.effect,
		storage: Storage.custom(effectStorage),
	});
	const effectResult = await Effect.runPromise(
		scenario.effect.pipe(Effect.tap(Harness.waitForIdle), Effect.provide(live)),
	);

	const piStorage = new KeptStorage();
	const registry = createRegistry();
	for (const extension of scenario.extensions?.pi ?? []) registry.install(extension);
	const { models } = scriptedModels(scenario.responses());
	const harness = await PiHarness.open(piStorage, { models, registry }, BACKGROUND_CONTEXT);
	// `Harness.layer` is Pi's open followed by `resume()`.
	harness.resume();
	const piResult = await scenario.pi(harness, BACKGROUND_CONTEXT);
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	await harness.close(BACKGROUND_CONTEXT);

	return {
		effect: { records: await records(effectStorage), result: normalise(effectResult) },
		pi: { records: await records(piStorage), result: normalise(piResult) },
	};
}

/** Everything a storage holds, as plain data. */
export interface Records {
	readonly conversations: ReadonlyArray<Record<string, unknown>>;
	readonly entries: ReadonlyArray<Record<string, unknown>>;
	readonly tasks: ReadonlyArray<Record<string, unknown>>;
	readonly submissions: ReadonlyArray<Record<string, unknown>>;
	/** Every current document: its record, stored version and value. */
	readonly documents: ReadonlyArray<{ readonly record: Record<string, unknown>; readonly value: unknown }>;
}

/** Reads every record of `storage` and normalises it. */
export async function records(storage: PiStorage): Promise<Records> {
	const context = BACKGROUND_CONTEXT;
	const conversations = await scanAll((cursor) => storage.scanConversations({}, PAGE, cursor, context));
	const tasks = await scanAll((cursor) => storage.scanTasks({}, PAGE, cursor, context));
	const submissions = await scanAll((cursor) => storage.scanSubmissions({}, PAGE, cursor, context));
	// A fork's scan includes the entries it inherits: keep each entry once, by id.
	const entries = new Map<number, unknown>();
	for (const { id } of conversations) {
		const scan = { conversationId: id, order: "ascending" } as const;
		for (const entry of await scanAll((cursor) => storage.scanEntries(scan, PAGE, cursor, context))) {
			entries.set(entry.id, entry);
		}
	}
	const scopes = [
		{ kind: "session" } as const,
		...conversations.map(({ id }) => ({ kind: "conversation", conversationId: id }) as const),
		...tasks.map(({ id }) => ({ kind: "task", taskId: id }) as const),
	];
	const documents: unknown[] = [];
	for (const scope of scopes) {
		const found = await scanAll((cursor) => storage.scanDocuments({ scope, at: "current" }, PAGE, cursor, context));
		for (const record of found) {
			const stored = await storage.document(record.id, "current", context);
			documents.push({ record, version: stored?.version, value: stored?.value });
		}
	}
	// Normalising goes through JSON, so the typed records leave as plain data.
	return normalise({ conversations, entries: [...entries.values()], tasks, submissions, documents }) as Records;
}

const PAGE = 100;

async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/**
 * A copy of `value` without what differs between two runs of one scenario, so the rest can be compared exactly:
 * wall-clock times (`timestamp`, `startedAt`, `endedAt`) and the random provider session id of `pi.provider`
 * (`sessionId`) hold a fixed marker, and a message's `durationMs` is dropped, because pi-ai only measures it when the
 * scripted message was created in the same millisecond as its request.
 */
export function normalise(value: unknown): unknown {
	if (value === undefined) return value;
	return JSON.parse(
		JSON.stringify(value, (key, field: unknown) => {
			if (key === "durationMs") return undefined;
			return MARKED.has(key) && field !== undefined ? `<${key}>` : field;
		}),
	);
}

const MARKED = new Set(["timestamp", "startedAt", "endedAt", "sessionId"]);
