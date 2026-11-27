# @effectified/pi-agent

Pi's agent loop ([`@earendil-works/pi-agent-core`](../agent)) in Effect terms, for `effect` 4.1: the non-durable
agent, for short-lived uses.

- An agent as a scoped handle: running a prompt is an `Effect`, its events are a `Stream`.
- Tools whose handlers are Effects, with `Schema` parameters and results.
- The hooks (`beforeToolCall`, `finishTurn`, `transformContext`, ...) as Effects.
- The low-level loop and `runToolCall` as Streams and Effects.
- Interrupting a fiber aborts the run.

It adds no behaviour of its own: what pi-agent-core does is what happens. Built for pi-agent-core 1.6.1. For an agent
whose state survives a restart, use [`@effectified/pi-durable`](../durable-effect/README.md).

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.2.0
npm install --allow-remote=all $R/effectified-pi-agent-0.2.0.tgz $R/effectified-pi-ai-0.2.0.tgz $R/effectified-pi-schema-0.2.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Quick start

```ts
import { Context, Effect, Layer, Schema } from "effect";
import { Agent, StreamFn, Tool } from "@effectified/pi-agent";
import { fauxAssistantMessage, fauxToolCall, ScriptedModels } from "@effectified/pi-ai/testing";

// A service of your program. Tool handlers reach it through the Layer you provide.
class Records extends Context.Service<
	Records,
	{ readonly get: (id: string) => Effect.Effect<{ readonly title: string }> }
>()("app/Records") {}

const Lookup = Tool.make("lookup", {
	label: "Lookup",
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	handler: ({ id }) => Records.use((records) => records.get(id)), // Effect<{ title }, never, Records>
});

const program = Effect.gen(function* () {
	// No provider and no key: the model answers with these turns, in order.
	const models = yield* ScriptedModels;
	yield* models.setResponses([
		fauxAssistantMessage([fauxToolCall("lookup", { id: "42" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Record 42 is titled Answer."),
	]);
	const agent = yield* Agent.make({
		initialState: { systemPrompt: "You look records up.", model: models.model, tools: [Lookup] },
	});
	yield* agent.prompt("What is record 42 called?");
	const { messages } = yield* agent.state;
	return messages.map((message) => message.role); // ["system", "user", "assistant", "toolResult", "assistant"]
});

const live = Layer.mergeAll(
	// Requests go to the providers of `Models`; here, the scripted one.
	Layer.provideMerge(StreamFn.models, ScriptedModels.layer()),
	Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) }),
);

Effect.runPromise(Effect.scoped(Effect.provide(program, live)));
```

An agent lives in a scope: closing it aborts a run that is still going and waits for it to settle. `Agent.make` builds
the tools' JSON Schemas, and fails with `SchemaConversionError` if one cannot be built.

