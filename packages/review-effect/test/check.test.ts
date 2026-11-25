import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Subject } from "../src/check.ts";
import { Check } from "../src/index.ts";

class Glossary extends Context.Service<Glossary, { readonly banned: ReadonlyArray<string> }>()("app/Glossary") {}

describe("Check.make", () => {
	const Wording = Check.make("app.wording", (subject) =>
		Glossary.use(({ banned }) =>
			Effect.succeed(
				banned
					.filter((word) => subject.answer.includes(word))
					.map((word) => ({ severity: "warn" as const, text: `Do not say "${word}".`, location: word })),
			),
		),
	);

	it("names a check and keeps what it needs in its type", async () => {
		// The service the check needs is its requirement, which the registry inherits.
		const needs: Check.Services<typeof Wording> extends Glossary ? true : false = true;
		const subject = { answer: "Obviously it is 42." } as unknown as Subject;
		const found = await Effect.runPromise(
			Effect.provideService(Wording.run(subject), Glossary, { banned: ["Obviously", "Clearly"] }),
		);
		expect([Wording.name, needs]).toEqual(["app.wording", true]);
		expect(found).toEqual([{ severity: "warn", text: 'Do not say "Obviously".', location: "Obviously" }]);
	});
});
