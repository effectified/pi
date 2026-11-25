// The reviewer's request as a model call record: a wrapper of the product's record sink that adds, after every
// verdict's entry record that holds a request, a `ModelCall` record of that request.

import { RecordSink, type Records } from "@gunta/pi-recorder-effect";
import * as Review from "@gunta/pi-review-effect";
import { Effect, Layer, Option, Schema } from "effect";

/**
 * The fields of `Records.ModelCall` no verdict holds: the review keeps the route that served, how the request ended,
 * its tokens and one cost. They carry their empty value in the record, and `derived.unknown` names them.
 */
const NOT_HELD = ["api", "cost.input", "cost.output", "cost.cacheRead", "cost.cacheWrite", "cost.fromProvider"];

/** Also not held when the request ended without a response: pi-ai reported no usage for it. */
const NOT_ANSWERED = [...NOT_HELD, "usage", "cost.total"];

/** What this module reads of a verdict: the reviewer's request, and when the verdict was decided. */
const Reviewed = Schema.Struct({ call: Review.Call, time: Schema.Number });

// Stored input: an entry's data in the shape its writer gave it, which for another version may be another.
const decode = Schema.decodeUnknownOption(Reviewed);

/**
 * The reviewer's request of a verdict's record, in the shape of every other model call: none for a record of
 * another kind, and for a verdict without a request (the family rule stopped the review before one was sent). Data
 * only, from the record alone, so every delivery of the verdict gives the same record.
 *
 * - `id`: `<conversation>:<entry>:0:model`, the recorder's id of the model call of an entry's first message. No
 *   record of the recorder has it: an entry that gives an `Entry` record has no model message, and gives no other.
 * - `entry`, `task`: the verdict's entry, and the review task that appended it and made the request.
 * - `time`: when the verdict was decided, the one time a verdict holds, not when the response came.
 * - `provider`, `model`, `stopReason`, `error`, the tokens: the verdict's `call`, as the review stored them. The
 *   tokens are those the budget settled.
 * - `cost.total`: pi-ai's cost of the response, as the verdict holds it: what `cost.total` is in every other model
 *   call record. It is not what the lease was charged: that is the route's price, which the product's `Lease` was
 *   told when the request was settled.
 * - `responseModel`, `responseId`, `durationMs`, `usage.cacheWrite1h`, `usage.reasoning`: `null`, the record's
 *   own word for a value that is absent.
 * - `derived`: `from` is the id of the verdict's record; `unknown` names the fields a verdict does not hold, which
 *   carry `""`, `0` or `false`: the api, the parts of the cost and whether a provider billed it, and, for a request
 *   that ended without a response, the tokens and the cost as a whole.
 */
export function modelCall(record: Records.Record): Option.Option<Records.ModelCall> {
	if (record._tag !== "Entry" || record.kind !== Review.VerdictEntry.kind) return Option.none();
	return Option.map(decode(record.data), ({ call, time }) => ({
		_tag: "ModelCall",
		id: `${record.conversation}:${record.entry}:0:model`,
		conversation: record.conversation,
		entry: record.entry,
		time,
		advisory: false,
		task: record.task,
		provider: call.provider,
		model: call.model,
		api: "",
		responseModel: null,
		responseId: null,
		stopReason: call.stopReason,
		error: call.error ?? null,
		usage: {
			input: call.usage?.input ?? 0,
			output: call.usage?.output ?? 0,
			cacheRead: call.usage?.cacheRead ?? 0,
			cacheWrite: call.usage?.cacheWrite ?? 0,
			cacheWrite1h: null,
			reasoning: null,
			totalTokens: call.usage?.totalTokens ?? 0,
		},
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: call.usage?.cost ?? 0,
			fromProvider: false,
		},
		durationMs: null,
		derived: { from: record.id, unknown: call.usage === undefined ? NOT_ANSWERED : NOT_HELD },
	}));
}

/**
 * The record sink the composition's recorder delivers to: the product's own, which gets every batch as it is, with
 * the `modelCall` of each verdict's record right after that record, in the same batch. Nothing else changes: no
 * record is dropped, reordered or rewritten, and no id of the recorder is used twice. The recorder itself knows no
 * review: this is the one place that knows both.
 */
export const layer: Layer.Layer<RecordSink, never, RecordSink> = Layer.effect(
	RecordSink,
	RecordSink.use((sink) =>
		Effect.succeed({
			deliver: (records: ReadonlyArray<Records.Record>) =>
				sink.deliver(records.flatMap((record) => [record, ...Option.toArray(modelCall(record))])),
		}),
	),
);
