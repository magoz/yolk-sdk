# Vercel Workflow architecture research

## Question

Can Vercel Workflows replace the Cloudflare Durable Object runtime for Yolk agents, especially when using ChatGPT/Codex subscription OAuth?

## Short answer

Yes, as a strong candidate for the Codex OAuth runtime path.

Do not replace the reusable agent stack. Add a Vercel Workflow runtime adapter at the app boundary first, then extract a package only after the seam is stable.

```txt
Browser
  → Next API route
  → Vercel Workflow run
  → Yolk agent loop in Workflow steps
  → Codex provider from Vercel
  → durable stream back to browser
```

## Why this matters

The current Cloudflare agent path owns durable runtime/session work well, but direct Cloudflare Worker egress to ChatGPT/Codex is blocked for us:

```txt
Cloudflare Worker / Durable Object
  → wss://chatgpt.com/backend-api/codex/responses
  → 403 Cloudflare WAF HTML before WebSocket upgrade
```

Vercel/Next egress already works as the tactical Codex response proxy. Vercel Workflows move durable execution onto the same accepted egress and credential boundary:

```txt
Vercel Workflow step
  → get valid Codex OAuth token from app DB
  → chatgpt.com/backend-api/codex/responses
```

This removes the Cloudflare token broker/proxy hot path for Codex mode.

## Project Think comparison

Cloudflare Project Think is not affected by the Codex OAuth issue because it does not depend on ChatGPT subscription OAuth or `chatgpt.com/backend-api/codex/responses`.

The blog example uses Workers AI:

```ts
createWorkersAI({ binding: env.AI })("@cf/moonshotai/kimi-k2.5")
```

Workers AI does not support Codex / ChatGPT subscription OAuth. A Think agent using Codex OAuth directly from Workers could hit the same WAF problem.

## Vercel Workflow model

Vercel Workflows split execution into:

- workflow functions: deterministic orchestration with `"use workflow"`;
- step functions: full Node.js work with `"use step"`;
- event log: durable state and replay source;
- durable streams: persisted stream chunks, resume by run id;
- queues: step/run scheduling.

Workflow runs are unlimited duration. Individual step executions still run on Vercel Functions and are limited by the platform maximum for the plan.

Current limits from Vercel docs:

| Limit | Value |
| --- | --- |
| Workflow run duration | No limit |
| Workflow steps per run | 10,000 |
| Workflow events per run | 25,000 |
| Step max runtime | Vercel Function max |
| Function max runtime, Hobby | 300s |
| Function max runtime, Pro/Ent | 800s |
| Workflow replay max duration | 240s |
| Workflow payload size | 50MB |
| Total entity storage per run | 2GB |

Implication:

```txt
Full agent turn may exceed 800s if split across steps.
One model stream or tool call should not exceed the function max.
```

## Open Agents findings

Reference repo cloned to `.repos/open-agents`.

Open Agents architecture:

```txt
Web → Agent workflow → Sandbox VM
```

Important design decision: the agent is not the sandbox. The Workflow controls the agent loop; the sandbox is a separate execution environment for filesystem, shell, git, dev servers, and preview ports.

Main files inspected:

- `.repos/open-agents/apps/web/app/api/chat/route.ts`
- `.repos/open-agents/apps/web/app/workflows/chat.ts`
- `.repos/open-agents/apps/web/app/workflows/chat-sandbox-runtime.ts`
- `.repos/open-agents/packages/agent/open-agent.ts`
- `.repos/open-agents/packages/agent/tools/bash.ts`
- `.repos/open-agents/apps/web/lib/sandbox/config.ts`

Chat route starts a Workflow and returns a durable stream:

```ts
const run = await start(runAgentWorkflow, [{ ...input, maxSteps: 500 }])
return createUIMessageStreamResponse({
  stream: run.getReadable(),
  headers: { "x-workflow-run-id": run.runId },
})
```

The workflow loops over durable steps:

```ts
export async function runAgentWorkflow(options) {
  "use workflow"

  for (let step = 0; step < options.maxSteps; step++) {
    const result = await runAgentStep(...)
    if (result.finishReason !== "tool-calls") break
  }
}
```

Each agent step is a Vercel Workflow step:

```ts
const runAgentStep = async (...) => {
  "use step"
  const result = await webAgent.stream(...)
  for await (const part of result.toUIMessageStream(...)) {
    await writable.getWriter().write(part)
  }
}
```

The Open Agents `ToolLoopAgent` is configured with one model/tool step per outer Workflow step:

