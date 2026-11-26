// Pi's execution environments in Effect: any environment's files and commands as Effects and Streams, its watcher
// and readers as scoped resources, and one closed union of tagged errors. Connections, processes, terminals, SSH and
// the local and remote environments are in `@effectified/pi-env/node`.

export type * from "@earendil-works/pi-env";
// Every type pi-env declares (`SshTarget`, `RemoteInfo`, `RemotePlatform`, ...), and every type of the environment
// interface it implements (`FileInfo`, `WatchTarget`, `ShellExecResult`, ...), which `@effectified/pi-durable/env`
// offers, so an application names them without importing Pi; where this package exports a name of its own, its own
// wins.
export type * from "@effectified/pi-durable/env";
export * as Env from "./env.ts";
export {
	type EnvError,
	EXECUTION_ERROR_CODES,
	ExecFailed,
	FILE_ERROR_CODES,
	FileFailed,
	HostKeyChanged,
	HostKeyUnknown,
	RemoteFailed,
	type SshError,
	SshFailed,
	UnexpectedError,
} from "./errors.ts";
export type { Command, ExecEvent, ExecOptions } from "./exec.ts";
export type { BinaryReader } from "./readers.ts";
export type { WatchChange, Watcher } from "./watcher.ts";
