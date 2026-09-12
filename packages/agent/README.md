# @yolk-sdk/agent

Domain-free agent protocol, loop, runtime, Effect-native client, compaction, tools, React, providers, OAuth, skillset, and voice primitives.

Root export is intentionally empty. Import feature APIs from explicit subpaths.

## Install

```bash
pnpm add @yolk-sdk/agent@canary effect@4.0.0-beta.80
```

Add `react` if you use `@yolk-sdk/agent/react` or `@yolk-sdk/agent/voice/react`.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0-beta.80`) in host code.
Published package metadata requires Node.js 22+.

## Subpaths

| Subpath                                                | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `@yolk-sdk/agent/protocol`                             | Wire messages, events, content, usage, tool schemas            |
| `@yolk-sdk/agent/loop`                                 | Stateless LLM/tool loop                                        |
| `@yolk-sdk/agent/loop/testing`                         | Faux provider and tool executor test helpers                   |
| `@yolk-sdk/agent/runtime`                              | Transcript or append-backed runtime orchestration              |
| `@yolk-sdk/agent/client`                               | HTTP/NDJSON transport, HITL resume, retry/error state helpers  |
| `@yolk-sdk/agent/compaction`                           | Host-owned compaction budgets, checkpoints, formatting, retry  |
| `@yolk-sdk/agent/tools`                                | Tool registry, `makeTool`, subagent/question contracts         |
| `@yolk-sdk/agent/react`                                | Headless React chat hook, reducer, selectors, and render model |
| `@yolk-sdk/agent/oauth`                                | Provider-neutral OAuth token and broker contracts              |
| `@yolk-sdk/agent/providers/openai`                     | OpenAI/Codex OAuth and broker helpers                          |
| `@yolk-sdk/agent/providers/openai/codex`               | OpenAI Codex request and auth helpers                          |
| `@yolk-sdk/agent/providers/openai/codex-usage`         | Codex subscription-allowance snapshots                         |
| `@yolk-sdk/agent/providers/openai/codex-provider`      | Codex LLM provider factory                                     |
| `@yolk-sdk/agent/providers/openai/provider`            | OpenAI-compatible LLM provider factory                         |
| `@yolk-sdk/agent/providers/openai/realtime`            | OpenAI Realtime session config and event codecs                |
| `@yolk-sdk/agent/providers/openai/speech`              | OpenAI text-to-speech and transcription adapters               |
| `@yolk-sdk/agent/providers/vercel/ai-gateway-provider` | Vercel AI Gateway Chat Completions provider factory            |
| `@yolk-sdk/agent/providers/anthropic`                  | Anthropic/Claude OAuth and broker helpers                      |
| `@yolk-sdk/agent/providers/anthropic/claude`           | Claude request and auth helpers                                |
| `@yolk-sdk/agent/providers/anthropic/usage`            | Claude subscription-allowance snapshots                        |
| `@yolk-sdk/agent/providers/anthropic/claude-provider`  | Claude LLM provider factory                                    |
| `@yolk-sdk/agent/providers/xai`                        | Grok subscription OAuth and token broker helpers               |
| `@yolk-sdk/agent/providers/xai/grok`                   | Grok subscription request and auth helpers                     |
| `@yolk-sdk/agent/providers/xai/grok-provider`          | Grok subscription LLM provider factory                         |
| `@yolk-sdk/agent/providers/xai/usage`                  | Grok subscription-allowance snapshots                          |
| `@yolk-sdk/agent/providers/subscription-usage`         | Shared allowance snapshot and safe error schemas               |
| `@yolk-sdk/agent/skillset`                             | Portable skill and slash-command parsing/catalogs              |
| `@yolk-sdk/agent/voice`                                | Voice protocol, controller, tool handler, projection, speech   |
| `@yolk-sdk/agent/voice/browser`                        | Browser WebRTC voice transport                                 |
| `@yolk-sdk/agent/voice/react`                          | Headless browser voice React hook                              |

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
  makeNonRecursiveSubagentToolModule,
  makeSubagentToolResult,
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
import { makeVercelAiGatewayProviderLayer } from '@yolk-sdk/agent/providers/vercel/ai-gateway-provider'
```

