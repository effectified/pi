// The ids of this package's own: a swarm's id, a job's key in its swarm, a driver's id of a fork, and the id of one
// request of a job in its fork. Pi's ids are Pi Durable's (`Conversation.Id`, `Entry.Id`, `Task.Id`).

import { Schema } from "effect";

/**
 * The id of a swarm: the caller's idempotency key, which names one swarm of a harness storage (`Plan.id`). A caller
 * brands its own (`SwarmId.make(id)`); a stored one is branded as it is decoded.
 */
export const SwarmId = Schema.String.pipe(Schema.brand("@effectified/pi-swarm/SwarmId"));

/** The id of a swarm. */
export type SwarmId = typeof SwarmId.Type;

/** The key of a job, unique in its swarm (`PlannedJob.key`): with the swarm id, it is the key of the job's fork. */
export const JobKey = Schema.String.pipe(Schema.brand("@effectified/pi-swarm/JobKey"));

/** The key of a job. */
export type JobKey = typeof JobKey.Type;

/**
 * A driver's own id of a fork: a conversation id, an actor id. Only the driver that gave it reads it; the driver
 * brands it where it makes or finds the fork.
 */
export const ForkId = Schema.String.pipe(Schema.brand("@effectified/pi-swarm/ForkId"));

/** A driver's own id of a fork. */
export type ForkId = typeof ForkId.Type;

/**
 * The id of one request of a job in its fork, `<swarm id>/<job key>/<n>`: `0` is the job, `1` and up its corrections.
 * The coordinator makes it; a driver hands it to Pi as the submission's request id, which makes the request one.
 */
export const RequestId = Schema.String.pipe(Schema.brand("@effectified/pi-swarm/RequestId"));

/** The id of one request of a job in its fork. */
export type RequestId = typeof RequestId.Type;
