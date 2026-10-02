# @yolk-sdk/agent

## 0.1.0-canary.96

### Minor Changes

- 367aceb: Add classifier models (ADR 0003). The new `@yolk-sdk/agent/classification` subpath is a provider-neutral contract for models that answer typed questions about one `state` (a string, JSON object, or JSON array) with probabilities: Effect Schemas for `boolean`, `choice` (2-255 options), and `score` (2-10 levels) questions and their answers, `ClassificationRequest`, `ClassificationResult` with token usage and optional `costUsd`, the `ClassifierModel` service, a typed `classify` helper whose choice answers infer the union of their option keys, and typed errors (`ClassificationRequestInvalid`, `ClassificationProviderError`, `ClassificationResponseInvalid`, which keeps the billed usage). Every answer is checked against its question; probabilities are never renormalized.

  Add `@yolk-sdk/agent/providers/vercel/ai-gateway-classifier`: a `ClassifierModel` layer over AI Gateway `POST /v1/evaluate` (Gateway calls this evaluation) with `typesafe-ai/jev` by default and the same Gateway credential as the chat provider (`AI_GATEWAY_API_KEY`, falling back to `VERCEL_OIDC_TOKEN`). It passes `providerOptions` through, maps `providerMetadata.gateway.cost` to `usage.costUsd`, keeps `x-ai-gateway-evaluation-fallback-*` headers in `providerMetadata.evaluationFallbackHeaders`, reads confidence from the answer or `providerMetadata.typesafe.confidence`, and maps Gateway error envelopes to sanitized typed errors. It retries 408, 429, 5xx, and transport failures up to `maxRetries` times (default 2, configurable on the layer config; `0` disables) with exponential backoff and full jitter (base 250 ms, cap 4 s), or after `Retry-After` (delta-seconds or HTTP-date, capped at 10 s); other 4xx statuses and undecodable responses are never retried. Delays run on the Effect `Clock` (so `TestClock` drives them), interruption stops retrying, and the error after the last attempt keeps its typed shape and `retryable` flag. Code mode scripts reach a classifier through `makeClassifierTool` in `@yolk-sdk/codemode` (a `classify` function or `ClassifierModel` value, capped per script and per process); nested-call records carry its token usage only, and `costUsd` stays in the result's `structuredContent`.

  `@yolk-sdk/agent/providers/vercel/conformance` also exports four classifier `read` cases (boolean, choice, score, error envelope) with synthetic, unverified fixtures (`vercelAiGatewayClassifierConformanceCases`, `vercelAiGatewayClassifierConformanceFixtures`, `VercelAiGatewayClassifierConformanceConfig`), apart from the unchanged chat cases.

  `@yolk-sdk/emulators/gateway` answers the classifier route `POST /v1/evaluate` fixture-only from those recordings, with its own unverified manifest (`gatewayEvaluateEmulatorRoutes`), ledger, faults (for example a one-shot 429 with `retry-after`), scripted errors, and control plane (`emulator.evaluate`, `/_emulate/evaluate/*`). The chat route, its manifest, and its top-level APIs are unchanged; `GatewayEmulator` gains `evaluate`.

- 367aceb: Add `@yolk-sdk/codemode` (ADR 0002, step 2): a code mode tool whose input is a short JavaScript program (an async function body) that calls the host's resolved tools, filters and aggregates their results, and returns only what matters.

  - `makeCodeModeTool({ executor, name?, inlineBudget?, limits?, deadline?, loadStore?, beforeNestedCall? })` returns a `write` registration (default name `codemode`, input `{ code }`) with nested tool access. Nested calls run through the resolution's execute path with the same host context, get ids `<toolCallId>/<seq>`, are capped by `maxNestedCalls` (default 256), resolve to `structuredContent` for tools with an output schema and to text otherwise, reject with an `Error` on error results, and are recorded on `ToolResult.nestedCalls` with summed token usage. Interrupted calls reject with `was cancelled`; defects reject with `failed unexpectedly` and are recorded as errors. Calls still running when a script ends are cancelled and recorded as such; the wait for them to stop is bounded.
  - `beforeNestedCall({ call, context })` runs before each nested call; a failure rejects that call in the script with its message and records an error without executing it. Decorators around the host `ToolExecutor` never see nested calls, so per-call run-authority checks belong here or in registration-level wrappers.
  - The resolved description lists the script globals and the nested tools by namespace (with `ToolModule.description` under each heading): `codemode` + `listed` tools with TypeScript declarations within an inline budget (default 3,000 estimated tokens) filled fairly across namespaces, `callableBy: 'all'` tools with one line each outside the budget, and one fixed line pointing to `searchTools(query, { limit?, namespace? })` (BM25 over names, descriptions, namespaces, and module descriptions), `describeTool(name)`, and `describeNamespace(name)`. `codemode` + `search` tools contribute nothing, so adding or removing them, even whole modules of them, leaves the description byte-identical.
  - Results start with `Script completed` or `Script failed`, include the wall time, the output (images as image parts), and the JSON return value, and are cut head and tail at `maxOutputChars` (default 40,000). Images beyond `maxImages` (default 8) or `maxImageBytes` (default 4 MiB of base64) are dropped with a note. Failures add the error and the tool calls already made. Limits: timeout (default 120 s, clamped to `deadline` minus 5 s, at least 1 s, with a `timeout` backstop 5 s after it for executors that miss it) and VM heap (default 64 MiB). The pi engine buffers output on the host thread without a limit while a script runs; only the timeout bounds it.
  - Store writes of successful scripts are returned in `structuredContent.codemode.storeWrites`; `codeModeStoreFromToolResults(entries, { toolName? })` rebuilds the store for `loadStore` from `{ toolName, result }` entries, applying only results of the code mode tool (default `codemode`) and dropping writes beyond 256 KiB per value or 1 MiB in total.
  - `makeClassifierTool({ classify, name?, maxConcurrency?, processLimiter?, description? })` exposes a `ClassifierModel` as a `codemode` + `listed` read tool with compact JSON answers, the full result (including `usage.costUsd`) as `structuredContent`, token usage on `ToolResult.usage`, and model-visible error results. Each classification takes a per-script permit (`maxConcurrency`, default 100, keyed by the parent tool call id) and then a process permit from `processLimiter`, a limiter shared across scripts and registrations: by default the module-level `defaultClassifierProcessLimiter` (200 concurrent classifications per process), or one built with `makeClassifierConcurrencyLimiter(max)`, or `false` to disable the process cap. Interrupting a call while it waits releases its permits.
  - `@yolk-sdk/codemode/node` adds `makePiCodeModeExecutor({ wasm?, workerUrl?, maxConcurrentExecutions? })` on `@earendil-works/pi-codemode` 1.0.0: one QuickJS (WebAssembly) VM in a fresh worker thread per script, TypeScript annotations stripped with Node's `stripTypeScriptTypes`, and a concurrency cap per executor (default 4). Requires Node.js 22.19+; Next.js hosts add `serverExternalPackages: ['@yolk-sdk/codemode', '@earendil-works/pi-codemode', 'quickjs-wasi']`.

  `@yolk-sdk/agent/tools`: registrations (and `makeTool`) accept an optional `describe({ tools })` hook. For registrations with `nestedToolAccess: true`, `resolveTools` computes the resolved definition's description from the nested tools of the resolution; `def.description` stays the static fallback. New type `NestedToolDescriber`.