```ts
new ToolLoopAgent({
  stopWhen: stepCountIs(1),
})
```

So one complete chat turn can run across many persisted Workflow steps. This avoids needing the whole turn to fit in one function invocation, but one model stream still needs to fit inside one step.

Other cost/runtime controls:

- bash command timeout: 120s;
- dev servers run `detached: true`;
- sandbox lifetime is separate from workflow lifetime;
- standard sandbox timeout is roughly 5h minus hook buffer;
- hobby sandbox timeout is roughly 40m minus hook buffer;
- active run id is persisted to the app DB for resume/conflict control.

## Pricing model

Vercel Workflow cost is small relative to sandbox cost.

Workflow:

| Resource | Rate |
| --- | --- |
| Workflow steps | $2.50 / 100k = $0.000025 / step |
| Workflow storage | $0.00069 / GB-hour |
| Queue operations | $0.60–$0.96 / 1M operations |

Vercel Functions in `iad1`:

| Resource | Rate |
| --- | --- |
| Active CPU | $0.128 / CPU-hour |
| Provisioned memory | $0.0106 / GB-hour |

CPU billing pauses during I/O. Provisioned memory billing does not.

Vercel Sandbox:

| Resource | Rate / limit |
| --- | --- |
| Active CPU | $0.128 / vCPU-hour |
| Provisioned memory | $0.0212 / GB-hour |
| Sandbox creation | $0.60 / 1M |
| Data transfer | $0.15 / GB |
| Pro max runtime | 5h |
| Pro concurrent sandboxes | 2,000 |

### Chat-only estimates

Assumptions: 2GB function, `iad1`, 7d retention, no sandbox, excluding model/provider cost.

| Run type | Wall time | Agent steps | Stored stream | Est/run |
| --- | ---: | ---: | ---: | ---: |
| Light | 5m | 10 | 1MB | ~$0.003 |
| Normal | 15m | 50 | 5MB | ~$0.009 |
| Heavy | 45m | 150 | 20MB | ~$0.029 |

Monthly rough order:

| Runs/mo | Light | Normal | Heavy |
| ---: | ---: | ---: | ---: |
| 1k | ~$3 | ~$9 | ~$29 |
| 10k | ~$30 | ~$90 | ~$290 |
| 100k | ~$300 | ~$900 | ~$2.9k |

### Coding-agent estimates with Sandbox

Open Agents standard sandbox default is 4 vCPU / 8GB.

| Sandbox session | Duration | CPU load | Sandbox cost | + workflow | Est/run |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quick | 5m | 20% | ~$0.023 | ~$0.005 | ~$0.03 |
| Typical | 30m | 20% | ~$0.136 | ~$0.018 | ~$0.15 |
| CPU-heavy | 30m | 100% | ~$0.341 | ~$0.018 | ~$0.36 |
| Long | 2h, 8vCPU/16GB | 50% | ~$1.70 | ~$0.06 | ~$1.76 |
| Long maxed | 2h, 8vCPU/16GB | 100% | ~$2.73 | ~$0.06 | ~$2.79 |

Monthly rough order:

| Sessions/mo | Typical 30m | CPU-heavy 30m |
| ---: | ---: | ---: |
| 1k | ~$150 | ~$360 |
| 10k | ~$1.5k | ~$3.6k |
| 100k | ~$15k | ~$36k |

### Cloudflare Durable Object cost comparison

Cloudflare DO raw runtime remains cheaper.

Example: one 15m active DO at 128MB:

```txt
0.125GB × 900s = 112.5 GB-s
112.5 × $12.50 / 1,000,000 = ~$0.0014
```

But this does not solve the current Codex OAuth egress block. For Codex mode, accepted network path and credential simplicity may matter more than raw runtime cost.

## Architecture implication for Yolk

Add a Vercel Workflow runtime backend, not a wholesale replacement.

Keep core packages runtime-neutral:

```txt
packages/agent/src/loop      # pure loop
packages/agent/src/runtime   # runtime contract + append/session abstractions
packages/agent/src/client          # protocol/client replay helpers
packages/agent/src/react     # headless chat state/UI hooks
packages/agent/src/providers/openai  # Codex mechanics and OAuth schemas
packages/agent/src/oauth     # broker/credential contracts
```

Put Vercel-specific glue at the app boundary first:

