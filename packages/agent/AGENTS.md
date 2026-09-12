# Agent Package

`@yolk-sdk/agent` is the main package for building and running agents. Root export stays intentionally empty; use explicit subpaths.

## Structure

`package.json` is the export source of truth. See `patterns/PACKAGE_ARCHITECTURE.md` for the public
subpath catalog, dependency direction, physical layout, and tree-shaking constraints.

## Boundaries

- Core subpaths have no React, Next.js, app imports, auth, storage drivers, provider SDKs, or product concepts.
- `src/react` and `src/voice/react.ts` are the only React-using areas; React is an optional peer.
- Provider subpaths own vendor mechanics only; hosts still own token storage/refresh and app policy.
- Subscription-usage adapters expose best-effort snapshots from fixed private provider endpoints. They accept fresh host-owned `OAuthAccessToken` values and an Effect `HttpClient`, force manual Fetch redirect handling, and reject non-2xx redirects; hosts own polling, persistence, stale-data rules, labels, alerts, billing interpretation, and UI. Grok usage additionally requires the actual authenticated xAI `user_id` and a truthful host client version as explicit options; never infer `x-userid` from generic `OAuthAccessToken.accountId` or impersonate an official Grok version.
- Client depends on protocol + Effect HTTP/Stream. HTTP helpers are runtime-portable; attachment helpers require `Blob`/`File` and may use `FileReader`, while Cloudflare WebSocket transport constructs the global `WebSocket` when its stream runs. Browser globals are never read at import time.
- `makeWebSocketVoiceTransport` needs a host `Socket.WebSocketConstructor` layer.
- `voice/browser` is the only WebRTC-using area; it accesses browser globals lazily at transport creation, never at import time, and exposes a `WebRtcVoiceRuntime` seam for fakes. Client attachment/WebSocket helpers also use browser APIs as described above.
- Voice tools execute server-side only: the client `makeVoiceController` forwards provider tool calls to a host endpoint (`VoiceSessionToolCallRequest` in, `VoiceToolCallOutcome` out); `handleVoiceToolCall` applies `ToolDef.approval` policy before the executor and never runs approval-gated tools without a matching approved response.
- Voice HITL supports tool approval only in v1; the package `question` tool is intentionally deferred for voice sessions and `submitHitlResponse` ignores question responses.
- If a voice session ends while awaiting approval, the approval stays pending host-side and the event stream completes; durable resume is host/session-log policy.
- One-shot speech contracts live in voice: `VoiceSpeechSynthesizer`, `VoiceTranscriber`, `VoiceSpeechRequest`, and `speechResultToAudioPart`. `VoiceSpeechRequest.instructions` is delivery-style steering only (tone, pacing), not model-visible content instructions.
- `providers/openai/speech` is host/server integration: it requires runtime `FormData`/`Blob`, an
  Effect `HttpClient`, and a secret API key. Do not invoke it directly from browsers.