- 367aceb: Add the code mode tool contract (ADR 0002, step 1) without adding code mode itself.

  - Output schemas: `makeTool({ output })` lowers an Effect Schema into declaration-only
    `ToolDef.outputSchema` the same way as `parameters`. Connector tool registrations pass the action
    `outputSchema` through, and `mcpToolToToolDef` passes a plain-object MCP `outputSchema` through.
    Output schemas are never sent to providers and never validate results.
  - Exposure: `ToolDef.callableBy` (`all` default, `model`, `codemode`) and, for `codemode` only,
    `discovery` (`listed` default, `search`), typed on `makeTool` options as the `ToolExposure`
    union. Protocol helpers `isCodeModeCallable`, `isCodeModeFailClosed`, `providerToolDefs`,
    `isProviderToolDef`, and `toolDiscovery` implement the rules. Approval, input, interaction,
    activated background, `question`, and `subagent` tools never run from code mode; `resolveTools`
    fails `codemode_unsupported_tool` when they are marked `codemode` and `invalid_tool_exposure` for
    `discovery` without `codemode`, and warns when codemode-only tools have no nested-access tool.
  - Exposure for generated tools: `makeConnectorToolRegistration` and `makeConnectorToolModule`
    accept `exposure`, a `ToolExposure` value or a resolver `(actionId, action) => ToolExposure`
    (`ConnectorToolExposureResolver`; `action` is the declared `id`/`description`/`access`, or
    `undefined` for an undeclared action id). `mcpToolToToolDef` and the MCP listing functions
    (`McpClientOptions.exposure`) accept the same option as `McpToolExposureResolver`, a value or
    `(tool, serverName) => ToolExposure`. Without it neither adapter sets `callableBy`/`discovery`;
    the fail-closed rules above still apply at resolution.
  - Codemode-only tools never reach providers: `run`, `runModelTurn`, capability checks, and the
    OpenAI Realtime session builders omit them. Provider-issued calls to them fail closed as unknown
    tools (`prepareToolBatch` synthetic error result, `ResolvedToolSet.execute` `not_found`, voice
    denial) without dispatch.
  - Nested tool access: registrations with `nestedToolAccess: true` receive a `nested`
    `NestedToolExecutor` scoped to the same resolution and host context. Its `tools` list the
    code-mode-callable tools (excluding nested-access registrations) with their module ids; its
    `execute` runs through the resolved execute path and returns model-visible error results for
    unknown, disabled, or non-callable tools and tool failures. Nested call ids follow
    `<parentToolCallId>/<seq>`. Decorators outside `ResolvedToolSet.execute` (for example a wrapped
    `ToolExecutor`) do not see nested calls.
  - Module descriptions: `ToolModule` accepts an optional `description`, carried on `NestedTool` as
    `moduleDescription` for code mode listing and search.
  - Nested-call record: optional `ToolResult.nestedCalls` (`NestedToolCalls`) and summed
    `ToolResult.usage`, built with `recordNestedToolCall` / `nestedToolCallResultFields` within
    exported bounds (256 calls, 8 KiB arguments per call, 32 KiB in total, 500-character errors).
    They round-trip as plain JSON and are dropped by `toolResultMessageFromResult`, so transcripts
    and providers never see them.

### Patch Changes

- 0ce9c3e: Add experimental conformance cases and a runner to `@yolk-sdk/conformance`. `./case` defines a case as a small Effect program proving one wire claim (`defineConformanceCase` with dotted lower-case ids, `read` / `write-reversible` / `write-irreversible` safety, `docs` vs `wire` claims, an optional live `observed` record, and backing fixture ids) plus `expectConformance` / `expectEqual` helpers that fail with a typed `ConformanceMismatch`. `./runner` adds `runConformance`, which skips cases a target does not allow (on a live account: reads run, reversible writes only with `allowWrites: 'reversible'`, irreversible writes only when explicitly listed by id), runs each allowed case with a freshly built layer, turns failures, defects, and throwing layer factories into `failed` results whose messages are sanitized best-effort (`sanitizeConformanceMessage`: credential patterns and credential header lines redacted, credential-shaped tags dropped, JSON spans elided, length capped), and reports unverified or stale cases and fixtures as warnings; `formatConformanceReport` prints a plain-text summary.

  `@yolk-sdk/agent/providers/vercel/conformance` now also exports four read-only Vercel AI Gateway conformance cases (plain-text streaming, DeepSeek reasoning before text, tool-call argument assembly, and the error envelope) that run against the replay fixtures or a host-provided live `HttpClient` via `VercelAiGatewayConformanceConfig`. They are not yet observed against the live Gateway. The repo's Gateway fixture probe now records fixtures by running these cases live and writes them only after the same cases pass on replay.

- 00904fd: Add `@yolk-sdk/emulators/anthropic`: `makeAnthropicEmulator`, an experimental fetch-handler emulator of Anthropic Messages (`POST /v1/messages` on `https://api.anthropic.com`) with Messages SSE in the API's event order (`message_start`, `content_block_start` / deltas / `content_block_stop`, `ping`, `message_delta`, `message_stop`), `text`, `thinking`, and `tool_use` blocks (`text_delta`, `thinking_delta` + `signature_delta`, `input_json_delta`), `end_turn` / `tool_use` / `max_tokens` stops, the `message` JSON body, scripted turns, and the `{ type: 'error', error: { type, message } }` envelope (404 `not_found_error` for unknown models, 401 `authentication_error` without an `x-api-key` or bearer credential, neither of which is checked or stored). Requests without `anthropic-version: 2023-06-01`, or with `thinking` plus a forced `tool_choice`, get a 400 `invalid_request_error`. Faults include 429 with `retry-after`, 529 `overloaded_error`, a mid-stream `error` event (`error-event-after-chunks`), and truncation before `message_stop`. `anthropicEmulatorRoutes` is its unverified route evidence manifest linked to the new Anthropic Messages conformance cases. The Gateway and OpenAI emulators now share an internal emulator kernel with it; their API and wire behaviour are unchanged.

  Add `@yolk-sdk/agent/providers/anthropic/conformance`: five synthetic, unverified Anthropic Messages wire fixtures and five read-only conformance cases (streamed plain text, forced `tool_use` input-fragment assembly, thinking before text, the unknown-model error envelope, and `stop_reason: max_tokens` as a non-retryable invalid response) for native Messages, runnable against replay, an emulator, or a host-provided live `HttpClient` via `AnthropicConformanceConfig`.

- 425c172: Add `@yolk-sdk/emulators/openai`: `makeOpenAiEmulator`, an experimental fetch-handler emulator of OpenAI Chat Completions (`POST /v1/chat/completions` on `https://api.openai.com`) with the OpenAI error envelope `{ error: { message, type, param, code } }` (404 `model_not_found` for unknown models, 401 `invalid_api_key` without a bearer credential), plus `openAiEmulatorRoutes`, its unverified route evidence manifest linked to the new OpenAI chat conformance cases. Reasoning models are not emulated for `/openai` yet. It shares an internal Chat Completions core with the Gateway emulator, whose API and wire behaviour are unchanged except that both ledgers now also record the output-token limit (`max_tokens` for the Gateway, `max_completion_tokens` for OpenAI) as `maxCompletionTokens`, without validating it.

  Add `@yolk-sdk/agent/providers/openai/conformance`: four synthetic, unverified OpenAI Chat Completions wire fixtures and four read-only conformance cases for the generic OpenAI-compatible chat provider (streamed plain text, tool-call argument assembly, the error envelope, and non-streamed JSON plain text) that run against replay, an emulator, or a host-provided live `HttpClient` via `OpenAiConformanceConfig`.

