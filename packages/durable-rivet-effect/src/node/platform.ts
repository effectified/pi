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

/** The process ids of the engines started on `directory`, by any process. See `EngineProcess.running`. */
export function running(directory: string): Effect.Effect<ReadonlyArray<number>, EngineUnavailable> {
	return Effect.provide(EngineProcess.running(directory), layer);
}

/** Stops the engines started on `directory`, for a test or a clean-up. See `EngineProcess.stop`. */
export function stop(directory: string): Effect.Effect<void, EngineUnavailable> {
	return Effect.provide(EngineProcess.stop(directory), layer);
}
