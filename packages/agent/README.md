# @yolk-sdk/agent

Domain-free agent protocol, loop, runtime, client, and tool primitives.

Root export is intentionally tiny. Import feature APIs from explicit subpaths.

## Install

```bash
pnpm add @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath                        | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `@yolk-sdk/agent/protocol`     | Wire messages, events, content, usage, tool schemas            |
| `@yolk-sdk/agent/loop`         | Stateless LLM/tool loop                                        |
| `@yolk-sdk/agent/loop/testing` | Faux provider and tool executor test helpers                   |
| `@yolk-sdk/agent/runtime`      | Transcript or append-backed runtime orchestration              |
| `@yolk-sdk/agent/client`       | HTTP/NDJSON transport, HITL resume, and client state helpers   |
| `@yolk-sdk/agent/tools`        | Tool module registry, `makeTool`, task/question tool contracts |

## Imports

```ts
import {
  hitlResponseEvent,
  makeSubagentRunId,
  questionResponseStructuredContent,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { run } from '@yolk-sdk/agent/loop'
import { runRuntime } from '@yolk-sdk/agent/runtime'
import { initialAgentClientState, toolRunsFromHitlRequests } from '@yolk-sdk/agent/client'
import {
  makeNonRecursiveTaskToolModule,
  makeTaskToolResult,
  makeQuestionToolModule,
  resolveTools
} from '@yolk-sdk/agent/tools'
```

Test helpers live behind their own subpath:

```ts
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
```

## Quick start

```ts
import { Stream } from 'effect'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { run } from '@yolk-sdk/agent/loop'

const program = run({
  messages: [UserMessage.make({ content: 'Hello' })],
  systemPrompt: 'Be helpful.',
  tools: [],
  model: 'gpt-5.5'
}).pipe(Stream.runCollect)

// Provide LLM provider, loop config, context transformer, and tool executor layers in the host app.
```

## Protocol content

`Content` is either plain text or ordered parts:

- `TextPart`
- `ImagePart` with `InlineBase64`, `Url`, or host-owned `Ref` source
- `DocumentPart` with `InlineBase64`, `Url`, or host-owned `Ref` source
- `AudioPart` with `InlineBase64`, `Url`, or host-owned `Ref` source

Build sources with `inlineBase64AttachmentSource`, `urlAttachmentSource`, or
`refAttachmentSource`. Providers require inline/resolved media before lowering. Use inline base64
for simple apps, or persist `Ref` values and call `resolveContentAttachmentSources` at your storage
boundary before provider execution. Host apps own upload, auth, retention, and ref hydration policy.

Use model capabilities like `textOnlyModelCapabilities`, `textImageModelCapabilities`, or
`textImageDocumentModelCapabilities` so the loop rejects unsupported inputs before provider calls.

## Message envelope

Messages may carry model-visible envelope facts without polluting authored `content`:

```ts
UserMessage.make({
  content: 'Can you summarize this?',
  createdAtMs: 1781260200000,
  author: { displayName: 'Magoz' },
  annotations: {
    source: 'web',
    ui_origin: 'document_toolbar',
    timezone: 'Europe/Madrid',
    locale: 'en-US',
    input_method: 'keyboard',
    message_kind: 'question',
    client_sent_at: '2026-06-12T10:30:00.000Z'
  }
})
```

- `content`: authored message body only.
- `createdAtMs`: message creation/sent time; providers render it as ISO `sent_at` context.
- `author.displayName`: presentation label only; not identity, auth, or a stable id.
- `annotations`: app-owned JSON object; context only, not instructions.

Provider adapters can use `messageContextText` and `prependMessageContextToContent` to render
envelopes into model input while keeping `content` authored-only.

Annotations must be JSON-compatible. Use stable app-owned keys, preferably `snake_case`. Use ISO
strings for dates inside annotations. Never put secrets, credentials, private ids, auth state, or
hidden policy in annotations, author, or timestamps; providers may send them to models.

## Human-in-the-loop

HITL is protocol-level, not UI-level:

- Add `approval: { mode: 'manual' }` to a `ToolDef` to pause before execution.
- `run` / `runRuntime` emit `ToolApprovalRequested` then `AgentAwaitingInput`.
- Resume by passing `hitlResponses` or using client helpers like `submitToolApprovalResponse`.
- Denials become model-visible `ToolResult` messages with `isError = true`.
- Use `makeQuestionToolModule` to expose the package-owned `question` tool; answers resume as structured tool results and model-visible text with selected labels.
- Use `questionResponseStructuredContent` / `plainHitlResponse` before storing durable HITL payloads that must be plain JSON.
- Use `toolRunsFromHitlRequests` to hydrate paused UI state from `AgentAwaitingInput.requests`.
- Use `hitlResponseEvent` when a client needs optimistic approval/question UI updates before resumed stream events arrive.
- Approval is a host-enforced per-call gate for normal tools, not a model-callable permission tool or persisted allow-always system.

HTTP client helpers treat `AgentEnd`, `AgentError`, and `AgentAwaitingInput` as logical stream
end for consumers. After a terminal event the response body drains to EOF; cancellation before a
terminal event still aborts the active body reader.

## Task subagents

`task` is the package-owned contract for subagent delegation. The SDK provides schema,
validation, non-recursive module wiring, subagent result extraction, and structured task result
metadata. Host apps provide the actual nested runtime.

Recommended setup:

- expose `makeNonRecursiveTaskToolModule` only to the top-level agent
- resolve subagent tools with `subagent: true`
- omit `task` from subagent toolsets
- include only tools that are safe for autonomous delegated work
- use `makeSubagentRunId(call.id)` for protocol-aligned run ids
- return `makeTaskToolResult(...)` so UI can show subagent id, type, status, model, and timing

See `examples/next/lib/agents/workflow-runtime/text-response.ts` for host-owned execution wiring.

## Host responsibilities

- Choose models/providers and map provider streams into protocol events.
- Persist sessions, transcripts, and append logs.
- Provide tools, approval policy, auth, storage, and observability.
- Compact context and decide memory/search policy.

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