- `projectVoiceEvent` keeps assistant drafts per segment key (`itemId`, falling back to `responseId`): a delta for a new segment flushes the previous draft, and finals for already-flushed keys project nothing. Providers emit transcript finals per output item, duplicate final event families, and back-to-back responses; response-level keying wipes later items of the same response, key-less/global drafts concatenate or duplicate.
- `voiceSeedTextsFromMessages` seeds visible text only; pass `{ includeAuthors: true }` to prefix user seeds with author display names for multi-user transcripts (assistant seeds never carry names).
- Segment finals with empty transcripts keep the streamed draft text (truncated/interrupted segments must never lose text the user already heard).
- Voice session logs are host-persisted: `VoiceSessionLogState` is the versioned serializable fold state and `foldStoredVoiceEvents` is the pure, replay-safe batch fold; hosts run it inside their storage transaction and append the returned messages. Bump `VOICE_SESSION_LOG_STATE_VERSION` on breaking state-shape changes.
- Tool lifecycle events use deterministic per-call ids (`voiceToolEventId`); `storedVoiceToolEvents` splits requested batches per call and `storedToolEventsFromOutcome` lets tool endpoints log server-witnessed activity that dedupes against client outbox replays.
- `makeVoiceEventOutbox` (and the `useYolkVoice` `eventLog` option) is client transport mechanics only: at-least-once batching with boundary flushes and a scope-close drain; hosts own the flush endpoint, auth, and storage, and should flush with keepalive-capable transport.
- `@yolk-sdk/agent/tools` owns the domain-free `subagent` tool contract for subagents; host apps provide subagent execution, available model/reasoning choices, prompts, provider layers, and tool policy. Optional subagent runtime selections inherit host settings when omitted.
- `@yolk-sdk/agent/tools` owns the domain-free `question` HITL tool contract; loop intercepts enabled questions before executor dispatch. If omitted from `tools`, even provider-emitted/replayed questions return unavailable results without HITL or executor dispatch.
- `@yolk-sdk/agent/tools` exposes `makeTool` for Effect-Schema-backed registrations; avoid hand-written JSON Schema when validation schema can be the source of truth.
- `ModelVisibleToolError` is for recoverable, model-visible tool failures; `makeTool` returns `ToolResult.isError` with structured `{ type, tool, reason, message, details? }` content.
- Tool approval is host-enforced policy on normal tools, not a model-callable permission tool; v1 approvals are per-call, no persistent allow-always rules.
- Use `EmptyToolParams` for no-arg `makeTool` tools instead of `Schema.Struct({})` when author intent is no parameters.
- v1 subagents may use normal tools but must not receive the `subagent` tool recursively unless a future explicit capability enables it.
- Protocol owns `SubagentStarted`/`SubagentCompleted` and `makeSubagentRunId`; loop emits lifecycle events around `subagent` calls while preserving generic tool lifecycle as the source of truth.

## Protocol/loop rules

- `AgentReasoningEffort` is protocol-only request config; app/provider layers choose and pass through values.
- Anthropic Claude lowers `low`, `medium`, `high`, and `xhigh` reasoning efforts to `output_config.effort`; omit `minimal` and an absent effort because Anthropic does not support that value and must not receive an empty output config.
- Anthropic tool schemas require a provider compatibility projection because Claude subscription OAuth rejects valid JSON Schema constructs that Effect Schema can emit, including `anyOf`, `oneOf`, `allOf`, and tuple-only `prefixItems`. The projection is model guidance only: preserve the original Effect Schema as the execution validator, recursively remove unsupported constructs only in schema positions, keep literal data (`enum`, `const`, defaults, examples) opaque, and widen unrepresentable constraints rather than narrowing the set of originally valid calls. See `patterns/AI_TOOL_SCHEMAS.md`.
- `AgentMessage` envelope fields are optional and model-visible: `createdAtMs`, `author.displayName`, and JSON `annotations`; preserve them through protocol round-trips.
- Provider lowering renders message envelopes via `messageContextText` + `prependMessageContextToContent`; annotations are context only, not instructions.
- `Content = string | ContentPart[]`; parts include text, image, document, and audio. Media parts carry `InlineBase64`, `Url`, or host-owned `Ref` sources. Use protocol helpers (non-exhaustive: source factories, text/preview/parts, emptiness/append, hydration, document inference, attachment accessors) instead of app-local duplication.
- `resolveMessageAttachmentSources` / `resolveMessagesAttachmentSources` reuse content resolution across user, assistant text, nested provider tool results, and host tool results; opaque tool/provider payloads stay untouched. Resolution does not add vendor media capabilities. For fresh signing, hosts put resolution inside overflow retry (retry → resolve → transport), not solely in a `ContextTransformer`; compaction and durable history keep refs.
- OpenAI Codex lowering preserves text, image, and document `ToolResultMessage` content as native function output blocks. Anthropic Claude preserves text, images, inline text documents, and URL/base64 PDFs as nested tool-result blocks. Audio and unresolved `Ref` sources remain unsupported.
- Keep semantic `ImagePart`/`DocumentPart`/`AudioPart` over generic file parts; capability checks, provider lowering, validation, and UI rendering branch by media kind. Add generic file content only when arbitrary non-media files become first-class.
- `AgentModelCapabilities` is protocol-only; app/provider config chooses input media support, and loop rejects unsupported input before provider calls.
- Loop stays stateless: no persistence, sessions, WebSockets/SSE, compaction policy, app context, or provider SDKs.
- Loop composition is four Layers (`LLMProvider`, `ToolExecutor`, `ContextTransformer`, `LoopConfig`) plus `run` / `runModelTurn` / `runToolBatch`. Interception is decorating a service (`decorateLLMProvider`), not hooks. Durable hosts fold model-turn streams with `collectModelTurn`.
- Model-produced text is untrusted input: `replaceLoneSurrogates` / `replaceLoneSurrogatesDeep` in protocol harden lone UTF-16 surrogates (unencodable UTF-8); provider request lowering and the realtime client codec apply them to outbound payloads. Storage-specific constraints (e.g. Postgres rejecting NUL) remain host sanitization policy.
- Provider adapters classify retryable failures, attach safe provider metadata, and normalize raw
  usage. `LLMUsage` events are additive deltas; convert vendor cumulative snapshots before emitting.
  Loop owns retry/usage aggregation.
