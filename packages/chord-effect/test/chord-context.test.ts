import { sleep as chordSleep } from "@earendil-works/chord";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	traceIn,
	withCancel,
	withContextValue,
	withTelemetry,
} from "@earendil-works/chord/context";
import { InMemoryTelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import { PiTelemetry } from "@effectified/pi-telemetry";
import { Deferred, Effect, Exit, Fiber, Option, Scope, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { ChordContext } from "../src/context.ts";
import { run } from "./run.ts";

const Tenant = createContextKey<string>("test.tenant");

describe("ChordContext.scoped", () => {
	it("is open while its scope is, and aborted when the scope closes", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const context = yield* Scope.provide(ChordContext.scoped(), scope);
				const before = context.abortSignal?.aborted;
				yield* Scope.close(scope, Exit.void);
				return { before, after: context.abortSignal?.aborted, reason: context.abortSignal?.reason };
			}),
		);
		expect(seen.before).toBe(false);
		expect(seen.after).toBe(true);
		expect(seen.reason).toMatchObject({ name: "AbortError" });
	});

	it("cancels the Chord call of a fiber that is interrupted", async () => {
		const outcome = await run(
			Effect.gen(function* () {
				// The call's promise, handed over in a record: the Deferred holds it, it does not await it.
				const started = yield* Deferred.make<{ readonly call: Promise<void> }>();
				const fiber = yield* Effect.forkChild(
					Effect.scoped(
						Effect.gen(function* () {
							const context = yield* ChordContext.scoped();
							// Chord's own wait: a real timer of a minute, which only the context can end early.
							const call = chordSleep(60_000, context);
							yield* Deferred.succeed(started, { call });
							yield* Effect.promise(() => call);
						}),
					),
					{ startImmediately: true },
				);
				const { call } = yield* Deferred.await(started);
				yield* Fiber.interrupt(fiber);
				return yield* Effect.promise(() =>
					call.then(
						() => "resolved",
						(reason: unknown) => reason,
					),
				);
			}),
		);
		expect(outcome).toMatchObject({ name: "AbortError" });
	});

	it("keeps the values, the telemetry span and the cancellation of its parent", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "host" }, (span) =>
			run(
				Effect.gen(function* () {
					const parent = withContextValue(Tenant, "acme", withTelemetry(span, BACKGROUND_CONTEXT));
					const context = yield* ChordContext.scoped(parent);
					expect(context.value(Tenant)).toBe("acme");
					expect(context.telemetry).toBe(span);
					yield* Effect.promise(() => traceIn({ name: "chord.call" }, async () => {}, context));
				}),
			),
		);
		const { traces } = await telemetry.findTraces();
		const spans = traces.flatMap((trace) => trace.spans);
		const host = spans.find((recorded) => recorded.name === "host");
		expect(spans.find((recorded) => recorded.name === "chord.call")?.parentId).toBe(host?.id);

		const { context: cancellable, cancel } = withCancel(BACKGROUND_CONTEXT);
		const reason = await run(
			Effect.gen(function* () {
				const context = yield* ChordContext.scoped(cancellable);
				cancel("outside");
				return context.abortSignal?.reason;
			}),
		);
		expect(reason).toBe("outside");
	});
});

/** Effect's own in-memory spans, kept in start order: where the pi-telemetry adapter puts the spans Pi starts. */
function recording(): { readonly tracer: Tracer.Tracer; readonly span: (name: string) => Tracer.NativeSpan } {
	const spans: Tracer.NativeSpan[] = [];
	return {
		tracer: Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		}),
		span: (name) => {
			const span = spans.find((candidate) => candidate.name === name);
			if (span === undefined) throw new Error(`No recorded span ${name}`);
			return span;
		},
	};
}

