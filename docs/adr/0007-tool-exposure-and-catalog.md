# Tool exposure and catalog

Status: accepted.

Every tool a model can call directly is declared to the provider on every request. Hosts with many
tools (owner-added MCP servers list 40 to 100+ each) pay that context on every step, so they cap
tool counts and lose tools. Code mode ([ADR 0002](0002-code-mode.md)) moves tools into scripts,
but three gaps remain:

1. **Approval-gated tools must stay declared.** They are fail-closed in scripts and staging
   ([ADR 0005](0005-staged-tool-plans.md)) needs them `all`, so every gated tool costs context.
2. **No middle ground between always declared and script-only.** A tool is either in every request
   or only reachable from scripts; a one-off direct call (with its one-click approval) of a rarely
   used tool means declaring it forever.
3. **The catalog lives in the `codemode` tool description.** Tool definitions are the start of
   every request, so any listed change (a server connects, a listing changes) rewrites the cached
   prefix. Search-only tools avoid that by never being listed, which also hides which namespaces
   exist: hosts add their own prompt sections to say what to search for.

This ADR separates **who may call a tool** from **when the model sees it**, lets scripts find and
stage gated tools, and moves the catalog into append-only instructions. State of the art it follows:
Cloudflare Code Mode and `McpConnector`, Anthropic code execution with MCP and Tool Search
(`defer_loading`), Pi 1.0 exposure (`direct`/`deferred`/`codemode`/`hidden`), and OpenCode v2's
catalog instructions (which append deltas; Yolk appends whole catalogs, see Compaction).

## Terms

- **Caller axis** (`callableBy`, unchanged): `model`, `codemode`, or `all`.
- **Loading axis** (`loading`, new): `eager` (declared on every request, the default) or `deferred`
  (declared only once activated).
- **Activation**: a deferred tool becomes declared after a `tool_search` result in the transcript
  names it. It stays declared for the rest of that conversation branch.
- **Stage-only tool**: a stageable approval-gated tool with `callableBy: 'codemode'`; scripts find
  it and can only `stage()` it.
- **Catalog instructions**: the code mode catalog delivered as an instruction message, not in the
  `codemode` tool description; a change appends the whole new catalog.

## Decision summary

| Area             | Decision                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exposure model   | Two orthogonal axes: `callableBy` (who) and `loading` (when). `hidden` stays host-side (not resolved).                                                                                            |
| Deferred loading | `ToolDef.loading: 'deferred'`; the package `tool_search` tool activates matches; activation is derived from the transcript, so it is deterministic across steps, redeliveries and hosts.          |
| Gated tools      | `deferred` is valid with approval: direct calls keep their one-click approval once activated.                                                                                                     |
| Stage-only       | `callableBy: 'codemode'` is valid on stageable approval tools; scripts find them by search and only `stage()` them.                                                                               |
| Catalog          | The `codemode` description is invariant. The catalog is an instruction message: every namespace always listed (name, count, description), signatures within a budget, pinned tools always listed. |
| Catalog changes  | Appended as a new, complete instruction message; earlier messages and tool definitions never change.                                                                                              |
| Fail-closed      | Unchanged: approval tools never run from scripts. Deferral saves context, not authority: an allowed deferred tool runs when called by name.                                                       |
| Provider-native  | Optional later: Anthropic `defer_loading` + tool search and `cache_control` breakpoints map to the same model.                                                                                    |

## 1. Two axes

`callableBy` keeps its meaning. `loading` applies to model-callable tools (`all`, `model`):

| `callableBy` | `loading: eager`                      | `loading: deferred`                                     |
| ------------ | ------------------------------------- | ------------------------------------------------------- |
| `model`      | declared every request                | declared after activation                               |
| `all`        | declared, and callable from scripts   | declared after activation, callable from scripts always |
| `codemode`   | never declared (`loading` is invalid) | invalid                                                 |

