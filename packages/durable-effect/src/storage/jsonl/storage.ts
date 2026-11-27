// Pi's JSONL storage as a storage Layer: a directory of append-only files on any environment's file system.

import {
	JsonlCorruptionError,
	JsonlStorage,
	type JsonlStorageOptions,
	JsonlStoragePoisonedError,
	JsonlStorageReadOnlyError,
} from "@earendil-works/pi-durable/storage/jsonl";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import { Effect, type Layer, Schema } from "effect";
import { call } from "../../call.ts";
import type { FileSystem } from "../../env/index.ts";
import type { DurableError } from "../../errors.ts";
import { custom, type HarnessStorage } from "../../storage.ts";

/** A JSONL storage directory is damaged in a way recovery cannot repair: opening it fails with this. */
export class JsonlCorrupted extends Schema.TaggedError<JsonlCorrupted, { readonly brand: unique symbol }>()(
	"JsonlCorrupted",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** A commit reached a JSONL storage opened `readOnly`; nothing was written. */
export class JsonlReadOnly extends Schema.TaggedError<JsonlReadOnly, { readonly brand: unique symbol }>()(
	"JsonlReadOnly",
	{
		message: Schema.String,
	},
) {}

/** A JSONL storage failed to write and refuses everything until it is reopened. */
export class JsonlPoisoned extends Schema.TaggedError<JsonlPoisoned, { readonly brand: unique symbol }>()(
	"JsonlPoisoned",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** What opening a JSONL storage fails with besides Pi's failures. */
export type JsonlError = JsonlCorrupted | JsonlReadOnly | JsonlPoisoned;

/**
 * Pi's JSONL storage in `directory` on the file system `fs` (an environment of `@effectified/pi-durable/env`, which
 * is one), created when absent unless `readOnly`. Opening recovers what a crash left. Closing the harness or the
 * Layer's scope closes it. A storage call that fails later fails the harness (`SessionFailed`), with Pi's error as its
 * cause.
 */
export function jsonl(
	directory: string,
	fs: FileSystem,
	options?: JsonlStorageOptions,
): Layer.Layer<HarnessStorage, JsonlError | DurableError> {
	return opened((context) => JsonlStorage.open(directory, fs, context, options));
}

/** A JSONL storage `open` opens as a storage Layer, its own failures tagged. */
export function opened(
	open: (context: ChordContext) => Promise<JsonlStorage>,
): Layer.Layer<HarnessStorage, JsonlError | DurableError> {
	return custom(Effect.mapError(call(open), tagged));
}

/** Pi's JSONL errors, which `call` leaves untagged, with their tags: what Pi rejected with is unknown, so the classes are tested here. */
function tagged(error: DurableError): JsonlError | DurableError {
	if (error._tag !== "UnexpectedError") return error;
	const cause = error.cause;
	if (cause instanceof JsonlCorruptionError) {
		return JsonlCorrupted.make({
			message: cause.message,
			...(cause.cause === undefined ? {} : { cause: cause.cause }),
		});
	}
	if (cause instanceof JsonlStorageReadOnlyError) return JsonlReadOnly.make({ message: cause.message });
	if (cause instanceof JsonlStoragePoisonedError)
		return JsonlPoisoned.make({ message: cause.message, cause: cause.cause });
	return error;
}
