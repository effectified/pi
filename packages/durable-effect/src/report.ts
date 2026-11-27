// Pi Durable's reports for the Effect logger: one log line per report, at a level by its kind, without content.

import type { Report } from "@earendil-works/pi-durable";
import { Effect, Match, Predicate } from "effect";

/** What a log line says about a report: its kind, the ids and names Pi gives, and the class of the error. */
type Annotations = { readonly [annotation: string]: string | number };

/** The log level of a report: `Error` when work was lost or stopped for good, `Warn` when the run went on. */
export const level: (report: Report) => "Error" | "Warn" = Match.type<Report>().pipe(
	Match.discriminatorsExhaustive("kind")({
		storage_failed: () => "Error" as const,
		task_faulted: () => "Error" as const,
		migration_failed: () => "Error" as const,
		task_interrupted: () => "Warn" as const,
		task_outdated: () => "Warn" as const,
		task_error: () => "Warn" as const,
		extension_error: () => "Warn" as const,
		host_error: () => "Warn" as const,
		listener_error: () => "Warn" as const,
	}),
);

/**
 * What a log line says about a report: its kind and the ids and names Pi gives, and the class of the error. Never the
 * error's message or stack, which may quote a prompt, tool arguments or a tool's output; `Harness.reports` has the
 * whole report.
 */
export function annotations(report: Report): Annotations {
	const error = { error: Predicate.isError(report.error) ? report.error.name : typeof report.error };
	return Match.value(report).pipe(
		Match.discriminatorsExhaustive("kind")({
			storage_failed: (failed): Annotations => ({ report: failed.kind, ...error }),
			listener_error: (failed): Annotations => ({ report: failed.kind, ...error }),
			task_faulted: (failed): Annotations => ({
				report: failed.kind,
				...task(failed),
				reason: failed.reason,
				...error,
			}),
			task_outdated: (failed): Annotations => ({
				report: failed.kind,
				...task(failed),
				reason: failed.reason,
				...error,
			}),
			task_interrupted: (failed): Annotations => ({
				report: failed.kind,
				...task(failed),
				reason: failed.reason,
				restarts: failed.restarts,
				...error,
			}),
			migration_failed: (failed): Annotations => ({ report: failed.kind, ...task(failed), ...error }),
			task_error: (failed): Annotations => ({ report: failed.kind, ...task(failed), ...error }),
			extension_error: (failed): Annotations => ({
				report: failed.kind,
				...(failed.task === undefined ? {} : task({ task: failed.task })),
				...(failed.extension === undefined ? {} : { extension: failed.extension }),
				...(failed.conversationId === undefined ? {} : { conversationId: failed.conversationId }),
				...error,
			}),
			host_error: (failed): Annotations => ({
				report: failed.kind,
				callback: failed.callback,
				...(failed.task === undefined ? {} : task({ task: failed.task })),
				...error,
			}),
		}),
	);
}

/** Logs `report` to the Effect logger of the context: the message names the kind, the annotations say the rest. */
export function log(report: Report): Effect.Effect<void> {
	return Effect.annotateLogs(
		Effect.logWithLevel(level(report))(`Pi Durable reported ${report.kind}`),
		annotations(report),
	);
}

/** The task a report is about, and the extension whose code failed when Pi knows it. */
function task(report: {
	readonly task: Extract<Report, { readonly kind: "task_error" }>["task"];
	readonly extension?: string;
}): Annotations {
	return {
		taskId: report.task.id,
		taskKind: report.task.kind,
		conversationId: report.task.conversationId,
		...(report.extension === undefined ? {} : { extension: report.extension }),
	};
}
