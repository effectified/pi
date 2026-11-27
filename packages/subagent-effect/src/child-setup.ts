// The child setup port: what the product does to a child conversation as it is created, such as grants and budgets.

import { Conversation, type Tx } from "@effectified/pi-durable";
import { Context, Effect, Layer, Schema } from "effect";
import { Depth, Mode } from "./child.ts";
import type { ChildSetupFailed } from "./errors.ts";
import { Name } from "./subagent-name.ts";

/** The child a setup is asked about. */
export const Child = Schema.Struct({
	/** The child conversation, created in this commit. */
	conversationId: Conversation.Id,
	/** The conversation whose model asked for the child. */
	parentId: Conversation.Id,
	/** The name of the declaration the child runs as. */
	subagent: Name,
	/** Whether the parent's tool call waits for the child (`foreground`) or goes on without it (`background`). */
	mode: Mode,
	/** How deep the child is: 1 for the child of a conversation that is no subagent. */
	depth: Depth,
});

/** The child a setup is asked about. */
export type Child = typeof Child.Type;

/** What the product decides about every child. */
export interface ChildSetupService {
	/**
	 * Runs inside the commit that creates the child, after the child got its declared agent: what it writes through
	 * `tx` exists exactly when the child does. The child is a table write already, so only documents and
	 * `tx.configure` work here. A failure fails the commit: no child exists, and the parent's model reads `reason`.
	 */
	readonly created: (tx: Tx.Tx, child: Child) => Effect.Effect<void, ChildSetupFailed>;
	/**
	 * Runs after that commit is stored and before the child gets its task, for what needs a commit of its own or the
	 * outside world. Pi may run it again after a crash, so it must be idempotent. A failure ends the child without a
	 * provider request, and the parent's model reads `reason`.
	 */
	readonly beforeStart: (child: Child) => Effect.Effect<void, ChildSetupFailed>;
}

/**
 * The port. It is required: a registry with the subagent extension does not build without it, because a child that
 * nobody decided about would run with whatever the other plugins default to (no budget cap at all). A product that
 * wants nothing done says so with `none`.
 */
export class ChildSetup extends Context.Service<ChildSetup, ChildSetupService>()(
	"@effectified/pi-subagent/child-setup/ChildSetup",
) {}

/** A setup that does nothing, for a product without guards and budgets: the stated choice, never a default. */
export const none: Layer.Layer<ChildSetup> = Layer.succeed(ChildSetup, {
	created: () => Effect.void,
	beforeStart: () => Effect.void,
});
