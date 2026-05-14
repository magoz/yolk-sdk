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
packages/agent-loop      # pure loop
packages/agent-runtime   # runtime contract + append/session abstractions
packages/client          # protocol/client replay helpers
packages/react           # headless chat state/UI hooks
packages/openai          # Codex mechanics and OAuth schemas
packages/oauth           # broker/credential contracts
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

## Why not create `packages/agent-runtime-vercel` first

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
packages/agent-runtime-vercel
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

Current v1 does not split every LLM call or tool call into separate Workflow steps.
One Workflow run currently executes one `runAgentWorkflowStep`, and that step runs the
full Yolk text runtime loop. This gives durable execution/stream replay, but a long
model stream or long tool cascade still needs to fit inside one Vercel Function step.
Open Agents-style one-model/tool-boundary-per-step remains the next architecture task.

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