- Provider subscription usage is distinct from protocol `AgentUsage`: it reports consumer subscription allowance percentages and reset windows, not per-request token counts. Keep provider labels and alert eligibility in the host.
- Anthropic prompt-too-long signals normalize to non-retryable `context_overflow`; generic loop retry must not retry them. `makeContextOverflowRetryProvider` is the explicit exception and may compact and retry once per provider stream.
- Anthropic `stop_reason: "max_tokens"` is a non-retryable `invalid_response` in JSON and SSE responses; never emit `LLMDone` or report normal completion for a truncated turn.
- OpenAI-compatible JSON Chat Completions, including Vercel AI Gateway, treat `finish_reason: "length"` and `"content_filter"` as non-retryable `invalid_response`; never report truncated or filtered output as normal completion.
- OpenAI-compatible chat, Vercel AI Gateway, Anthropic, and Grok providers require host-owned output-token limits; never infer model limits or add hidden fallbacks. ChatGPT subscription Codex does not expose or send an output-token limit because its endpoint rejects the vendor `max_output_tokens` field; the optional deprecated `maxOutputTokens` config field is ignored for compatibility.
- Vercel AI Gateway uses the OpenAI-compatible JSON Chat Completions endpoint at `https://ai-gateway.vercel.sh/v1/chat/completions` and lowers the host limit to Gateway `max_tokens`. It forwards request `reasoningEffort` as `{ reasoning: { effort } }` for every opaque Gateway model id; hosts must offer only efforts supported by the selected model. Model ids remain opaque `provider/model` strings; optional fallback models and provider routing are host policy. Routing is emitted under `providerOptions.gateway`, with official `sort` literals `cost`, `ttft`, and `tps`. Authentication accepts an AI Gateway API key or Vercel OIDC token as Bearer auth, required auth/content-negotiation headers override extras, and custom endpoint URLs are trusted credential-bearing proxies.
- The Grok subscription provider defaults to the fixed xAI CLI proxy, not the developer API-key origin. Every request sends Bearer auth, `X-XAI-Token-Auth: xai-grok-cli`, the selected model in `x-grok-model-override`, and the required host-owned `clientVersion` in `x-grok-client-version` because the proxy version-gates requests with HTTP 426; custom response URLs are trusted-proxy configuration because they receive the bearer.
- Codex and Grok share the private OpenAI Responses lowering/stream parser in `src/providers/openai-responses-provider-internal.ts`; public vendor wrappers supply their own endpoint, required auth headers, output-limit policy, provider id, and display name, and own vendor-named request/reasoning types so generated declarations never reference the private module.
- The shared Responses SSE parser treats the first `response.completed` as terminal and ignores later frames. Grok requires an explicit terminal event; Codex retains EOF-completion compatibility.
- Compaction is host-owned through `ContextTransformer`. Persist the raw transcript and host-owned compaction payload, not the synthetic `UserMessage` returned by `makeCompactionCheckpointMessage`; use `compactionSummarySourceMessages` to exclude the previous leading checkpoint when summarizing again.
- `@yolk-sdk/agent/compaction` provides pure planning/estimation, checkpoint formatting, ordered rich transcript formatting, and per-stream one-shot context-overflow retry helpers; hosts own thresholds, summary wording, LLM summarization, durable storage, and active-run guards.
- Built-in token estimates are provider-neutral heuristics. `countTextTokens` improves selected message text/reasoning/host-call estimates only; exact provider-request accounting must also include non-message input and vendor framing. Hosts may inject a whole-transcript `estimateTokens`, reuse one estimator across warnings/planning/before-after checks, and keep tokenizer dependencies outside the package.
- Only preserve provider-supplied reasoning summaries (`LLMReasoningDelta` / assistant reasoning parts); never fabricate reasoning.
- Durable replay may use `LLMTextDelta.textSoFar` / `LLMReasoningDelta.reasoningSoFar`; chat projection prefers snapshots and de-dupes by `eventId`.
- `UserMessageEvent` is the replay-safe durable-stream projection for host-promoted user input. Hosts own queue/promotion policy and must supply a stable `eventId`.
- `accumulateAssistantMessage` preserves ordered assistant parts: text, reasoning, host tool calls, provider tool calls/results.
- Same-turn sibling tool calls are native parallelism: providers emit normal tool calls, loop runs them concurrently within `toolConcurrency`, and dependent work waits for the next model turn.
- OpenAI Codex streaming preserves every sibling function call and deduplicates `response.completed` replays by call id before parsing replayed arguments; a malformed replay of an already-emitted call must not invalidate unseen sibling calls.
- Tool executor `ToolError`s are model-visible failed tool results, not stream failures; every host tool call must have a matching `ToolResultMessage` before the next provider request.
- Use `validateNoDanglingHostToolCalls` before provider lowering and `repairDanglingHostToolCalls` only for persisted/replayed transcripts that already have gaps.
- HITL semantics live in `patterns/AGENT_HITL.md`: approvals/questions pause with `AgentAwaitingInput`; responses resume through `hitlResponses`/typed client inputs.
- Question resume content must be model-visible text with selected answer labels plus structured answers; never replay only `answered`.
- Use SDK HITL helpers for durable apps: `plainHitlResponse`, `questionResponseStructuredContent`, `hitlResponseEvent`, and `toolRunsFromHitlRequests`.
- Client HTTP transport treats `AgentEnd`/`AgentError`/`AgentAwaitingInput` as logical end, but only pre-terminal consumer cancellation should abort the body.
- HTTP callback producers forward failed exits to their output queues with the original Cause. Typed-only catches strand consumers when host callbacks or cleanup defect; preserve defects rather than wrapping them as recoverable transport errors.
- Use `isTerminalAgentEvent` as the canonical protocol helper for `AgentEnd`/`AgentError`/`AgentAwaitingInput` checks.
- Client durable-run helpers are transport-only: they follow NDJSON continuation chunks via run/tail headers, poll empty non-terminal chunks without advancing `startIndex`, require outbound `startIndex >= 0`, and do not own Workflow hook tokens, route auth, run ownership, or HITL request matching.
- Client public helpers are Effect-native: stream helpers return `Stream`; `cancelAgentRun`, `collectAgentEvents`, `textFromBlob`, and `documentPartFromTextFile` return `Effect`; HTTP helpers accept `httpClientLayer`.

