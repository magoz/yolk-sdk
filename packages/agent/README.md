# @yolk-sdk/agent

Domain-free agent protocol, loop, runtime, client, compaction, tools, React, providers, OAuth, skillset, and voice primitives.

Root export is intentionally tiny. Import feature APIs from explicit subpaths.

## Install

```bash
pnpm add @yolk-sdk/agent@canary effect
```

Add `react` if you use `@yolk-sdk/agent/react`.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath                                               | Purpose                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `@yolk-sdk/agent/protocol`                            | Wire messages, events, content, usage, tool schemas             |
| `@yolk-sdk/agent/loop`                                | Stateless LLM/tool loop                                         |
| `@yolk-sdk/agent/loop/testing`                        | Faux provider and tool executor test helpers                    |
| `@yolk-sdk/agent/runtime`                             | Transcript or append-backed runtime orchestration               |
| `@yolk-sdk/agent/client`                              | HTTP/NDJSON transport, HITL resume, retry/error state helpers   |
| `@yolk-sdk/agent/compaction`                          | Host-owned compaction budgets, checkpoints, formatting, retry   |
| `@yolk-sdk/agent/tools`                               | Tool module registry, `makeTool`, task/question tool contracts  |
| `@yolk-sdk/agent/react`                               | Headless React chat hook, reducer, selectors, and render model  |
| `@yolk-sdk/agent/oauth`                               | Provider-neutral OAuth token and broker contracts               |
| `@yolk-sdk/agent/providers/openai`                    | OpenAI/Codex OAuth and broker helpers                           |
| `@yolk-sdk/agent/providers/openai/codex`              | OpenAI Codex request and auth helpers                           |
| `@yolk-sdk/agent/providers/openai/codex-provider`     | Codex LLM provider factory                                      |
| `@yolk-sdk/agent/providers/openai/provider`           | OpenAI-compatible LLM provider factory                          |
| `@yolk-sdk/agent/providers/openai/realtime`           | OpenAI Realtime session config and event codecs                 |
| `@yolk-sdk/agent/providers/openai/speech`             | OpenAI text-to-speech and transcription adapters                |
| `@yolk-sdk/agent/providers/anthropic`                 | Anthropic/Claude OAuth and broker helpers                       |
| `@yolk-sdk/agent/providers/anthropic/claude`          | Claude request and auth helpers                                 |
| `@yolk-sdk/agent/providers/anthropic/claude-provider` | Claude LLM provider factory                                     |
| `@yolk-sdk/agent/skillset`                            | Portable skill and slash-command parsing/catalogs               |
| `@yolk-sdk/agent/voice`                               | Voice protocol, controller, tool handler, projection, speech    |
| `@yolk-sdk/agent/voice/browser`                       | Browser WebRTC voice transport                                  |
| `@yolk-sdk/agent/voice/react`                         | Headless browser voice React hook                               |

## Imports

