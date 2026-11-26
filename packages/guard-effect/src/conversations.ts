// Granting: a conversation's grant written in the commit that creates or configures it, with Pi's offer made to match.

import type { ConversationId, ConversationOwnership, ConversationRecord } from "@earendil-works/pi-durable";
import { BuiltinDoc, type Conversation, type Doc, type DurableError, Harness, type Tx } from "@effectified/pi-durable";
import { Effect, Option } from "effect";
import * as Classification from "./classification.ts";
import * as Enforced from "./enforced.ts";
import { type ModelNotCleared, Unguarded, UnknownClassification } from "./errors.ts";
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
 * - It fails with `Unguarded` (`no-registry`), before anything is written, when the guard built no registry: no hook
 *   would enforce the grant.
 * - With `mode: "narrow"` the tools given are the intersection described at `Options.mode`.
 * - A conversation a task owns is never labelled below its owner (see `created`, which records the owner): the
 *   classification stored is the higher of the grant's and the one the owner holds in this commit, and `model` is
 *   checked against that.
 */
export function grantIn(
	tx: Tx.Tx,
	conversationId: ConversationId,
	grant: Grant.Grant,
	options?: Options,
): Effect.Effect<void, GrantError, Guard> {
	return Effect.gen(function* () {
		const guard = yield* Guard;
		if (!Enforced.any(guard)) return yield* new Unguarded({ conversationId, reason: "no-registry" });
		const { policy } = guard;
		const asked = Grant.normalize(grant);
		if (asked.classification !== undefined && !policy.classifications.includes(asked.classification)) {
			return yield* new UnknownClassification({ classification: asked.classification });
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
	});
}

/**
 * Gives an existing conversation `grant`, in one commit of its own. Fails with `Unguarded`, before anything is
 * written, when the conversation does not ask the guard's own extension first.
 */
export function grant(
	conversation: Conversation.Conversation,
	given: Grant.Grant,
	options?: Options,
): Effect.Effect<void, GrantError, Guard> {
	return Effect.andThen(
		guarded(conversation),
		conversation.commit((tx) => grantIn(tx, conversation.id, given, options)),
	);
}

/**
 * A new conversation with `grant`, created in one commit. Fails with `Unguarded`: `no-registry`, and nothing is
 * created, when the guard built no registry; `not-selected`, when the harness runs on a registry the guard did not
 * build: the conversation then exists, with its grant, and nothing would enforce it.
 */
export function create(
	options: Pick<Options, "model"> & { readonly ownership: ConversationOwnership; readonly grant: Grant.Grant },
): Effect.Effect<Conversation.Conversation, GrantError, Guard | Harness.Harness> {
	return Effect.gen(function* () {
		const id = yield* Harness.commit((tx) =>
			Effect.gen(function* () {
				const record = yield* tx.createConversation({ ownership: options.ownership });
				yield* grantIn(tx, record.id, options.grant, options);
				return record.id;
			}),
		);
		const conversation = yield* Effect.flatMap(
			Harness.conversation(id),
			Option.match({
				// The commit above stored the conversation, so the harness has it.
				onNone: () => Effect.die(new Error(`Conversation ${id} is missing after its creating commit`)),
				onSome: (found) => Effect.succeed(found),
			}),
		);
		yield* guarded(conversation);
		return conversation;
	});
}

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
export function created(tx: Tx.Tx, conversation: ConversationRecord): Effect.Effect<void, Doc.Failure, Guard> {
	return Effect.gen(function* () {
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
}

/**
 * The grant that holds for a conversation now, its tools and its classification: the stored one, or the policy's for
 * a conversation without one. A read outside a commit, which needs no checked registry: what another part of a
 * product asks to learn what a conversation holds, such as the constraints a router filters its routes by.
 */
export function granted(
	conversationId: ConversationId,
): Effect.Effect<Grant.Grant, Doc.Failure, Guard | Harness.Harness> {
	return Effect.gen(function* () {
		const { policy } = yield* Guard;
		const stored = yield* Harness.snapshot(Grant.Document, conversationId);
		return Grant.effective(Option.getOrUndefined(stored), policy.ungranted);
	});
}

/**
 * Succeeds when Pi asks the guard's own extension first for this conversation; fails with `Unguarded` otherwise. The
 * extension is compared as the object a registry this guard built holds: a harness on another registry, and an
 * extension installed under the guard's name, are `not-selected`.
 */
export function guarded(conversation: Conversation.Conversation): Effect.Effect<void, Unguarded | DurableError, Guard> {
	return Effect.gen(function* () {
		const guard = yield* Guard;
		const { extensions } = yield* conversation.agent;
		if (Enforced.owns(guard, extensions[0])) return;
		const reason = extensions.some((extension) => Enforced.owns(guard, extension)) ? "not-first" : "not-selected";
		return yield* new Unguarded({ conversationId: conversation.id, reason });
	});
}

/**
 * `grant` as a conversation `owner` owns may hold it: with the higher of its classification and the one the owner's
 * grant has in this commit. Content goes from an owner to what it owns, so a child labelled lower would reach tools
 * and models the policy keeps from its owner. An absent label is above every other, and so is one the policy does
 * not list. Unchanged without an owner, and under a policy without classifications.
 */
function underOwner(
	tx: Tx.Tx,
	policy: Policy,
	grant: Grant.Grant,
	owner: ConversationId | undefined,
): Effect.Effect<Grant.Grant, Doc.Failure> {
	const labels = policy.classifications;
	if (owner === undefined || labels.length === 0) return Effect.succeed(grant);
	return Effect.gen(function* () {
		const document = yield* tx.doc(Grant.Document, owner);
		const held = Grant.effective(yield* document.get, policy.ungranted).classification;
		const asked = grant.classification === undefined ? -1 : labels.indexOf(grant.classification);
		const bound = held === undefined ? -1 : labels.indexOf(held);
		if (asked < 0 || (bound >= 0 && asked >= bound)) return grant;
		return Grant.normalize({ tools: grant.tools, classification: bound < 0 ? undefined : held });
	});
}

/**
 * Those of `tools` the conversation may keep under `mode: "narrow"`: the ones Pi's stored agent enables now and, when
 * the conversation has a grant, that grant lists. A stored agent without a list enables every tool, less those it
 * removes.
 */
function narrowed(
	tx: Tx.Tx,
	conversationId: ConversationId,
	tools: ReadonlyArray<string>,
	had: Grant.Grant | null,
): Effect.Effect<ReadonlyArray<string>, Doc.Failure> {
	return Effect.gen(function* () {
		const agent = yield* tx.doc(BuiltinDoc.agent, conversationId);
		const enabled = (yield* agent.get).tools;
		return tools.filter(
			(name) =>
				(enabled === undefined ||
					(Array.isArray(enabled) ? enabled.includes(name) : !enabled.remove.includes(name))) &&
				(had === null || had.tools.includes(name)),
		);
	});
}
