# @gunta/pi-guard-effect

What an agent of a [Pi Durable](../durable) harness may do, enforced so that it fails closed. A plugin for
[`@gunta/pi-durable-effect`](../durable-effect), for `effect` 4.1:

- **Denied names.** A tool whose name the policy denies fails the construction of the registry: no harness opens.
- **An exact allow-list per conversation.** A grant names the tools a conversation may call. It is stored in the
  harness storage, the model is offered exactly those tools, and a call to any other tool is blocked.
- **Argument rules.** Your own check over the decoded arguments of a call: allow, block or rewrite.
- **Classification ceilings.** A conversation carries a label; a tool whose ceiling is below it is blocked, and a
  model can be checked against it.
- **Refusals.** Every call the guard kept from running is published as it happens and recorded in the call's
  stored result, without its arguments, so a host can count and attribute refusals after a restart.

Nothing here knows your tools, verbs or labels: all of it is data and rules you supply.

## Install

```sh
npm install @gunta/pi-guard-effect @gunta/pi-durable-effect @earendil-works/pi-durable effect
```

`effect` is a peer dependency (`~4.1.5`). Built for Pi Durable 1.6.0.

## Quick start

`Guard.layer` takes the place of `Registry.layer`. A program whose tools need a service that itself needs the guard
builds it in two parts instead: see "The guard in two parts". The examples of this README run as they stand on the
scripted model of the testing kit, and are the test [`test/readme.test.ts`](test/readme.test.ts).

```ts
import { Effect, Layer, Schema, Stream } from "effect";
import { Extension, Harness, Storage, Tool } from "@gunta/pi-durable-effect";
import { ScriptedModels, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Conversations, Guard, Matcher, Policy, Rule } from "@gunta/pi-guard-effect";

const Search = Tool.make("search", {
	description: "Search the web.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.String,
	handler: ({ query }) => Effect.succeed(`Results for ${query}`),
});
const Read = Tool.make("read", {
	description: "Read a record.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.String,
	handler: ({ id }) => Effect.succeed(`Record ${id}`),
});
const App = Extension.make({ name: "app", tools: [Search, Read] });

const policy: Policy.Policy = {
	...Policy.empty,
	// No tool may be registered under these verbs, in snake or camel case.
	denied: [Matcher.firstWord(["approve", "sign", "export", "send", "delete"])],
	classifications: ["public", "internal", "confidential"],
	// A search sends text out: only public conversations may call it.
	toolCeilings: { search: "public" },
	modelCeilings: [{ provider: "faux", modelId: "faux-1", ceiling: "internal" }],
};

// Your own rule over the decoded arguments of `search`.
const TidyQueries = Rule.make("tidy-queries", Search, ({ query }) =>
	Effect.succeed(query.length > 200 ? Rule.block("query too long") : Rule.rewrite({ query: query.trim() })),
);

const live = Harness.layer({ conversationCreated: Conversations.created }).pipe(
	// The guard's extension first, then yours: other plugins' extensions go into the same list.
	Layer.provideMerge(Guard.layer({ policy, rules: [TidyQueries], extensions: [App] })),
	Layer.provide(Storage.memory),
	Layer.provideMerge(ScriptedModels.layer()),
);

const program = Effect.gen(function* () {
	const refused: Array<string> = [];
	yield* Effect.forkScoped(
		Stream.runForEach(Guard.refusals, (refusal) => Effect.sync(() => refused.push(`${refusal.tool}: ${refusal.rule}`))),
	);
	yield* Effect.yieldNow;
	const { model } = yield* TestHarness.agent;
	// Exactly these tools, this classification and this model, stored in the creating commit.
	const conversation = yield* Conversations.create({
		ownership: { kind: "ownerless" },
		grant: { tools: ["search"], classification: "public" },
		model,
	});
	yield* conversation.prompt("Find record 42 and read it.");
	yield* conversation.waitForIdle;
	return refused; // ["read: unavailable"] when the model tried `read`
});

Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(live)));
```

## The guard in two parts

`Guard.layer` is two Layers in one:

| Layer | Provides | Requires |
|---|---|---|
| `Guard.fromPolicy(policy)` | `Guard`: the policy and the refusals, what grants and reads need | nothing |
| `Guard.registry({ rules, extensions })` | The checked `Registry` | `Guard`, and what the tools, hooks and rules need |
| `Guard.layer({ policy, rules, extensions })` | Both | What the tools, hooks and rules need, less the `Guard` |

