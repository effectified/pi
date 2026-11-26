import type { ConversationId } from "@earendil-works/pi-durable";
import { Harness } from "@effectified/pi-durable";
import { answer, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Child, Subagents } from "../src/index.ts";
import { children, conversation, harness, parent, routed, worker } from "./scene.ts";

describe("how a host links a child to its parent", () => {
	it("finds the parent in Pi's own record of the child, and the rest in the `subagent.child` document", async () => {
		const { layer } = harness({
			config: { subagents: [worker("researcher")], maxDepth: 1, maxLive: 1 },
			responses: routed({
				parent: [toolCall(Subagents.TOOLS.foreground, { subagent: "researcher", task: "Work." }), answer("Done.")],
				child: [answer("Worked.")],
			}),
		});
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* parent;
				yield* root.prompt("Delegate.");
				yield* root.waitForIdle;
				// A host that knows the parent lists its children by the owner index, in a commit without writes.
				const owned = yield* Harness.commit((tx) => tx.scanConversations({ ownerConversationId: root.id }, 10));
				const record = owned.items[0];
				const id = record?.id as ConversationId;
				const document = yield* Harness.snapshot(Child.Document, Child.key(id));
				// A fork of the child is a conversation of its own, and no subagent: the document is the session's.
				const child = yield* conversation(id);
				const fork = yield* child.fork({
					at: Option.getOrThrow(yield* child.head),
					ownership: { kind: "ownerless" },
				});
				return {
					id,
					key: Child.key(id),
					record,
					document: Option.getOrThrow(document),
					ofFork: yield* Harness.snapshot(Child.Document, Child.key(fork.id)),
					ofRoot: yield* Harness.snapshot(Child.Document, Child.key(root.id)),
					all: (yield* children).length,
				};
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.key).toBe(String(seen.id));
		expect(seen.record?.owner).toEqual({ conversationId: 1, taskId: seen.document.task });
		expect(seen.document).toMatchObject({
			conversation: seen.id,
			subagent: "researcher",
			parent: 1,
			depth: 1,
			mode: "foreground",
			state: { _tag: "Answered" },
		});
		expect(Option.isNone(seen.ofFork)).toBe(true);
		expect(Option.isNone(seen.ofRoot)).toBe(true);
		expect(seen.all).toBe(1);
	});
});