- 9f7aba3: Add `@yolk-sdk/emulators/opencode` (`makeOpenCodeGoEmulator`): one experimental, fixture-only fetch handler for `https://opencode.ai` answering the OpenCode Go routes under `/zen/go/v1` (`/chat/completions`, `/messages`, `/responses`, and `GET /usage`) with the recorded responses of the synthetic Go conformance fixtures. Requests that match a recorded request shape (within documented request-shape latitude) get the recorded response; anything else answers a ledgered 400 not-emulated. Each route keeps its own ledger, faults, scripted error turns, and control plane (`emulator.chat`, `.messages`, `.responses`, `.usage`; `/_emulate/<part>/*`), with combined coverage and reset and an unverified manifest (`openCodeGoEmulatorRoutes`).

  The Anthropic, Codex, and Grok emulators also answer their subscription-usage endpoints (`GET /api/oauth/usage`, `GET /backend-api/wham/usage`, `GET /v1/billing?format=credits`) with the recorded synthetic snapshot bodies, under the same fixture-only rule, through `emulator.usage` with separate unverified manifests. Model-route manifests and coverage are unchanged; the emulator types gain `usage` and a `subscriptionUsage` option (a replacement body with the recorded shape), and their `fetch` now answers those usage paths and `/_emulate/usage/*`.

  Add conformance cases: the new `@yolk-sdk/agent/providers/opencode/conformance` exports five synthetic, unverified fixtures and five read-only cases (streamed plain text on each Go protocol, the Responses commentary-phase replay, and the Go usage snapshot) with `OpenCodeGoConformanceConfig`; the Anthropic, OpenAI, and xAI conformance subpaths also export Claude, Codex, and Grok subscription-usage snapshot cases and fixtures (`anthropicClaudeUsageSnapshotCase`, `openAiCodexUsageSnapshotCase`, `xAiGrokUsageSnapshotCase` and their config services), which assert the normalized windows against the raw body so no window is fabricated or dropped. Existing case arrays and provider behaviour are unchanged.

- ccc64a3: Add `@yolk-sdk/emulators/codex` (`makeCodexEmulator`, `POST /backend-api/codex/responses` on `https://chatgpt.com`) and `@yolk-sdk/emulators/xai` (`makeXAiGrokEmulator`, `POST /v1/responses` on `https://cli-chat-proxy.grok.com`): experimental fetch-handler emulators of the OpenAI Responses wire the Codex and Grok subscription providers use, on one shared Responses core and the emulator kernel. They stream typed `event:` server-sent events in the API's order (`response.created`, `response.in_progress`, per output item `response.output_item.added` / deltas / `response.output_item.done`, and `response.completed` with usage) with `reasoning` summary, `message` text, and `function_call` argument-delta items, answer `stream: false` with a completed `response` JSON body, and use the `{ error: { message, type, param, code } }` envelope (400 `model_not_found` for unknown models, 401 without a bearer credential, which is never checked or stored). `/codex` rejects `max_output_tokens`; `/xai` requires `X-XAI-Token-Auth` (401), `x-grok-client-version` (426), and `x-grok-model-override` (400). Scripted turns (including a JSON body for the providers' JSON fallback), faults (429 with `retry-after`, a mid-stream `error` or `response.failed` event, truncation before `response.completed`, dropped connections), the ledger, the control plane, and unverified route evidence manifests (`codexEmulatorRoutes`, `xAiGrokEmulatorRoutes`) work as for the other emulators.

  Add Responses conformance cases for the subscription providers: `@yolk-sdk/agent/providers/openai/conformance` now also exports four synthetic, unverified Codex fixtures and four read-only cases (`openAiCodexConformanceCases`, `OpenAiCodexConformanceConfig`), and the new `@yolk-sdk/agent/providers/xai/conformance` exports the same for Grok (`xAiGrokConformanceCases`, `XAiGrokConformanceConfig`): streamed plain text, `function_call` argument assembly, the unknown-model error envelope, and the terminal `response.completed` event, runnable against replay, an emulator, or a host-provided live `HttpClient`. Provider behaviour is unchanged.

- 6d3b497: The `@yolk-sdk/emulators/gateway` emulator now follows the verified live Vercel AI Gateway recordings, and `gatewayEmulatorRoutes` is `verified` (`observedAt: '2026-09-30'`), so Gateway responses no longer carry `x-emulator-evidence: unverified`. Streamed completions send a `{ role: 'assistant' }` opening delta, `logprobs: null` on every choice, `system_fingerprint` on every chunk, and one finish event whose delta carries a synthetic `provider_metadata` (the recorded upstream entry, `openai` for `openai/*` models or `baseten` for `deepseek/*` models, then `gateway`) and which carries the Gateway-shaped `usage` (when `stream_options.include_usage` is set), `service_tier` (for `openai/*` models), and `generationId`, followed only by `data: [DONE]`; there is no separate usage chunk any more. Several SSE events are packed into each network chunk: the new `eventsPerChunk` option (default `gatewayEmulatorDefaultEventsPerChunk`, 2; 1 restores one event per chunk) packs from the end so the finish event and `data: [DONE]` share the last chunk, and chunk faults count these network chunks. Reasoning streams as `delta.reasoning` with `delta.reasoning_details` (scripted `reasoningField` now defaults to `reasoning`; `reasoning_content` is still accepted). The non-streamed `chat.completion` body (not covered by a recording) now carries the same Gateway-shaped `usage` with its cost fields, and reasoning as `message.reasoning` instead of `message.reasoning_content`. Unknown models get the recorded 404 `{ error: { message: "Model '<id>' not found", type: 'model_not_found', param: { modelId } } }` without `code` (was 400 `invalid_request_error` / `model_not_found`). `deepseek/deepseek-v4.1-flash` joins the default known and reasoning models. `GatewayEmulatorInputInvalid` now also reports an invalid `eventsPerChunk` (`input: 'options'`). The `/openai` emulator's wire is unchanged.

  `vercelAiGatewayConformanceDefaultModels.reasoning` is now `deepseek/deepseek-v4.1-flash`, the model the verified DeepSeek fixture was recorded with, so the default model ids now match every committed Gateway fixture.

- 9ff96b8: Vercel AI Gateway conformance fixtures are now verified live recordings.

  The four `@yolk-sdk/agent/providers/vercel/conformance` fixtures (plain text, DeepSeek reasoning, tool-call deltas, error envelope) were recorded from the live Gateway on 2026-09-30 by `pnpm conformance:gateway --live` with the synthetic account label `synthetic` (`evidence: 'verified'`), and the four Gateway conformance cases now record that live observation in `observed`. The recordings show `delta.reasoning` (with `delta.reasoning_details`) for DeepSeek reasoning, `usage` on the finish event, several events per network chunk, and a 404 `model_not_found` envelope without `error.code` for unknown models.