Use the parts when a tool needs a service that needs the guard. The usual case is a port that grants a child
conversation in the commit that creates it (the `ChildSetup` of `@gunta/pi-subagent-effect`): with `Guard.layer`
alone, the port would need the `Guard` that only the registry gives, and the registry the port. With the parts
there is no cycle, and no `Deferred`:

```ts
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Tx } from "@gunta/pi-durable-effect";
import { Context } from "effect";

// A port of your own that a tool needs, and that needs the guard.
class Children extends Context.Service<
	Children,
	{ readonly created: (tx: Tx.Tx, child: ConversationId) => Effect.Effect<void, Conversations.GrantError> }
>()("app/Children") {}

const ChildrenLive = Layer.effect(
	Children,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		return {
			// In the child's creating commit: at most these tools, and never more than the child was set to.
			created: (tx, child) =>
				Conversations.grantIn(tx, child, { tools: ["read", "search"] }, { mode: "narrow" }).pipe(
					Effect.provideService(Guard.Guard, guard),
				),
		};
	}),
);

const guard = Guard.fromPolicy(policy);
const registry = Guard.registry({ rules: [TidyQueries], extensions: [App, Delegating] }).pipe(
	Layer.provide(ChildrenLive),
	// One Layer value is one guard: the port's is the one the registry was checked by.
	Layer.provideMerge(guard),
);
const composed = Harness.layer({ conversationCreated: Conversations.created }).pipe(
	Layer.provideMerge(registry),
	Layer.provide(Storage.memory),
	Layer.provideMerge(ScriptedModels.layer()),
);
```

`Delegating` is an extension whose tool requires `Children` and calls `created` in the commit that creates the
child, after it set the child's agent to what it may have at most. Give `Guard.fromPolicy(policy)` to everything as
one value: calling it twice makes two guards, and the one that built no registry refuses every grant (see
guarantee 1).

## The policy

A policy is plain data, described by the schema `Policy.Policy`, so it can come from a file. Spread `Policy.empty`
and set what you use.

| Field | Meaning | Default in `Policy.empty` |
|---|---|---|
| `denied` | Matchers: no tool they name is ever registered or run | none |
| `classifications` | The labels, lowest to highest | none: no ceiling is checked |
| `toolCeilings` | Tool name to the highest classification of a conversation that may call it | none |
| `modelCeilings` | `{ provider, modelId, ceiling }`: the highest classification a model may serve | none |
| `ungranted` | The grant of a conversation that was given none | `{ tools: [] }`: nothing |

`Guard.fromPolicy`, and so `Guard.layer`, fails with `InvalidPolicy` for a policy that contradicts itself: a ceiling
that is no classification, a label or a model listed twice, an empty name, prefix or word.

A matcher names tools in one of three ways:

| Matcher | Names |
|---|---|
| `Matcher.exact("drop_table")` | The tool with exactly this name |
| `Matcher.prefix("admin__")` | Every tool whose name starts with these characters, as they are |
| `Matcher.firstWord(["approve", "sign"])` | Every tool whose first word is one of these, in any case |
| `Matcher.anyWord(["delete"])` | Every tool with one of these words anywhere in its name |

Words are what `Matcher.words` finds: `sign_document`, `signDocument`, `sign-document` and `SignDocument` are
`sign`, `document`; `exportPDF` is `export`, `pdf`; `send2` is `send`, `2`. So `firstWord(["sign"])` denies
`sign_document` and `signDocument` and leaves `signature_lookup` alone.

What matchers cannot express: regular expressions, suffixes, and combinations (this word and that one). They know
no inflections, so list `approve`, `approves` and `approval` yourself. Two words written together with no capital
and no separator (`approveclaim`) are one word; only `prefix` catches that, and it also catches `approver_list`.
Only ASCII letters and digits make words. A matcher reads the name, never what the tool does: a tool called
`finalize` that signs is yours to keep out.

## Guarantees and their limits

**1. Denied names fail registry construction, and only a checked registry is granted on.** `Guard.registry` (and
so `Guard.layer`) checks every tool of every extension it is given against the policy of its `Guard`, and fails with
`DeniedTool` naming the tool, its extension and the matcher. A registry that passed is remembered by that guard, with
the guard's own extension as Pi holds it. The `Guard` service alone, from `Guard.fromPolicy`, protects nothing, and
says so: what each function checks, and when, is this.

