import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type * as PiWatch from "@earendil-works/chord/watch";
import type { Watchable, WatchCall, WatchEnd } from "@earendil-works/chord/watch";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import { defineFacet, defineState, Host, int, local, method, nul, obj, Reference } from "../src/index.ts";
import { changes, values } from "../src/watch.ts";
import { run } from "./run.ts";

const open = (why: string): Coverage => ({ kind: "open", why });

const SOURCE = open(
	"the implementation a watch source builds its handles on: Chord's documents, derives and references are the " +
		"sources an application watches, through changes and values here; a source written in Effect would be " +
		"behaviour of ours, not a wrapper",
);

/** What `@effectified/pi-chord/watch` does with every value Chord's `/watch` exports. */
const COVERAGE = { Watch: SOURCE, NativeWatch: SOURCE } satisfies Record<keyof typeof PiWatch, Coverage>;

describe("the coverage of Chord's /watch", () => {
	it("records both values, the implementations of a source", () => {
		expect(Object.keys(COVERAGE).sort()).toEqual(["NativeWatch", "Watch"]);
	});
});

const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Counter = local("example.counter", {
	version: 1,
	params: {},
	members: { count: obj({ n: int() }), bump: method(nul()) },
});
const counter = defineFacet((host) => {
	host.serve(Counter, (_, self) => {
		const count = self.state(Count);
		return {
			count,
			bump: async (ctx) => {
				await count.change((draft) => void draft.n++, ctx);
				return null;
			},
		};
	});
});

const counted = Effect.gen(function* () {
	const host = yield* Host.make({});
	yield* host.load([{ name: "@example/counter", facet: counter }]);
	return yield* host.get(Counter, {});
});

describe("changes", () => {
	it("gives the value at attachment, then each change with its ops", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const reference = yield* counted;
				const watching = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes(reference.count), 2)), {
					startImmediately: true,
				});
				yield* Reference.call(reference.bump);
				return yield* Fiber.join(watching);
			}),
		);
		expect(seen[0]).toEqual({ value: { n: 0 }, ops: [], retired: false });
		expect(seen[1]?.value).toEqual({ n: 1 });
		expect(seen[1]?.ops.length).toBeGreaterThan(0);
	});

	it("fails with WatchFailed when the source cannot compute its value", async () => {
		const failing: Watchable<number> = {
			value: 0,
			watch: async () => {
				let resolve: (end: WatchEnd) => void = () => {};
				const closed = new Promise<WatchEnd>((settle) => {
					resolve = settle;
				});
				return {
					value: 0,
					start: (listener: (call: WatchCall<number>, context: Context) => Promise<void>) => {
						void listener({ kind: "failed", error: new Error("source down") }, BACKGROUND_CONTEXT);
					},
					stop: async () => {
						const end: WatchEnd = { kind: "stopped" };
						resolve(end);
						return end;
					},
					closed,
				};
			},
		};
		const exit = await run(Effect.exit(Stream.runCollect(changes(failing))));
		expect(exit).toMatchObject(Exit.fail({ _tag: "WatchFailed" }));
	});
});

describe("values", () => {
	it("gives a native watchable's value now, then each new one", async () => {
		const states = await run(
			Effect.flatMap(counted, (reference) => Stream.runCollect(Stream.take(values(reference.state), 1))),
		);
		expect(states.map((state) => state.kind)).toEqual(["live"]);
	});
});