With a real provider, provide `StreamFn.models` with `Models.layer([...])` of `@effectified/pi-ai` and the provider's
constructor ([pi-ai's `Models`](../ai-effect/README.md#models)) instead of `ScriptedModels.layer()`.

## Tools

`Tool.make` takes Effect schemas. Pi validates a call's arguments against the JSON Schema of `parameters`; the
handler gets them decoded (a `Date` is a `Date`). The model reads the result as text: a string as it is, anything else
as JSON.

```ts
const Search = Tool.make("search", {
	label: "Search",
	description: "Search the records.",
	parameters: Schema.Struct({ query: Schema.String, since: Schema.optional(Schema.Date) }),
	success: Schema.Array(Schema.String),
	handler: ({ query }, api) =>
		Effect.gen(function* () {
			// Progress: Pi emits it as a tool_execution_update event.
			yield* api.update({ content: [{ type: "text", text: `searching ${query}` }], details: undefined });
			if (query === "") return Tool.error("An empty query finds nothing."); // the model reads an error result
			return Tool.result([`${query}-1`, `${query}-2`], { details: { hits: 2 } }); // details for a UI
		}),
});
```

- A tool's name is a `ToolName` (`Lookup.name`), and the handler gets the call's id as a `ToolCallId`
  (`api.toolCallId`): branded strings, so the one is never passed for the other. `ToolName.make("lookup")` brands a
  name you hold.
- A handler's failure becomes Pi's error result, with the failure's message; the run goes on. The tool rejects Pi's
  call with `ToolFailed`, whose `cause` is the failure.
- `structured: true` declares the JSON Schema of `success` as Pi's `outputSchema` and passes the value as
  `structuredContent`.
- `executionMode`, `replay`, `prepareArguments` and `constrainedSampling` are Pi's own, passed on unchanged.
- Pi aborting a call (an interrupted run) interrupts the handler.
- Each call has a span, `Tool.execute`, and so does each call of a hook (`Hooks.beforeToolCall`, ...).
- The JSON Schemas are built once per tool and shared by every agent and loop given it.

## Events

`agent.stream(input)` is the events of one run, from `agent_start` to `agent_end`. Ending the Stream early aborts the
run. Pi awaits each event it emits, so the Stream applies back-pressure: when its consumer is 16 events behind, the
run waits. `agent.subscribe` gives every event of every run until its scope closes, in an unbounded buffer: a run
never waits for a subscriber that reads later.

```ts
import { Stream } from "effect";

const replies = Effect.gen(function* () {
	const agent = yield* Agent.make({ initialState: { model: (yield* ScriptedModels).model } });
	const deltas = agent.stream("Say hello.").pipe(
		Stream.filter((event) => event.type === "message_update"),
		Stream.map((event) => event.assistantMessageEvent),
		Stream.filter((update) => update.type === "text_delta"),
		Stream.map((update) => update.delta),
	);
	return (yield* Stream.runCollect(deltas)).join("");
});
```

`AgentEvents.messages` is the Sink of what a run added (the messages of its `agent_end`), for a stream a consumer
also reads:

```ts
import { AgentEvents } from "@effectified/pi-agent";

const shown = Effect.gen(function* () {
	const agent = yield* Agent.make({ initialState: { model: (yield* ScriptedModels).model } });
	return yield* agent.stream("Say hello.").pipe(
		Stream.tap((event) => (event.type === "message_end" ? Effect.log(event.message.role) : Effect.void)),
		Stream.run(AgentEvents.messages),
	);
});
```

## Interruption

Interrupting the fiber that waits for a run aborts the run: the model request is aborted, running tool handlers are
interrupted, and the interruption is done once the agent is idle. The transcript then ends in an assistant message
with stop reason `aborted`.

```ts
const bounded = Effect.gen(function* () {
	const agent = yield* Agent.make({ initialState: { model: (yield* ScriptedModels).model } });
	const answered = yield* agent.prompt("Take your time.").pipe(Effect.timeout("30 seconds"), Effect.option);
	return { answered, state: yield* agent.state };
});
```

`agent.abort` aborts the current run without waiting; `agent.waitForIdle` waits for it.

## Hooks

Pi's hooks are Effects that run with the services of the context `Agent.make` runs in. An aborted run interrupts the
hook that runs. A hook cannot fail: Pi's contract is that hooks do not throw.

```ts
const guarded = Agent.make({
	initialState: { tools: [Lookup] },
	// Asked before a tool runs, with validated arguments: a blocked call becomes Pi's error result.
	beforeToolCall: ({ toolCall }) =>
		Effect.succeed(toolCall.name.startsWith("delete") ? { block: true, reason: "read only" } : undefined),
	// Asked after each turn: end the run after the first one.
	finishTurn: () => Effect.succeed({ action: "end" as const }),
});
```

The hooks are `convertToLlm`, `transformContext`, `getApiKey`, `beforeToolCall`, `afterToolCall`, `finishTurn`,
`prepareRequest`, `prepareNextTurn` (which gets the turn's context), `onPayload`, `onResponse` and
`onProviderStreamEvent`.

## The agent's handle

| Pi's `Agent` | `Agent.make`'s handle |
|---|---|
| `prompt(...)`, `continue()` | `prompt(...)`, `continue`: Effects that end with the run |
| `subscribe(listener)` | `subscribe` (a scoped Stream), `stream(input)` |
| `state`, assigning `state.model` and the others | `state` (a snapshot), `setModel`, `setThinkingLevel`, `setTools`, `setMessages` |
| `steer`, `followUp`, the queue methods and modes | the same names, as Effects; `setSteeringMode`, `setFollowUpMode` |
| `abort()`, `waitForIdle()`, `reset()` | `abort`, `waitForIdle`, `reset` |
| `signal` | none: interrupting the fiber aborts the run |

`prompt` and `continue` fail with `AgentBusy` while another run is going (as does `reset`), and `continue` with
`CannotContinue` when there is nothing to continue from. A failed model response is no failure of the Effect: Pi
ends the run normally, with that message in the transcript.

## The low-level loop

`AgentLoop` runs Pi's loop over a context you hold: `stream` and `streamContinue` give the events (with the
back-pressure of `agent.stream`), `run` and `runContinue` the messages the run added. `convertToLlm` is required, as
in Pi. The run's tools and hooks are traced under the Stream's span.

```ts
import { AgentLoop } from "@effectified/pi-agent";
import type { Message } from "@effectified/pi-ai";

const added = Effect.gen(function* () {
	const model = (yield* ScriptedModels).model;
	const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "Hi." }], timestamp: 0 };
	return yield* AgentLoop.run([prompt], { messages: [], tools: [Lookup] }, {
		model,
		// What a model takes: Pi's own messages, not those an app adds (coding-agent's, say).
		convertToLlm: (messages) =>
			Effect.succeed(messages.filter((message): message is Message => ["system", "user", "assistant", "toolResult"].includes(message.role))),
		getSteeringMessages: Effect.succeed([]),
	});
});
```

`runToolCall` runs one tool call through the steps of a model's (argument preparation, validation,
`beforeToolCall`, execution, `afterToolCall`), for tools that call other tools.

## Where requests go

`StreamFn` is the stream function the agents and loops of the program send their model requests through: Pi's own
`StreamFn`, as a service instead of Pi's process-wide default.

- `StreamFn.models` sends them to the providers of `Models` (`@effectified/pi-ai`).
- `StreamFn.proxy({ proxyUrl, authToken })` sends them to a server that calls the providers (Pi's `streamProxy`);
  `authToken` is an Effect asked again for each request.

```ts
const proxied = StreamFn.proxy({
	proxyUrl: "https://genai.example.com",
	authToken: Effect.succeed("token"), // or an Effect that refreshes it
});
```

## Not wrapped yet

- Pi's agent settings after `make` (`sessionId`, `transport`, `thinkingBudgets`, `toolExecution`, `identity`,
  `maxRetryDelayMs`) and its hooks: `make` sets them once.
- Timestamps of the messages Pi builds itself (tool results, tool-change system messages) come from Pi's
  `Date.now()`, not from `Clock`; only a text prompt is stamped with `Clock`.

## License

MIT
