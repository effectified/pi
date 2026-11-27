// The ids of this package's own: the token of a reservation and the key of a spend. Provider and model ids and the key
// of a request are pi-ai's (`ProviderId`, `ModelId`, `RequestKey` of `@effectified/pi-ai`), a conversation's id is Pi
// Durable's (`Conversation.Id` of `@effectified/pi-durable`).

import { Schema } from "effect";

/**
 * The token of one reservation, as the product's `Lease` gave it: what `settle` names the reservation by, and what the
 * `Reserved` and `Settled` events of one request carry. The lease brands its own (`Reservation.make(token)`).
 */
export const Reservation = Schema.String.pipe(Schema.brand("@effectified/pi-budget/Reservation"));

/** The token of one reservation. */
export type Reservation = typeof Reservation.Type;

/**
 * The caller's name for a spend recorded through `Spend`: the same every time the same spend is told, also by a later
 * process, so it is recorded once. For a router's attempt: its request id and attempt number.
 */
export const SpendKey = Schema.String.pipe(Schema.brand("@effectified/pi-budget/SpendKey"));

/** The caller's name for a spend. */
export type SpendKey = typeof SpendKey.Type;
