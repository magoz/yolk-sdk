# Code mode

Status: accepted.

An agent should be able to write one short script that calls several tools, filters or
aggregates their results, and returns only what matters, instead of spending one model turn per
tool call and echoing every intermediate result into the conversation. Add a code mode tool to
Yolk: the model writes JavaScript, a confined sandbox runs it, and the script reaches the outside
world only through the host's resolved tools.

## Terms

- **Code mode tool**: the model-facing tool (default name `codemode`) whose only input is
  `{ code }`.
- **Script**: the JavaScript the model passes as `code`. It runs as an async function body, so
  top-level `await` and `return` work.
- **Nested call**: a `tools.<name>(args)` call made by a script. It executes a real Yolk tool;
  only the script's output and return value reach the model.

## Motivation

- Hosts with many connectors advertise every tool schema on every model step. A fully connected
  10x session exposes 100+ tools (Notion, Outlook, email, Todoist, Dropbox, OneDrive, Fortnox, and
  more), and speldosa adds about 50 generated connector tools to roughly 28 curated ones.
- Paginated, bulk, and aggregate work costs one model turn per call. In Vercel Workflow each turn
  is a model step plus a tool step: two function invocations, queue hops, durable events, and the
  growing context resent. Large results are truncated rather than filtered, so the model reads
  bounded slices of data it only needed to summarize.
- Non-chat models such as classifiers (see [Classifier models](0003-classifier-models.md)) are
  most useful applied per item, which requires a loop the model cannot express in tool calls.

## Decision summary

| Area             | Decision                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Engine           | Depend on `@earendil-works/pi-codemode`, pinned exactly, behind a Yolk executor interface.                       |
| Package          | New public package `@yolk-sdk/codemode`; the pi executor lives behind a Node subpath.                            |
| Placement        | Scripts run inside the host's tool-batch step, never inside a `'use workflow'` function.                         |
| Nested calls     | Execute through the resolved tool set's normal execute path with the same host context.                          |
| Exposure         | New `callableBy` (`all` / `model` / `codemode`) and, for `codemode`, `discovery` (`listed` / `search`) on tools. |
| Fail-closed rule | Approval, input, interaction, and background tools never run from code mode, whatever their `callableBy` says.   |
| Approvals        | Not supported inside scripts in phase 1. Phase 2 uses abort-and-replay over a recorded nested-call log.          |

## Engine

`@earendil-works/pi-codemode` (MIT, v1.0.0, single dependency `quickjs-wasi` maintained by
vercel-labs) runs each script in a fresh QuickJS VM compiled to WebAssembly, inside a worker
thread. The VM has its own linear memory and an optional heap cap; the host owns the deadline and
abort signal, sets a shared interrupt flag the VM polls, and terminates the worker. The only
capability inside the VM is calling injected functions. There are no timers, `fetch`, `process`,
`require`, modules, or `WebAssembly`.

Evidence from a deployed spike (Next 16.1.3, `workflow` 5.0.0-beta.42, iad1, Node 24.21, both
engines in one workflow, one step per engine, three runs):

| Scenario                                          | `@opencode/codemode` 2.0.22                         | `pi-codemode` 1.0.0              |
| ------------------------------------------------- | --------------------------------------------------- | -------------------------------- |
| Trivial script                                    | 1–19 ms                                             | 78–187 ms (new worker + VM)      |
| 200 parallel nested calls (50 ms each) and filter | 122–185 ms                                          | 142–208 ms                       |
| Aggregate 10k rows                                | 405–819 ms                                          | 116–165 ms                       |
| 1M-iteration loop                                 | 12.5–13.0 s                                         | 173–178 ms                       |
| Catastrophic regex, 1 s limit                     | ran 4.3–5.0 s, blocked the event loop ~4.95 s, `ok` | stopped at 1.0 s, loop lag ≤5 ms |
| Memory bomb                                       | stopped by timeout; no memory cap exists            | stopped by 32 MB cap             |
| Getter, class private field                       | fail                                                | pass                             |
| TypeScript annotation                             | fail                                                | fail                             |

Both engines needed `serverExternalPackages` to load inside a Next workflow step. Next's file
tracing then included pi's worker file and `quickjs.wasm` automatically.

Accept these pi limitations:

- About 80–190 ms per script on Vercel, because every execution starts a worker and VM. This is
  small next to one Workflow turn.
- The worker is created with `workerData` only, so it inherits a copy of `process.env`. Scripts
  cannot reach it (no `process` exists in the VM). Ask upstream for a worker-options hook.
- The VM's clock and `Math.random` come from QuickJS's WASI shim. Phase 2 replay captures
  nondeterministic values through a host `step()` global instead.
