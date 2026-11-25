import { BACKGROUND_CONTEXT, createContextKey, withCancel, withContextValue } from "@earendil-works/chord/context";
import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { call, ParentContext } from "../src/call.ts";
import { invoker } from "../src/invocation.ts";

class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}

const invoke = invoker(Context.make(Greeting, { text: "hello" }));

describe("invoker", () => {
	it("resolves with what the Effect succeeds with, run with the context it was made on", async () => {
		const text = await invoke(
			Greeting.use((greeting) => Effect.succeed(greeting.text)),
			BACKGROUND_CONTEXT,
		);
		expect(text).toBe("hello");
	});

	it("rejects with the failure itself, and with a defect itself", async () => {
		const failure = { reason: "refused" };
		const defect = new Error("boom");
		expect(await invoke(Effect.fail(failure), BACKGROUND_CONTEXT).catch((error: unknown) => error)).toBe(failure);
		expect(await invoke(Effect.die(defect), BACKGROUND_CONTEXT).catch((error: unknown) => error)).toBe(defect);
	});

	it("interrupts the fiber when Pi aborts the invocation, and rejects", async () => {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		const started = Promise.withResolvers<void>();
		let interrupted = false;
		const settled = invoke(
			Effect.sync(() => started.resolve()).pipe(
				Effect.andThen(Effect.never),
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						interrupted = true;
					}),
				),
			),
			context,
		).then(
			() => "resolved",
			() => "rejected",
		);
		await started.promise;
		cancel(new Error("stop"));
		expect(await settled).toBe("rejected");
		expect(interrupted).toBe(true);
	});

	it("makes the invocation's context the parent of the Pi calls the Effect makes", async () => {
		const key = createContextKey<string>("test.span");
		const invocation = withContextValue(key, "span-of-the-hook", BACKGROUND_CONTEXT);
		const seen = await invoke(
			Effect.all({
				parent: Effect.service(ParentContext),
				inCall: call(async (context) => context.value(key)),
			}),
			invocation,
		);
		expect(seen).toEqual({ parent: invocation, inCall: "span-of-the-hook" });
	});
});