```ts
import {
  danglingHostToolCalls,
  hitlResponseEvent,
  isTerminalAgentEvent,
  makeSubagentRunId,
  ProviderErrorInfo,
  questionResponseStructuredContent,
  repairDanglingHostToolCalls,
  UserMessage,
  validateNoDanglingHostToolCalls
} from '@yolk-sdk/agent/protocol'
import { run } from '@yolk-sdk/agent/loop'
import { runRuntime } from '@yolk-sdk/agent/runtime'
import {
  documentPartFromTextFile,
  initialAgentClientState,
  streamAgentEventStreamUntilTerminal,
  toolRunsFromHitlRequests
} from '@yolk-sdk/agent/client'
import {
  makeContextBudget,
  makePreviewSummaryMessage,
  makeWindowCompactionTransformer
} from '@yolk-sdk/agent/compaction'
import {
  makeNonRecursiveTaskToolModule,
  makeTaskToolResult,
  modelVisibleToolError,
  modelVisibleToolErrorStructuredContent,
  makeQuestionToolModule,
  resolveTools
} from '@yolk-sdk/agent/tools'
import {
  applyAgentEventToChatProjection,
  makeAgentChatEventProjectionState,
  useAgentChat
} from '@yolk-sdk/agent/react'
import { makeOpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai/provider'
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

## Provider configuration

Provider output limits are required and host-owned. Yolk does not infer model limits or apply hidden
fallbacks.

| Provider factory                       | Required output-limit field |
| -------------------------------------- | --------------------------- |
| `makeOpenAiProviderLayer`              | `maxCompletionTokens`       |
| `makeOpenAiCodexProviderLayer`         | `maxOutputTokens`           |
| `makeAnthropicClaudeProviderLayer`     | `maxTokens`                 |

The public `toOpenAiRequestBody`, `toOpenAiCodexRequestBody`, and
`toAnthropicClaudeRequestBody` helpers require the same limit configuration. ChatGPT subscription
Codex rejects vendor `max_output_tokens`, so the Codex adapter retains the required host config but
omits that field from requests. `OpenAiProviderLayer` reads both `OPENAI_API_KEY` and integer
`OPENAI_MAX_COMPLETION_TOKENS` through Effect Config.

## Provider failures and retries

Provider adapters classify safe failure metadata at the boundary. The loop owns bounded retry
policy and emits protocol-visible retry/error state:

- `ProviderErrorInfo` carries safe provider id, failure kind, HTTP status, provider code, and
  optional `retryAfterMs`.
- `AgentRetry.provider` exposes current retry metadata and chosen `delayMs`.
- `AgentError.provider` preserves final terminal metadata.
- `AgentErrorCode` includes `rate_limit`, `overloaded`, `context_overflow`, and generic
  `provider_error`.
- Client and React state keep `error: string | null` for compatibility and add typed `errorInfo` /
  `retryInfo`.
- `buildAgentChatItems` can project active retry state as an `AgentChatItem` with `_tag: 'Retry'`.
- Anthropic prompt-too-long responses become non-retryable `context_overflow`; the host-owned
  compaction wrapper may compact and retry once.
- Anthropic `max_tokens` completion fails as non-retryable `invalid_response` instead of reporting
  a truncated turn as complete.

Raw provider response bodies stay out of protocol/UI. Hosts own durable persistence and display of
typed retry/error state.

## Usage accounting

Provider `LLMUsage` events are additive deltas. Adapters normalize vendor counters before emitting;
for example, Anthropic stream snapshots become deltas and cached input tokens count toward input
totals. The loop aggregates usage and emits protocol `UsageUpdate` / terminal usage for hosts to
persist or display.

## Context compaction

`@yolk-sdk/agent/compaction` provides pure budgeting, planning, estimation, checkpoint, and
formatting utilities plus Effect-native context-transformer and provider-retry adapters. It does
not summarize or persist checkpoints. Hosts own thresholds, summary policy, durable storage, and
active-run guards. The one-shot context-overflow wrapper calls your host compactor.

```ts
import {
  makeContextBudget,
  makePreviewSummaryMessage,
  makeWindowCompactionTransformer
} from '@yolk-sdk/agent/compaction'

const budget = makeContextBudget({
  contextWindowTokens: 200_000,
  reservedOutputTokens: 20_000,
  warningRatio: 0.8,
  compactionRatio: 1
})

const ContextLayer = makeWindowCompactionTransformer({
  strategy: 'window-summary-v1',
  thresholdTokens: budget.compactionInputTokens,
  tailMessageCount: 16,
  makeSummaryMessage: messages => makePreviewSummaryMessage(messages)
})
```

The default estimator uses provider-neutral character and media heuristics. Pass
`TokenEstimateOptions.countTextTokens` to improve estimates for selected message text, reasoning,
and host tool-call identifiers, or pass a whole-transcript `estimateTokens` to planners and
transformers. Exact provider-request accounting must also include system prompts, tool definitions,
vendor framing, and a safety margin. Reuse one estimator for warnings, planning, and before/after
checks; tokenizer dependencies remain host-owned.

## Protocol content

`Content` is either plain text or ordered parts:

- `TextPart`
- `ImagePart` with `InlineBase64`, `Url`, or host-owned `Ref` source
- `DocumentPart` with `InlineBase64`, `Url`, or host-owned `Ref` source
- `AudioPart` with `InlineBase64`, `Url`, or host-owned `Ref` source

Build sources with `inlineBase64AttachmentSource`, `urlAttachmentSource`, or
`refAttachmentSource`. Providers can pass through supported media URLs: OpenAI Chat supports image
URLs; OpenAI Codex supports image and document URLs; Anthropic supports image and PDF URLs. Use
inline base64 for simple apps, durable URLs for app-owned uploads, or persist `Ref` values and call
`resolveContentAttachmentSources` at your storage boundary before provider execution. Host apps own
upload, auth, retention, URL durability, and ref hydration policy.

OpenAI Codex preserves text, image, and document `ToolResultMessage` parts as native function output
content. Anthropic Claude preserves text, images, inline text documents, and URL/base64 PDFs as
nested tool-result content. Audio and unresolved `Ref` sources still fail before the provider
request.

```ts
import { ImagePart, UserMessage, urlAttachmentSource } from '@yolk-sdk/agent/protocol'