Resolution errors: `loading` on `codemode` tools (`invalid_tool_exposure`); `deferred` on loop-owned
tools (`question`, `subagent`), interaction, input, plan review, nested-access and background tools
(`background: true` whether or not a background host is configured), and on `tool_search` itself
(`deferred_unsupported_tool`). Approval-gated tools may be `deferred`.

Hosts map their own settings onto the axes, for example Pi-style `direct` = `all`+`eager`,
`deferred` = `all`+`deferred`, `codemode` = `codemode`, `hidden` = not resolved.

## 2. Deferred loading

**`tool_search`** is a package tool (`makeToolSearchTool`, `access: 'read'`, `callableBy:
'model'`) that `resolveTools` adds when at least one model-callable tool is deferred, unless the
host passes `toolSearch: false` or registers its own `tool_search`. Input `{ query, limit? }`; it
ranks deferred tools (name, description, module description) with the same BM25 as code mode
search (`rankToolSearchDocuments` in `@yolk-sdk/agent/tools`, shared by both packages) and returns
names, descriptions and `structuredContent.toolSearch: { activated: string[] }`.

**Activation is derived, never stored.** Before each model request the loop computes the declared
set from `config.tools` and the request messages:

```
declared = eager model-callable tools
         ∪ deferred tools named in any tool_search result of the transcript (still resolved, still deferred)
```

The tool list therefore stops being static per run: `makeLlmStream` calls
`declaredToolDefs(config.tools, messages)` instead of `providerToolDefs(config.tools)`. Durable
hosts need nothing extra: a redelivered step reads the same transcript and declares the same tools.

**Calls.** Deferral saves context; it is not an authority boundary. A deferred tool is a resolved,
allowed tool, so a call to it by name runs like any call (the durable tool-batch step has no
transcript to check activation against). Approval-gated deferred tools prompt as always.

**Activation source.** A tool result counts only when it answers a `tool_search` call of the
assistant message it follows (providers may reuse call ids across turns, so ids are matched
against the latest assistant message only). Activation is read from the host's full transcript
(`input.currentMessages`, before any `ContextTransformer`), so compacting a request never unloads
a tool. A host that rewrites its persisted history loses activations; the model searches again
(fail-safe).

**Code mode.** A deferred `all` tool's declaration is not in model context until activated, so
code mode treats it like a `search` tool: never listed, found with `searchTools`.

**Cache.** Tool definitions start every request, so an activation invalidates the cached prefix
once: with prompt caching ([ADR 0008](0008-prompt-caching.md)) the whole conversation is re-read at
full price on that request, then cached again. Script calls never touch definitions, so bulk and
exploratory work belongs in scripts; direct activation pays off for tools the model calls
repeatedly. Anthropic's native tool search (section 5) inserts definitions in place and removes
the miss.

## 3. Stage-only approval tools

- `resolveTools` accepts `callableBy: 'codemode'` (with `discovery`) on approval tools that pass the
  staging rules (`isToolStageable`, `validate`, no input, interaction, plan review, nested access or
  background). Every other `codemode` + approval combination stays `codemode_unsupported_tool`.
  `isCodeModeFailClosed` is unchanged, so they are never in `nestedRegistrations` and
  `tools.<name>()` stays fail-closed.
- Code mode adds every stageable tool to its catalog marked `stage` (stageable tools are
  approval-gated, so scripts can only stage them whatever their `callableBy`; `all` ones,
  deferred or not, are found the same way): `searchTools` hits carry `stageOnly: true` and the
  `stage("<name>", args)` signature, and
  `describeTool` renders `stage("<name>", args: …)`. They have no callable `tools` binding: the
  executor gets them as `unbound` keys (identifier and raw name), so `tools.<id>(args)` rejects with
  "`<name>` is approval-gated: record it with `stage("<name>", args)` instead of calling it".
- `stage()` accepts the catalog identifier or the raw name. `not_stageable` names close matches and
  points to `searchTools`, not every stageable tool.