- 0c58a89: Conformance placeholder fixture notes name the owner-approved live probe command.
- 92f016f: Add the experimental `@yolk-sdk/conformance` package: Effect-only wire fixtures (`./fixture`) with schema decode, staleness helpers, and a secret scan; an offline, fail-closed replay `HttpClient` with a request ledger and wire faults for status-on-attempt, mid-stream failure, truncation, and held chunks (`./replay`); and a recorder that wraps a host-provided `HttpClient` to capture exchanges losslessly (text or base64 bodies and per-chunk stream bytes with original boundaries) with allowlisted headers (`./record`). The package performs no network I/O itself.

  `@yolk-sdk/agent` subscription-usage fetchers for Claude, Codex, Grok, and OpenCode Go accept an optional `url` endpoint override (default unchanged); only point it at a trusted proxy or local emulator because the credential is sent there. The new `@yolk-sdk/agent/providers/vercel/conformance` subpath exports synthetic Vercel AI Gateway wire fixtures (plain text, DeepSeek-style reasoning, split tool-call deltas, and an error envelope) for replay tests. `@yolk-sdk/agent` now depends on `@yolk-sdk/conformance`, which only its conformance subpaths import.

  `@yolk-sdk/connectors` Fortnox archive and invoice-preview downloads now build their URL from the shared `fortnoxApiBaseUrl` instead of a duplicated literal; requests are unchanged.

- Updated dependencies [0ce9c3e]
- Updated dependencies [575a282]
- Updated dependencies [a4ba6db]
- Updated dependencies [92f016f]
  - @yolk-sdk/conformance@0.1.0-canary.96

## 0.1.0-canary.95

### Patch Changes

- 8d919b4: Advance unchanged public packages in lockstep with Gmail multipart sending and host-only Outlook draft attachment uploads in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.94

## 0.1.0-canary.93

## 0.1.0-canary.92

### Patch Changes

- 7bc4f70: Advance unchanged public packages in lockstep with the new GitHub connector at `@yolk-sdk/connectors/github`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.91

### Patch Changes

- b9c5610: Add IMAP Sent-copy configuration to generic email submission. Sent saving is requested by default; `saveToSentItems: false` skips it. Legacy hosts receive synthesized `unsupported` or `skipped` status instead of an implied save. Confirmed SMTP acceptance is preserved when ancillary metadata is invalid. Hosts still own MIME rendering and Sent storage; storage failures must not trigger resubmission.

  Support tool-result images, readable text documents, and PDFs when `supportsPdfAttachments` is enabled in OpenAI-compatible Chat Completions. Those parts are lowered to origin-labeled supplementary user content after the complete tool-result block. Other native document formats and audio remain unsupported. Validate all content before resolving URL-backed PDFs, preserve canonical history, and continue rejecting unresolved references.

## 0.1.0-canary.90

### Patch Changes

- 6c7efcb: Add native PDF file-part lowering to the OpenAI-compatible Chat Completions transport, including resolving URL-backed PDF attachments, and enable it by default for the Vercel AI Gateway provider.

## 0.1.0-canary.89

### Patch Changes

- 4188847: Make background subagent parameter and acceptance guidance host-neutral instead of instructing models to call status/wait tools that the SDK does not register. Preserve model-visible lookup identities, structured acceptance metadata, and zero-usage launch acknowledgement semantics. Hosts continue to own completion delivery and observation policy.

## 0.1.0-canary.88

### Patch Changes

- 879f27b: Advance unchanged public packages in lockstep with the portable email batch, filter, and permanent-deletion primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.87

### Patch Changes

- 30f73f0: Advance unchanged public packages in lockstep with the reviewed-email submission primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.86

### Minor Changes

- 275d402: Add general-purpose action-backed interactions: `makeInteractionTool` registers call/response Effect schemas, an app renderer key, explicit access, and server-defined named actions with optional side-effect-free validation and execute handlers. Distinct `InteractionRequest`/`InteractionResponse` flow through the existing HITL protocol, transport, runtime, and headless React projection with requested/accepted/executing/completed/failed/unknown states; submitted interactions never synthesize a tool result. Selected actions execute behind `ToolExecutor` with an explicit interaction reference admitted through the mandatory host receipt port (`read`/`claim`/`settle` over host-owned storage). Built-in payload-free cancellation, JSON-preserving validation, replay of settled receipts, and fail-closed voice/background/unsupported handling included.

## 0.1.0-canary.85

### Patch Changes

- 979db9e: Advance unchanged public packages in lockstep with the generic-email label, flag, move, and header additions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.84

### Patch Changes

- a627921: Preserve normalized `reasoning` thinking output from OpenAI-compatible hosts such as Vercel AI Gateway in streaming and single-shot chat completions when `reasoningContent` is enabled. Prefer `reasoning_content` when both are present, so reasoning surfaces as events instead of being dropped.

## 0.1.0-canary.83

### Patch Changes

- 245e0b0: Allow overriding the Vercel AI Gateway reasoning-effort wire format and merging a thinking toggle into the request body, so DeepSeek-style hosts can receive `reasoning_effort` and `thinking` instead of the default Anthropic `reasoning` object. Defaults are unchanged.

## 0.1.0-canary.82

### Minor Changes

- 79a074a: Add schema-backed typed input interactions through the existing HITL lifecycle. `makeInputTool`
  keeps original call/response validators server-side while serializable descriptors identify app-owned
  renderers. Hosts pass resolved input handlers to loop/runtime configs; input requests support submit,
  cancel, validation correction, and first-valid-response replay without authorizing actions.

  Preserve question compatibility, add HTTP/WebSocket and headless React input submission/projection,
  and match input responses in harness outcomes. Input tools reject approval/background policy and
  direct execution; voice remains approvals-only. React waits for server acceptance before creating
  replayable results, including across failed submissions and pending-state hydration.

### Patch Changes

- 16fa58c: Forward optional `streaming` and `reasoningContent` flags from the Vercel AI Gateway provider factory to the OpenAI-compatible transport, so hosts can opt into SSE deltas and reasoning output instead of single-shot JSON completions.

## 0.1.0-canary.81

### Patch Changes

- 9f85933: Harden OpenAI-compatible chat streaming against non-SSE 2xx responses and add optional safe stream diagnostics to `ProviderErrorInfo`.

  A chat streaming response with an explicit non-SSE `Content-Type` (JSON, HTML) now fails before the body is consumed with `invalid_response` `providerCode: 'unexpected_content_type'` (non-retryable, safe numeric status attached). A missing `Content-Type` keeps the existing lenient SSE parsing. `ProviderErrorInfo.stream` optionally carries closed-enum `ProviderStreamDiagnostics` (`protocol`, `responseFormat`, `receivedBytes`, `bufferedChars`, `outputStarted`, `terminalSeen`) on `unexpected_content_type` and `incomplete_stream` chat errors so counters survive provider sanitization and wire serialization; no transcript bytes, raw headers, or body fragments are retained. Unterminated streams at EOF still fail `incomplete_stream` and never emit `Done`.

## 0.1.0-canary.80

### Patch Changes

- 82c3cad: Omit `is_error` from Anthropic tool-result blocks when the tool result carries no flag, instead of serializing it as `undefined`, preventing request-body validation failures when replaying successful tool results without an error flag.
- df007e7: Stream OpenAI-compatible chat completions as server-sent events when enabled.

  The shared chat provider was request/response-only, so hosts saw whole turns at once. `OpenAiProviderConfig.streaming` now requests incremental `chat.completion.chunk` deltas (with `stream_options.include_usage`) and folds them into text/reasoning/tool-call events plus terminal and usage events, mirroring the Responses SSE terminal policy: unterminated streams fail `invalid_response` and never emit `Done`. OpenCode Go chat models opt in; the default JSON behavior is unchanged.