const message = UserMessage.make({
  content: [
    ImagePart.make({
      source: urlAttachmentSource('https://cdn.example.com/image.webp'),
      mimeType: 'image/webp'
    })
  ]
})
```

For text files, use `documentPartFromText`, `inferTextDocumentMimeType`, and the client helper
`documentPartFromTextFile` to create UTF-8 inline
`DocumentPart` values without trusting filename extensions over explicit non-text MIME types.

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

## Replay-safe chat projection

Durable transports may reconnect or replay overlapping chunks. Protocol events can carry optional
`eventId`; `LLMTextDelta` and `LLMReasoningDelta` can also carry `textSoFar` / `reasoningSoFar`
snapshots when a host can provide cumulative text.

Use `applyAgentEventToChatProjection` for replayable event logs:

```ts
import {
  applyAgentEventToChatProjection,
  makeAgentChatEventProjectionState
} from '@yolk-sdk/agent/react'

const projection = events.reduce(
  (state, event) => applyAgentEventToChatProjection(state, event),
  makeAgentChatEventProjectionState()
)
```

Use `applyAgentEventToChatMessages` only for ephemeral local streams where append-only deltas cannot
replay.

## Transcript invariants

Every assistant host tool call must be followed by a matching `ToolResultMessage` before the next
non-tool message/provider request. Use `validateNoDanglingHostToolCalls` for preflight checks,
`danglingHostToolCalls` for diagnostics, and `repairDanglingHostToolCalls` only when loading older
persisted transcripts that already have gaps. Built-in providers reject dangling host tool calls
before vendor lowering with a non-retryable validation error.

## Human-in-the-loop

HITL is protocol-level, not UI-level:

- Add `approval: { mode: 'manual' }` to a `ToolDef` to pause before execution.
- `run` / `runRuntime` emit `ToolApprovalRequested` then `AgentAwaitingInput`.
- Resume by passing `hitlResponses`, using `useAgentChat` methods like
  `submitToolApprovalResponse` / `submitQuestionResponse`, or using client stream helpers like
  `streamToolApprovalResponseEventStream`.
- Denials become model-visible `ToolResult` messages with `isError = true`.
- Use `makeQuestionToolModule` to expose the package-owned `question` tool; answers resume as structured tool results and model-visible text with selected labels.
- Use `questionResponseStructuredContent` / `plainHitlResponse` before storing durable HITL payloads that must be plain JSON.
- Use `toolRunsFromHitlRequests` to hydrate paused UI state from `AgentAwaitingInput.requests`.
- Use `hitlResponseEvent` when a client needs optimistic approval/question UI updates before resumed stream events arrive.
- Approval is a host-enforced per-call gate for normal tools, not a model-callable permission tool or persisted allow-always system.

HTTP client helpers treat `AgentEnd`, `AgentError`, and `AgentAwaitingInput` as logical stream
end for consumers. Use `isTerminalAgentEvent` when projecting generic protocol streams. After a
terminal event the response body drains to EOF; cancellation before a terminal event still aborts
the active body reader.
Durable Workflow clients can use `streamAgentEventStreamUntilTerminal`,
`streamAgentRunEventStreamUntilTerminal`, and `streamAgentRunHitlResponseEventStreamUntilTerminal` to follow
continuation chunks by `x-workflow-run-id` and `x-workflow-stream-tail-index` headers. These helpers
fail with `AgentTransportError` if no terminal event is reached before the continuation limit.
Empty non-terminal continuation chunks are polling gaps: the client waits briefly, retries from the
same `startIndex`, and respects the request `signal` while waiting.
Outbound `startIndex` values must be non-negative safe integers; invalid values fail before the
HTTP request is sent.
For HITL resume responses, `x-workflow-stream-tail-index` means the stream tail before the returned
body. The returned body starts at `tail + 1`; the next continuation starts after all returned
events. `continuationLimit: 0` disables follow-up chunks, so any non-terminal response fails
immediately.

```ts
import { Stream } from 'effect'
import { streamAgentEventStreamUntilTerminal } from '@yolk-sdk/agent/client'
import { UserMessage } from '@yolk-sdk/agent/protocol'

const events = Stream.toAsyncIterable(
  streamAgentEventStreamUntilTerminal({
    endpoint: '/api/agent/workflow',
    sessionId: 'session_1',
    messages: [UserMessage.make({ content: 'Hello' })],
    runEndpoint: runId => `/api/agent/workflow/${encodeURIComponent(runId)}`
  })
)