Test helpers live behind their own subpath:

```ts
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
```

## Headless React chat

`useAgentChat` exposes protocol messages, render-oriented chat messages, run/error/waiting state,
and actions for submit, stop, edit, regenerate, delete, tool approval, and question responses. The
package supplies no components, styling, auth, or route ownership, and React remains an optional
peer used only by React subpaths.

By default the hook streams HTTP/NDJSON through `@yolk-sdk/agent/client`. Pass an
`AgentChatTransport` through the `transport` option to use another runtime. A custom transport
receives the transcript, session/model options, HITL responses, and an `AbortSignal`, and returns an
`AsyncIterable<AgentEvent>`; the host still owns endpoint auth and persistence.

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

Loop composition is those four Layers plus `run` / `runModelTurn` / `runToolBatch`.
Intercept by decorating a service (`decorateLLMProvider`), not with hooks.
Durable hosts fold model-turn steps with `collectModelTurn`. Use `collectModelTurnAttempt` when the fold must retain partial output after a failed stream. Kernel incomplete streams (zero `Done` events) set optional `LLMError.responseIssue: 'missing_done'` and stay `invalid_response` / `retryable: false`.

## OAuth credentials

`@yolk-sdk/agent/oauth` defines provider-neutral access-token, broker, freshness, and credential-source
contracts. Provider subpaths add vendor request/response conversion without owning persistence.

```ts
import { credentialSourceFromBroker, type TokenBrokerClient } from '@yolk-sdk/agent/oauth'

const makeTokenProgram = (hostBroker: TokenBrokerClient) =>
  credentialSourceFromBroker(hostBroker, {
    provider: 'openai-codex',
    subjectId: 'host-user-id'
  }).getAccessToken({ minTtlSeconds: 300 })
```

`hostBroker` is a host implementation of `TokenBrokerClient`. The host stores, refreshes, revokes,
and authorizes credentials; the package receives short-lived access tokens and never persists
secrets.

## Provider configuration

Provider output limits are host-owned when the endpoint supports them. Yolk does not infer model
limits or apply hidden fallbacks.

| Provider factory                   | Output-limit field    |
| ---------------------------------- | --------------------- |
| `makeOpenAiProviderLayer`          | `maxCompletionTokens` |
| `makeVercelAiGatewayProviderLayer` | `maxCompletionTokens` |
| `makeOpenAiCodexProviderLayer`     | none                  |
| `makeAnthropicClaudeProviderLayer` | `maxTokens`           |
| `makeXAiGrokProviderLayer`         | `maxOutputTokens`     |

The public `toOpenAiRequestBody`, `toAnthropicClaudeRequestBody`, and `toXAiGrokRequestBody` helpers
require the matching limit configuration. ChatGPT subscription Codex rejects vendor
`max_output_tokens`, so `makeOpenAiCodexProviderLayer` and `toOpenAiCodexRequestBody` ignore the
optional deprecated `maxOutputTokens` compatibility field. `OpenAiProviderLayer` reads both
`OPENAI_API_KEY` and integer `OPENAI_MAX_COMPLETION_TOKENS` through Effect Config.

Vercel AI Gateway uses its OpenAI-compatible JSON Chat Completions endpoint. Pass either an AI
Gateway API key or Vercel OIDC token as `apiKey`; `maxCompletionTokens` is sent as Gateway
`max_tokens`. The env-backed `VercelAiGatewayProviderLayer` tries `AI_GATEWAY_API_KEY` first, then
`VERCEL_OIDC_TOKEN`, and requires integer
`AI_GATEWAY_MAX_COMPLETION_TOKENS`. Model ids are opaque `provider/model` strings. Hosts may set
`fallbackModels`, provider `routing`, and optional `http-referer` / `x-title` attribution headers.
A request `reasoningEffort` is sent as Gateway `{ reasoning: { effort } }` for any opaque model id;
hosts remain responsible for offering only efforts supported by the selected model. Required
authorization and JSON headers cannot be replaced through `extraHeaders`. Only override
`chatCompletionsUrl` with a trusted proxy because it receives the bearer credential.

