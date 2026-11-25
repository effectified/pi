import type { ConversationId, Report, TaskId } from "@earendil-works/pi-durable";
import { Effect, Logger, References } from "effect";
import { describe, expect, it } from "vitest";
import * as Reports from "../src/report.ts";

const task = { id: 14 as TaskId, kind: "pi.generation", conversationId: 1 as ConversationId };
const secret = new RangeError("The prompt said: launch codes 0000");

const reports: ReadonlyArray<Report> = [
	{ kind: "storage_failed", error: secret },
	{ kind: "task_faulted", task, extension: "app", reason: "threw", error: secret },
	{ kind: "task_interrupted", task, reason: "restart_limit", restarts: 5, error: secret },
	{ kind: "migration_failed", task, error: secret },
	{ kind: "task_outdated", task, reason: "missing_task", error: secret },
	{ kind: "task_error", task, error: secret },
	{ kind: "extension_error", extension: "guard", task, error: secret },
	{ kind: "extension_error", conversationId: 3 as ConversationId, error: "not an error" },
	{ kind: "host_error", callback: "env", task, error: secret },
	{ kind: "host_error", callback: "onWake", error: secret },
	{ kind: "listener_error", error: secret },
];

describe("level", () => {
	it("is Error when work was lost or stopped for good, and Warn when the run went on", () => {
		expect(reports.map((report) => [report.kind, Reports.level(report)])).toEqual([
			["storage_failed", "Error"],
			["task_faulted", "Error"],
			["task_interrupted", "Warn"],
			["migration_failed", "Error"],
			["task_outdated", "Warn"],
			["task_error", "Warn"],
			["extension_error", "Warn"],
			["extension_error", "Warn"],
			["host_error", "Warn"],
			["host_error", "Warn"],
			["listener_error", "Warn"],
		]);
	});
});

describe("annotations", () => {
	const located = { taskId: 14, taskKind: "pi.generation", conversationId: 1 };

	it("name the kind, Pi's ids and names, and the class of the error", () => {
		expect(reports.map(Reports.annotations)).toEqual([
			{ report: "storage_failed", error: "RangeError" },
			{ report: "task_faulted", ...located, extension: "app", reason: "threw", error: "RangeError" },
			{ report: "task_interrupted", ...located, reason: "restart_limit", restarts: 5, error: "RangeError" },
			{ report: "migration_failed", ...located, error: "RangeError" },
			{ report: "task_outdated", ...located, reason: "missing_task", error: "RangeError" },
			{ report: "task_error", ...located, error: "RangeError" },
			{ report: "extension_error", ...located, extension: "guard", error: "RangeError" },
			{ report: "extension_error", conversationId: 3, error: "string" },
			{ report: "host_error", callback: "env", ...located, error: "RangeError" },
			{ report: "host_error", callback: "onWake", error: "RangeError" },
			{ report: "listener_error", error: "RangeError" },
		]);
	});

	it("never carry the error's message", () => {
		expect(JSON.stringify(reports.map(Reports.annotations))).not.toContain("launch codes");
	});
});

describe("log", () => {
	it("writes one line per report to the logger of the context, at its level, with its annotations", async () => {
		const lines: unknown[] = [];
		const capture = Logger.make((options) => {
			lines.push({
				level: options.logLevel,
				message: options.message,
				annotations: options.fiber.getRef(References.CurrentLogAnnotations),
			});
		});
		await Effect.runPromise(
			Effect.forEach([reports[0] as Report, reports[6] as Report], Reports.log).pipe(
				Effect.provide(Logger.layer([capture])),
			),
		);
		expect(lines).toEqual([
			{
				level: "Error",
				message: ["Pi Durable reported storage_failed"],
				annotations: { report: "storage_failed", error: "RangeError" },
			},
			{
				level: "Warn",
				message: ["Pi Durable reported extension_error"],
				annotations: {
					report: "extension_error",
					taskId: 14,
					taskKind: "pi.generation",
					conversationId: 1,
					extension: "guard",
					error: "RangeError",
				},
			},
		]);
	});
});
