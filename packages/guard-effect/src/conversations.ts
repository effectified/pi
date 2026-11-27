// Granting: a conversation's grant written in the commit that creates or configures it, with Pi's offer made to match.

import type { ConversationId, ConversationOwnership, ConversationRecord, ToolName } from "@effectified/pi-durable";
import { BuiltinDoc, type Conversation, type Doc, type DurableError, Harness, type Tx } from "@effectified/pi-durable";
import { Array as Arr, Effect, Option } from "effect";
import * as Classification from "./classification.ts";
import * as Enforced from "./enforced.ts";
import { type ModelNotCleared, Unguarded, UnguardedReason, UnknownClassification } from "./errors.ts";
import * as Grant from "./grant.ts";
import { Guard } from "./guard.ts";
import type { Policy } from "./policy.ts";

/** What a grant may set besides the grant itself. */
export interface Options {
	/** The conversation's model, set in the same commit. Refused unless it may serve the grant's classification. */
	readonly model?: Classification.ModelRef;
	/**
	 * How the grant's tools meet what the conversation has.
	 *
	 * - `"replace"`, the default: the conversation gets exactly the grant's tools, more than it had or fewer.
	 * - `"narrow"`: it gets those of the grant's tools that its stored agent enables now and, when it has a grant, that
	 *   grant lists. The stored grant is that intersection. For a conversation that was just set to what it may have at
	 *   most, such as a subagent's child after its declaration: the grant can take tools away and never adds one.
	 */
	readonly mode?: "replace" | "narrow";
}

/** What giving a grant fails with besides a failed Pi call. */
export type GrantError = UnknownClassification | ModelNotCleared | Unguarded | Doc.Failure;

/**
 * Gives the conversation `grant` inside the caller's commit: the grant is stored in the guard's document and Pi's
 * stored agent is set to enable exactly its tools, so the model is offered those and no other tool resolves, for a
 * nested call either. Stored with the commit or not at all. Both are document writes, so it works after table
 * writes: on a conversation the commit just created or forked, and in `conversationCreated`. It replaces the grant
 * the conversation had, a fork's inherited one too.
 *
 * - It fails with `Unguarded` (`NoRegistry`), before anything is written, when the guard built no registry: no hook
 *   would enforce the grant.
 * - With `mode: "narrow"` the tools given are the intersection described at `Options.mode`.
 * - A conversation a task owns is never labelled below its owner (see `created`, which records the owner): the
 *   classification stored is the higher of the grant's and the one the owner holds in this commit, and `model` is
 *   checked against that.
 */
export const grantIn: (
	tx: Tx.Tx,
	conversationId: ConversationId,
	grant: Grant.Grant,
	options?: Options,
) => Effect.Effect<void, GrantError, Guard> = Effect.fn("Conversations.grantIn")(
	function* (tx, conversationId, grant, options) {
		const guard = yield* Guard;
		if (!Enforced.any(guard)) {
			return yield* Unguarded.make({ conversationId, reason: UnguardedReason.cases.NoRegistry.make({}) });
		}
		const { policy } = guard;
		const asked = Grant.normalize(grant);
		if (asked.classification !== undefined && !Arr.contains(policy.classifications, asked.classification)) {
			return yield* UnknownClassification.make({ classification: asked.classification });
		}
		const document = yield* tx.doc(Grant.Document, conversationId);
		const stored = yield* document.get;
		const bounded = yield* underOwner(tx, policy, asked, stored.owner);
		const model = options?.model;
		if (model !== undefined) yield* Classification.checkModel(policy, model, bounded.classification);
		const tools =
			options?.mode === "narrow" ? yield* narrowed(tx, conversationId, bounded.tools, stored.grant) : bounded.tools;
		yield* document.set({ ...stored, grant: { ...bounded, tools } });
		yield* tx.configure(conversationId, { tools, ...(model === undefined ? {} : { model }) });
	},
);

/**
 * Gives an existing conversation `grant`, in one commit of its own. Fails with `Unguarded`, before anything is
 * written, when the conversation does not ask the guard's own extension first.
 */
export const grant: (
	conversation: Conversation.Conversation,
	given: Grant.Grant,
	options?: Options,
) => Effect.Effect<void, GrantError, Guard> = Effect.fn("Conversations.grant")(
	function* (conversation, given, options) {
		yield* guarded(conversation);
		yield* conversation.commit((tx) => grantIn(tx, conversation.id, given, options));
	},
);

/**
 * A new conversation with `grant`, created in one commit. Fails with `Unguarded`: `NoRegistry`, and nothing is
 * created, when the guard built no registry; `NotSelected`, when the harness runs on a registry the guard did not
 * build: the conversation then exists, with its grant, and nothing would enforce it.
 */
export const create: (
	options: Pick<Options, "model"> & { readonly ownership: ConversationOwnership; readonly grant: Grant.Grant },
) => Effect.Effect<Conversation.Conversation, GrantError, Guard | Harness.Harness> = Effect.fn("Conversations.create")(
	function* (options) {
		const id = yield* Harness.commit((tx) =>
			Effect.gen(function* () {
				const record = yield* tx.createConversation({ ownership: options.ownership });
				yield* grantIn(tx, record.id, options.grant, options);
				return record.id;
			}),
		);
		const found = yield* Harness.conversation(id);
		// The commit above stored the conversation, so the harness has it.
		if (Option.isNone(found)) return yield* Effect.die(`Conversation ${id} is missing after its creating commit`);
		yield* guarded(found.value);
		return found.value;
	},
);