## Tests

- Area tests live under `test/protocol`, `test/loop`, `test/runtime`, `test/client`, `test/compaction`, `test/tools`, `test/react`, `test/oauth`, `test/providers`, `test/skillset`, `test/voice`, and `test/property`.
- Use `@yolk-sdk/agent/loop/testing` for fake providers/tool executors outside loop internals.
- Cover subagent tool schema, unknown subagent rejection, and result formatting in `test/tools`.
- Cover subagent protocol round-trips in `test/protocol` and same-turn parallel subagent lifecycle in `test/loop`.

## Durable subagent host seams

- `prepareToolBatch` is public via `./loop`; `pendingRequests` fences **all** launches, including otherwise executable sibling calls. Hosts preserve synthetic results and original order.
- `makeSubagentAcceptedToolResult` is an opt-in background acknowledgement (`background: true` registration option); it must never emit `SubagentCompleted` or contribute child usage.
- Keep logical `subagent:<callId>` identity independent of physical run ids. Status/wait observations use their own tool-call ids and must not duplicate original usage accounting. Host results marked `type: 'subagent_observation'` with the matching logical `subagent_run_id` suppress child completion (not tool completion); uncertainty/budget exhaustion must not claim a terminal outcome.
- Existing inline registrations do not advertise background execution and retain final-result compatibility.

