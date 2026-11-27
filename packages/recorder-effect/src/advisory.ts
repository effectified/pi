// The advisory record: a model request about to be sent, which no committed entry holds, told to the sink from a hook.

import { Entry, Extension, Hook } from "@effectified/pi-durable";
import { Effect, Option, Stream } from "effect";
import * as Records from "./record.ts";
import { RecordSink } from "./sink.ts";

/** The entry id a request names as the newest when its conversation has no entry yet: Pi's id of no record. */
const NO_ENTRY = Entry.Id.make(0);

/**
 * A `beforeRequest` hook that hands one `ModelCallRequested` record to the sink before every model request, and
 * changes nothing of the request. Advisory: a hook cannot commit, so the record is not stored with any step. When the
 * sink fails, Pi reports the hook and sends the request anyway, and the record is lost. When Pi asks again (after a
 * close, a crash or a wake), the record is sent again with the same id and, through a memo of the task, the same time.
 */
export const hook: Hook.Hook<RecordSink> = Hook.beforeRequest(
	Effect.fn("Advisory.hook")(function* (_request, api) {
		const newest = yield* Stream.runHead(api.entries({ pageSize: 1, order: "descending" }).pipe(Stream.take(1)));
		const after = Option.match(newest, { onNone: () => NO_ENTRY, onSome: (entry) => entry.id });
		const now = yield* api.now;
		// First writer wins: every later ask about the same request reads the time of the first one.
		const time = yield* api.memo(`recorder.requested.${after}`, now);
		const sink = yield* RecordSink;
		yield* sink.deliver([
			{
				_tag: "ModelCallRequested",
				id: Records.Id.make(`${api.conversationId}:${after}:requested`),
				conversation: api.conversationId,
				after,
				task: api.taskId,
				time,
				advisory: true,
			},
		]);
		return Option.none();
	}),
);

/**
 * The hook as an extension named `recorder`, for `Registry.layer`. Install it last: it observes, it decides nothing.
 * Its type is what `Extension.make` gives, so the registry requires exactly what the hook needs: `RecordSink`.
 */
export const extension = Extension.make({ name: "recorder", hooks: [hook] });
