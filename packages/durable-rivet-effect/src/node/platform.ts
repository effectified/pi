// The platform services the local engine's code runs on, in Node's implementations, which Bun runs as well: what the
// `node` and `bun` entries provide, so that their functions need nothing of the caller.

import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, type FileSystem, Layer, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { EngineUnavailable } from "../errors.ts";
import * as EngineProcess from "./engine-process.ts";

/** What the local engine's code needs of the platform: its file system, its paths, and child processes. */
export type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** Node's implementations of `Services`. Those of `@effect/platform-bun` are re-exports of these. */
export const layer: Layer.Layer<Services> = NodeChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

/** `effect` on Node's implementations of the platform services, `layer`: what the entries' functions run on. */
export function provide<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Services>> {
	// @effect-diagnostics-next-line strictEffectProvide:off The `/node` and `/bun` entries are where the local engine's platform is decided, so that their functions need nothing of the caller (README, "What runs locally"); the services hold no state.
	return Effect.provide(effect, layer);
}

/** The process ids of the engines started on `directory`, by any process. See `EngineProcess.running`. */
export const running: (directory: string) => Effect.Effect<ReadonlyArray<number>, EngineUnavailable> = Effect.fn(
	"LocalEngine.running",
)(function* (directory: string) {
	return yield* provide(EngineProcess.running(directory));
});

/** Stops the engines started on `directory`, for a test or a clean-up. See `EngineProcess.stop`. */
export const stop: (directory: string) => Effect.Effect<void, EngineUnavailable> = Effect.fn("LocalEngine.stop")(
	function* (directory: string) {
		return yield* provide(EngineProcess.stop(directory));
	},
);