/**
 * For `Harness.layer`'s `conversationCreated`: makes Pi's offer match the guard in every commit that creates or
 * forks a conversation, whoever makes it. A fork is offered the tools of the grant it inherits; any other new
 * conversation, a task-owned child included, the tools the policy gives a conversation without a grant. Without it
 * the guard still refuses every call outside the grant; the model is only offered tools it cannot call. A `grantIn`
 * later in the same commit replaces what it set.
 *
 * It also records, in the guard's document, the conversation that owns a task-owned one (a subagent's child, a
 * swarm's fork): the owner's classification then bounds every grant given to it, and a fork's inherited grant is
 * raised to it here. Pi names the owner only in the creating commit, so without this hook no grant is bounded.
 */
export const created: (tx: Tx.Tx, conversation: ConversationRecord) => Effect.Effect<void, Doc.Failure, Guard> =
	Effect.fn("Conversations.created")(function* (tx, conversation) {
		const { policy } = yield* Guard;
		const owner = conversation.owner?.conversationId;
		// Only a fork holds a grant already (its copy of the parent's document), and only an owned conversation gets an
		// owner written: any other new conversation needs no document yet.
		if (conversation.parent === undefined && owner === undefined) {
			return yield* tx.configure(conversation.id, { tools: policy.ungranted.tools });
		}
		const document = yield* tx.doc(Grant.Document, conversation.id);
		const copied = yield* document.get;
		const owned = owner === undefined ? copied : { ...copied, owner };
		const inherited = owned.grant === null ? null : yield* underOwner(tx, policy, owned.grant, owned.owner);
		yield* document.set({ ...owned, grant: inherited });
		yield* tx.configure(conversation.id, { tools: Grant.effective(owned, policy.ungranted).tools });
	});

/**
 * The grant that holds for a conversation now, its tools and its classification: the stored one, or the policy's for
 * a conversation without one. A read outside a commit, which needs no checked registry: what another part of a
 * product asks to learn what a conversation holds, such as the constraints a router filters its routes by.
 */
export const granted: (
	conversationId: ConversationId,
) => Effect.Effect<Grant.Grant, Doc.Failure, Guard | Harness.Harness> = Effect.fn("Conversations.granted")(
	function* (conversationId) {
		const { policy } = yield* Guard;
		const stored = yield* Harness.snapshot(Grant.Document, conversationId);
		return Grant.effective(Option.getOrUndefined(stored), policy.ungranted);
	},
);

/**
 * Succeeds when Pi asks the guard's own extension first for this conversation; fails with `Unguarded` otherwise. The
 * extension is compared as the object a registry this guard built holds: a harness on another registry, and an
 * extension installed under the guard's name, are `NotSelected`.
 */
export const guarded: (
	conversation: Conversation.Conversation,
) => Effect.Effect<void, Unguarded | DurableError, Guard> = Effect.fn("Conversations.guarded")(
	function* (conversation) {
		const guard = yield* Guard;
		const { extensions } = yield* conversation.agent;
		if (Enforced.owns(guard, extensions[0])) return;
		const { NotFirst, NotSelected } = UnguardedReason.cases;
		const reason = Arr.some(extensions, (extension) => Enforced.owns(guard, extension))
			? NotFirst.make({})
			: NotSelected.make({});
		return yield* Unguarded.make({ conversationId: conversation.id, reason });
	},
);

/**
 * `grant` as a conversation `owner` owns may hold it: with the higher of its classification and the one the owner's
 * grant has in this commit. Content goes from an owner to what it owns, so a child labelled lower would reach tools
 * and models the policy keeps from its owner. An absent label is above every other, and so is one the policy does
 * not list. Unchanged without an owner, and under a policy without classifications.
 */
const underOwner = Effect.fn("Conversations.underOwner")(function* (
	tx: Tx.Tx,
	policy: Policy,
	grant: Grant.Grant,
	owner: ConversationId | undefined,
) {
	const labels = policy.classifications;
	if (owner === undefined || Arr.isReadonlyArrayEmpty(labels)) return grant;
	const document = yield* tx.doc(Grant.Document, owner);
	const stored = yield* document.get;
	const held = Grant.effective(stored, policy.ungranted).classification;
	const asked = rank(labels, grant.classification);
	const bound = rank(labels, held);
	if (asked < 0 || (bound >= 0 && asked >= bound)) return grant;
	return Grant.normalize({ tools: grant.tools, classification: bound < 0 ? undefined : held });
});

/** The place of `label` in `labels` from 0, or -1 for an absent label and one that is not listed. */
function rank(labels: ReadonlyArray<string>, label: string | undefined): number {
	return label === undefined
		? -1
		: Option.getOrElse(
				Arr.findFirstIndex(labels, (listed) => listed === label),
				() => -1,
			);
}

/**
 * Those of `tools` the conversation may keep under `mode: "narrow"`: the ones Pi's stored agent enables now and, when
 * the conversation has a grant, that grant lists. A stored agent without a list enables every tool, less those it
 * removes.
 */
const narrowed = Effect.fn("Conversations.narrowed")(function* (
	tx: Tx.Tx,
	conversationId: ConversationId,
	tools: ReadonlyArray<ToolName>,
	had: Grant.Grant | null,
) {
	const agent = yield* tx.doc(BuiltinDoc.agent, conversationId);
	const enabled = (yield* agent.get).tools;
	const allowed = (name: ToolName): boolean =>
		enabled === undefined ||
		(Arr.isArray(enabled) ? Arr.contains(enabled, name) : !Arr.contains(enabled.remove, name));
	return Arr.filter(tools, (name) => allowed(name) && (had === null || Arr.contains(had.tools, name)));
});