Grok subscription access uses `https://cli-chat-proxy.grok.com/v1/responses`, not the xAI developer
API-key endpoint. The adapter sends the required CLI-session and model-routing headers and rejects
mismatched or expired access-token envelopes before HTTP. `makeXAiGrokProviderLayer` also requires
a truthful host-owned `clientVersion`, sent as `x-grok-client-version`, because the xAI CLI proxy
version-gates requests and rejects missing or outdated versions with HTTP 426; required headers
stay non-overridable through `extraHeaders`. The package exports browser-PKCE and
device-flow constants; hosts own the callback listener or device polling, token exchange/refresh,
secure storage, and model discovery. Only set `responsesUrl` to a trusted proxy because it receives
the OAuth bearer. xAI controls the public CLI OAuth client and private, unsupported proxy contract,
so hosts should treat those surfaces as changeable and confirm that their use complies with xAI
terms.

Set optional `reasoningEffort` on `run` or `runRuntime`; provider adapters lower it to vendor
configuration. Anthropic Claude forwards `low`, `medium`, `high`, and `xhigh` through
`output_config.effort`. It omits `minimal`, which Anthropic does not support. Hosts remain
responsible for choosing an effort accepted by the selected provider and model.

### Anthropic tool schemas

Claude subscription OAuth rejects some valid JSON Schema constructs that Effect Schema can emit
for unions, refinements, and tuples. The Claude adapter therefore projects tool parameters to a
provider-compatible object schema without `anyOf`, `oneOf`, `allOf`, or tuple-only `prefixItems`.
When a constraint cannot be represented faithfully, the projection widens the model-facing schema
rather than excluding a valid call. Tool execution remains safe because `makeTool` validates the
returned arguments against the original Effect Schema before invoking the executor.

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
- Anthropic `max_tokens` and OpenAI-compatible `finish_reason: "length"` / `"content_filter"`
  completions fail as non-retryable `invalid_response` instead of reporting truncated or filtered
  output as complete.

Raw provider response bodies stay out of protocol/UI. Hosts own durable persistence and display of
typed retry/error state.

## Subscription allowance snapshots

The Claude, Codex, and Grok usage adapters read best-effort consumer subscription allowance
percentages and reset windows. Claude normalizes its aggregate five-hour and seven-day windows;
Codex normalizes primary and secondary rate-limit windows; Grok normalizes its aggregate shared
credit allowance. Additional provider-specific buckets are ignored. These private provider
endpoints may change without notice. Pass a fresh host-owned `OAuthAccessToken` and provide an
Effect `HttpClient`:

```ts
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { fetchOpenAiCodexSubscriptionUsage } from '@yolk-sdk/agent/providers/openai/codex-usage'

const snapshot = await fetchOpenAiCodexSubscriptionUsage(hostOAuthAccessToken).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.runPromise
)
```

Use `fetchAnthropicClaudeSubscriptionUsage` from
`@yolk-sdk/agent/providers/anthropic/usage` for Claude. Use
`fetchXAiGrokSubscriptionUsage` from `@yolk-sdk/agent/providers/xai/usage` for Grok and pass the
actual authenticated xAI `user_id` as `xAiUserId`. The generic token `accountId` is not interpreted
as an xAI user id. Also pass your host integration's truthful version as `clientVersion`; the
adapter sends it with `x-grok-client-mode: headless` and never claims an official Grok client
version.

