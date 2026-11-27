// The port a product provides: where a request is shown to a person.

import { Context, type Effect } from "effect";
import type { Request } from "./request.ts";

/**
 * Where requests go to be decided. `publish` runs every time Pi asks the gate about an undecided call: at the first
 * ask, after every reopen of the harness and after every registry change. So it sees a request at least once and
 * possibly again, always with the same `id`: deduplicate by it. A `publish` that dies blocks the call, as any failing
 * `beforeTool` hook does.
 */
export class Inbox extends Context.Service<Inbox, { readonly publish: (request: Request) => Effect.Effect<void> }>()(
	"@effectified/pi-approvals/inbox",
) {}