```txt
app/workflows/agent.ts
lib/agents/workflow-runtime/run-agent-workflow.ts
lib/agents/workflow-runtime/agent-step.ts
lib/agents/workflow-runtime/active-run.ts
lib/agents/workflow-runtime/cancellation.ts
lib/agents/sandbox/vercel-*.ts        # only if adding Vercel Sandbox
```

Runtime backend shape:

```ts
type AgentRuntimeBackend = {
  startTurn(input): Promise<{ runId: string; stream: ReadableStream }>
  resumeTurn(runId): Promise<ReadableStream>
  cancelTurn(runId): Promise<void>
}
```

Potential backends:

```txt
Next inline runtime
Cloudflare DO runtime
Vercel Workflow runtime
```

Recommended default split:

| Mode | Runtime |
| --- | --- |
| Codex subscription OAuth | Vercel Workflow |
| Claude/OpenAI API-key or Gateway, no Worker egress issue | Either Workflow or Cloudflare DO |
| Worker-native provider experiments | Cloudflare DO |
| Sandbox-backed coding agent | Vercel Workflow + Vercel Sandbox |

## Product state vs execution state

Workflow managed state should not become product memory.

Product state stays in Postgres:

- sessions;
- messages/transcripts;
- selected model/reasoning config;
- provider OAuth credentials;
- active run id;
- final run status/summary/usage.

Workflow state is execution-only:

- in-flight step events;
- durable stream chunks;
- retry metadata;
- temporary execution state.

Reason: Workflow retention is plan-bound by default (Pro: 7 days after completion). It is not the long-term transcript store.

## Why not create `packages/agent/src/runtime-vercel` first

Start in app code because the stable seam is not known yet.

Reasons:

- `"use workflow"` and `"use step"` directives are bundler/runtime-sensitive;
- `withWorkflow()` generates hidden Next routes from app code;
- `getWritable()`, `getWorkflowMetadata()`, `start()`, and `getRun()` are host concerns;
- auth/session/DB ownership is app-specific;
- active stream locking is product policy;
- cancellation semantics need proving;
- Codex calls from Vercel may need app env and token storage;
- early package boundary would likely become callback-heavy and leaky.

Risk of packaging too early:

```txt
generic package
  → accepts app callbacks
  → callbacks need step directives
  → directive transform may fail or leak
  → wrong abstraction fossilized
```

Extract later only if the adapter stabilizes.

Likely extractable later:

```txt
packages/agent/src/runtime-vercel
  stream protocol glue
  run status mapping
  resumable transport helpers
  cancellation helpers
```

Likely app-owned forever:

```txt
app/workflows/*
  "use workflow"
  "use step"
  DB/auth/session policy
  provider token loading/refresh
```

## Recommended spike

Build a concrete app adapter first.

Architecture explainer page: `/vercel-workflows`.

1. Add `/agent/workflow` page or route variant. ✅
2. Add `POST /api/agent/workflow` that starts a Workflow run. ✅
3. Add `runAgentWorkflow` with `"use workflow"`. ✅
4. Add `runAgentStep` with `"use step"`. ✅
5. Split Yolk agent loop into one model/tool step per Workflow step.
6. Use `getWritable()` for protocol event streaming.
7. Persist active run id in Postgres for resume/conflict control.
8. Resume via `getRun(runId).getReadable()`.
9. Cancel via `getRun(runId).cancel()` plus provider abort where possible.
10. Use direct Vercel Codex provider path, no Cloudflare token broker/proxy.
11. Do not add Vercel Sandbox until chat-only Workflow path is proven.

Implementation note: Workflow arguments must be plain serializable values. Decode the
HTTP body into `AgentRouteRequest` at the route boundary, encode it back to plain
wire data before `start(runAgentWorkflow, ...)`, then decode inside the step before
calling app runtime code. Passing Effect Schema class instances directly causes
Workflow serialization failures.

Current app runtime exposes `x-workflow-run-id` in the Activity panel, supports stream
replay via `GET /api/agent/workflow/:runId`, and calls `DELETE /api/agent/workflow/:runId`
to request `run.cancel()` when the user stops a Workflow-backed text run.

Current implementation now splits the Workflow run across model/tool boundaries:

```txt
runAgentWorkflow                    # "use workflow"
  runAgentWorkflowModelStep(...)     # "use step"
  runAgentWorkflowToolBatchStep(...) # "use step", when tool_use
  runAgentWorkflowModelStep(...)
  ...
```