- `ALL_TOOLS` lists callable tools only, so it excludes stageable tools; `searchTools` and
  `describeNamespace` include them, marked `stageOnly`. `describeTool` matches a stageable tool's
  exact name before callable identifiers, so a callable sharing its identifier never answers for it.
- The Stageable section names stageable tools except `search` and deferred ones: `pinned` ones
  always, the others up to a cap of 20 with a count of the rest.
- Plan apply is unchanged: the plan executor uses `executeRegistration` over the stageable
  registrations, not the model-facing `execute` that drops codemode-only tools. Ledger keys, fences
  and previews are as in ADR 0005.
- Without staging (no plans, host or review tool) a stage-only tool is unreachable; resolution warns,
  as for codemode-only tools without code mode.

## 4. Catalog instructions

**The `codemode` description becomes invariant**: intro, globals, the `stage()` line whenever
staging is offered (plans, an interaction host and a review tool, even before any stageable tool
resolves), and a pointer to the catalog. Nothing in it depends on tools.

**Catalog summary** (`summarizeCodeModeCatalog`, pure):

- every namespace with nested tools: ``- `<namespace>` (<n> tools[, <k> listed | none listed]): <description>``;
- full signatures of `listed` and `pinned` tools, filled round-robin across namespaces, cheapest
  first, within the inline budget (`defaultCodeModeInlineBudget`, host-configurable); `pinned`
  tools are always shown, outside the budget; `search` tools never are;
- stageable tools counted in their namespace and named in the Stageable section unless `search` or
  deferred (as above).

`ToolDiscovery` gains `pinned` (`listed` = shown when the budget allows, `search` = never shown,
`pinned` = always shown), valid only with `callableBy: 'codemode'` like the others.

**Instruction messages.** A user-role `UserMessage` with an `instruction: { key, state? }`
envelope field (`MessageInstruction`): `state` is the JSON state it rendered (any JSON, `null`
included) and is never model-visible (only `content` is); a message without `state` records a
removal. No new message kind, so providers, persistence and host decoders need no change.
`isInstructionMessage` identifies them, `latestInstructionState` reads the last state of a key, and
`latestInstructionMessages` the last message of each key still holding a state.

**UIs.** The React chat projection never shows instruction messages as user messages; it keeps
them on the previous chat message (`instructionsAfter`), and `toAgentMessages` emits them back in
place, so a transcript rebuilt from chat messages keeps them.

**Compaction.** The loop compares with the uncompacted transcript, so a summary that folded an
instruction away would leave the model without it and never re-append it. Window compaction
(`applyCompactionPlan`) keeps the latest instruction message of each key verbatim after its
summary. Hosts with their own compaction must do the same (`latestInstructionMessages`). Because
only the latest message of a key survives, every instruction message must be self-contained: a
delta would leave the model with the change but without the rest. `render` therefore never sees
the previous state, which makes a delta unrepresentable rather than a rule to remember; a changed
catalog costs one full render (bounded by the inline budget), still appended after the cached
prefix.

**Delivery.** `RunInstruction` is `{ key, state, render(current) }`. Before each model request the
loop compares `state` with the latest recorded state of the key (canonical JSON): equal appends
nothing; different appends one instruction message (the full render, or a removal notice once).
States compare as JSON values independent of object key order (`interactionJsonEquals`). `run()` does it for `RunConfig.instructions` and returns
the messages with its created messages; it never emits a `UserMessage` event (not user input).
Durable hosts driving `runModelTurn` own their transcript: they append
`instructionMessages(transcript, instructions)` themselves and persist them before the model step.
`runModelTurn` does not accept `instructions` (`ModelTurnConfig`): a single step cannot report
messages it appended, so they would be re-appended, unpersisted, on every step.