- b3acb64: Declare an object root on provider-facing tool parameter schemas derived from Effect unions, and surface machine provider error codes on OpenAI-compatible HTTP failures.

  `makeTool` now adds `type: "object"` to typeless unions of object schemas (unions compile to typeless `anyOf`), which strict OpenAI-compatible upstreams such as DeepSeek behind OpenCode Go require; call validation still runs against the original Effect Schema. The OpenAI Chat Completions and Responses HTTP error paths now extract the envelope `code`/`type` into `provider.providerCode` for kind classification and host diagnostics; free-text upstream messages stay out of `LLMError` per the existing sanitization policy.

## 0.1.0-canary.79

### Patch Changes

- 3c243ee: Align all public SDK packages for the Go Responses replay fix and the branded-identity TypeScript migration. MCP and Vercel Workflows have no direct API or runtime changes in this release; they advance with the fixed SDK package group.
- 2ab26c7: Tag OpenCode Go Responses assistant text that precedes host function calls as `phase: commentary` on replay. Preserve ordered text/call segments through streaming, JSON fallback, and completion-only responses; trailing and final-answer text omit phase. Codex and Grok shared Responses lowering stays untagged.

## 0.1.0-canary.78

### Minor Changes

- 5ff44d6: Export canonical tagged constructors on existing subpaths: `PlainHitlResponse` and `RuntimeRequest` values, React chat ADTs, harness inbox/outcome/`StopDecision` companions, knowledge source/scope `.make`, and workflow `WorkflowStepResult` / `VercelAgentWorkflowRunResult`.

  `Data.taggedEnum` values are plain objects with `_tag` last, not Equal/Hash classes. Prefer constructors over handwritten `{ _tag }` objects and omit absent optionals.

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

- 00e4d60: Add OpenCode Go API-key provider support for host-selected Chat Completions, Anthropic Messages, and OpenAI Responses protocols, with explicit output limits and native tool/reasoning handling.

  Add best-effort Go subscription usage snapshots for rolling, weekly, and monthly allowance windows using the fixed API-key usage endpoint. Hosts retain credential, model, polling, and UI policy.

  Share Anthropic lowering/parsing without applying Claude OAuth fingerprints to Go. Reject filtered Messages output and ignore frames after terminal completion. Sanitize Go provider errors while preserving classified metadata.

- 5ff44d6: `WebRtcPeerConnectionLike.addTrack` on `@yolk-sdk/agent/voice/browser` is a void command (was unused `unknown`). Hosts and fakes must not read a sender. Real `RTCPeerConnection.addTrack` remains assignable. No export-map change.

  Voice raw-argument JSON on `@yolk-sdk/agent/voice`: `protocolToolCallFromVoice` and `decideVoiceToolCall` admit finite JSON. Actual `null` / `false` / `0` still admit as those values. Raw text `1e999` uses the existing malformed fallbacks instead of publishing `Infinity` (projection params `'1e999'`; approval display `{ argumentsJson: '1e999' }`). Nested overflow takes the same fallbacks. Do not demonstrate with `JSON.stringify(Infinity)` (that is `null`). Execution schema validation and approval identifiers/gates are unchanged.

  `@yolk-sdk/mcp/client` and `@yolk-sdk/mcp/protocol` export Schema owners `InitializeClientInfo`, `InitializeParams`, `InitializedNotification`, and `ToolsCallParams`. Prefer Schema owners for new construction. Compatibility `makeJsonRpcRequest`, `makeInitializeParams`, and `makeInitializedNotification` remain and omit `params` when `undefined`. No new export subpath.

- 5ff44d6: **Breaking type imports** (runtime and wire unchanged; no compatibility aliases):

  - `LoopConfigShape` → `LoopConfigSettings` from `@yolk-sdk/agent/loop`
  - `RunStoreShape` → `RunStoreApi` from `@yolk-sdk/harness/store`
  - `InboxShape` → `InboxApi` from `@yolk-sdk/harness/inbox`
  - `DriverShape` → `DriverApi` from `@yolk-sdk/harness/driver`

  ```ts
  import type { LoopConfigSettings } from '@yolk-sdk/agent/loop'
  import type { RunStoreApi } from '@yolk-sdk/harness/store'
  import type { InboxApi } from '@yolk-sdk/harness/inbox'
  import type { DriverApi } from '@yolk-sdk/harness/driver'
  ```

- 5ff44d6: Breaking: `OpenAiProviderConfig.extraBody` takes JSON-object input (`OpenAiRequestExtras`). Untyped runtime input is still snapshotted and validated at request lowering; layer creation stays Effect-lazy and does not walk extras or credentials.

  Admission copies own data properties once (cycle-stack + DAG memo), then uses that snapshot. Surviving accessors, functions, `undefined`, nonfinite numbers, cycles, arrays-at-root, `null`, primitives, Date/Map, and class/custom-prototype objects fail non-retryable `LLMError` `provider_error` with a fixed `Invalid … extraBody JSON: expected a JSON object` message that does not echo values. Canonical keys `model`, `messages`, `stream`, `tools`, `parallel_tool_calls`, `max_completion_tokens`, and `max_tokens` — plus `reasoning` when `reasoningEffortFormat` is `'reasoning-object'` — are omitted by key without reading values. JSON `null`/`false`/`0`, own `__proto__`/`constructor` keys, dense arrays, and DAG aliases are kept. Identity is not preserved: extras on the request are a snapshot. Composed-body `Schema.Json` serialization after lone-surrogate rewrite remains the last finite-JSON defense. Vercel AI Gateway emits JSON `models` / `providerOptions` as `OpenAiRequestExtras`.

  Migrate hosts: pass portable JSON objects only; do not rely on live getters, class instances, or serialize-time extraBody validation. See the agent README and migration guide for the new admission boundary.

- 5ff44d6: `ToolDef.parameters` admits a JSON Schema **representation** at construction: boolean schema or plain JSON object (unknown annotation keywords allowed as JSON). This is not meta-schema validation and is not `Schema.Json` for tool call params, results, or HITL — those stay opaque.

  Admission is identity-preserving (not a Record snapshot): enumerable data-only own string keys, including own `__proto__`/`constructor`, dense `Array.prototype` arrays, primitives, null-prototype objects, and DAG aliases. Accessors are rejected from property descriptors and are not invoked. Cycles, nonfinite numbers, functions, `undefined` values, Date/Map/class/custom prototypes, and sparse arrays fail before a tool runs. Effect/Result decoding reports `SchemaError`; synchronous `ToolDef.make` and `makeTool`'s generated-document admission throw the installed Effect constructor's `Error` shape with a `SchemaIssue` cause. Proxy traps on `ownKeys`/`getOwnPropertyDescriptor` are not claimed immune.

  Background activation wraps boolean `true`/`false` parameter documents as `arguments` schemas (not `{}`). Unsupported `$ref`/resource keywords still fail only at activation.

  MCP `tools/list` `inputSchema` admits the object arm at decode (`McpError` `validation`). Boolean MCP input schemas are rejected there. Omitted MCP input schemas still default to `{ type: 'object', additionalProperties: true }`.