Provider adapters return an immutable Effect `Chunk` of semantic window ids, percentages, and
optional reset/duration fields; hosts own labels, polling, persistence, stale-data policy, alert
thresholds, billing interpretation, and UI. Configure `requestTimeoutMs` at the server integration
boundary. Endpoint origins stay fixed, and `FetchHttpClient.layer` is configured for manual
redirects. A custom `HttpClient` must not follow redirects for these credential-bearing requests.

Subscription allowance snapshots are separate from protocol `AgentUsage`, which accounts for tokens
used by model requests and nested model work.

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

## Skillsets

`@yolk-sdk/agent/skillset` parses skill Markdown and slash-command Markdown into portable
`SkillInfo`, `CommandInfo`, and `SkillsetManifest` data. Use `parseSkillMarkdown` /
`parseCommandMarkdown` at file or database boundaries, `renderCommand` for command invocation, and
`mergeSkillsets` to combine host sources. Earlier sources win name conflicts; duplicate names
inside one source fail validation. Hosts own file discovery, storage, enablement, and source order.

## Protocol content

`Content` is either plain text or ordered parts:

- `TextPart`
- `ImagePart` with `InlineBase64`, `Url`, or host-owned `Ref` source
- `DocumentPart` with `InlineBase64`, `Url`, or host-owned `Ref` source
- `AudioPart` with `InlineBase64`, `Url`, or host-owned `Ref` source

Build sources with `inlineBase64AttachmentSource`, `urlAttachmentSource`, or
`refAttachmentSource`. Providers can pass through supported media URLs: OpenAI Chat and Vercel AI
Gateway support image URLs; OpenAI Codex supports image and document URLs; Anthropic supports image
and PDF URLs. The Grok
Responses lowerer can encode image URLs/data URLs, but hosts should enable image capability only for
subscription models they have verified accept image input. Use
inline base64 for simple apps, durable URLs for app-owned uploads, or persist opaque `Ref` values and
resolve them immediately before each provider attempt. `resolveContentAttachmentSources` handles one
`Content`; `resolveMessageAttachmentSources` and `resolveMessagesAttachmentSources` also walk assistant
text and nested provider tool results, preserving metadata and ordering without mutating history.
All accept `AttachmentSourceResolver<E, R>`, preserve typed Effect errors/services, and leave opaque
tool/provider payloads alone. Resolution does not add provider media capabilities or cache sources.

Host apps own upload, authorization, byte/MIME limits, retention, and fresh signing. Put a host
resolving provider wrapper inside `makeContextOverflowRetryProvider` so compaction sees refs and each
retry signs the effective context afresh. Never persist the resolved copy. See the
[private attachment guide](../../apps/docs/content/docs/guides/private-attachments.mdx) for the
host-owned composition and bounded connector transport.

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

When the host promotes queued user input into a durable stream, emit a replay-safe user event:

```ts
import { UserMessage, UserMessageEvent } from '@yolk-sdk/agent/protocol'

const event = UserMessageEvent.make({
  eventId: 'session_1:user-message_42',
  message: UserMessage.make({ content: 'Please also compare the alternatives.' })
})
```

The host owns queueing and promotion policy and must assign a stable `eventId` so reconnects do not
project the same promoted message twice.

## Parallel tool calls

OpenAI, Vercel AI Gateway, OpenAI Codex, and Grok requests enable vendor parallel tool calls when tools are available. The
Codex stream adapter preserves every sibling function call and suppresses final-response replays
by call id. The loop executes calls emitted in the same model turn concurrently, bounded by the
host-configured `LoopConfig.toolConcurrency`; dependent work waits for the next model turn.

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
- Use `makeQuestionToolModule` to expose the package-owned `question` tool; answers resume as structured tool results and model-visible text with selected labels. The loop intercepts questions only when the tool is enabled in `tools`; omitted questions return an unavailable result without HITL or executor dispatch, even if a provider emits one.
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
- Tools execute server-side only: the controller forwards the normalized
  `VoiceSessionToolCallRequest` JSON envelope to your endpoint; `handleVoiceToolCall` returns a
  JSON-compatible `VoiceToolCallOutcome` envelope, applies `ToolDef.approval` policy, and never runs
  approval-gated tools without a matching approved response.
