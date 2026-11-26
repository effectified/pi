// `@effectified/pi-durable/storage/jsonl/node`: Pi's JSONL storage on the local file system, as a storage Layer.

import type { JsonlStorageOptions } from "@earendil-works/pi-durable/storage/jsonl";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Layer } from "effect";
import type { DurableError } from "../../errors.ts";
import type { HarnessStorage } from "../../storage.ts";
import { type JsonlError, opened } from "./storage.ts";

export type { JsonlStorage, JsonlStorageOptions } from "@earendil-works/pi-durable/storage/jsonl";
export { JsonlCorrupted, type JsonlError, JsonlPoisoned, JsonlReadOnly } from "./storage.ts";

/**
 * Pi's JSONL storage in `directory` on the local file system, through Node's (Bun runs it too): `jsonl` of
 * `@effectified/pi-durable/storage/jsonl` on Pi's local environment.
 */
export function nodeJsonl(
	directory: string,
	options?: JsonlStorageOptions,
): Layer.Layer<HarnessStorage, JsonlError | DurableError> {
	return opened((context) => openNodeJsonlStorage(directory, context, options));
}