- 5ff44d6: Voice sessions are now an injectable Effect resource graph instead of a React-owned factory trio.

  This is a breaking 0.x change: `makeVoiceController` no longer accepts a `transport` value and instead yields `VoiceTransport`. Hosts that already have an API value should `Effect.provideService(VoiceTransport, transport)` or pass `Layer.succeed(VoiceTransport, transport)` into `VoiceSession.layer`. `Layer.succeed` injects a caller-owned transport and does not allocate or finalize it.

  - New `VoiceSession` (`@yolk-sdk/agent/voice`) composes one session from a supplied transport layer, `VoiceController`, and optional `eventLog`. Configured durable logging is session-owned: controller events are captured even without an external `events` consumer, and omitting `eventLog` never reads an ambient `VoiceEventOutbox`.
  - `webRtcVoiceTransportLayer` and `webSocketVoiceTransportLayer` publish a connected transport as `VoiceTransport`. `VoiceController.layer` / `VoiceEventOutbox.layer` wrap the existing scoped factories.
  - `useYolkVoice` still owns UI state, latest callbacks, HITL helpers, attempt cancellation, and audio-element identity. It no longer imports service constructors; each `start()` provides a fresh `VoiceSession.layer`.

- 5ff44d6: Claude lowering requires `ToolDef.parameters` and `ToolCall.params` to decode as `Schema.Json`; non-JSON fails non-retryable `LLMError` `provider_error`. Lone-surrogate rewrite is re-decoded as JSON (failure, not skip). HTTP non-JSON errors still classify from status.

  `useAgentChat` dispatches/returns the existing `AgentChatAction` and hook-result constructors (`Data.taggedEnum` plains, `_tag` last, not Equal/Hash classes). Prefer constructors and `$is`; omit absent optionals. `Schema.TaggedStruct.make` still validates duration plains.

- 5ff44d6: OpenAI Chat Completions and Responses admit `ToolDef.parameters` and tool-call `params` as `Schema.Json` before transport. Non-JSON fails non-retryable `LLMError` `provider_error`. `ToolDef.parameters` admits a `ToolJsonSchema` representation at construction; tool-call params and results stay opaque. Public Codex `OpenAiCodexTool.parameters` remains `unknown`. Inbound HTTP JSON and Responses SSE JSON admit `Schema.Json`; non-object SSE JSON is ignored, malformed non-JSON event text fails `invalid_response`, and HTTP error bodies stay raw text.

  `OpenAiProviderConfig.extraBody` now takes `OpenAiRequestExtras` JSON-object input, also used by Gateway. Request lowering snapshots surviving fields and discards canonical keys without reading their values. Surviving accessors and non-JSON values fail non-retryable `provider_error` with `Invalid … extraBody JSON: expected a JSON object`; getters are not invoked. Composed-body `Schema.Json` serialization after lone-surrogate rewriting remains the final finite-JSON defense.

  Public Realtime `OpenAiRealtimeFunctionTool.parameters` and `openAiRealtimeToolParameters` now require `Schema.Json`. Non-JSON advertisement fails `VoiceToolBridgeError` (sync throw / Effect fail). Mapper defects stay defects. Union-root lowering merges own `__proto__` / `constructor` via `Map`.

  Gmail `get_thread` / `list_attachments` MIME `payload` admits `Schema.Json` after JSON parse. Best-effort optional size omission and sibling preservation are unchanged. Raw HTTP `1e999` → `Infinity` rejects the whole payload (`ConnectorError` `validation_failed`). Public Gmail action classes and `gmail.get_attachment` are unchanged.

### Patch Changes

- 5ff44d6: Tighten `makeTool({ invalidParamsMessage })` on `@yolk-sdk/agent/tools` to
  `(error: Schema.SchemaError) => string`. Default remains
  `Invalid ${name} arguments: ${String(error)}`, including the `SchemaError(...)` wrapper.
  In Effect rc.115, `SchemaError` extends native `Error`, but the wrapper remains part of this
  tool-message contract; do not default to `.message`. Existing
  `(error: unknown) => string` callbacks remain assignable. No new export subpath.

  Tighten `commitThenWriteTerminalEvent({ writeCommitError })` on `@yolk-sdk/vercel-workflows` to
  the existing `CommitError` generic from `commit`. Result `commitError` / `error` fields stay
  `unknown`. Existing `(error: unknown) => …` callbacks remain assignable. No generic expansion.

- 5ff44d6: Keep each Workflow tool-batch HITL response array independent from the loop's accumulator, preserving response order and element identity. Normalize custom React chat transport rejections through the existing transport error owner, retaining their underlying cause and recognizing aborts.

  Return a JSON-RPC invalid-request response when a legacy MCP HTTP request body cannot be read. Precisely narrow missing-sandbox SDK errors to HTTP 404/410 without assuming an object-shaped error payload or discarding other API errors.

## 0.1.0-canary.77

### Minor Changes

- 7827908: Add optional `LLMError.responseIssue: 'missing_done'` for kernel zero-Done completions, `collectModelTurnAttempt` for partial-failure model-turn collection, and shared overflow compaction that runs only before published output. `collectModelTurn` still finalizes `assistantMessage` only from `AssistantMessage` events. Pure typed sink/stream failures stay `SinkFailed`/`StreamFailed`; Causes that also contain a defect or interruption stay on the error channel, including Fail annotations.

### Patch Changes

