import type { AssistantMessage, Context as PiContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { complete, completeSimple, finalMessage, type ResponseEvent, stream, streamSimple } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, ScriptedModels } from "../src/testing/index.ts";

// Equal bounds make every delta four characters, so the events are exact.
const scripted = () => ScriptedModels.layer({ tokenSize: { min: 1, max: 1 } });

const context: PiContext = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function label(event: ResponseEvent): string {
	switch (event.type) {
		case "start":
			return "start";
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return `${event.type} ${event.contentIndex} ${event.delta}`;
		case "done":
			return `done ${event.reason}`;
		default:
			return `${event.type} ${event.contentIndex}`;
	}
}

/** A scripted response that never arrives, and the abort signal its request carried. */
function hangingResponse() {
	let report: (signal: AbortSignal | undefined) => void = () => {};
	const signal = new Promise<AbortSignal | undefined>((resolve) => {
		report = resolve;
	});
	const response = (_context: unknown, options: SimpleStreamOptions | undefined) => {
		report(options?.signal);
		return new Promise<AssistantMessage>(() => {});
	};
	return { response, signal };
}

describe("stream", () => {
	it("emits pi-ai's events in order and ends with done", async () => {
		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([
					fauxAssistantMessage(
						[
							fauxThinking("hmm"),
							fauxText("Hello world"),
							fauxToolCall("lookup", { id: "42" }, { id: "call-1" }),
						],
						{ stopReason: "toolUse" },
					),
				]);
				return yield* Stream.runCollect(stream(models.model, context));
			}).pipe(Effect.provide(scripted())),
		);
		expect(events.map(label)).toEqual([
			"start",
			"thinking_start 0",
			"thinking_delta 0 hmm",
			"thinking_end 0",
			"text_start 1",
			"text_delta 1 Hell",
			"text_delta 1 o wo",
			"text_delta 1 rld",
			"text_end 1",
			"toolcall_start 2",
			'toolcall_delta 2 {"id',
			'toolcall_delta 2 ":"4',
			'toolcall_delta 2 2"}',
			"toolcall_end 2",
			"done toolUse",
		]);
		const last = events[events.length - 1];
		expect(last.type === "done" && last.message.content).toEqual([
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "Hello world" },
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { id: "42" } },
		]);
	});

	it("fails with the typed error that keeps pi-ai's error message", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([
					fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "boom" }),
				]);
				const seen: string[] = [];
				const error = yield* Effect.flip(
					Stream.runForEach(stream(models.model, context), (event) => Effect.sync(() => seen.push(label(event)))),
				);
				return { error, seen };
			}).pipe(Effect.provide(scripted())),
		);
		// The events before the failure still arrive; the error event is the failure, not an element.
		expect(result.seen).toEqual(["start", "text_start 0", "text_delta 0 part", "text_delta 0 ial", "text_end 0"]);
		expect(result.error._tag).toBe("ModelRequestError");
		expect(result.error.reason).toBe("error");
		expect(result.error.message).toBe("boom");
		expect(result.error.response.stopReason).toBe("error");
		expect(result.error.response.content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("aborts the provider request when the consumer stops early", async () => {
		const signal = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				let seen: AbortSignal | undefined;
				yield* models.setResponses([
					(_context, options) => {
						seen = options?.signal;
						return fauxAssistantMessage("Hello world");
					},
				]);
				const events = yield* Stream.runCollect(stream(models.model, context).pipe(Stream.take(2)));
				expect(events.map(label)).toEqual(["start", "text_start 0"]);
				return seen;
			}).pipe(Effect.provide(scripted())),
		);
		expect(signal?.aborted).toBe(true);
	});

	it("aborts the provider request when its fiber is interrupted, and is interrupted itself", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const hanging = hangingResponse();
				yield* models.setResponses([hanging.response]);
				const fiber = yield* Effect.forkChild(Stream.runDrain(stream(models.model, context)));
				const signal = yield* Effect.promise(() => hanging.signal);
				const abortedBefore = signal?.aborted;
				yield* Fiber.interrupt(fiber);
				return { signal, abortedBefore, exit: yield* Effect.exit(Fiber.join(fiber)) };
			}).pipe(Effect.provide(scripted())),
		);
		expect(result.abortedBefore).toBe(false);
		expect(result.signal?.aborted).toBe(true);
		expect(Exit.hasInterrupts(result.exit)).toBe(true);
		expect(Exit.hasFails(result.exit)).toBe(false);
	});
});

