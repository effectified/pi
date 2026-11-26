// pi-tui's settings list with its changes and its cancel as a Stream instead of constructor callbacks.

import { type SettingItem, SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";
import { type Cause, Effect, Queue, type Scope, Stream } from "effect";

/** What the user did in a settings list: set a setting to a value, or left the list (`tui.select.cancel`). */
export type SettingsListEvent =
	| { readonly kind: "change"; readonly id: SettingItem["id"]; readonly value: string }
	| { readonly kind: "cancel" };

/** A settings list and what the user does in it. */
export interface SettingsListOf {
	/** pi-tui's component: add it to a container or show it as an overlay, and give it focus. */
	readonly list: SettingsList;
	/** Each change and cancel, in order, until the scope closes. */
	readonly events: Stream.Stream<SettingsListEvent>;
}

/** What pi-tui's `SettingsList` takes besides its two callbacks. */
type Options = ConstructorParameters<typeof SettingsList>[5];

/**
 * pi-tui's `SettingsList` of `items`, `maxVisible` rows at a time, styled by `theme`, whose callbacks feed `events`.
 * The list shows a value the user picked itself (it sets the item's `currentValue`); a change made elsewhere is
 * shown with `updateValue`.
 */
export function settingsList(
	items: SettingItem[],
	maxVisible: number,
	theme: SettingsListTheme,
	options?: Options,
): Effect.Effect<SettingsListOf, never, Scope.Scope> {
	return Effect.gen(function* () {
		// Ended, not shut down, when the scope closes: the events stream ends, and what was not taken yet stays to take.
		const queue = yield* Effect.acquireRelease(Queue.unbounded<SettingsListEvent, Cause.Done>(), Queue.end);
		const list = new SettingsList(
			items,
			maxVisible,
			theme,
			(id, value) => Queue.offerUnsafe(queue, { kind: "change", id, value }),
			() => Queue.offerUnsafe(queue, { kind: "cancel" }),
			options,
		);
		return { list, events: Stream.fromQueue(queue) };
	});
}