The workflow carries plain wire continuation data between steps: request, transcript,
created messages, accumulated usage, pending tool calls, and turn index. `runModelTurn`
and `runToolBatch` remain package-level, store-agnostic APIs; Vercel-specific directives
stay in app-owned workflow wrappers. Keep Effect runtime execution out of the
`"use workflow"` orchestration function: Vercel's workflow sandbox may not expose globals
that Effect expects, such as `AbortController`. Effect pipelines can run inside `"use step"`
functions, where model/tool work and stream writes happen.

## AI SDK WorkflowAgent findings

Reference files inspected:

- `.repos/ai/packages/workflow/src/workflow-agent.ts`
- `.repos/ai/packages/workflow/src/stream-text-iterator.ts`
- `.repos/ai/packages/workflow/src/do-stream-step.ts`

The AI SDK implementation is also split at the model-call boundary:

```txt
workflow context
  streamTextIterator(...)
    -> prepare step state
    -> serialize tools
    -> await doStreamStep(...)    # "use step"
    -> yield tool calls
    -> receive tool results
    -> append tool results to prompt
    -> next model step
```

Important mechanics:

- tools are serialized before crossing the Workflow step boundary because Zod schemas
  and executable functions are not Workflow-serializable;
- the model is resolved inside the step;
- `doStreamStep` streams each model chunk to `getWritable()` as it arrives;
- the step returns compact step state: text, reasoning, tool calls, usage, finish reason,
  response metadata, and provider-executed tool results;
- tool calls are yielded back to the workflow iterator; tool results are sent back into
  the generator and appended to the prompt;
- helper write/close operations may need their own steps when the Workflow runtime does
  not allow a writable operation from orchestration context.

Yolk differs in one key way: tools are already protocol data plus an injected
`ToolExecutor`, so we should not serialize executable tool definitions through Workflow.
The Workflow step should receive only protocol `ToolCall` values and resolve app-owned
tool execution from the injected layer inside a `"use step"` function.

## Step-split plan for Yolk

Keep the app-owned Workflow adapter. Add a package-level step API first, then call it
from app `"use step"` functions.

Target flow:

```txt
runAgentWorkflow                         # "use workflow"
  decode request wire data
  initialize continuation
  emit AgentStart
  loop maxSteps
    modelResult = runAgentModelStep(...) # "use step"
    if modelResult.stop: emit AgentEnd; return
    toolResult = runAgentToolBatchStep(...) # "use step"
    append assistant + tool result messages to continuation
  emit max_turns error
```

Package seam:

```txt
packages/agent/src/loop
  runModelTurn(config, continuation) -> Stream<AgentEvent> + StepResult
  runToolBatch(calls) -> Stream<AgentEvent> + ToolResultMessage[]

packages/agent/src/runtime
  optional continuation schemas + append-store helpers

app/lib/agents/workflow-runtime
  "use workflow" orchestration
  "use step" wrappers that provide AppLayer and write protocol NDJSON chunks
```

Continuation state should be plain wire data:

- original request metadata: session id, model, reasoning effort, user id;
- current transcript: user/assistant/tool-result protocol messages;
- created messages for this run;
- turn number and max-turn guard;
- accumulated usage;
- compacted/context-transformed messages for the current model step only if needed;
- pending assistant message and tool calls between model and tool steps;
- run status and failure metadata.

Do not put these into Workflow as class instances. Encode/decode with Effect Schema at
the route/step boundary, same as the current `AgentRouteRequest` serialization fix.

Recommended implementation order:

1. Extract pure loop internals from `packages/agent/src/loop/run.ts` into explicit
   model-step and tool-batch functions without changing current `run` behavior.
2. Add package tests with `FauxProvider` and `TestToolExecutor` proving the new step API
   emits the same semantic event order as `run`.
3. Add app Workflow continuation schemas and step wrappers.
4. Change `runAgentWorkflow` from one full-loop step to a workflow-level loop that calls
   model/tool step wrappers.
5. Keep current `/agent/workflow` request/stream/cancel/resume API stable.
6. Add active-run persistence in Postgres after step splitting works.

Retry/idempotency policy:

- keep provider retry inside the model step before any provider event is emitted;
- once a model step writes stream chunks, Workflow retry can duplicate chunks unless the
  client/runtime dedupes by deterministic event id;
- add deterministic event ids before relying on automatic Workflow step retries for
  streamed model/tool chunks;
- for now, prefer low/no retry at the Workflow step layer and keep existing provider retry
  semantics inside `@yolk-sdk/agent/loop`.

## Cross-repo persistence patterns

Additional reference files inspected:

