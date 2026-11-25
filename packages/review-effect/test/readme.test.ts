// The examples of README.md, each as it is written there, run on scripted models.

import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Models } from "@gunta/pi-ai-effect";
import { Harness, Registry, Storage } from "@gunta/pi-durable-effect";
import { answer, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Review from "../src/index.ts";

// Policy as data: who reviews, the family of every model, how many corrective runs, what blocks.
const policy: Review.Policy.Policy = {
	reviewer: { provider: "reviewer-lab", modelId: "judge" },
	families: [
		{ provider: "author-lab", modelId: "writer", family: "alpha" },
		{ provider: "reviewer-lab", modelId: "judge", family: "beta" },
	],
	maxCorrections: 1,
	blocking: "block",
};

/** A harness whose author answers with `author` and whose reviewer, of a second provider, with `reviewer`. */
function harness<const Checks extends ReadonlyArray<Review.Check.Any> = readonly []>(options: {
	readonly policy?: Review.Policy.Policy;
	readonly checks?: Checks;
	readonly author: ReadonlyArray<string>;
	/** A text is the reviewer's answer; anything else is a scripted response as it is. */
	readonly reviewer: ReadonlyArray<string | FauxResponseStep>;
}) {
	// Two scripted providers stand in for two model families: no network and no key.
	const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
	reviewer.setResponses(options.reviewer.map((step) => (typeof step === "string" ? answer(step) : step)));
	return Layer.effectDiscard(Models.use((models) => Effect.sync(() => models.setProvider(reviewer.provider)))).pipe(
		Layer.provideMerge(
			TestHarness.layer({
				extensions: [Review.extension({ policy: options.policy ?? policy, checks: options.checks })],
				responses: options.author.map((text) => answer(text)),
				provider: { provider: "author-lab", models: [{ id: "writer" }] },
			}),
		),
	);
}

const WRONG = '{"findings":[{"severity":"block","text":"Six times seven is 42.","location":"It is 41."}]}';
const CLEAN = '{"findings":[]}';

describe("README", () => {
	it("quick start: a blocked answer is corrected once, and the corrected one stands", async () => {
		const live = harness({ author: ["It is 41.", "It is 42."], reviewer: [WRONG, CLEAN] });

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			// Settles once an answer passed its review: here the second one.
			const settled = yield* root.prompt("What is six times seven?");
			yield* root.waitForIdle;
			const state = yield* Review.state(root);
			const verdicts = yield* Stream.runCollect(Review.verdicts(root));
			return {
				settled: settled.status,
				state: state._tag,
				outcomes: verdicts.map((entry) => entry.data.outcome._tag),
			};
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({
			settled: "done",
			state: "Reviewed",
			outcomes: ["Corrected", "Passed"],
		});
	});

	it("policy: decoded from plain data", () => {
		const decoded = Schema.decodeUnknownSync(Review.Policy.Policy)({
			reviewer: { provider: "reviewer-lab", modelId: "judge" },
			families: [
				{ provider: "author-lab", modelId: "writer", family: "alpha" },
				{ provider: "reviewer-lab", modelId: "judge", family: "beta" },
			],
			maxCorrections: 1,
			blocking: "block",
			instructions: "Check every date against the transcript.",
		});
		expect(decoded.maxCorrections).toBe(1);
		expect(Review.Policy.familyOf(decoded.families, decoded.reviewer)).toEqual(Option.some("beta"));
	});

	it("policy: a reviewer alias has a row for itself and one for each of its routes", () => {
		const routed = Schema.decodeUnknownSync(Review.Policy.Policy)({
			reviewer: { provider: "router", modelId: "reviewer" }, // an alias
			families: [
				{ provider: "author-lab", modelId: "writer", family: "alpha" },
				{ provider: "router", modelId: "reviewer", family: "beta" }, // the alias
				{ provider: "reviewer-lab", modelId: "judge", family: "beta" }, // each of its routes
			],
			maxCorrections: 1,
			blocking: "block",
		});
		const familyOf = (provider: string, modelId: string) =>
			Review.Policy.familyOf(routed.families, { provider, modelId });
		expect([
			familyOf("router", "reviewer"),
			familyOf("reviewer-lab", "judge"),
			familyOf("other-lab", "judge"),
		]).toEqual([Option.some("beta"), Option.some("beta"), Option.none()]);
	});

	it("verdicts: the reviewer's requests as a product records model calls", async () => {
		const live = harness({ author: ["It is 41.", "It is 42."], reviewer: [WRONG, CLEAN] });

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			yield* root.prompt("What is six times seven?");
			yield* root.waitForIdle;
			// What a record of the reviewer's model calls is made from: Pi's usage ledger does not hold these requests.
			const verdicts = yield* Stream.runCollect(Review.verdicts(root));
			const calls = verdicts.flatMap((entry) => {
				const call = entry.data.call;
				return call === undefined
					? []
					: [`${entry.id} ${call.provider}/${call.model} ${call.stopReason} ${call.usage?.totalTokens ?? 0}`];
			});
			// What a sink gets as an entry's data decodes with the entry's own schema.
			const decoded = verdicts.map((entry) =>
				Schema.decodeUnknownSync(Review.VerdictEntry.schema)(JSON.parse(JSON.stringify(entry.data))),
			);
			return {
				calls,
				decoded,
				stored: verdicts.map((entry) => entry.data),
				ledger: Object.keys((yield* Harness.usage).models),
			};
		});

		const result = await Effect.runPromise(Effect.provide(program, live));
		expect(result.decoded).toEqual(result.stored);
		expect(result.calls).toEqual([
			expect.stringMatching(/^\d+ reviewer-lab\/judge stop [1-9]\d*$/),
			expect.stringMatching(/^\d+ reviewer-lab\/judge stop [1-9]\d*$/),
		]);
		expect(result.ledger).toEqual(["author-lab/writer"]);
	});

	it("checks: a citation check and a check of your own, each with a service the registry requires", async () => {
		// A check of your own: an Effect over the answer. What it needs is a requirement of the registry.
		class Glossary extends Context.Service<Glossary, { readonly banned: ReadonlyArray<string> }>()("app/Glossary") {}

		const Wording = Review.Check.make("app.wording", (subject) =>
			Glossary.use(({ banned }) =>
				Effect.succeed(
					banned
						.filter((word) => subject.answer.includes(word))
						.map((word) => ({ severity: "warn" as const, text: `Do not say "${word}".`, location: word })),
				),
			),
		);

		// The citation check: your extractor finds the citations, your verifier says whether each one holds.
		const Cited = Review.Citations.check((text) =>
			[...text.matchAll(/([^.\]]+?)\s*\[([^\]]+)\]/g)].map((match) => ({
				source: match[2] ?? "",
				claim: (match[1] ?? "").trim(),
			})),
		);

		const VerifierLive = Layer.succeed(Review.Citations.Verifier, {
			verify: (citation) =>
				Effect.succeed<Review.Citations.Verification>(
					citation.source === "atlas" ? { _tag: "Verified" } : { _tag: "Unresolved" },
				),
		});

		const live = harness({
			checks: [Cited, Wording],
			author: ["Obviously the sky is blue [gazette].", "The sky is blue [atlas]."],
			reviewer: [CLEAN, CLEAN],
		}).pipe(Layer.provide(VerifierLive), Layer.provide(Layer.succeed(Glossary, { banned: ["Obviously"] })));

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			yield* root.prompt("What colour is the sky?");
			yield* root.waitForIdle;
			const verdicts = yield* Stream.runCollect(Review.verdicts(root));
			return verdicts.map((entry) => ({
				outcome: entry.data.outcome._tag,
				findings: entry.data.findings.map((finding) => `${finding.check}: [${finding.severity}] ${finding.text}`),
			}));
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual([
			{
				outcome: "Corrected",
				findings: [
					'review.citations: [block] The citation "gazette" does not resolve.',
					'app.wording: [warn] Do not say "Obviously".',
				],
			},
			{ outcome: "Passed", findings: [] },
		]);
	});

	it("held: the submission stays open until a person releases the answer", async () => {
		const live = harness({ policy: { ...policy, maxCorrections: 0 }, author: ["It is 41."], reviewer: [WRONG] });

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const submission = yield* root.submit({ type: "input", content: "What is six times seven?" });
			// A held answer never settles its submission: wait for whichever comes first.
			const held = root.changes().pipe(
				Stream.mapEffect(() => Review.state(root)),
				Stream.filter((state) => state._tag === "Held"),
				Stream.runHead,
				Effect.map(Option.getOrThrow),
			);
			const outcome = yield* Effect.raceFirst(Effect.andThen(submission.wait, Review.state(root)), held);
			const before = (yield* submission.status).status;
			// Later, once your host has authenticated the person who decides:
			const delivery =
				outcome._tag === "Held" ? yield* Review.release(root, { _tag: "Accept", by: "user:ada" }) : "not held";
			const ended = yield* Review.waitForHoldEnd(root);
			const settled = yield* submission.wait;
			yield* root.waitForIdle;
			const after = yield* Review.state(root);
			return {
				outcome: outcome._tag,
				before,
				delivery,
				ended: ended._tag,
				settled: settled.status,
				after: after._tag,
			};
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({
			outcome: "Held",
			before: "placed",
			delivery: "released",
			ended: "Accepted",
			settled: "done",
			after: "Accepted",
		});
	});

	it("deferred: the reviewer's request fails, and the same answer is reviewed once it is asked for again", async () => {
		const live = harness({
			author: ["It is 42."],
			reviewer: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }), CLEAN],
		});

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const submission = yield* root.submit({ type: "input", content: "What is six times seven?" });
			// A deferred review does not settle its submission either: watch the state, as for a hold.
			const deferred = root.changes().pipe(
				Stream.mapEffect(() => Review.state(root)),
				Stream.filter((state) => state._tag === "Deferred"),
				Stream.runHead,
				Effect.map(Option.getOrThrow),
			);
			const outcome = yield* Effect.raceFirst(Effect.andThen(submission.wait, Review.state(root)), deferred);
			const reason = outcome._tag === "Deferred" ? outcome.reason : "";
			const before = (yield* submission.status).status;
			// Later, once the reviewer can be reached and paid for again:
			const asked = outcome._tag === "Deferred" ? yield* Review.retry(root) : "not deferred";
			const settled = yield* submission.wait;
			yield* root.waitForIdle;
			const verdicts = yield* Stream.runCollect(Review.verdicts(root));
			return {
				outcome: outcome._tag,
				reason,
				before,
				asked,
				settled: settled.status,
				after: (yield* Review.state(root))._tag,
				verdicts: verdicts.map((entry) => [entry.data.pass, entry.data.outcome._tag]),
			};
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({
			outcome: "Deferred",
			reason: "overloaded",
			before: "placed",
			asked: "retrying",
			settled: "done",
			after: "Reviewed",
			verdicts: [
				[1, "Deferred"],
				[1, "Passed"],
			],
		});
	});

	it("not reviewed by choice: a conversation without the extension is not required to be reviewed", async () => {
		const live = harness({ author: ["It is 42.", "It is 56."], reviewer: [] });

		const program = Effect.gen(function* () {
			// A conversation that is not reviewed, among reviewed ones: it is created without the extension.
			const unreviewed = yield* Harness.createConversation({
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "author-lab", modelId: "writer" }, extensions: { remove: [Review.NAME] } },
			});
			const settled = yield* unreviewed.prompt("What is six times seven?");
			const state = yield* Review.state(unreviewed);

			// The same inside a commit, for a conversation the commit creates.
			const created = yield* Harness.commit((tx) =>
				Effect.gen(function* () {
					const record = yield* tx.createConversation({ ownership: { kind: "ownerless" } });
					yield* tx.configure(record.id, { extensions: { remove: [Review.NAME] } });
					return record.id;
				}),
			);

			const second = Option.getOrThrow(yield* Harness.conversation(created));
			yield* second.configure({ model: { provider: "author-lab", modelId: "writer" } });
			const answered = yield* second.prompt("And seven times eight?");
			yield* Harness.waitForIdle;
			const verdicts = yield* Stream.runCollect(Review.verdicts(unreviewed));
			return {
				settled: settled.status,
				state,
				answered: answered.status,
				created: yield* Review.state(second),
				verdicts: verdicts.length,
			};
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({
			settled: "done",
			state: { _tag: "NotRequired" },
			answered: "done",
			created: { _tag: "NotRequired" },
			verdicts: 0,
		});
	});

	it("held: a person's correction continues the run, and the next answer is reviewed", async () => {
		const live = harness({
			policy: { ...policy, maxCorrections: 0 },
			author: ["It is 41.", "It is 42."],
			reviewer: [WRONG, CLEAN],
		});

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const submission = yield* root.submit({ type: "input", content: "What is six times seven?" });
			while ((yield* Review.state(root))._tag !== "Held") yield* Effect.sleep("1 millis");
			yield* Review.release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
			const settled = yield* submission.wait;
			yield* root.waitForIdle;
			return { settled: settled.status, state: (yield* Review.state(root))._tag };
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({ settled: "done", state: "Reviewed" });
	});

	it("the waits of a transcript: a hold and a deferral are read back after both ended", async () => {
		const live = harness({
			policy: { ...policy, maxCorrections: 0 },
			author: ["It is 41.", "It is 42."],
			reviewer: [WRONG, fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }), CLEAN],
		});

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const submission = yield* root.submit({ type: "input", content: "What is six times seven?" });
			while ((yield* Review.state(root))._tag !== "Held") yield* Effect.sleep("1 millis");
			yield* Review.release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
			while ((yield* Review.state(root))._tag !== "Deferred") yield* Effect.sleep("1 millis");
			yield* Review.retry(root);
			yield* submission.wait;
			yield* root.waitForIdle;
			// Every hold and deferral of a conversation, oldest first, read back after the fact.
			const waits = (yield* Stream.runCollect(Review.verdicts(root))).flatMap((entry) =>
				Option.toArray(Review.waitOf(entry.data)),
			);
			return { state: (yield* Review.state(root))._tag, waits: waits.map((wait) => wait._tag) };
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({
			state: "Reviewed",
			waits: ["Held", "Deferred"],
		});
	});

	it("not reviewed: a reviewer of the author's family reviews nothing, and the state says so", async () => {
		const sameFamily = {
			...policy,
			families: [
				{ provider: "author-lab", modelId: "writer", family: "alpha" },
				{ provider: "reviewer-lab", modelId: "judge", family: "alpha" },
			],
		};
		const live = harness({ policy: sameFamily, author: ["It is 41."], reviewer: [] });

		const program = Effect.gen(function* () {
			const root = yield* TestHarness.root;
			const settled = yield* root.prompt("What is six times seven?");
			yield* root.waitForIdle;
			const state = yield* Review.state(root);
			// Pi's `done` says the run ended. Whether the answer is reviewed is the state.
			return {
				settled: settled.status,
				state: state._tag,
				reason: state._tag === "NotReviewed" ? state.reason : "",
			};
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toEqual({
			settled: "done",
			state: "NotReviewed",
			reason: "same_family",
		});
	});

	it("registry: the extension goes after the guards, in a harness of your own", async () => {
		const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
		const author = fauxProvider({ provider: "author-lab", models: [{ id: "writer" }] });
		author.setResponses([answer("It is 42.")]);
		reviewer.setResponses([answer(CLEAN)]);
		const Guards = { name: "guards", hooks: [] };

		const live = Harness.layer().pipe(
			// Guards first, then your tools, then the review: the only extension with an `onYield` hook.
			Layer.provide(Registry.layer([Guards, Review.extension({ policy })])),
			Layer.provide(Storage.memory),
			// Both models come from the harness's `Models`: a budget that wraps them covers the reviewer too.
			Layer.provide(Models.layer([author.provider, reviewer.provider])),
		);

		const program = Effect.gen(function* () {
			const root = yield* Harness.rootWith({ agent: { model: { provider: "author-lab", modelId: "writer" } } });
			yield* root.prompt("What is six times seven?");
			yield* root.waitForIdle;
			return (yield* Review.state(root))._tag;
		});

		expect(await Effect.runPromise(Effect.provide(program, live))).toBe("Reviewed");
	});
});
