# @effectified/pi-env

[`@earendil-works/pi-env`](../env/README.md) in Effect terms: Pi's execution environments, local and remote, with
the pi-env daemon, SSH, processes and terminals. For `effect` 4.1.

- **An environment in Effect terms.** Any Pi `ExecutionEnv` (local, remote over pi-env, or one of your own) as an
  `Env`: file operations and commands are Effects; command output, file lines and directory entries are Streams;
  readers and watchers are scoped resources.
- **Local and remote environments.** `Local.make` and `Remote.make` give an `Env` whose running commands are killed
  when its scope closes; `Local.layer` and `Remote.layer` give `Env.Current`.
- **Connections, processes and terminals are scoped.** A daemon connection stops its daemon with its scope, which
  kills everything it started; a process or a terminal is killed with its scope. Their output is a Stream.
- **Interruption cancels.** Interrupting a fiber aborts Pi's call through its `AbortSignal` and waits until Pi settled
  it: a command's processes are killed, a daemon request is cancelled.
- **One closed union of tagged errors.** `FileFailed`, `ExecFailed`, `RemoteFailed`, `HostKeyUnknown`,
  `HostKeyChanged`, `SshFailed` and `UnexpectedError` (`EnvError`); the SSH and host-key ones are `SshError`.

The root (`@effectified/pi-env`) is the environment in Effect terms and the errors. The environment contract itself
(`ExecutionEnv`, its results, `FileFailed` and `ExecFailed`) is Pi Durable's, which
[`@effectified/pi-durable/env`](../durable-effect/README.md#subpaths) offers; this package re-exports it. pi-env starts programs with Node's
child processes (Bun runs them too), so its connections, processes, terminals, SSH and environments are in
`@effectified/pi-env/node`.

## Installation

```bash
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-env-0.1.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`). Built for pi-env 1.6.1, which ships the daemon for Linux, macOS, Android
(Termux) and Windows on x86-64 and arm64. The examples below are the test
[`test/readme.test.ts`](test/readme.test.ts); those that start the daemon run against a daemon built from
`packages/env`, and the SSH ones through a stand-in for `ssh` that runs on the same machine.

## A local environment

`Local.make` is Pi Durable's Node environment with `listFiles` through a daemon on the same machine. The daemon
starts only when something needs it.

```typescript
import { Effect, Stream } from "effect";
import { Connection, Local, Ssh } from "@effectified/pi-env/node";

const local = (cwd: string) =>
	Effect.gen(function* () {
		// This machine's daemon, for `listFiles`; several environments may share the connection.
		const connection = yield* Connection.make({ command: [yield* Ssh.local] });
		const env = yield* Local.make({ cwd, connection });

		yield* env.writeFile("notes/today.txt", "one\ntwo\n");
		// A non-zero exit code is a result, not a failure.
		const { exitCode } = yield* env.exec("grep -q three notes/today.txt");
		// The output as it arrives, then the exit.
		const output = yield* Stream.runCollect(env.execOutput(["cat", "notes/today.txt"]));
		const lines = yield* Stream.runCollect(env.textLines("notes/today.txt"));
		return { exitCode, output, lines };
	});

// Closing the scope kills the commands the environment still runs, and stops the daemon.
const result = await Effect.runPromise(Effect.scoped(local("/home/me/project")));
// result.exitCode: 1
// result.output: [{ kind: "output", text: "one\ntwo\n", stream: "stdout" }, { kind: "exited", exitCode: 0 }]
// result.lines: [{ text: "one", terminated: true }, { text: "two", terminated: true }]
```

An `Env` gives Pi's own environment as `env.pi`, for what takes one as it is, such as a harness of
[`@effectified/pi-durable`](../durable-effect/README.md) (`Harness.layer({ env: env.pi })`). `Env.fromPi` puts any
Pi environment in Effect terms, the one a tool receives from Pi included; it stays the caller's to clean up.

## Interruption and failures

Interrupting a fiber kills its command; a failure is a tagged error.

```typescript
import { Effect, Fiber } from "effect";
import { Connection, Local } from "@effectified/pi-env/node";

const interrupted = (cwd: string, daemon: string) =>
	Effect.gen(function* () {
		const connection = yield* Connection.make({ command: [daemon] });
		const env = yield* Local.make({ cwd, connection });

		const sleeping = yield* Effect.forkChild(env.exec("sleep 30"), { startImmediately: true });
		// Returns once the command's processes are gone.
		yield* Fiber.interrupt(sleeping);

		const missing = yield* env.readTextFile("missing.txt").pipe(
			Effect.catchTag("FileFailed", (error) => Effect.succeed(`${error.code}: ${error.path}`)),
		);
		const listing = yield* env.listFiles(".", { exclude: ["node_modules"] });
		return { missing, entries: listing.entries.length };
	});
```

## Processes and terminals

