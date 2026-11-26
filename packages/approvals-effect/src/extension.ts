// The extension a product installs: the gate of its policy and the record of what the gate decided by.

import type { Extension, Hook } from "@effectified/pi-durable";
import { record } from "./applied.ts";
import { gate } from "./gate.ts";
import type { Inbox } from "./inbox.ts";
import type { Policy } from "./policy.ts";

/** The hooks of the extension: the gate, then the record. */
export type Hooks<R> = readonly [Hook.Hook<R | Inbox>, Hook.Hook<never>];

/**
 * The extension `approvals` for `policy`. The registry it is installed in requires `Inbox` and what the policy's
 * rule needs. Install it after every extension that blocks or rewrites tool calls: a call a guard blocks never asks a
 * person, and arguments a later hook rewrote would run without anyone having seen them. `NoInfer`: `R` is read from
 * the policy only, so a call written inside the array of `Registry.layer` does not take it from there.
 */
export function extension<R = never>(
	policy: Policy<R>,
): Extension.Extension<readonly [], Hooks<NoInfer<R>>, readonly [], readonly [], readonly []> {
	return { name: "approvals", hooks: [gate(policy), record] };
}
