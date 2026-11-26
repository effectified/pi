// The child setup of the composition: a subagent is granted at most its declared tools through the guard, capped on
// the budget's lease, routed as its parent is, and left out of the review, all in the commit that creates it.

import { Shares } from "@effectified/pi-budget";
import { Conversations, Grant, Guard } from "@effectified/pi-guard";
import * as Review from "@effectified/pi-review";
import { ChildSetup, ChildSetupFailed, type Subagent } from "@effectified/pi-subagent";
import { Effect, Layer } from "effect";
import * as Routing from "./routing.ts";

/** What a product decides about its declared subagents beside their declarations. */
export interface Options {
	/** The declarations the registry installs: a child is granted the tools of its own. */
	readonly subagents: ReadonlyArray<Subagent.Subagent>;
	/**
	 * Per declared name, the micro units a child may settle of the harness's lease. A declaration without one starts no
	 * child: a child nobody capped would spend without a bound.
	 */
	readonly caps: Readonly<Record<string, bigint>>;
}

/**
 * The `ChildSetup` of the composition. Everything is in `created`, the commit that creates the child, so no child
 * ever exists without any of it:
 *
 * - the grant of its declared tools, narrowed (`mode: "narrow"`), so it can never offer the child more than its
 *   declaration, with the classification its parent holds, which its declared model must be cleared for;
 * - its cap on the lease, so its first request counts against it;
 * - its parent's routing limits, so the router constrains its requests as its parent's;
 * - for a declaration that selects no extensions itself, the host's selection without the review. A child is not a
 *   thread: its answer goes to its parent's model, and a held child would hold its parent's tool call.
 *
 * It fails closed with `ChildSetupFailed`: no child exists. `beforeStart` has nothing left to do.
 */
export function layer(options: Options): Layer.Layer<ChildSetup.ChildSetup, never, Guard.Guard | Shares> {
	return Layer.effect(
		ChildSetup.ChildSetup,
		Effect.gen(function* () {
			const guard = yield* Guard.Guard;
			const shares = yield* Shares;
			const declared = new Map(options.subagents.map((subagent) => [subagent.name, subagent]));
			const refused = (child: ChildSetup.Child, why: string) => (cause: unknown) =>
				new ChildSetupFailed({ reason: `The subagent ${child.subagent} ${why}.`, cause });
			return {
				created: (tx, child) =>
					Effect.gen(function* () {
						const cap = yield* Effect.mapError(
							Effect.fromNullishOr(
								Object.hasOwn(options.caps, child.subagent) ? options.caps[child.subagent] : undefined,
							),
							refused(child, "has no budget share"),
						);
						const subagent = yield* Effect.mapError(
							Effect.fromNullishOr(declared.get(child.subagent)),
							refused(child, "is not declared"),
						);
						const parent = yield* (yield* tx.doc(Grant.Document, child.parentId)).get;
						const classification = parent.grant?.classification;
						const grant = {
							tools: subagent.agent.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)),
							...(classification === undefined ? {} : { classification }),
						};
						// With the model, so the guard checks that the declared model may serve that classification.
						yield* Conversations.grantIn(tx, child.conversationId, grant, {
							model: subagent.agent.model,
							mode: "narrow",
						}).pipe(Effect.provideService(Guard.Guard, guard));
						yield* shares.setCapIn(tx, child.conversationId, cap);
						yield* Routing.inheritIn(tx, child.conversationId, child.parentId);
						if (subagent.agent.extensions === undefined) {
							yield* tx.configure(child.conversationId, { extensions: { remove: [Review.NAME] } });
						}
					}).pipe(
						Effect.mapError((error) =>
							error._tag === "ChildSetupFailed" ? error : refused(child, "could not be set up")(error),
						),
					),
				beforeStart: () => Effect.void,
			};
		}),
	);
}