`Process.open` runs a program with plain pipes in a daemon, for programs that speak a protocol on stdin and stdout
(an MCP server, a language server). `Terminal.open` runs one in a pseudo-terminal. Both are killed when their scope
closes; their output is kept until it is read.

```typescript
import { Effect, Stream } from "effect";
import { Connection, Process, Terminal } from "@effectified/pi-env/node";

const programs = (cwd: string, daemon: string) =>
	Effect.gen(function* () {
		const connection = yield* Connection.make({ command: [daemon] });

		const server = yield* Process.open(connection, { cwd, argv: ["sh", "-c", 'read request; echo "answer to $request"'] });
		yield* server.write("ping\n");
		const answer = yield* server.stdout.pipe(Stream.decodeText(), Stream.mkString);

		const terminal = yield* Terminal.open(connection, { cwd, argv: ["sh", "-c", "stty size"], cols: 100, rows: 30 });
		const screen = yield* terminal.output.pipe(Stream.decodeText(), Stream.mkString);
		return { answer, exitCode: yield* server.exited, screen, terminalExit: yield* terminal.exited };
	});
// { answer: "answer to ping\n", exitCode: 0, screen: "30 100\r\n", terminalExit: 0 }
```

## Watching files

`env.watch` establishes coverage before it returns: a change made after it is in `changes`. A watcher in a daemon
(`RemoteWatch.open`, or `watch` of a remote environment) reports `overflow` after a lost connection came back.

```typescript
import { Effect, Stream } from "effect";
import { Connection, Local } from "@effectified/pi-env/node";

const watching = (cwd: string, daemon: string) =>
	Effect.gen(function* () {
		const connection = yield* Connection.make({ command: [daemon] });
		const env = yield* Local.make({ cwd, connection });
		const watcher = yield* env.watch([{ path: ".", recursive: true }]);
		yield* env.writeFile("changed.txt", "x");
		// `paths` changes until the scope closes; Pi's `failed` change fails the stream.
		return yield* Stream.runHead(watcher.changes);
	});
```

## A remote machine over SSH

The host's key is trusted once, after its owner compared the fingerprint out of band. A changed key fails with
`HostKeyChanged` and is never accepted on its own: `HostKey.forget` the old key once the owner confirmed the new one.
`Ssh.connect` detects the remote system, deploys the daemon (named by its SHA-256 and verified before every start),
and gives a connection; `Remote.make` is an environment on that machine. `Ssh.lazy` connects on the first request
instead.

```typescript
import { Effect } from "effect";
import { HostKey, Remote, Ssh } from "@effectified/pi-env/node";

const trust = (target: Ssh.ConnectOptions) =>
	Effect.gen(function* () {
		const { lines, fingerprints } = yield* HostKey.scan(target);
		// Show `fingerprints` to the owner; accept only what they confirmed.
		yield* HostKey.accept(target, lines);
		return fingerprints;
	});

const remote = (target: Ssh.ConnectOptions, cwd: string) =>
	Effect.gen(function* () {
		const { connection, remote } = yield* Ssh.connect(target);
		const env = yield* Remote.make({ connection, id: `pi-env:${target.hostKeyAlias}`, cwd });
		const { exitCode } = yield* env.exec("test -d .");
		return { platform: remote.platform, exitCode };
	});
```

`target` is pi-env's `SshTarget`: `host`, `knownHostsFile` (the application's own) and `hostKeyAlias` (the name its
keys are stored under), and optionally `user`, `port`, `identityFile`, `configFile`, the `ssh` program, the daemon
`binary` to deploy and `loginShell`. `ssh` runs in batch mode with strict host keys, no forwarding of any kind and no
shared connections (`Ssh.args` gives its arguments).

## Guarantees and their limits

- Interrupting a file operation, a command or a daemon request aborts Pi's call and waits until Pi settled it.
- Pi's SSH functions (`Ssh.detect`, `Ssh.deploy`, `Ssh.connect`, `HostKey.scan`) take no `AbortSignal`: interrupting
  stops waiting at once, and the `ssh` run ends on its own, within pi-env's timeouts (60 s, 300 s for an upload).
- Output of a process, a terminal or a watcher is buffered until read, without a bound: read it, or close its scope.
- A connection's `logs` delivers what the daemon writes from when the stream runs; earlier lines are dropped.
- Operations run under the Chord context that `ChordContext.scoped()` of
  [`@effectified/pi-chord`](../chord-effect/README.md#telemetry-and-values) makes for the calling fiber, with the
  fiber's cancellation: when the program provides `PiTelemetry`, the spans Pi starts for an operation are children of the
  Effect span that runs it. Closing a reader, stopping a watcher and `cleanup` run under Chord's background context,
  outside any caller's cancellation.
- Not covered by the default tests: a real remote machine. Set `PI_ENV_SSH_HOST` (and `PI_ENV_SSH_USER`,
  `PI_ENV_SSH_PORT`, `PI_ENV_SSH_KEY`, `PI_ENV_SSH_PROGRAM` as for pi-env's own test) to run one over SSH.