describe("complete", () => {
	it("returns the final message with its usage", async () => {
		const message = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([fauxAssistantMessage("Hello world")]);
				return yield* complete(models.model, context);
			}).pipe(Effect.provide(scripted())),
		);
		expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(message.stopReason).toBe("stop");
		expect(message.provider).toBe("faux");
		expect(message.model).toBe("faux-1");
		// The faux provider counts a token per four characters: "user:hi" is 2, "Hello world" is 3.
		expect(message.usage).toEqual({
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("fails with the typed error for an error response and for a provider with nothing to say", async () => {
		const errors = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" })]);
				const scriptedError = yield* Effect.flip(complete(models.model, context));
				const emptyQueue = yield* Effect.flip(complete(models.model, context));
				return { scriptedError, emptyQueue };
			}).pipe(Effect.provide(scripted())),
		);
		expect(errors.scriptedError._tag).toBe("ModelRequestError");
		expect(errors.scriptedError.response.errorMessage).toBe("overloaded");
		expect(errors.emptyQueue.message).toBe("No more faux responses queued");
		expect(errors.emptyQueue.reason).toBe("error");
	});

	it("aborts the provider request when its fiber is interrupted, and is interrupted itself", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const hanging = hangingResponse();
				yield* models.setResponses([hanging.response]);
				const fiber = yield* Effect.forkChild(complete(models.model, context));
				const signal = yield* Effect.promise(() => hanging.signal);
				yield* Fiber.interrupt(fiber);
				return { signal, exit: yield* Effect.exit(Fiber.join(fiber)) };
			}).pipe(Effect.provide(scripted())),
		);
		expect(result.signal?.aborted).toBe(true);
		expect(Exit.hasInterrupts(result.exit)).toBe(true);
		expect(Exit.hasFails(result.exit)).toBe(false);
	});
});

describe("streamSimple and completeSimple", () => {
	it("send pi-ai's provider-neutral options to the provider", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const seen: (SimpleStreamOptions | undefined)[] = [];
				const record = (_context: unknown, options: SimpleStreamOptions | undefined) => {
					seen.push(options);
					return fauxAssistantMessage("ok");
				};
				yield* models.setResponses([record, record]);
				const events = yield* Stream.runCollect(
					streamSimple(models.model, context, { reasoning: "high", toolChoice: "none" }),
				);
				const message = yield* completeSimple(models.model, context, { reasoning: "low", maxTokens: 64 });
				return { seen, events, message };
			}).pipe(Effect.provide(scripted())),
		);
		expect(result.events.map(label)).toEqual(["start", "text_start 0", "text_delta 0 ok", "text_end 0", "done stop"]);
		expect(result.message.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.seen.map((options) => [options?.reasoning, options?.toolChoice, options?.maxTokens])).toEqual([
			["high", "none", undefined],
			["low", undefined, 64],
		]);
		expect(result.seen.every((options) => options?.signal instanceof AbortSignal)).toBe(true);
	});
});

describe("finalMessage", () => {
	it("gives the message of done to a consumer that also reads the events", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([fauxAssistantMessage("Hello world")]);
				const deltas: string[] = [];
				const message = yield* stream(models.model, context).pipe(
					Stream.tap((event) => Effect.sync(() => event.type === "text_delta" && deltas.push(event.delta))),
					Stream.run(finalMessage),
				);
				return { deltas, message };
			}).pipe(Effect.provide(scripted())),
		);
		expect(result.deltas.join("")).toBe("Hello world");
		expect(result.message.content).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("dies on events that do not end in done: a broken provider", async () => {
		const exit = await Effect.runPromiseExit(Stream.run(Stream.empty, finalMessage));
		expect(Exit.hasDies(exit)).toBe(true);
	});
});