for await (const event of events) {
  // Apply AgentEvent to app state.
}
```

The SDK client does not own durable route auth, run ownership, Workflow hook-token routing, or HITL
request matching. Hosts expose the run endpoints and validate access/response identity server-side.

## Voice

Voice is a first-class modality: browser WebRTC transport, client controller, server tool
handler, approval HITL, transcript projection, and one-shot TTS/STT contracts.

- `useYolkVoice` (`@yolk-sdk/agent/voice/react`) owns browser session lifecycle, user drafts,
  and pending approvals; provider codecs come from `@yolk-sdk/agent/providers/openai/realtime`.
- Tools execute server-side only: the controller forwards provider tool calls as
  `VoiceSessionToolCallRequest` to your endpoint; `handleVoiceToolCall` applies
  `ToolDef.approval` policy and never runs approval-gated tools without a matching approved
  response.
- Approval-gated calls pause with `AwaitingInput`; approvals/denials resume through
  `submitHitlResponse`. Voice `question` is deferred in v1.
- `projectVoiceEvent` turns voice events into protocol messages with no dangling host tool
  calls. Assistant drafts are keyed per provider output item (falling back to response id), so
  back-to-back responses, multi-item responses, and duplicate final transcript event families
  never concatenate, wipe, or duplicate messages. `sequenceVoiceEvent`/`dedupeStoredVoiceEvents`
  give replay-safe durable event ids; `voiceSeedTextsFromMessages` seeds new provider sessions
  after reconnect, optionally prefixing user seeds with author display names via
  `{ includeAuthors: true }` for multi-user transcripts.
- `makeWebSocketVoiceTransport` covers Node/server realtime sessions;
  `@yolk-sdk/agent/providers/openai/speech` provides `makeOpenAiSpeechSynthesizerLayer` and
  `makeOpenAiTranscriberLayer` for the provider-neutral voice services.
  `VoiceSpeechRequest.instructions` steers delivery style only, and
  provider 429s (rate limit or exhausted credits) surface as `VoiceSpeechError` code
  `rate_limited` so hosts can distinguish quota from outage.

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
- optionally configure model and reasoning-effort choices so the parent can select child runtime settings
- treat omitted `model` and `reasoning_effort` parameters as inheritance of host runtime settings
- return `makeTaskToolResult(...)` so UI can show subagent id, type, status, model, reasoning effort, and timing

Keep host-owned subagent execution wiring outside this package; pass only the package task contract across the boundary.

## Tool failures

Use `modelVisibleToolError(...)` for expected tool-domain failures the model can recover
from, such as invalid arguments, not-found resources, denied policy, or unavailable upstream
data. `makeTool` converts these failures into `ToolResult.isError = true` so the agent can
see the message and continue. The result includes structured content with `type`, `tool`,
`reason`, `message`, and optional `details` for UI/runtime handling.

Thrown `ToolError`s become model-visible failed tool results plus `ToolExecutionError` events,
so keep messages safe and non-secret. Reserve stream failure for provider/runtime defects,
aborts, and implementation bugs outside typed tool execution.

## Host responsibilities

- Choose models/providers and provide an LLM provider layer, using SDK provider subpaths or host adapters.
- Configure model-specific provider output-token limits.
- Persist sessions, transcripts, and append logs.
- Persist/return one `ToolResultMessage` for every host tool call, including `isError` failures.
- Persist terminal provider failures and clear active run ids where applicable.
- Provide tools, approval policy, auth, storage, and observability.
- Compact context and decide memory/search policy.

## Boundaries

- Core loop/protocol/runtime/tools have no React, Next.js, provider SDKs, auth, storage drivers, or app concepts.
- `@yolk-sdk/agent/compaction` combines pure planning/formatting helpers with Effect-native transformer and retry adapters; hosts own thresholds, summaries, compaction payloads, and durable compactor policy.
- `@yolk-sdk/agent/react` is headless and uses React as an optional peer.
- Provider subpaths own vendor wire/auth mechanics only; hosts own token storage, refresh, routing, and policy.
- `@yolk-sdk/agent/providers/openai/speech` is server integration requiring runtime
  `FormData`/`Blob`, a host `HttpClient` layer, and a secret API key; do not invoke it from browser
  code.
- Loop stays stateless: transcript in, events out.
- Runtime owns generic session orchestration only; host apps own persistence adapters and policy.
- Client HTTP helpers are runtime-portable with a host `HttpClient` layer. Attachment helpers need
  `Blob`/`File` and may use `FileReader`; the Cloudflare WebSocket transport needs the global
  `WebSocket` constructor when its stream runs. None read browser globals at import time.
- Tools model generic metadata/execution; host apps own concrete tool catalogs.
- `task` is the standard subagent delegation tool. Packages define the schema; host apps execute subagents and omit `task` from subagent toolsets in v1.

## Testing

Use `@yolk-sdk/agent/loop/testing` for deterministic provider/tool tests.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports only.
- No top-level env reads, network calls, SDK clients, or service construction.