- Schemas only shape declarations; pi does not validate values. Yolk validates through the
  resolved tool set.
- pi buffers script output (text and images) on the host thread without a limit while the script
  runs. The timeout mitigates it, and Yolk bounds the result afterwards (characters, image count,
  and image bytes). Ask upstream for an output budget hook.

The Yolk executor interface hides the engine. Vendoring the MIT runtime is the fallback if Yolk
needs warm worker pools, worker options, or replay hooks that `globals` cannot express. A Workers
or edge executor (for example `@opencode/codemode` in a killable context, or Cloudflare's
executor) can be added for `cloudflare/agent` without changing the tool contract.

## Packaging

`@yolk-sdk/codemode` is a separate package because it brings a third-party engine, a wasm asset,
and a worker thread, and its executor is Node-only. This matches `@yolk-sdk/sandbox` standing
beside `@yolk-sdk/agent`.

- `@yolk-sdk/codemode` (runtime-neutral): `makeCodeModeTool`, the executor interface, catalog
  rendering, discovery helpers, result bounding, and `makeClassifierTool`.
- `@yolk-sdk/codemode/node`: the pi executor, with wasm and worker resolution owned by Yolk.
- Dependency direction: `@yolk-sdk/codemode` depends on `@yolk-sdk/agent` subpaths
  (`tools`, `protocol`, `classification`). `@yolk-sdk/agent` never imports code mode.

Host setup is one Next config line:

```ts
serverExternalPackages: ['@yolk-sdk/codemode', '@earendil-works/pi-codemode', 'quickjs-wasi']
```

## Placement in Vercel Workflow

The code mode call is one ordinary tool call inside the host's tool-batch step (`'use step'`,
full Node). Running the interpreter inside the `'use workflow'` function with nested calls as
steps was rejected: it requires a pure-JS engine in the replay sandbox, costs about three durable
events per nested call (a 200-item script approaches the 2,000-event replay slowdown), replays the
script after every step, and cannot enforce a timeout on a busy loop.

- **Duration**: clamp the script timeout to the step's remaining function budget minus a margin;
  default 120 s.
- **Retries**: Yolk workflow steps default to one attempt, so a crashed step fails the batch rather
  than silently re-running nested writes. Nested call ids are `<toolCallId>/<seq>`; hosts that
  enable retries or guard external actions derive stable idempotency keys from them.
- **Step output**: return the bounded script output and a bounded nested-call record, never raw
  nested results.
- **Concurrency**: cap concurrent executions per instance (Fluid compute shares instances) and the
  VM heap (default 64 MB).
- **Progress**: phase 1 reports nested calls in the final result. Streaming them live through the
  run's durable stream is a follow-up that needs a tool progress seam.

## Tool contract changes in `@yolk-sdk/agent`

These changes are useful without code mode and land first.

### Output schemas

Add an optional `output` Effect Schema to `makeTool` and `ToolRegistration`, rendered to JSON
Schema for declarations. Connector registrations pass their action `outputSchema` through. A
nested call to a tool with an output schema resolves to its `structuredContent`; other tools
resolve to their text content.

### Exposure

```ts
type ToolCallableBy =
  | { readonly callableBy: 'all' } // default
  | { readonly callableBy: 'model' }
  | { readonly callableBy: 'codemode'; readonly discovery?: 'listed' | 'search' } // default 'listed'
```

| Setting                                         | Meaning                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `callableBy: 'all'`                             | The model calls it as a normal tool call, and scripts can call it.                   |
| `callableBy: 'model'`                           | Only the model calls it. Scripts never can.                                          |
| `callableBy: 'codemode'`, `discovery: 'listed'` | Only scripts call it. Listed with its signature in the code mode tool's description. |
| `callableBy: 'codemode'`, `discovery: 'search'` | Only scripts call it. Not listed; scripts find it with `searchTools()`.              |

Tools with `callableBy: 'codemode'` are not sent to providers. Without a code mode tool in the
same tool set, they are unreachable, and resolution warns.

Fail-closed rule: a tool with `ToolDef.approval`, `ToolDef.input`, `ToolDef.interaction`, or
`ToolDef.execution === 'background-v1'`, and the package-owned `question` and `subagent` tools,
are never callable from code mode. Marking them `all` behaves as `model`; marking them `codemode`
is a resolution error.

### Nested tool access

A registration opts in with `nestedToolAccess: true`. `resolveTools` then passes its `execute` a
`nested` executor scoped to the same resolution:

