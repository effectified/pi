// The reviewer's request as a model call record: a wrapper of the product's record sink that adds, after every
// verdict's entry record that holds a request, a `ModelCall` record of that request.

import { RecordSink, Records } from "@effectified/pi-recorder";
import * as Review from "@effectified/pi-review";
import { Array as Arr, Effect, Layer, Option, Record, Result, Schema } from "effect";

/** What this module reads of a verdict: the reviewer's request, and when the verdict was decided (epoch millis). */
const Reviewed = Schema.Struct({ call: Review.Call, time: Review.Verdict.fields.time });

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
 * - `time`: when the request started, as every model call record has it; the verdict's own time for a verdict
 *   stored before the review kept it.
 * - The other fields: the verdict's `call`, as the review stored it from pi-ai's response, with `null` where pi-ai
 *   reported nothing, as in every other model call record. The tokens are those the budget settled. `cost.total` is
 *   pi-ai's cost of the response, not what the lease was charged: that is the route's price, which the product's
 *   `Lease` was told when the request was settled.
 * - `derived`: `from` is the id of the verdict's record; `unknown` names the fields the verdict does not hold, which
 *   carry `""`, `0` or `false` (`unknownOf`).
 */
export function modelCall(record: Records.Record): Option.Option<Records.ModelCall> {
	if (record._tag !== "Entry" || record.kind !== Review.VerdictEntry.kind) return Option.none();
	return Option.map(decode(record.data), ({ call, time }) => {
		const { usage } = call;
		return {
			_tag: "ModelCall",
			id: Records.Id.make(`${record.conversation}:${record.entry}:0:model`),
			conversation: record.conversation,
			entry: record.entry,
			time: call.timestamp ?? time,
			advisory: false,
			task: record.task,
			provider: call.provider,
			model: call.model,
			api: call.api ?? "",
			responseModel: call.responseModel ?? null,
			responseId: call.responseId ?? null,
			stopReason: call.stopReason,
			error: call.error ?? null,
			usage: {
				input: usage?.input ?? 0,
				output: usage?.output ?? 0,
				cacheRead: usage?.cacheRead ?? 0,
				cacheWrite: usage?.cacheWrite ?? 0,
				cacheWrite1h: usage?.cacheWrite1h ?? null,
				reasoning: usage?.reasoning ?? null,
				totalTokens: usage?.totalTokens ?? 0,
			},
			cost: {
				input: usage?.costs?.input ?? 0,
				output: usage?.costs?.output ?? 0,
				cacheRead: usage?.costs?.cacheRead ?? 0,
				cacheWrite: usage?.costs?.cacheWrite ?? 0,
				total: usage?.cost ?? 0,
				fromProvider: usage?.costs?.totalFromProvider === true,
			},
			durationMs: call.durationMs ?? null,
			derived: { from: record.id, unknown: unknownOf(call) },
		};
	});
}

/**
 * Per field of a model call record's cost, whether only the parts of pi-ai's cost give it (`usage.costs`), which a
 * call stored before the review kept them lacks; `total` is pi-ai's whole cost (`usage.cost`). Typed by the record:
 * a field the recorder adds fails to compile here until it is decided.
 */
const FROM_PARTS = {
	input: true,
	output: true,
	cacheRead: true,
	cacheWrite: true,
	fromProvider: true,
	total: false,
} as const satisfies { readonly [Field in keyof Records.ModelCall["cost"]]: boolean };

/** The cost fields only the parts give, as `derived.unknown` names them. */
const COST_PARTS = Arr.filterMap(Record.toEntries(FROM_PARTS), ([field, fromParts]) =>
	fromParts ? Result.succeed(`cost.${field}`) : Result.failVoid,
);

/**
 * The fields of the model call record `call` does not hold, by name: none for a call the review stored whole. A
 * call stored before the review kept its api and the parts of its cost lacks `api`, the four parts and
 * `cost.fromProvider`; a request that ended without a response lacks the tokens and the cost as a whole.
 */
function unknownOf(call: Review.Call): ReadonlyArray<string> {
	return [
		...(call.api === undefined ? ["api"] : []),
		...(call.usage?.costs === undefined ? COST_PARTS : []),
		...(call.usage === undefined ? ["usage", "cost.total"] : []),
	];
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
		Effect.succeed(
			RecordSink.of({
				deliver: (records: ReadonlyArray<Records.Record>) =>
					sink.deliver(Arr.flatMap(records, (record) => Arr.prepend(Option.toArray(modelCall(record)), record))),
			}),
		),
	),
);
