// Pi Durable's reports for the Effect logger: one log line per report, at a level by its kind, without content.

import type { Report } from "@earendil-works/pi-durable";
import { Effect, Predicate } from "effect";

/** The log level of a report: `Error` when work was lost or stopped for good, `Warn` when the run went on. */
export function level(report: Report): "Error" | "Warn" {
	switch (report.kind) {
		case "storage_failed":
		case "task_faulted":
		case "migration_failed":
			return "Error";
		case "task_interrupted":
		case "task_outdated":
		case "task_error":
		case "extension_error":
		case "host_error":
		case "listener_error":
			return "Warn";
	}
}

/**
 * What a log line says about a report: its kind and the ids and names Pi gives, and the class of the error. Never the
 * error's message or stack, which may quote a prompt, tool arguments or a tool's output; `Harness.reports` has the
 * whole report.
 */
export function annotations(report: Report): Record<string, string | number> {
	const error = { error: Predicate.isError(report.error) ? report.error.name : typeof report.error };
	switch (report.kind) {
		case "storage_failed":
		case "listener_error":
			return { report: report.kind, ...error };
		case "task_faulted":
		case "task_outdated":
			return { report: report.kind, ...task(report), reason: report.reason, ...error };
		case "task_interrupted":
			return { report: report.kind, ...task(report), reason: report.reason, restarts: report.restarts, ...error };
		case "migration_failed":
		case "task_error":
			return { report: report.kind, ...task(report), ...error };
		case "extension_error":
			return {
				report: report.kind,
				...(report.task === undefined ? {} : task({ task: report.task })),
				...(report.extension === undefined ? {} : { extension: report.extension }),
				...(report.conversationId === undefined ? {} : { conversationId: report.conversationId }),
				...error,
			};
		case "host_error":
			return {
				report: report.kind,
				callback: report.callback,
				...(report.task === undefined ? {} : task({ task: report.task })),
				...error,
			};
	}
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
}): Record<string, string | number> {
	return {
		taskId: report.task.id,
		taskKind: report.task.kind,
		conversationId: report.task.conversationId,
		...(report.extension === undefined ? {} : { extension: report.extension }),
	};
}
