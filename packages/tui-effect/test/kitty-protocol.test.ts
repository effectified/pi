import { isKittyProtocolActive as piIsKittyProtocolActive } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { isKittyProtocolActive, setKittyProtocolActive } from "../src/kitty-protocol.ts";
import { run } from "./run.ts";

describe("isKittyProtocolActive and setKittyProtocolActive", () => {
	it("read and set the flag pi-tui's key decoding reads", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const before = yield* isKittyProtocolActive;
				yield* setKittyProtocolActive(!before);
				const toggled = yield* isKittyProtocolActive;
				const pi = piIsKittyProtocolActive();
				yield* setKittyProtocolActive(before);
				return {
					flipped: toggled !== before,
					pi: pi === toggled,
					restored: (yield* isKittyProtocolActive) === before,
				};
			}),
		);
		expect(seen).toEqual({ flipped: true, pi: true, restored: true });
	});
});