/** `effect` in a program that has the pi-telemetry adapter on `tracer`. */
function withPiTelemetry<A, E, R>(
	tracer: Tracer.Tracer,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, PiTelemetry>> {
	return effect.pipe(Effect.provide(PiTelemetry.layer), Effect.provideService(Tracer.Tracer, tracer));
}

/** Pi code under test: a call that starts its span under the context it is given, as Pi's calls do. */
function piCall(context: Context): Promise<void> {
	return traceIn({ name: "pi.call" }, async () => {}, context);
}

describe("the fiber's current span", () => {
	it("makes the span of a Pi call through ChordContext.scoped a child of the Effect span", async () => {
		const { tracer, span } = recording();
		const tenant = await run(
			withPiTelemetry(
				tracer,
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* ChordContext.scoped(withContextValue(Tenant, "acme", BACKGROUND_CONTEXT));
						yield* Effect.promise(() => piCall(context));
						return context.value(Tenant);
					}),
				).pipe(Effect.withSpan("app.turn")),
			),
		);
		expect(Option.getOrUndefined(span("pi.call").parent)).toBe(span("app.turn"));
		expect(span("pi.call").traceId).toBe(span("app.turn").traceId);
		expect(tenant).toBe("acme");
	});

	it("does the same through ChordContext.timeout", async () => {
		const { tracer, span } = recording();
		await run(
			withPiTelemetry(
				tracer,
				Effect.scoped(
					Effect.flatMap(ChordContext.timeout("30 seconds"), (context) => Effect.promise(() => piCall(context))),
				).pipe(Effect.withSpan("app.turn")),
			),
		);
		expect(Option.getOrUndefined(span("pi.call").parent)).toBe(span("app.turn"));
	});

	it("takes the fiber's span over the parent's", async () => {
		const { tracer, span } = recording();
		const host = new InMemoryTelemetryContext();
		await host.startSpan({ name: "host" }, (parent) =>
			run(
				withPiTelemetry(
					tracer,
					Effect.flatMap(ChordContext.scoped(withTelemetry(parent, BACKGROUND_CONTEXT)), (context) =>
						Effect.promise(() => piCall(context)),
					).pipe(Effect.withSpan("app.turn")),
				),
			),
		);
		expect(Option.getOrUndefined(span("pi.call").parent)).toBe(span("app.turn"));
		const { traces } = await host.findTraces();
		expect(traces.flatMap((trace) => trace.spans).map((recorded) => recorded.name)).toEqual(["host"]);
	});

	it("keeps the parent's telemetry in a fiber with no span, and in a program without PiTelemetry", async () => {
		const { tracer } = recording();
		const host = new InMemoryTelemetryContext();
		const seen = await host.startSpan({ name: "host" }, async (parent: TelemetrySpan) => {
			const under = withTelemetry(parent, BACKGROUND_CONTEXT);
			const noSpan = await run(withPiTelemetry(tracer, ChordContext.scoped(under)));
			const noTelemetry = await run(ChordContext.scoped(under).pipe(Effect.withSpan("app.turn")));
			return { parent, noSpan: noSpan.telemetry, noTelemetry: noTelemetry.telemetry };
		});
		expect(seen.noSpan).toBe(seen.parent);
		expect(seen.noTelemetry).toBe(seen.parent);
	});
});

describe("ChordContext.timeout", () => {
	it("cancels with TimeoutError when the Clock passes the deadline", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const context = yield* ChordContext.timeout("30 seconds");
				const call = awaitWithContext(new Promise<never>(() => {}), context).catch((reason: unknown) => reason);
				yield* TestClock.adjust("29 seconds");
				const early = context.abortSignal?.aborted;
				yield* TestClock.adjust("1 second");
				return { early, reason: yield* Effect.promise(() => call) };
			}),
		);
		expect(seen.early).toBe(false);
		expect(seen.reason).toMatchObject({ name: "TimeoutError" });
	});

	it("is cancelled when its scope closes before the deadline", async () => {
		const reason = await run(
			Effect.gen(function* () {
				const context = yield* Effect.scoped(ChordContext.timeout("1 hour"));
				return context.abortSignal?.reason;
			}),
		);
		expect(reason).toMatchObject({ name: "AbortError" });
	});
});

describe("ChordContext.aborted", () => {
	it("completes with the reason once the context is cancelled, at once when it already is", async () => {
		const { context: parent, cancel } = withCancel(BACKGROUND_CONTEXT);
		const reasons = await run(
			Effect.gen(function* () {
				const context = yield* ChordContext.scoped(parent);
				const waiting = yield* Effect.forkChild(ChordContext.aborted(context), { startImmediately: true });
				cancel("first");
				return { waited: yield* Fiber.join(waiting), already: yield* ChordContext.aborted(context) };
			}),
		);
		expect(reasons).toEqual({ waited: "first", already: "first" });
	});

	it("never completes for a context that cannot be cancelled", async () => {
		const result = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Effect.timeoutOption(ChordContext.aborted(BACKGROUND_CONTEXT), "1 day"),
					{ startImmediately: true },
				);
				yield* TestClock.adjust("1 day");
				return yield* Fiber.join(fiber);
			}),
		);
		expect(Option.isNone(result)).toBe(true);
	});
});
