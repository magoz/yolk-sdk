# @yolk-sdk/agent

Domain-free agent protocol, loop, runtime, client, and tool primitives.

Root export is intentionally tiny. Import feature APIs from explicit subpaths.

## Install

```bash
pnpm add @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/agent/protocol` | Wire messages, events, content, usage, tool schemas |
| `@yolk-sdk/agent/loop` | Stateless LLM/tool loop |
| `@yolk-sdk/agent/loop/testing` | Faux provider and tool executor test helpers |
| `@yolk-sdk/agent/runtime` | Transcript or append-backed runtime orchestration |
| `@yolk-sdk/agent/client` | HTTP/NDJSON transport and client state helpers |
| `@yolk-sdk/agent/tools` | Tool module registry, `makeTool`, task/question tool contracts |

```ts
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { run } from '@yolk-sdk/agent/loop'
import { runRuntime } from '@yolk-sdk/agent/runtime'
import { initialAgentClientState } from '@yolk-sdk/agent/client'
import { makeQuestionToolModule, makeTaskToolModule, resolveTools } from '@yolk-sdk/agent/tools'
```

Test helpers live behind their own subpath:

```ts
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
```

## Quick start

```ts
import { Effect } from 'effect'
import { run } from '@yolk-sdk/agent/loop'

const program = run({
  messages: [{ role: 'user', content: 'Hello' }],
  maxTurns: 4
})

// Provide LLM provider + tool executor layers in the host app.
Effect.runPromise(program)
```

## Human-in-the-loop

HITL is protocol-level, not UI-level:

- Add `approval: { mode: 'manual' }` to a `ToolDef` to pause before execution.
- `run` / `runRuntime` emit `ToolApprovalRequested` then `AgentAwaitingInput`.
- Resume by passing `hitlResponses` or using client helpers like `submitToolApprovalResponse`.
- Denials become model-visible `ToolResult` messages with `isError = true`.
- Use `makeQuestionToolModule` to expose the package-owned `question` tool; answers resume as structured tool results.

## Host responsibilities

- Choose models/providers and map provider streams into protocol events.
- Persist sessions, transcripts, and append logs.
- Provide tools, approval policy, auth, storage, and observability.
- Compact context and decide memory/retrieval policy.

## Boundaries

- No React, Next.js, provider SDKs, auth, storage drivers, or app concepts.
- Loop stays stateless: transcript in, events out.
- Runtime owns generic session orchestration only; host apps own persistence adapters and policy.
- Tools model generic metadata/execution; host apps own concrete tool catalogs.
- `task` is the standard subagent delegation tool. Packages define the schema; host apps execute subagents and omit `task` from subagent toolsets in v1.

## Testing

Use `@yolk-sdk/agent/loop/testing` for deterministic provider/tool tests.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports only.
- No top-level env reads, network calls, SDK clients, or service construction.