**Registry.** A nested-access registration may declare `instruct` (like `describe`);
`ResolvedToolSet.instructions` collects them for `RunConfig.instructions`. `instruct` without
`nestedToolAccess` is `invalid_tool_exposure`; two instructions with one key are
`duplicate_instruction` (each would find the other's message and append every turn).

A host that cannot append messages to its persisted conversation may put the instruction
(`render(state)`, only while `state` is defined; `undefined` renders the removal notice) into its
system prompt instead: the catalog then invalidates the cache from the system prompt on when it
changes (rarely), never the tool definitions before it.

Code mode ships the catalog as one such instruction with `makeCodeModeTool({ catalog:
'instructions' })` (`codeModeCatalogInstruction`, key `yolk.codemode.catalog`); the default
`catalog: 'description'` keeps the previous behavior for existing hosts. Hosts drop their own
"which servers exist" prompt sections: the namespace inventory replaces them.

Realtime voice sessions declare tools once per session (`providerToolDefs`), so they declare
deferred tools eagerly and have no use for `tool_search`; deferral applies to the text loop.

## 5. Provider-native mapping (later)

- **Anthropic tool search**: deferred tools may be sent with `defer_loading: true` plus the native
  tool search tool, so the provider inserts definitions in place. The loop's activation semantics
  stay the source of truth for which calls are allowed.
- **Prompt caching** (provider cache breakpoints) is a separate change. This ADR guarantees the
  stable prefix that makes it effective: invariant tool definitions and `codemode` description,
  catalog changes appended, activation adding definitions at most once per tool.

## Security

No tool gains authority. `tool_search` activates only tools the resolution already allows the
model to call; hidden (unresolved) tools are never searchable. Activated gated tools keep their
approval; stage-only tools only reach `review_plan`. Activation from transcript content is safe:
only results answering a `tool_search` call of the assistant message they follow count (the
package tool, or a host tool of that name, which takes over its contract), and activated names
only declare tools that are resolved and still deferred. Deferral is not an authority boundary
anyway: an allowed deferred tool called by name runs.

## Rejected alternatives

- **OpenCode's binary `codemode: true | false`**: no "callable by both" level (also rejected in
  ADR 0002).
- **Catalog in the `codemode` description** (status quo): any listed change rewrites the prefix.
- **Host-only deferral** (hosts recompute tool lists per step): every host reimplements activation,
  compaction and replay rules, and gets them subtly different.
- **Activation stored in host state**: diverges from the transcript on redelivery and branching.
- **Script approvals by blocking** (OpenCode `permission.assert`): needs a live process; durable
  steps have deadlines. Abort-and-replay (ADR 0002 Phase 2) stays deferred: staging plus deferred
  direct calls cover bulk and single gated work.

## Tests

- Agent: resolution errors per axis combination (codemode loading, question, input, background,
  nested access, `tool_search`; duplicate instruction keys; `instruct` without nested access);
  `tool_search` added, opted out, or host-owned; `declaredToolDefs` from transcripts (activation,
  look-alike results of other tools, reused call ids); activation read through a compacting
  transform; activated gated tool keeps its approval; a run declares a tool after its search.
- Agent: stage-only resolution, no provider declaration, nested direct call rejected, stage →
  review → apply unchanged.
- Codemode: invariant description across catalog changes and when the first stageable tool
  connects; summary namespace lines, counts, budget, pinned (pinned stage-only names past the
  cap); stage-only search marker and declaration; `stage` by identifier; the pi executor rejects a
  direct call with the stage hint and keeps it out of `ALL_TOOLS`.
- Instructions: initial, change (whole render), removal, `null` state; idempotent per transcript
  (key order independent); `run()` keeps them for later turns, never as user message events; kept
  through window compaction, the kept code mode catalog complete after a change; hidden in and
  round-tripped through the chat projection.

## Implementation plan

1. Stage-only approval tools (section 3). Smallest, no new protocol.
2. Catalog instructions (section 4): protocol message, loop delivery, code mode summary,
   `discovery: 'pinned'`.
3. Deferred loading (section 2): `loading`, `tool_search`, per-request declared set, compaction.
4. Provider-native tool search (section 5).

Each step ships its changeset and updates `packages/agent/AGENTS.md`, `packages/codemode/AGENTS.md`
and ADRs 0002/0005 where their rules change.