- 978ea8f: Recover Codex streams that omit a final `output` payload and normalize context-window errors in the provider.
- 978ea8f: Name the loop composition kernel: `makeAgentLoopLayer`, `decorateLLMProvider`, `collectModelTurn`, and `collectModelTurnAttempt`. Omitted tools use `ToolExecutor.unavailable`.
- 6b9c60b: Release all seven public packages together.

  This canary introduces `@yolk-sdk/harness` run lifecycle and related agent loop composition, collection, Codex missing-final-output, and overflow-after-output changes. `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, `@yolk-sdk/sandbox`, and `@yolk-sdk/vercel-workflows` are unchanged except for lockstep compatibility.

## 0.1.0-canary.76

### Patch Changes

- 8f5ea35: Add host-only retrieval for Google Drive download/export, Gmail, Outlook, IMAP/POP3, Notion, Telegram, Todoist attachments, Fortnox preview/archive, and R2 gets, plus bounded Dropbox/OneDrive writes and conditional R2 puts. Preserve GET-only binary adapters, base64 attachment actions, and R2 presigning. OneDrive update requires acknowledgeOverwrite and is unconditional, not CAS; Dropbox revision and R2 ETag preconditions stay strict. Add Fortnox list_supplier_invoice_files and Todoist list_comments read actions. Drive bytes default to drive.file with host-only drive.readonly opt-in; Fortnox archive/connectfile slots are opt-in and not added to the combined hint. No generic agent byte actions or app wiring.
- 34b4275: Add a host-only Dropbox original-byte download helper, `downloadDropboxFile`, on `@yolk-sdk/connectors/dropbox`. It mirrors the host-only OneDrive original-byte helper, but Dropbox never follows content redirects. It reuses the existing `dropbox.oauth` binding through a new `files.content.read` scope and `DropboxContentReadOAuthCredentialSlot` (now also included in `DropboxCombinedOAuthCredentialSlot`), calls the Dropbox content endpoint once through the optional bounded binary HTTP port, returns allowlisted `Dropbox-API-Result` metadata plus untouched bytes, and sanitizes failures to typed codes. Default Dropbox actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

## 0.1.0-canary.75

### Minor Changes

- 7f238d8: Add a host-only OneDrive/SharePoint original-byte download helper and an optional bounded binary HTTP port. Reuse existing Microsoft read credentials, resolve remote item identities, sanitize failures, and strip all original headers on download redirects. Default Microsoft actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

## 0.1.0-canary.74

### Patch Changes

- 79fe70b: Reject disabled question calls without entering HITL, and distinguish matching subagent
  observations from terminal child completion without charging nested usage. Supply deterministic
  zero-based read/sleep attempt indices to `awaitWorkflowChild` so durable hosts can bound
  observation polling and apply capped backoff while preserving existing zero-argument callbacks.
- 79fe70b: Add explicit opt-in, model-chosen background tool calls. `makeTool`/`ToolRegistration` accept a
  `background: true` capability that stays inert until `resolveTools` receives a lifecycle-owning
  `BackgroundToolHost`. Activated tools expose a required `{ execution, arguments }` envelope with the
  original schema nested unchanged; the registry validates without business effects, strips control
  fields, and returns one acknowledgement `ToolResult` with typed `acceptance` metadata. The loop
  emits `ToolExecutionAccepted` instead of completion or usage, approval ids bind the exact payload
  and mode for activated calls, and client/React projections treat `Accepted` as settled but not
  completed and protect acceptance from stale Started/input replay. Activation rejects unsupported
  JSON Schema references/resource boundaries with `background_unsupported_schema` while preserving
  ordinary document-root `$defs` references and literal default/example data. Activated definitions
  fail closed at realtime advertisement and voice dispatch (including replayed approvals and the
  low-level bridge); voice toolsets must resolve without a background host. Definitions and behavior
  without a host are unchanged.

  Preserve entire accepted calls and receipts across active-event replay, terminal/next-turn cleanup,
  and hydration without classifying admission as completion. Add typed Effect realtime mapper/config
  builders alongside the synchronous APIs, preserving fail-closed voice behavior. Activated makeTool
  business-argument failures retain their structured model-visible contract before any effects. Share
  receipt-preserving result-to-message conversion and loop-owned tool names. Document intentionally
  lossless, potentially long canonical-payload approval IDs and host input/storage responsibilities.

## 0.1.0-canary.73

### Patch Changes

- 6672571: Add opt-in background subagent acknowledgements without premature child-completion events,
  public whole-batch HITL preflight, and generic bounded Workflow tool orchestration and durable
  child read/sleep seams. Preserve inline subagent compatibility and logical usage identity.
  The Next example wires independent foreground/background child workflows with owned durable
  reservations/results and tombstone-first explicit Stop cancellation.
- 2749df0: Add Effect-native `resolveMessageAttachmentSources` and `resolveMessagesAttachmentSources` protocol helpers. Traverse user, assistant, and tool-result media, including nested assistant provider tool results, while preserving metadata and ordering without mutation or caching. Document host-owned fresh signing inside provider retries, native PDF/image tool results, and bounded attachment transport.

  Validate Gmail discovery attachment sizes as nonnegative integers and omit malformed optional size metadata. Keep download limits, decoded-byte validation, authorization, storage, and extraction policy host-owned.

## 0.1.0-canary.72

### Patch Changes

- 79b6ff8: Align installation examples with the SDK's Effect version, correct Google connector tool wiring, document Outlook optional read inputs, and date previously released canary migrations.
- 9897531: Add `@yolk-sdk/connectors/fortnox` with nine read-only actions for company information and list/get customers, invoices, suppliers, and supplier invoices. Include typed schemas, pagination, resource-scoped OAuth credential hints, provider failure handling, and agent-tool access metadata. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
- 782092d: Normalize null and blank optional inputs for Outlook message search and listing, including null page sizes, before execution. Direct connector callers and generated agent tools now share the compatibility behavior while preserving real cursors, input validation, application-mailbox guards, and provider failures.

## 0.1.0-canary.71

## 0.1.0-canary.70

### Patch Changes

- 7c636c9: Upgrade the Effect runtime to beta.80 so rejected HTTP response bodies retain their typed transport errors instead of becoming cleanup defects and leaving durable-run streams pending. Keep the Effect platform packages aligned with that runtime.

  Ensure HTTP callback producers forward all failure causes to consumers, including unexpected host callback defects, without wrapping defects as recoverable transport errors.

## 0.1.0-canary.69

### Patch Changes

- 9747ec9: Forward run-level reasoning effort to every Vercel AI Gateway model through the Gateway reasoning object.

## 0.1.0-canary.68

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.

## 0.1.0-canary.67

### Minor Changes

- 0da67d1: Add replay-safe durable user-message events and skip empty tool-batch steps when a workflow model turn continues without tool calls.

### Patch Changes

- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.

## 0.1.0-canary.66

## 0.1.0-canary.65

## 0.1.0-canary.64

## 0.1.0-canary.63

## 0.1.0-canary.62

### Patch Changes

- 7677e18: Require a host-owned Grok CLI `clientVersion` on `XAiGrokProviderConfig`, sent as `x-grok-client-version`, because the xAI CLI proxy version-gates subscription requests and rejects missing or outdated versions with HTTP 426.

## 0.1.0-canary.61

### Patch Changes

- 025b16b: Preserve paragraph boundaries between OpenAI Responses reasoning summary parts.
- f495460: Add a best-effort xAI Grok consumer subscription-allowance adapter with modern and safe legacy normalization, explicit xAI identity headers, and sanitized private-endpoint failures.

## 0.1.0-canary.60

### Patch Changes

- 8ac2ad9: Add a dedicated Vercel AI Gateway provider with API key or OIDC authentication, provider routing, model fallbacks, safe error attribution, tests, and public documentation.

## 0.1.0-canary.59

### Patch Changes

- eb908b7: Add xAI Grok subscription OAuth/broker helpers and a streaming Responses provider for the xAI CLI proxy, with host-owned output limits, normalized reasoning/tools/usage, and safe provider failures.
- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.

## 0.1.0-canary.58

### Patch Changes

- a4a3d52: Add best-effort Anthropic Claude and OpenAI Codex subscription-allowance snapshot adapters with portable Effect HTTP, shared schemas, sanitized errors, and host-owned polling policy.

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- de55946: Classify Codex context-window failures as context overflow, support endpoint-specific input budgets, expose subagent usage and redacted typed error summaries (including partial failed-run usage), reject subagent streams without terminal events, and clarify that ChatGPT Codex ignores output-token configuration. Carry tool-owned nested-model usage through durable workflow state and HITL failures, preserve wire-safe partial-progress failures, and normalize Workflow turn limits to positive integers.

## 0.1.0-canary.56

### Patch Changes

- 2013d5e: Keep Anthropic tool input schemas valid when Effect Schema emits repeated constraints inside `allOf`.

## 0.1.0-canary.55

### Minor Changes

- 6297363: Rename the model-facing `task` delegation tool and its public helpers to `subagent` so hosts can distinguish isolated child-agent runs from durable application tasks.

## 0.1.0-canary.54

### Minor Changes

- Forward supported protocol reasoning efforts to Anthropic Claude through `output_config.effort`.

### Patch Changes

- Preserve every sibling function call in streamed OpenAI Codex Responses while deduplicating final-response replays by call ID.

## 0.1.0-canary.53

### Minor Changes

- a47adb1: Let hosts expose validated model and reasoning-effort choices on the task subagent tool, and include the selected reasoning effort in structured task results.

## 0.1.0-canary.52

### Patch Changes

- 15d0159: Omit the unsupported `max_output_tokens` field from ChatGPT subscription Codex requests while retaining required host `maxOutputTokens` configuration.

## 0.1.0-canary.51

## 0.1.0-canary.50

## 0.1.0-canary.49

## 0.1.0-canary.48

### Patch Changes

- 6cfc7fb: Require hosts to configure model-specific output limits for Anthropic and OpenAI providers.

## 0.1.0-canary.47

### Patch Changes

- b0576d3: Fail Claude turns truncated at `max_tokens` instead of reporting normal completion.

## 0.1.0-canary.46

### Patch Changes

- Classify Anthropic context overflow, support tokenizer-backed compaction estimates, and return
  normalized Gmail threads without raw MIME or attachment bytes.

## 0.1.0-canary.45

### Patch Changes

- d8c0b7a: Send image and document tool results to OpenAI Codex as native function output content.

## 0.1.0-canary.44

### Patch Changes

- 607255e: Send image and document tool results to Anthropic Claude as native content blocks.

## 0.1.0-canary.43

### Patch Changes

- 5c53852: Pass URL-backed documents through as OpenAI Codex Responses input files.

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.

## 0.1.0-canary.41

## 0.1.0-canary.40

### Patch Changes

- Make public client, Workflow, and sandbox helpers Effect-native.

## 0.1.0-canary.39

### Patch Changes

- Expose Effect-native attachment and durable workflow helpers, and refresh package documentation for current public exports.

## 0.1.0-canary.38

### Patch Changes

- Harden agent transport and voice Effect boundaries.

## 0.1.0-canary.37

### Patch Changes

- Publish canary with agent client stream continuation fixes and package docs updates.

## 0.1.0-canary.36

### Patch Changes

- afb30a0: `voiceSeedTextsFromMessages` gains `{ includeAuthors }`: prefixes user seeds with author display names so multi-user transcripts keep who-said-what when replayed into realtime voice sessions.

## 0.1.0-canary.35

### Patch Changes

- e9d235d: Harden model-produced text: `replaceLoneSurrogates`/`replaceLoneSurrogatesDeep` protocol utils, applied to lowered provider request bodies (OpenAI, Codex, Claude) and OpenAI Realtime client codec payloads so lone UTF-16 surrogates in replayed transcripts cannot poison model calls.
- 26b8b4d: Durable voice session logs: versioned `VoiceSessionLogState` + pure `foldStoredVoiceEvents` batch fold, deterministic tool event ids (`voiceToolEventId`, `storedVoiceToolEvents`, `storedToolEventsFromOutcome`) so server-witnessed tool logs dedupe against client replays, `makeVoiceEventOutbox` + `useYolkVoice` `eventLog` option for at-least-once client event batching, and projection now keeps streamed draft text when finals arrive with empty transcripts.

## 0.1.0-canary.34

### Patch Changes

- 01719c0: Lower union-root (`anyOf`) tool parameters to a single object schema in `toOpenAiRealtimeTool`; OpenAI Realtime hangs until a gateway timeout (504) on union-root function tools. Exposes `openAiRealtimeToolParameters`.

## 0.1.0-canary.33

### Patch Changes

- Voice as a first-class agent modality in `@yolk-sdk/agent`:

  - `@yolk-sdk/agent/voice`: provider-neutral voice protocol, client controller, server tool handler with approval HITL, transcript projection, durable voice event ids, WebSocket transport, and one-shot TTS/STT service contracts (`VoiceSpeechSynthesizer`, `VoiceTranscriber`, `VoiceSpeechRequest.instructions` for delivery-style steering).
  - `@yolk-sdk/agent/voice/browser`: Effect-native browser WebRTC voice transport with a fakeable runtime seam.
  - `@yolk-sdk/agent/voice/react`: headless `useYolkVoice` browser hook.
  - `@yolk-sdk/agent/providers/openai/realtime`: OpenAI Realtime session config, event codecs, and voice client codec.
  - `@yolk-sdk/agent/providers/openai/speech`: OpenAI TTS/STT adapters; 429 responses surface as `VoiceSpeechError` code `rate_limited` so hosts can distinguish quota exhaustion from outages.
  - Projection keys assistant drafts per provider output item (falling back to response id): back-to-back responses, multi-item responses, and duplicate final transcript event families no longer concatenate, wipe, or duplicate projected messages.

  Other `@yolk-sdk/*` packages ship as part of the lockstep canary release.

## 0.1.0-canary.32

### Patch Changes

- Add Effect-native Vercel Workflow host wrappers and refresh package documentation.

## 0.1.0-canary.31

### Patch Changes

- Simplify knowledge to document, file, chunk, context, and search contracts.

## 0.1.0-canary.30

### Patch Changes

- 4148be9: Poll empty durable run continuation chunks and abort promptly while waiting.

## 0.1.0-canary.29

### Patch Changes

- Expose terminal agent event detection and add Workflow terminal commit-barrier helpers.

## 0.1.0-canary.28

### Patch Changes

- 90b0558: Fix Anthropic streamed usage deltas and include cache tokens in input totals.

## 0.1.0-canary.27

### Patch Changes

- Add durable run continuation and HITL resume client helpers.

## 0.1.0-canary.26

### Minor Changes

- Add replay-safe workflow event sequencing and chat projection helpers.

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.

## 0.1.0-canary.24

## 0.1.0-canary.23

### Patch Changes

- e8ac8ce: Support URL-backed image and PDF attachment lowering in agent providers.

## 0.1.0-canary.22

### Patch Changes

- 378cd92: Turn recoverable tool execution failures into model-visible error tool results, add transcript repair/validation helpers, and preflight dangling tool calls before provider lowering.

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.

## 0.1.0-canary.20

### Patch Changes

- Add text document attachment helpers.

## 0.1.0-canary.19

## 0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.
- 6a6d7a6: Add helpers for model-visible recoverable tool failures.

## 0.1.0-canary.16

### Minor Changes

- ca545a6: Add pure agent compaction utilities under `@yolk-sdk/agent/compaction`.

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

## 0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.
- 3797339: Add model-visible message envelope fields for timestamps, author display names, and annotations.

## 0.0.1-canary.12

### Patch Changes

- b5a297a: Add HITL response helpers and serializable question results.

## 0.0.1-canary.11

### Patch Changes

- 0c7ed24: Drain HTTP agent streams after terminal events.

## 0.0.1-canary.10

## 0.0.1-canary.9

### Patch Changes

- Add typed attachment sources for inline media, URLs, and host-owned refs.

## 0.0.1-canary.8

### Patch Changes

- 76d5c21: Add document chat content parts with provider lowering.

## 0.0.1-canary.7

## 0.0.1-canary.6

### Patch Changes

- Add package-owned task subagent helpers for non-recursive tool exposure, result formatting, and protocol-aligned subagent run ids.

## 0.0.1-canary.5

## 0.0.1-canary.4

### Patch Changes

- 992ae2c: Require exact HITL request matches before resuming runtime sessions.

## 0.0.1-canary.3

## 0.0.1-canary.2

### Patch Changes

- 55bc6c7: Prepare next canary release.

## 0.0.1-canary.1

### Patch Changes

- Prepare next canary release.

## 0.0.1-canary.0

### Patch Changes

- 4232c86: Prepare first public canary release.