| | Checks | When |
|---|---|---|
| `Guard.registry` | No tool has a denied name, no extension has the guard's name | When the Layer is built |
| `Conversations.grantIn` | The guard built a registry: else `Unguarded` (`no-registry`) | In the commit, before a write |
| `Conversations.grant` | The guard's own extension is asked first: else `Unguarded` (`not-selected`, `not-first`) | Before its commit |
| `Conversations.create` | As `grantIn`, so nothing is created; then as `grant` | In the commit, and after it |
| The guard's `beforeTool` hook | The denied names, the grant, the ceiling, the rules | Before every call |
| The backstop of every tool | The guard's own extension is the first the conversation selects | When the tool would run |

"The guard's own extension" is the object in a registry this guard built, not the name: a harness on a registry
built with `Registry.layer`, also one with an extension called `guard`, is `not-selected`.

Limits. `grantIn` cannot see which harness its commit belongs to: where one guard built a registry and a second
harness runs on an ordinary one, a `grantIn` in the second writes a grant nothing enforces (`create` and `grant`
there fail). `create` learns that the harness is on another registry only after its commit: the conversation then
exists, with its grant. A tool installed later straight into Pi's registry (`Registry.Registry` is Pi's own object)
is not checked when it is installed; the guard's hook still blocks every call to a denied name.

```ts
const Sign = Tool.make("signDocument", {
	description: "Sign a document.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.String,
	handler: () => Effect.succeed("signed"),
});
const refusedRegistry = Guard.layer({ policy, extensions: [Extension.make({ name: "office", tools: [Sign] })] });
// Building it fails: DeniedTool { tool: "signDocument", extension: "office", rule: the firstWord matcher }
```

**2. An exact allow-list, enforced twice.** A grant is stored in a document of this plugin (`guard.grant`) in the
harness storage, in the commit that creates or configures the conversation.

- First, the grant sets Pi's enabled tools (`tools` of the stored agent) to exactly its list: the model is offered
  those, and Pi resolves no other tool, for the model or for a nested call (`executeTool`). Pi answers such a call
  with its own error result, `tool_unavailable`.
- Second, the guard's `beforeTool` hook reads the grant at every call, the model's and a nested one, and blocks a
  tool outside it. This holds when `configure` changed Pi's choices behind the guard's back.
- A conversation without a grant gets the policy's `ungranted`: by default it can call nothing.
- A hook that cannot decide blocks: a grant it cannot read is a refusal (`guard-failed`).
- A grant replaces by default: the conversation gets exactly the grant's tools, more than it had or fewer. With
  `{ mode: "narrow" }` it only takes away: the conversation gets those of the grant's tools that Pi's stored agent
  enables now and, when it has a grant already, that grant lists. The stored grant is that intersection, so the
  hook agrees with the offer. `grantIn` and `grant` take the option; `create` does not, since a new conversation has
  nothing to narrow.

Why replacing is the default: `create`, and every caller written before the option, sets the tools of a
conversation that `Conversations.created` has just set to the `ungranted` ones, by default none. Narrowing from
there would grant nothing. So a grant given to a conversation that was just set to what it may have at most, such as
a subagent's child after its declaration, must ask for `"narrow"`; without it the grant's list wins, and a grant
wider than the declaration offers the child more.

Limits. Pi asks only the hooks of the extensions a conversation selects, so every tool built through the guard's
registry also carries a backstop: it refuses to run unless the guard's own extension is the first one the
conversation selects (`guard-not-first`). Of a tool's members only `execute` runs tool code behind that check; the
others are data or code Pi requires pure (`prepareArguments`) or calls only after a guarded `execute` parked
(`cancel`). A member the tool's registration sets that Pi's `ToolRegistration` does not declare is left out, so it
never runs unguarded. An extension installed later under the name `guard` replaces the guard's
hooks, and the backstop then refuses every such tool. A tool installed later straight into Pi's registry has no
backstop: in a conversation that deselects the guard, or after such a replacement, it runs unguarded. Host code is
trusted: whatever holds the `Guard` and a commit can grant. The offer is narrowed further, never widened, by Pi's
`modelTools`.

```ts
// Change the grant of an existing conversation, in one commit.
yield* Conversations.grant(conversation, { tools: ["search", "read"], classification: "public" });
// Or inside a commit of your own, for example the one that forks.
yield* Harness.commit((tx) =>
	Effect.gen(function* () {
		const fork = yield* tx.forkConversation(conversation.id, at, { ownership: { kind: "ownerless" } });
		yield* Conversations.grantIn(tx, fork.id, { tools: ["read"], classification: "public" });
	}),
);
const now = yield* Conversations.granted(conversation.id); // the grant that holds
// Take tools away and never add one: `write` is not in the grant the conversation has, so it is left out.
yield* Conversations.grant(conversation, { tools: ["read", "write"], classification: "public" }, { mode: "narrow" });
const narrowed = yield* Conversations.granted(conversation.id); // { tools: ["read"], classification: "public" }
```