## Background tool calls

- `ToolDef`/`makeTool`/`ToolRegistration` `background: true` is an inert capability flag; `resolveTools(modules, context, { backgroundHost })` activates it. A `BackgroundToolHost` asserts a real lifecycle owner; never supply one from a request-scoped detached task.
- Activated definitions carry `execution: 'background-v1'` and a required `{ execution, arguments }` envelope built by `backgroundToolDef` (original schema under `arguments`, `$defs` at the root). Activated definitions are advertisements only; re-registering one fails with `background_definition_already_active`.
- Activation only supports document-root `#/$defs/...` pointers without percent-encoded fragments. Other `$ref` forms and resource/anchor keywords fail with `background_unsupported_schema`; traverse schema positions only, never business defaults/examples/const/enum data. Do not turn this narrow guard into a reference compiler.
- Activated definitions are unsupported in voice/realtime, including foreground envelope calls: synchronous realtime mappers throw `VoiceToolBridgeError`, while the `toOpenAiRealtimeToolEffect`, `makeOpenAiRealtimeSessionConfigEffect`, and `openAiRealtimeSessionConfigFromVoiceEffect` counterparts return it in the typed error channel (use these in Effect programs); voice decisions deny before approval matching (even replayed approvals), and the private fiber-local `VoiceToolDispatch` marker fences direct low-level bridge dispatch in the activated registry before validation/admission/inline effects. Do not expose the marker as public API or infer activation from business params. Resolve ordinary voice toolsets without a host.
- `executeBackgroundTool` decodes the protocol `BackgroundToolInput` envelope exactly, runs the registration `validate` (schema-only, no business effects), strips control fields, then executes inline or calls `host.accept` and returns `makeBackgroundToolAcceptedResult`. Raw registrations without `validate` fail closed (`background_validation_required`); `question`/`subagent` fail closed (`background_unsupported_tool`).
- `makeTool` invalid business arguments remain structured `model_visible_tool_error` results in both activated execution modes, with no business/admission effects. Envelope errors and raw-registration/host `ToolError`s retain their typed failure semantics.
- Use protocol `toolResultMessageFromResult(result, envelope?)` for receipt-preserving result-to-message conversion; it adds no implicit message context. Reverse projection must explicitly select result fields: `Schema.Class.make` retains excess own keys, so never pass a message instance directly to `ToolResult.make`.
- Loop emits `ToolExecutionAccepted` for results carrying `acceptance`; never `ToolExecutionCompleted`/`SubagentCompleted` and never usage. Client `AgentToolRun`, chat `ChatToolState`, and `ToolRunState` have a distinct `Accepted` tag that is inactive, non-error, and not completed. Preserve the whole accepted call across active and mixed assistant-message replays without dropping siblings or moving acknowledged calls into another message; retain acknowledged runs through turn cleanup. Both batch projection and the hook's `HydrateMessage` reducer must settle transcript receipts, with result message context kept separately in `Accepted.resultEnvelope` for round-trip serialization.
- Approval ids for activated calls are `approval:<callId>:background-v1:<canonical JSON of name/execution/arguments>`; legacy ids stay `approval:<callId>`. `prepareToolBatch` rejects malformed envelopes with a synthetic `isError` result before prompting or launching. IDs intentionally include the full canonical payload without truncation/hashing: hosts must accommodate these opaque, potentially long IDs or enforce input bounds before admission.
- Tests live in `test/tools/background.test.ts`, `test/loop/background-tools.test.ts`, `test/react/background-tools.test.ts`, `test/client/background-tools.test.ts`, and `test/voice/background-tools.test.ts`.