- `.repos/opencode/packages/opencode/src/v2/session.ts`
- `.repos/opencode/packages/opencode/src/v2/session-event.ts`
- `.repos/opencode/packages/opencode/src/session/session.ts`
- `.repos/pi/packages/coding-agent/src/core/session-manager.ts`
- `.repos/flue/packages/runtime/src/session.ts`
- `.repos/kody/packages/worker/src/repo/repo-session-do.ts`
- `.repos/kody/packages/worker/src/repo/repo-sessions.ts`
- `.repos/kody/packages/worker/src/package-runtime/realtime-session.ts`
- `.repos/mcp-sdk/packages/server/src/server/streamableHttp.ts`
- `.repos/mcp-sdk/examples/server/src/inMemoryEventStore.ts`

### opencode

opencode has two relevant ideas:

1. Product session metadata is separate from streaming execution events.
2. Step/tool/text/reasoning/compaction are explicit event variants.

`session-event.ts` models durable events such as:

- `Step.Started` / `Step.Ended` / `Step.Failed`;
- `Text.Started` / `Text.Delta` / `Text.Ended`;
- `Reasoning.Started` / `Reasoning.Delta` / `Reasoning.Ended`;
- `Tool.Input.*`, `Tool.Called`, `Tool.Progress`, `Tool.Success`, `Tool.Failed`;
- `Retried`;
- `Compaction.Started` / `Delta` / `Ended`.

This supports the exact split Yolk needs: durable model/tool boundary events plus
stream-friendly deltas. For Yolk, the equivalent should stay protocol-level and not
be Vercel-specific.

opencode's context query starts from the latest compaction row, then returns newer
messages in order. This matches the principle that compaction is a checkpoint in the
message log, not a destructive rewrite of old history.

### pi

Pi stores sessions as JSONL append-only trees:

```txt
session header
entry(id, parentId, timestamp, type, payload)
entry(id, parentId, timestamp, type, payload)
...
leafId -> current branch tip
```

Key properties:

- every entry has `id` and `parentId`;
- appending creates a child of the current leaf;
- branching moves the leaf to an earlier entry, then appends without modifying history;
- context is derived by walking `leaf -> root`, reversing the path, and applying
  compaction/branch-summary rules;
- compaction stores `summary`, `firstKeptEntryId`, and `tokensBefore`;
- malformed JSONL lines are skipped for robustness;
- it delays flushing new sessions until an assistant message exists, avoiding empty
  or user-only session files in normal history.

Yolk does not need file JSONL, but the tree shape is useful for future edit/regenerate
and branch UX. Current `@yolk-sdk/agent/react` already has local edit/regenerate session events;
server persistence should eventually model branch parentage instead of overwriting a
linear transcript.

### Flue

Flue has an in-memory `SessionHistory` backed by a pluggable `SessionStore` snapshot:

```txt
SessionHistory(entries, leafId)
  buildContext()
  appendMessage(...)
  appendCompaction(...)
  appendBranchSummary(...)
  toData(metadata, createdAt, updatedAt)
```

It persists the whole session snapshot after meaningful state transitions rather than
append-per-event. It still keeps entry ids, parent ids, active path, compaction markers,
and branch summaries. It also records compaction usage and folds it into the triggering
operation's total usage.

Useful Yolk takeaways:

- append-log is better for concurrent/server durable runtime;
- snapshot projection is still useful as a cache/read model;
- compaction usage must be accounted in run usage, not hidden as maintenance;
- overflow recovery removes the failed assistant leaf, compacts, then retries from the
  compacted context.

### Kody

Kody uses Cloudflare Durable Objects for long-lived session actors, with product rows in
D1 and hot state in DO storage.

Repo sessions:

- D1 row stores ownership/status/checkpoints: `user_id`, `source_id`, `status`,
  `last_checkpoint_at`, `last_checkpoint_commit`, `conversation_id`;
- DO storage keeps a cached state keyed by session id to survive D1 replica lag;
- the cache is a fallback, while fresh D1 reads remain authoritative for correctness;
- every RPC payload carries both `sessionId` and `userId`.

Realtime sessions:

- DO storage stores a `PackageRealtimeState` snapshot;
- WebSocket attachments persist session id across hibernation;
- `ctx.getWebSockets(tag)` finds live sockets by tags;
- stale/disconnected sessions are removed from the persisted snapshot on failed send.

Useful Yolk takeaways:

