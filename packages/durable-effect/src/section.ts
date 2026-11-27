// Prompt sections in Effect: the parts of the system prompt an extension renders before each request, and wrappers of
// the sections of other extensions.

import {
	type PromptSection as PiSection,
	type PromptInput,
	section as piSection,
	wrapSection,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import { Effect, Option } from "effect";
import { call } from "./call.ts";
import * as Doc from "./doc.ts";
import type { DurableError } from "./errors.ts";
import { built, type Invoke, invoker } from "./invocation.ts";
import * as Wrap from "./wrap.ts";

/**
 * What a section renders from, for one request: Pi's input, with the committed document reads as Effects. `agent` is
 * the request's resolution (its `tools` are the tools offered in this request), `env` the conversation's environment
 * when the harness has one, and `shown` the sections in effect after replaying the active transcript, by key.
 */
export interface Input extends StrictOmit<PromptInput, "read"> {
	/** Committed document reads, as they are when the section renders. */
	readonly read: Doc.Reader;
	/** Pi's own input. */
	readonly pi: PromptInput;
}

/** How a section renders: its text, or none to leave it out of this request. */
export type Render<E, R> = (input: Input) => Effect.Effect<Option.Option<string>, E, R>;

/** Options of `make`. */
export interface Options {
	/** Wrap the text as `<key>\n...\n</key>`. Default true. */
	readonly tag?: boolean;
}

/** A section made by `make`: what an extension holds in `sections` and a registry installs. */
export interface Section<R> {
	/** Its key: unique among the sections of the extensions a conversation selects, and what `wrap` names. */
	readonly key: string;
	/** Builds Pi's section; its render runs with the context this Effect is run in (`Registry.layer` runs it). */
	readonly registration: Effect.Effect<PiSection, never, R>;
}

/** Any section, whatever its render needs. */
export interface Any {
	readonly key: string;
	readonly registration: Effect.Effect<PiSection, never, unknown>;
}

/** The services a section, or each section of a union, needs to render. */
export type Services<S> = S extends { readonly registration: Effect.Effect<infer _A, infer _E, infer R> } ? R : never;

/**
 * A section of the system prompt, rendered before each request of a conversation that selects its extension, in
 * extension order, then the agent's `instructions`. A render that fails is reported (`extension_error`) and the
 * request keeps the text the section showed before; interrupting the request interrupts the render.
 */
export function make<E = never, R = never>(key: string, render: Render<E, R>, options?: Options): Section<R> {
	return {
		key,
		registration: Effect.map(Effect.context<R>(), (context) =>
			piSection(key, rendered(invoker(built(context)), render), options),
		),
	};
}

/** A section as a wrapper finds it: its key, its tag, and its render as an Effect. */
export interface Wrapped {
	readonly key: string;
	readonly tag: boolean | undefined;
	/** The wrapped section's own render; it fails as Pi's render rejects. */
	readonly render: Render<DurableError, never>;
}

/** What a wrapper makes of a section: a new render, and the tag, which is the wrapped one's when left out. */
export interface Wrapping<E, R> {
	readonly render: Render<E, R>;
	readonly tag?: boolean;
}

/**
 * Wraps the section `key` of any extension, wherever the wrapping extension is selected (Pi's `wrapSection`): the
 * wrapper gets the section, its render as an Effect, and gives the render that replaces it. A wrapper is applied when
 * the registry composes, so it must be pure; its render runs at each request.
 */
export function wrap<E = never, R = never>(key: string, wrapper: (section: Wrapped) => Wrapping<E, R>): Wrap.Wrap<R> {
	return Wrap.registered((invoke) =>
		wrapSection(key, (section) => {
			const wrapping = wrapper(fromPi(section));
			const tag = wrapping.tag ?? section.tag;
			const render = rendered(invoke, wrapping.render);
			return tag === undefined ? { key: section.key, render } : { key: section.key, render, tag };
		}),
	);
}

/** Pi's section in this package's form, for a wrapper: its render runs under the invocation's Chord context. */
function fromPi(section: PiSection): Wrapped {
	return {
		key: section.key,
		tag: section.tag,
		render: (input) =>
			Effect.map(
				// Pi's render may answer at once or later: a promise either way.
				call((context) => Promise.resolve(section.render(input.pi, context))),
				Option.fromUndefinedOr,
			),
	};
}

/** `render` as Pi calls a section's render, run with `invoke`'s context under the invocation's Chord context. */
function rendered<E, R>(invoke: Invoke<R>, render: Render<E, R>): PiSection["render"] {
	return (input, context) =>
		invoke(
			Effect.map(
				Effect.suspend(() => render(fromPiInput(input, context))),
				Option.getOrUndefined,
			),
			context,
		);
}

/** Pi's input in this package's form; its reads run under `invocation`. */
function fromPiInput(input: PromptInput, invocation: ChordContext): Input {
	return { ...input, read: Doc.reader(input.read, invocation), pi: input };
}