**3. Argument rules.** `Rule.make(name, tool, check)` gives `check` the arguments decoded by the tool's
`parameters`, as its handler would get them, and the call (conversation, call id, whether it is nested, the grant).
It answers `Rule.allow`, `Rule.block(reason)` or `Rule.rewrite(arguments)`. Rules of one tool run in the order given;
each sees what the one before left, and Pi validates rewritten arguments again. A rule that fails, with a failure or
a defect, and arguments that do not decode, block the call. What a rule needs is a requirement of `Guard.registry`.
Limit: rules run before a call starts. When Pi runs a `replay: "safe"` tool again after a crash, it uses the
arguments it stored, which passed the rules then.

**4. Classification ceilings.** A grant carries the conversation's `classification`, one of the policy's labels.
The hook blocks a tool whose ceiling is below it (`ceiling`). A conversation without a classification is above
every ceiling. A tool without a ceiling is not limited; a model without a ceiling may serve nothing. The label is
what you set: the guard does not read the content.

For models, `Classification.checkModel(policy, model, classification)` is the pure check, with `ModelNotCleared`
as its error. The guard applies it wherever it sets a model itself: the `model` of `Conversations.create`, `grant`
and `grantIn`.

A conversation a task owns (a subagent's child, a fork a tool made) is never labelled below its owner. Content
goes from an owner to what it owns, so a child labelled lower would reach tools and models the policy keeps from
its owner. `Conversations.created` records the owner in the guard's document; every grant given to the conversation
afterwards stores the higher of its own classification and the one the owner holds in that commit, and checks the
`model` against that. No classification is above every label, so the child of an unlabelled owner is unlabelled.
The bound needs `Conversations.created` as the harness's `conversationCreated`: Pi names the owner only in the
creating commit. It compares classifications, not allow-lists: a child may be granted tools its owner does not
have. An owner's classification raised later does not reach a child granted before.

```ts
// Fails with ModelNotCleared { provider: "faux", modelId: "faux-1", classification: "confidential", ceiling: "internal" }
yield* Classification.checkModel(policy, { provider: "faux", modelId: "faux-1" }, "confidential");
```

Other parts of a product read what a conversation holds with `Conversations.granted(conversationId)`: the grant
that holds now, its tools and its classification. It is a read outside a commit and needs only the `Harness` and
the `Guard` (from `Guard.fromPolicy`: a read needs no checked registry). A router that asks the product for a
conversation's constraints is answered from it:

```ts
// What a router filters its routes by, for one conversation.
const constraintsOf = (conversationId: ConversationId) =>
	Effect.map(Conversations.granted(conversationId), (grant) => ({ classification: grant.classification }));
```

A router asks by what it sees at the model boundary, which is the conversation's provider session: the `sessionId`
of Pi's `pi.provider` document, sent as pi-ai's `sessionId` with each request. The guard keeps no index by it: the
product notes the session of a conversation where it creates the conversation, and looks the conversation up
there. An absent `classification` means above every ceiling, so answer it with your highest label or refuse the
request, never with no constraint.

Limit, stated plainly: **this package cannot stop a provider request.** In Pi Durable 1.6.0 a failing generation
hook is reported and skipped, and no hook can refuse a request. A model set with `configure`, outside the guard, is
not checked, and a classification raised later does not look at the stored model. Enforcement at request time
belongs to the model boundary: `@gunta/pi-router-effect` filters routes by classification and fails with a typed
error before a request leaves.

**5. Refusals are observable, and recorded.** Every call the guard kept from running is told twice.

- *As it happens*, on `Guard.refusals`, a Stream: the conversation, the task and call ids, the tool, the rule, and
  for an argument rule its name and reason. Never the arguments.
- *For good*, in the result of the call: the guard's `afterTool` hook writes `{ rule, name? }` under `guard` in the
  result's `details`, which Pi stores in the tool result entry. `Refused.of(entry)` reads it back as an `Option`:
  none for an entry that is no tool result, or of a call the guard did not refuse.

```ts
// In any process, also after a restart: which calls the guard refused, and by which rule.
const entries = yield* Stream.runCollect(conversation.entries({ order: "ascending" }));
const refused = yield* Effect.forEach(entries, Refused.of);
// Option.some({ rule: "unavailable" }) for the entry of the `read` the model tried, none for every other entry
```

The model reads one sentence whatever the rule, the one Pi uses for a tool it does not have: `Tool search is not
available`, as a blocked call. It is told neither the rule nor the reason, and it never reads `details`: Pi sends a
provider the content of a tool result, and no provider adapter of pi-ai sends its details.

| `rule` | The call did not run because |
|---|---|
| `denied` | The tool's name is one the policy denies |
| `allow-list` | The tool is not in the conversation's grant |
| `ceiling` | The tool's ceiling is below the conversation's classification |
| `argument` | An argument rule blocked it (`name`; on the stream also `reason`) |
| `argument-failed` | An argument rule failed (`name`) |
| `unavailable` | Pi refused it: the tool was not offered, or does not resolve |
| `guard-not-first` | The conversation does not ask the guard's extension first |
| `guard-failed` | The guard could not decide |

What the record tells apart: a result with Pi's code `blocked` and a record was blocked by the guard; one without
a record was blocked by another extension, such as a person's denial through an approval gate. The record holds the
rule and the rule's name only. The `reason` of an argument rule is your own text and stays on the stream.

What is recorded, and what is not:

- Every call the guard's `beforeTool` hook blocked, the model's and a nested one. A nested call has no entry: its
  record is in the `details` of the result the calling tool gets, read with `Refused.fromDetails(result.details)`.
- Every call Pi refused itself with `tool_unavailable` before any hook (a tool the model was not offered, or one
  that does not resolve, also when a parked call wakes), as `unavailable`: Pi passes those results through
  `afterTool` too. This says that Pi refused, not why: a tool outside the grant and a name the model made up look
  the same.
- Every call a tool's backstop refused, as `guard-not-first`, written by the tool itself, since the guard's hooks are
  not asked where its extension is not selected.
- Not recorded: a call whose result Pi settles without asking the hooks (a task cut off more often than the
  harness's restart limit, the last attempt of an abort); an `unavailable` call in a conversation that does not
  select the guard's extension; a result whose details are no object; and a record a later extension's `afterTool`
  hook drops by replacing `details`. A failing `afterTool` hook is reported by Pi and skipped, so the record is
  then missing while the call stays blocked.

Limits of the stream: refusals are published in memory, to the subscribers running at that moment. A process that
stops loses what nobody took, and Pi asks a hook again after a crash, so a call can be published twice across a
restart (`taskId` and `callId` identify it); the record is written once, with the result. Keep the arguments'
content out of the `reason` of a rule: it is published as you wrote it.

**6. The guard is asked first.** `Guard.registry` installs the guard's extension before yours, so its hooks run before
those of approvals and budgets: nobody is asked to approve a call the agent may not make. A conversation that
selects extensions itself (`configure({ extensions })`) must list `Guard.EXTENSION` first. The wrong order is
detected twice: `Conversations.create`, `Conversations.grant` and `Conversations.guarded` fail with `Unguarded`
(`not-selected` or `not-first`), and the backstop refuses the call.

## What a fork and a child conversation inherit

- **A fork** starts with the grant its parent has when the fork is committed, list, classification and recorded
  owner, whatever entry it forks at. Pi copies its own stored agent as of the fork's entry, which may offer tools
  the parent has lost since; the guard's document copies the current value, so a tool taken from the parent is not
  given back. Afterwards the fork's grant is its own. To narrow it, call `Conversations.grantIn` in the forking
  commit.
- **A task-owned child conversation** (a subagent) inherits no grant. Pi copies its owner's stored agent, so it would
  be offered its owner's tools; the guard has no grant for it, so it gets the policy's `ungranted`: by default it
  can call nothing. Its creator grants in the creating commit (`Conversations.grantIn(tx, child.id, grant)`), which
  a tool handler can do because the guard's registry gives the tools the `Guard`, and a port of the product because
  `Guard.fromPolicy` gives it the same one. With `{ mode: "narrow" }` the grant never offers the child more than its
  creator set it to. The guard does not compare the grant's tools with the owner's: the creator is your code. It
  does bound the classification by the owner's (guarantee 4).
- **`Conversations.created`**, given to `Harness.layer` as `conversationCreated`, makes Pi's offer match in every
  creating commit, whoever makes it: a fork is offered its inherited grant, any other new conversation the
  `ungranted` tools. It also records the owner of a task-owned conversation, and raises a task-owned fork's
  inherited classification to its owner's. Without it the guard still blocks every call outside the grant; the
  model is only offered tools it cannot call, and no classification is bounded by an owner's.

## License

MIT