```ts
interface NestedToolExecutor {
  /** Tools scripts may call: `callableBy` all or codemode, minus the fail-closed set and minus
   * every registration with nestedToolAccess (no recursion). */
  readonly tools: ReadonlyArray<{ readonly def: ToolDef; readonly moduleId: string }>
  /** Runs through ResolvedToolSet.execute with the same host context. */
  readonly execute: (call: ToolCall) => Effect<ToolResult>
}
```

Nested call IDs are `<parentToolCallId>/<seq>`, so hosts can derive idempotency keys from
`call.id`. `ToolModule.id` is the namespace used for grouping and search. Host wrappers apply to
nested calls only when they wrap registrations or the resolved tool set; executor decorators
outside `ResolvedToolSet.execute` do not see nested calls. `makeCodeModeTool` therefore takes an
optional `beforeNestedCall({ call, context })` hook for per-call run-authority checks: a failure
rejects that nested call in the script and records it as an error without executing it.

### Nested-call record

Add an optional bounded `nestedCalls` record and summed usage to `ToolResult`. Live nested
`ToolExecution*` events carrying `parentToolCallId` need a tool progress seam that does not exist
yet; they are a follow-up, and phase 1 exposes nested calls through the final result. Bounds follow pi: 256 calls, 8 KiB of
arguments per call, 32 KiB in total; the record is marked incomplete when truncated. Each entry
holds the tool name, compact arguments, status (`ok` / `error` / `cancelled`), duration, a
truncated error, and token usage when reported (`AgentUsage` has no cost field, so a tool's cost
stays in its own result, for example the classifier result's `structuredContent`). Nested results
are not stored.

## Code mode tool contract

`makeCodeModeTool({ executor, name, inlineBudget, limits, deadline, loadStore, beforeNestedCall })`
returns a tool registration; the nested tools come from the `resolveTools` resolution it is part
of. There is no `mode` option in v1: the only behavior is the former `mode: 'on'`.

- **Input**: `{ code: string }`. A leading `// @options:` line is not supported in v1; limits are
  host-owned.
- **Callable tools**: every tool in the same resolved tool set with `callableBy` `all` or
  `codemode`, except the fail-closed set. Nested calls run through `ResolvedToolSet.execute` with
  the run's host context, so input decoding, access metadata, and registration-level host wrappers
  (for example external action claims) apply as for direct calls. Run-authority checks that live
  in executor decorators must move to `beforeNestedCall` or registration wrappers.
- **Description**: the script globals in one line each, then tool declarations grouped by
  namespace. `codemode`/`listed` tools are listed within an inline token budget (default 3,000
  estimated tokens) filled fairly across namespaces, one tool per namespace per round.
  `codemode`/`search` tools contribute nothing (no headings, hints, or counts), so the description
  stays byte-identical as connectors change and the prompt cache survives; one fixed line points
  scripts to `searchTools()`, `describeTool()`, and `describeNamespace()`. `all` tools keep their
  normal declarations in their own description; the code mode description gives each one line,
  outside the budget, saying how scripts call it and what it resolves to. An optional
  `ToolModule.description` shows under the namespace heading.
- **Globals**: `tools.<name>(args)`, `searchTools(query, { limit?, namespace? })` (BM25 over names,
  descriptions, and namespace descriptions), `describeTool(name)`, `describeNamespace(name)`,
  `text()`, `image()`, `console.*`, `return`, `exit()`, `store()`/`load()`.
- **Preprocessing**: strip TypeScript annotations before execution; both evaluated engines reject
  them and models shown TypeScript declarations write them.
- **Result**: a `Script completed` or `Script failed` header, wall time, text and image output in
  order, and the JSON return value, bounded with a head-and-tail cut. A failed script keeps its
  partial output, the error, and the calls already made with a statement that they were not undone.
  Unknown tool names produce close-match suggestions.
- **Store**: `store()` writes from a successful script are persisted in the code mode result's
  `structuredContent` and rebuilt from the transcript for later scripts, which works for stateless
  Next, Workflow, and the Cloudflare Durable Object alike. The rebuild applies only results of the
  code mode tool (by tool name). Small values only: 256 KiB per value, 1 MiB in total; the rebuild
  drops writes beyond them.
- **Limits**: timeout (clamped as above, with an Effect backstop 5 s after it), VM heap, maximum
  nested calls per script, output size, and image count and bytes. All are host-configurable with
  safe defaults.
- **Surfaces**: hosts decide where to advertise the tool. Voice sessions do not get it in v1.

### Known gap: polling

Scripts have no timers, so tools that poll (`kie.get_task`, polling loops) would spin. Until a
tool offers a `wait` parameter or Yolk adds a deadline-bounded host `sleep()` global, such tools
should be `callableBy: 'model'`.

## Phase 2: approvals inside scripts

Not part of phase 1. When a script reaches a call that needs approval:

1. Abort the pass. Record the nested calls already applied, with their results, in sequence.
2. Return a paused code mode outcome. In Workflow, the step output persists the record; the
   existing `awaitingInput` → `createHook` path waits for the decision.
3. On approval, re-run the same script with the same execution identity. Applied calls return
   their recorded results; the approved call executes; the script continues to completion or the
   next approval.

Constraints: approval identity binds the outer call ID, sequence number, tool name, and canonical
arguments, following the `background-v1` binding. A sequence mismatch on replay is a divergence
error. Approval-gated calls must run sequentially because `Promise.all` arrival order can change
between passes. Nondeterministic values go through a host `step(name, fn)` global. Recorded
values are bounded and never truncated, because truncation changes replay.

## Rejected alternatives

- **`@opencode/codemode` as the default engine**: a subset interpreter that runs on the host
  thread. Host regex cannot be interrupted (it blocked the function for about 5 s in the spike), it
  has no memory cap, real computation is about 73× slower, common syntax fails, and it pins
  `effect@4.0.0-rc.112` as a regular dependency. It remains an option for non-Node runtimes.
- **opencode's binary exposure** (`codemode: true | false`): no "callable by both" level, so a
  host's everyday tools must choose between direct calls and scripting.
- **Writing our own engine on `quickjs-wasi`**: rebuilds about 1,000 subtle lines (interrupts,
  termination, memory caps, stack guard, bridge, cancellation, deadlock detection) for no new
  capability.
- **Interpreter inside the workflow function**: see Placement.
- **Calling tool executors directly from scripts**: skips input decoding and host wrappers.

## App guidance

Exposure is host policy. Example for speldosa:

- `all`: `web_fetch`, `web_search`, `knowledge_*`, `cms_lookup`, `cms_manage`, `sales_lookup`,
  `sales_manage`, `sales_playbook_lookup`, `sales_playbook_manage`, `just_bash`,
  `upload_tmp_file`, `gmail`, `resend`, `github_create_issue`, `resource_cards_grid`.
- `model`: `question`, `subagent`, `skill`, `update_task_goal`, `manage_tasks`,
  `sales_mark_won`, `sales_playbook_remove`, `telegram_send_message`, `sandbox`, `kie`, approval-gated
  connector deletes, destructive Afloat tools, and voice-only tools.
- `codemode` + `listed`: `classify`.
- `codemode` + `search`: remaining connector and MCP tools, `github_repository_activity`,
  `cms_upload`, `manage_skills`.

Speldosa's `ai-chat/AGENTS.md` rule against wrapper or meta-tools for parallelization must be
revised before it adopts code mode. Native same-turn batches remain the way to run a few
independent calls.

## Implementation and acceptance plan

1. **Tool contract** (`@yolk-sdk/agent`): `output` schemas, connector output pass-through,
   `callableBy`/`discovery`, the fail-closed rule, nested tool access, `nestedCalls` and usage on
   `ToolResult`, and provider tool lists that omit `codemode`-only tools. Live nested progress
   events follow later.
2. **`@yolk-sdk/codemode`**: executor interface, pi executor under `/node`, `makeCodeModeTool`,
   catalog and discovery, type stripping, bounding, store persistence, idempotency keys, limits,
   and `makeClassifierTool` once [Classifier models](0003-classifier-models.md) lands.
3. **Reference integration**: `examples/next` dogfood behind a flag, Workflow placement, the Next
   config line, docs pages, package exports, smoke imports, and a changeset.
4. **Measurement in 10x** before stable release: inbox triage, Fortnox follow-up, and Dropbox or
   OneDrive pagination compared with direct calls on DeepSeek V4.1 Flash: steps, tokens, latency,
   first-try script success, and Workflow events.
5. **Phase 2 approvals**: abort-and-replay as described, after phase 1 ships.

Tests must demonstrate:

- Nested calls go through `ResolvedToolSet.execute`: invalid input never executes, host wrappers
  run, and run-authority restrictions hold.
- Fail-closed tools cannot run from scripts under any `callableBy` value.
- `codemode`-only tools never reach provider tool lists; `search` tools never appear in the
  description; the description is stable when such tools change.
- Timeouts, memory caps, runaway regexes, and aborts end the script without blocking the host
  event loop, and running nested calls are cancelled through their signal.
- Output, nested-call records, and store values respect their bounds; failed scripts keep partial
  output and report calls made.
- Store writes persist only for successful scripts and replay correctly from transcripts.
- The pi executor loads inside a deployed Next workflow step with the documented config.
