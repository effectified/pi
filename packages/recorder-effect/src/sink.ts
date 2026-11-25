// The sink port: where a product takes the records, as a service it provides.

import { Context, type Effect, Schema } from "effect";
import type * as Records from "./record.ts";

/** A sink could not take a batch; `cause` is whatever the product's store failed with. The batch is delivered again. */
export class RecordSinkError extends Schema.TaggedError<RecordSinkError>()("RecordSinkError", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return "The record sink failed";
	}
}

/** What a product implements to receive records. */
export interface RecordSinkService {
	/**
	 * Takes one batch. Success means every record of it is stored: the recorder then never delivers them again, unless
	 * the process dies before it noted so. A failure, or a death meanwhile, delivers the whole batch again, so the sink
	 * must be idempotent by `Record.id`. Batches of one conversation come one at a time, in entry order; batches of
	 * different conversations, and advisory records, may come concurrently.
	 */
	readonly deliver: (records: ReadonlyArray<Records.Record>) => Effect.Effect<void, RecordSinkError>;
}

/** The record sink of this program: provided by the product, required by the pump and by the advisory hook. */
export class RecordSink extends Context.Service<RecordSink, RecordSinkService>()(
	"@gunta/pi-recorder-effect/RecordSink",
) {}