- persist product run/session rows in Postgres, not just runtime memory;
- keep hot runtime caches explicitly secondary to authoritative DB rows;
- every durable operation must carry/scoped-check `userId`;
- active run ids belong in product state for conflict/resume UX;
- if Cloudflare DO remains, hibernatable socket attachment/tag patterns are useful for
  live fanout, but Workflow durable streams remove most of that need for Vercel mode.

### MCP SDK resumability

MCP Streamable HTTP defines a small event-store interface:

```ts
type EventStore = {
  storeEvent(streamId, message): Promise<eventId>
  getStreamIdForEventId?(eventId): Promise<streamId | undefined>
  replayEventsAfter(lastEventId, { send }): Promise<streamId>
}
```

The server writes SSE event ids, lets clients resume after `Last-Event-ID`, and can close
streams early only when the client can resume. The example store keeps `(eventId ->
streamId, message)` and replays ordered events after the requested id.

Yolk Workflow currently delegates replay to Vercel's durable stream by run id. For
Postgres-backed product persistence, the MCP pattern suggests a complementary protocol:
persist event ids in Yolk's own append log so clients can resume by `(runId, lastEventId)`
even outside Vercel Workflow retention.

## Store-agnostic persistence recommendation

Important package boundary: Postgres is only the likely production store for this app.
Reusable packages must not know about Postgres, Vercel, Next, Cloudflare, filesystems,
SQLite, or browser storage.

Package model:

```txt
packages/agent/src/loop
  stateless model/tool loop and step APIs
  input: transcript/context + injected provider/tool executor
  output: protocol events + final messages/usage

packages/agent/src/runtime
  generic runtime orchestration
  optional injected append store interfaces
  supports Transcript mode with no persistence

app/runtime adapters
  choose storage implementation, transport, auth, tool policy, model policy
```

Valid host modes:

- fully stateless: send the whole transcript each request (`Transcript` mode);
- local durable: inject in-memory, JSONL, or SQLite stores;
- Cloudflare durable: inject Durable Object storage;
- Vercel production: app adapter can inject Postgres-backed stores;
- tests: inject fake stores/providers/tools.

So any mention of Postgres below is an app-layer implementation choice, not package
architecture.

## App production persistence recommendation

Combine the patterns:

```txt
Postgres product state
  sessions
  messages / branch entries
  run records: active/completed/failed/cancelled
  active run id per session

Postgres execution append log
  runId
  sequence/eventId
  turn/step
  protocol event wire payload
  checkpoint markers: model step done, tool batch done, compaction done

Workflow execution state
  current serializable continuation
  durable stream chunks
  retry metadata
```

Use append-log as source of truth for durable execution; derive snapshots/read models for
fast UI loading. Keep Vercel Workflow state execution-only and retention-bound.

Recommended event model additions for Yolk:

- `RunStepStarted` / `RunStepCompleted` / `RunStepFailed` in `@yolk-sdk/agent/runtime` append log;
- deterministic protocol event ids for streamed `AgentEvent`s;
- optional branch parent ids on persisted product messages/session entries;
- compaction checkpoint entries with `summary`, `firstKeptMessageId`, `tokensBefore`,
  and compaction usage;
- active-run row with `runId`, `sessionId`, `userId`, `status`, `startedAt`, `updatedAt`,
  `cancelRequestedAt`.

Do not persist every token delta as product messages. Persist deltas in execution log for
replay/debug only; commit final assistant/tool-result messages at step/run checkpoints.

## Operational guardrails

- Keep per-step model/tool work under function max duration.
- Use low function memory unless profiling requires more.
- Cap max agent steps per turn.
- Persist transcripts outside Workflow.
- Store only redacted run diagnostics.
- Keep Codex refresh tokens in app DB only.
- Treat Vercel Sandbox as opt-in expensive mode.
- Stop/hibernate sandboxes aggressively.
- Start with 1–2 vCPU sandbox profiles where possible.

## Current conclusion

Vercel Workflows are the best near-term replacement path for the Cloudflare DO runtime when Codex OAuth is the primary model access path.

Cloudflare DO remains useful for provider-agnostic/serverless actor experiments and for providers whose Worker egress works.

Do not package first. Build the app-owned Workflow adapter, measure, then extract stable pieces.

## Open questions

- Direct Codex stream max observed duration?
- Workflow cancel latency?
- Vercel stream reconnect behavior under deploy skew?
- Function memory needed for large transcripts?
- Sandbox minimum viable vCPU/memory?
- Whether Workflow adapter becomes package-worthy?
