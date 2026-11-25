// The run under review, as Pi stores it in its built-in live document: what a review reads of it.

import type { EntryId, LiveState, SubmissionId } from "@earendil-works/pi-durable";
import { Option } from "effect";

/** What Pi's live document says of a conversation's run, as far as a review needs it. */
export interface View {
	/**
	 * Whether the conversation works on an answer now: a run is live and has not answered for good. A run that only
	 * waits for its `afterRun` tasks has.
	 */
	readonly working: boolean;
	/**
	 * The entry of the answer the run's `onYield` tasks decide about (`run.yield.answer`): Pi appended it in the commit
	 * that created them. None when no run waits for such tasks.
	 */
	readonly yielded: Option.Option<EntryId>;
	/** The run's first entry (`run.first`), kept across corrective runs; none for a run Pi recorded none for. */
	readonly first: Option.Option<EntryId>;
	/**
	 * The submissions the run answers (`run.inputs`): the user inputs it placed, and a continuation's own. Empty when no
	 * run is live, and once the run answered for good.
	 */
	readonly inputs: ReadonlyArray<SubmissionId>;
}

/** The view of a conversation's run in `live`, a snapshot of `BuiltinDoc.live`; none is a conversation that never ran. */
export function view(live: Option.Option<LiveState>): View {
	const run = Option.getOrUndefined(live)?.run;
	return {
		working: run !== undefined && run.afterRun === undefined,
		yielded: Option.fromUndefinedOr(run?.yield?.answer),
		first: Option.fromUndefinedOr(run?.first),
		inputs: run?.inputs ?? [],
	};
}
