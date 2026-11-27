// The `Tui` service: the running pi-tui renderer of a program, as `layer`, `regular` or `fullscreen` started it.

import type { TUI } from "@earendil-works/pi-tui";
import { Context } from "effect";

/**
 * The running TUI of this program. The service value is pi-tui's own object (a `TuiMainScreen` or a `TuiAltScreen`),
 * so it can be handed to what takes one (an `Editor`, a `Loader`); the functions of `Tui` are the Effect way to
 * drive it.
 */
export class Tui extends Context.Service<Tui, TUI>()("@effectified/pi-tui/tui-service/Tui") {}
