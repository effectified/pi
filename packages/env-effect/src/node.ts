// The Node entry: pi-env's daemon connections, processes, terminals, SSH and environments, which start programs
// with Node's child processes (Bun runs them too).

// Pure functions of pi-env, as they are: Node's names of a daemon's system, and the daemon this package ships for one.
export { nodePlatform, packagedDaemon } from "@earendil-works/pi-env";
export * as Connection from "./node/connection.ts";
export * as HostKey from "./node/host-key.ts";
export * as Local from "./node/local.ts";
export * as Process from "./node/process.ts";
export * as Remote from "./node/remote.ts";
export * as RemoteWatch from "./node/remote-watch.ts";
export * as Ssh from "./node/ssh.ts";
export * as Terminal from "./node/terminal.ts";