- Approval-gated calls pause with `AwaitingInput`; approvals/denials resume through
  `submitHitlResponse`. Voice `question` is deferred in v1.
- `projectVoiceEvent` turns voice events into protocol messages with no dangling host tool
  calls. Assistant drafts are keyed per provider output item (falling back to response id), so
  back-to-back responses, multi-item responses, and duplicate final transcript event families
  never concatenate, wipe, or duplicate messages. `sequenceVoiceEvent`/`dedupeStoredVoiceEvents`
  give replay-safe durable event ids; `voiceSeedTextsFromMessages` seeds new provider sessions
  after reconnect, optionally prefixing user seeds with author display names via
  `{ includeAuthors: true }` for multi-user transcripts.
- `makeWebSocketVoiceTransport` covers Node/server realtime sessions and requires a host-provided
  `Socket.WebSocketConstructor` layer, such as `Socket.layerWebSocketConstructorGlobal`;
  `@yolk-sdk/agent/providers/openai/speech` provides `makeOpenAiSpeechSynthesizerLayer` and
  `makeOpenAiTranscriberLayer` for the provider-neutral voice services.
  `VoiceSpeechRequest.instructions` steers delivery style only, and
  provider 429s (rate limit or exhausted credits) surface as `VoiceSpeechError` code
  `rate_limited` so hosts can distinguish quota from outage.

## Subagents

`subagent` is the package-owned contract for child-agent delegation. The SDK provides schema,
validation, non-recursive module wiring, subagent result extraction, and structured result
metadata. Host apps provide inline or independently durable child execution.

Recommended setup:

- expose `makeNonRecursiveSubagentToolModule` only to the top-level agent
- resolve subagent tools with `subagent: true`
- omit `subagent` from subagent toolsets
- include only tools that are safe for autonomous delegated work
- use `makeSubagentRunId(call.id)` for protocol-aligned run ids
- optionally configure model and reasoning-effort choices so the parent can select child runtime settings
- treat omitted `model` and `reasoning_effort` parameters as inheritance of host runtime settings
- return `makeSubagentToolResult(...)` so UI can show subagent id, type, status, model, reasoning effort, timing, optional usage/turns, and typed failure metadata
- use `subagentUsageFromToolResult(...)` when a host must add child usage to cumulative workflow usage

Durable hosts may opt into `background: true` in the tool registration options. This advertises
an optional model parameter `background`; inline hosts keep their existing schema and behavior.
Return `makeSubagentAcceptedToolResult({ callId, workflowRunId, parentRunId })` for background acceptance.
The optional parent identity lets a later conversation run address the original child. Keep
acceptance independent of how quickly the child finishes.
It emits normal tool completion but **not** `SubagentCompleted`, and carries no usage. Keep the
logical `subagent:<toolCallId>` identity separate from the physical Workflow id. Never append a
second tool result for the original launch; expose host-owned status/wait tools whose observations
do not masquerade as fresh child usage. Host-owned storage must remain readable after parent end.

A lost control response or exhausted observation budget is not a terminal child failure. Hosts
can return a `ToolResult` with `structuredContent.type: 'subagent_observation'` and a matching
`subagent_run_id: makeSubagentRunId(call.id)`. The loop completes the tool observation but suppresses
`SubagentCompleted`; nested results do not contribute child usage. Include truthful status and an
owned recovery handle in the observation. Use normal final results for genuine terminal outcomes,
not this marker. These child observations are separate from generic background tool `acceptance`.

`prepareToolBatch` from `@yolk-sdk/agent/loop` exposes the same HITL preflight used by the loop.
Durable orchestration must check `pendingRequests` before dispatching **any** tool, even calls
listed in `callsToExecute`. Preserve synthetic results and original call ordering when committing.

