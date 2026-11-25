// Test helper: the thread actor of the host processes: the composition of world.ts, with the lease, the sinks, the
// models and the tools of the outside, over HTTP. The test makes one too, for its handles; only a host runs it.

import { type FauxResponseFactory, fauxProvider } from "@earendil-works/pi-ai";
import * as Approvals from "@gunta/pi-approvals-effect";
import { Lease } from "@gunta/pi-budget-effect";
import { Extension, Tool } from "@gunta/pi-durable-effect";
import { answer, toolCall } from "@gunta/pi-durable-effect/testing";
import { ActorInfo } from "@gunta/pi-durable-rivet-effect";
import { RecordSink } from "@gunta/pi-recorder-effect";
import { Effect, Layer, Schema } from "effect";
import { OutcomeSink } from "../src/index.ts";
import { ThreadActor } from "../src/rivet.ts";
import { type Ask, ask, type Turn } from "./hosts-wire.ts";
import { BACKUP, config, JUDGE, outside, type Providers, ports, WRITER } from "./world.ts";

/** The pool the host processes serve: not the one of the registry that comes with the test's own engine. */
export const HOST_POOL = "hosts";

/** The thread actor as the host process `host` hosts it, on the outside at `url`. */
export function threadOn(url: string, host: string) {
	/** One ask of the outside. An outside that is gone is a defect: the test has ended. */
	const say = (body: Ask) => Effect.promise((signal) => ask(url, body, signal));

	/** A lab whose every answer is the outside's, made from what the request shows. */
	function lab(model: { readonly provider: string; readonly modelId: string }) {
		const handle = fauxProvider({
			provider: model.provider,
			api: `scripted-${model.provider}`,
			models: [{ id: model.modelId }],
		});
		const respond: FauxResponseFactory = async (context, options) => {
			const text = (content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
				typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
			const turn = (await ask(
				url,
				{
					host,
					kind: "model",
					lab: model.provider,
					session: options?.sessionId ?? null,
					prompt: text(context.messages.findLast((message) => message.role === "user")?.content ?? ""),
					toolResults: context.messages.flatMap((message) =>
						message.role === "toolResult" ? [text(message.content)] : [],
					),
				},
				options?.signal,
			)) as Turn; // The outside of this test answers a `model` ask with a turn.
			return turn.kind === "answer"
				? answer(turn.text)
				: toolCall(turn.tool, { note: turn.note }, { id: `call-${turn.tool}` });
		};
		handle.setResponses(Array.from({ length: 1_000 }, () => respond));
		return handle;
	}

	/** A tool whose whole effect is in the outside, and which returns only when the outside replied. */
	const effectTool = <const Name extends string>(name: Name, replay: "safe" | "unsafe") =>
		Tool.make(name, {
			description: "Changes the outside.",
			parameters: Schema.Struct({ note: Schema.String }),
			success: Schema.String,
			replay,
			handler: ({ note }) => Effect.as(say({ host, kind: "tool", actor: "", tool: name, note }), `Did ${note}.`),
		});

	const labs: Providers = { author: lab(WRITER), backup: lab(BACKUP), reviewer: lab(JUDGE) };

	const world = config(outside(), labs);

	/** The product's ports in one actor at one wake: the in-memory ones of world.ts under those of the outside. */
	const productPorts = Layer.unwrap(
		ActorInfo.use(({ actorId: actor }) =>
			Effect.sync(() => {
				const wake = crypto.randomUUID();
				return Layer.mergeAll(
					ports(outside(), { actor }),
					Layer.succeed(Lease, {
						reserve: (_estimate, request) =>
							Effect.map(
								say({
									host,
									kind: "reserve",
									actor,
									model: request.model,
									session: request.session ?? null,
									conversation: request.conversation ?? null,
								}),
								String,
							),
						settle: (token, settlement) => say({ host, kind: "settle", actor, token, settlement }),
					}),
					Layer.succeed(RecordSink, { deliver: (batch) => say({ host, kind: "records", actor, batch }) }),
					Layer.succeed(OutcomeSink, {
						deliver: (event) =>
							say({
								host,
								kind: "outcome",
								actor,
								id: event.id,
								thread: event.thread,
								says: event._tag === "Started" ? "Started" : event.outcome._tag,
								settledMicros: event._tag === "Started" ? null : event.outcome.counts.settledMicros,
							}),
					}),
					Layer.succeed(Approvals.Inbox, { publish: () => Effect.void }),
					// Says which process runs the actor, for as long as its wake lasts.
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* say({ host, kind: "woke", actor, wake });
							yield* Effect.addFinalizer(() => say({ host, kind: "closed", actor, wake }));
							yield* Effect.forkScoped(
								Effect.forever(
									Effect.andThen(Effect.sleep("50 millis"), say({ host, kind: "beat", actor, wake })),
								),
							);
						}),
					),
				);
			}),
		),
	);

	return ThreadActor.make("thread", {
		composition: {
			...world,
			extensions: [
				Extension.make({
					name: "app",
					tools: [effectTool("note_once", "unsafe"), effectTool("note_again", "safe")],
				}),
			],
		},
		ports: productPorts,
		swarm: { pollMillis: 100 },
		rivet: { sleepTimeout: 60_000, actionTimeout: 60_000 },
	});
}
