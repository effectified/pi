// The tools the tests give their sandboxes: tools of `@effectified/pi-agent`, one per shape of result a script sees.

import { Tool } from "@effectified/pi-agent";
import { Context, Effect, type Latch, Layer, Schema } from "effect";

/** A service of the program, which a tool's handler reaches through the context its sandbox was made in. */
export class Records extends Context.Service<Records, { readonly title: (id: string) => Effect.Effect<string> }>()(
	"test/Records",
) {}

/** `Records` with a title for every id. */
export const records = Layer.succeed(Records, { title: (id) => Effect.succeed(`Record ${id}`) });

/** A structured tool: the script gets its success value as JSON. */
export const lookup = Tool.make("lookup", {
	label: "Lookup",
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	structured: true,
	handler: ({ id }) =>
		Effect.map(
			Records.use((service) => service.title(id)),
			(title) => ({ title }),
		),
});

/** A tool without `structured`: the script gets the text the model would read. */
export const greet = Tool.make("greet", {
	label: "Greet",
	description: "Greet someone.",
	parameters: Schema.Struct({ name: Schema.String }),
	success: Schema.String,
	handler: ({ name }) => Effect.succeed(`Hello, ${name}`),
});

/** A tool that answers with an error result of its own. */
export const refuse = Tool.make("refuse", {
	label: "Refuse",
	description: "Always refuses.",
	parameters: Schema.Struct({}),
	success: Schema.String,
	handler: () => Effect.succeed(Tool.error("not allowed")),
});

/** A tool whose handler fails. */
export const broken = Tool.make("broken", {
	label: "Broken",
	description: "Always fails.",
	parameters: Schema.Struct({}),
	success: Schema.String,
	handler: () => Effect.fail(new Error("the disk is gone")),
});

/** A tool that opens `started` and then never answers; `interrupted` opens when Pi aborts its call. */
export function held(started: Latch.Latch, interrupted: Latch.Latch) {
	return Tool.make("wait", {
		label: "Wait",
		description: "Never answers.",
		parameters: Schema.Struct({}),
		success: Schema.String,
		handler: () =>
			started.open.pipe(
				Effect.andThen(Effect.never),
				Effect.onInterrupt(() => interrupted.open),
			),
	});
}