Keep host-owned subagent execution wiring outside this package; pass only the package subagent contract across the boundary.

## Background tool calls

Any `makeTool` registration can opt into model-chosen background execution with `background: true`.
The flag is inert until `resolveTools(modules, context, { backgroundHost })` receives a
`BackgroundToolHost`, which asserts a real lifecycle owner (durable run, queue, or session) exists.
Without a host, definitions, approval ids, and inline behavior are unchanged.

- Activated tools advertise a required `{ execution: 'foreground' | 'background', arguments }`
  envelope; the original parameter schema nests under `arguments` and `$defs` stay at the root.
  Only document-root `#/$defs/...` references (without percent-encoded fragments) are supported.
  Other reference forms and resource/anchor keywords (`$id`, legacy `id`, `$anchor`, `$dynamicAnchor`,
  `$dynamicRef`, `$recursiveAnchor`, `$recursiveRef`) fail activation with
  `ToolRegistryError.cause: 'background_unsupported_schema'`. Literal defaults/examples/const/enum
  data are not traversed as schemas.
- The registry validates the envelope and original parameters without business effects, strips the
  control fields, then executes inline or calls `host.accept({ call, request, context })`.
  `makeTool` invalid business arguments still return structured model-visible errors in either
  mode, without business/admission effects. Raw validator and host errors remain typed failures.
- `accept` returns a versioned `BackgroundToolAccepted` receipt (`{ version: 1, executionId }`),
  never a closure. Make it idempotent per call id; fail with a `ToolError` to decline. The registry
  never falls back to inline execution.
- Use protocol `toolResultMessageFromResult(result, envelope?)` to preserve every result field and
  receipt when creating transcript messages; timestamps/authors remain explicit host inputs.
- The result is one acknowledgement `ToolResult` with typed `acceptance` metadata; the loop emits
  `ToolExecutionAccepted` (no `ToolExecutionCompleted`, no usage). Client state, chat projection,
  and tool cards treat `Accepted` as settled but not completed; active input/approval/Started
  replays cannot replace accepted calls or receipts, including across turn cleanup and hydration.
- Activated definitions are unsupported in voice/realtime, including foreground envelope calls.
  Resolve voice toolsets without a background host. Synchronous realtime tool/config mappers throw
  `VoiceToolBridgeError`; use `toOpenAiRealtimeToolEffect`, `makeOpenAiRealtimeSessionConfigEffect`,
  or `openAiRealtimeSessionConfigFromVoiceEffect` inside Effect programs to catch that typed error.
  Voice handlers deny before approval matching, and the low-level bridge
  rejects activated registry dispatch before validation, inline execution, or admission.
- Raw `ToolRegistration` objects need a side-effect-free `validate` to activate; the loop-owned
  `question` and `subagent` tools cannot activate (subagents keep `makeSubagentAcceptedToolResult`).
- Manual approval fences the whole batch; activated calls bind the approval `requestId` to the tool
  name, mode, and canonical arguments, and malformed envelopes are rejected before any prompt.
  IDs intentionally contain the full canonical payload: hosts must accommodate opaque, potentially
  long IDs or enforce input bounds before admission; never truncate or rebuild them.
- Hosts own authorization, status/wait tools, cancellation, terminal storage, usage, and delivery.
  Never append a second result for the original call.

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
- Store, refresh, revoke, and authorize OAuth credentials; expose only runtime access tokens.
- Configure model-specific provider output-token limits.
- Build UI components and styling, own auth, and wire headless React hooks to host transports.
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
- `subagent` is the standard delegation tool. Packages define the schema; host apps execute subagents and omit `subagent` from child toolsets in v1.

## Testing

Use `@yolk-sdk/agent/loop/testing` for deterministic provider/tool tests.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports only.
- No top-level env reads, network calls, SDK clients, or service construction.
