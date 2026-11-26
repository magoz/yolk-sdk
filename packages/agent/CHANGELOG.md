# @yolk-sdk/agent

## 0.1.0-canary.164

### Patch Changes

- 338a76f: Advance in lockstep with `@yolk-sdk/vercel-workflows`: its Cloudflare runtime can prepare a run's object before the run starts (`prepareRun`, `startWithRunId`, `registerRunPreloads`). These packages have no direct changes in this release.
- Updated dependencies [338a76f]
  - @yolk-sdk/conformance@0.1.0-canary.164

## 0.1.0-canary.163

### Patch Changes

- f4b28c7: Advance in lockstep with `@yolk-sdk/vercel-workflows` and `@yolk-sdk/codemode`: Workflow `executionId`s must be unique per execution of a step body, cancelled Cloudflare runs abort their running steps (`getStepSignal()`) and settle, and Cloudflare code mode keeps the output a script sent before hitting its CPU limit. These packages have no direct changes in this release.
- Updated dependencies [f4b28c7]
  - @yolk-sdk/conformance@0.1.0-canary.163

## 0.1.0-canary.162

### Patch Changes

- aab270f: Advance in lockstep with `@yolk-sdk/codemode`, which upgrades its script engine to `@earendil-works/pi-codemode` 1.6.0 (frozen built-ins, output limits, constraint tags in tool declarations). These packages have no direct changes in this release.
- Updated dependencies [aab270f]
  - @yolk-sdk/conformance@0.1.0-canary.162

## 0.1.0-canary.161

### Patch Changes

- 34b7f96: Advance in lockstep with `@yolk-sdk/codemode`: `readOnlyNestedCallGate` can admit model-invoking reads such as `classify` through `admitModelCall`. These packages have no direct changes in this release.
- Updated dependencies [34b7f96]
  - @yolk-sdk/conformance@0.1.0-canary.161

## 0.1.0-canary.160

### Minor Changes

- 6f9a9e3: Run code mode scripts outside a model turn, gate them to reads, mark tools that call a model, and
  keep message envelopes on chat items.

  `@yolk-sdk/codemode`:

  - `runCodeModeScript({ executor, code, nested, parentCallId, limits?, deadline?, store?, beforeNestedCall?, afterNestedCall?, staging? })`
    runs one script without a model tool call and returns a `CodeModeScriptResult`: `ok`, the JSON
    `value` and `storeWrites` of a successful script or its `error`, the unbounded `output`, every
    nested call (`calls`, `CodeModeScriptCall` with `refusal`), the bounded `nestedCalls` record,
    `usage`, `usageIncomplete`, `inputRequired`, `staged`, `timeoutMs` and `wallTimeMs`. It never
    fails; interrupting it aborts the script and cancels running nested calls. `makeCodeModeTool` now
    runs every script through it, so dispatch, limits, the deadline clamp, the executor backstop, the
    store and both hooks are one path; its results are unchanged.
  - `beforeNestedCall` also receives the called `tool` (`NestedTool`) and the call's effective
    `access`, and may refuse with `new CodeModeNestedCallRefused({ code, message })`: the script sees
    `error.code`, and the call's `refusal` keeps both. Existing hooks (`{ call, context }`, string
    failures) keep working. A hook that throws or dies now refuses the call, recording
    `The call could not be admitted.` as its `refusal`, instead of escaping the call.
  - `readOnlyNestedCallGate({ admit? })`: a ready-made `beforeNestedCall` that admits only calls whose
    effective access is `read` and refuses approval-gated and `invokesModel` tools, failing closed,
    with codes `unavailable`, `approval_required`, `invokes_model` and `not_read`. `admit` relaxes only
    the access check.
  - `makeClassifierTool` sets `invokesModel: true`.
  - `CodeModeLimits`, `defaultCodeModeLimits`, `CodeModeStagingOptions` and the deadline constants
    move to the new script module; they are exported from the root as before.

  `@yolk-sdk/agent`:

  - `ResolvedToolSet.nestedExecutor({ parentCallId })` returns the `NestedToolExecutor` a
    nested-access registration gets, bound to a host id instead of a tool call (nested ids
    `<parentCallId>/<seq>`, ledgered under parent key `parentCallId`), without staging. It is a
    required field: hosts that build `ResolvedToolSet` values by hand (test fakes) must add it. The
    warning for code-mode-only tools without a nested-access registration now says they stay
    reachable through it.
  - `ToolRegistration.invokesModel` and the `makeTool` option mark a tool that calls a model when it
    runs. `resolveTools` copies it to `ToolMetadata.invokesModel` and `NestedTool.invokesModel`; it is
    never sent to providers. The `subagent` tool sets it.
  - React: `buildAgentChatMessages` keeps assistant message envelopes (`createdAtMs`, `author`,
    `annotations`) from the transcript, as live events already did, so `toAgentMessages` round-trips
    them. `buildAgentChatItems` copies a message's envelope onto its `UserMessage` and
    `AssistantMessage` items (`AgentChatItemEnvelope`, each field only when set), so hosts render
    annotated host-authored messages without reading their own snapshots.

### Patch Changes

- Updated dependencies [d55175d]
  - @yolk-sdk/conformance@0.1.0-canary.160

## 0.1.0-canary.159

### Minor Changes

- 0e5d1ac: A client that rebuilds from a snapshot and resumes a run mid-turn, past that turn's `LLMStreamStart`, now starts the turn from its first model event instead of matching that turn's model events against any turn. Events gain an optional `executionTurn` identity field: the turn of the execution (`executionId`) that produced them, its `LLMStreamStart.turn`.

  `sequenceDurableAgentEvent` (and `writeDurableAgentEvent`) sets `executionTurn` from its `turn` on every event that carries an `executionId`, and removes it from events without one, as it does `executionId`. A step's `turn` must therefore be the turn its model call streams (`runModelTurn`'s `turn`): a lower one makes clients drop the execution's events as stale. With an `executionId`, a `turn` that is not a non-negative safe integer now throws a `TypeError`, like a blank `executionId`; untagged events are unchanged.

  `reduceAgentEvents`, `applyAgentEventToChatProjection` / `stepAgentChatProjection` and the `useAgentChat` reducer apply the `LLMStreamStart` an event's execution missed (no `eventId`) before the first event of an unseen `executionId` that carries `executionTurn`; only events a model call streams after its start qualify (never `LLMStreamStart`, `TurnStart` or host events). The missed start keeps a rebuilt draft streaming and moves the status as the real start would: `stepAgentChatProjection` returns it as `missedStart`, which hosts folding status beside the projection fold before `statusEvent` (the `useAgentChat` reducer does). The existing start rules then hold: a start in an ended run, or for a turn its run closed or moved past, drops the execution's events; a newer execution of the same turn supersedes the live one (after a rebuild, the execution seen first counts as the older one); otherwise the turn starts after the current messages and runs, so a call id the provider reuses in that turn no longer lands on an earlier turn's call. Hosts rebuilding from a snapshot keep calling `markChatRunStart` / `markAgentRunStart`; model events without `executionTurn` (older streams, hosts that sequence without `executionId`) behave as before.

- 628ebd5: Mark tool-attributed usage that under-counts its nested work. `ToolResult` gains an optional `usageIncomplete: true`: `usage` misses (part of) a nested model call that completed without the usage report it was billed for (a child stream's `LLMStreamEnd.usageUnavailable`, a provider's `LLMDone.usageUnavailable`, a classification without usage). It may stand without `usage` (nothing was reported) and, like `usage`, is never model-visible: `toolResultMessageFromResult` drops it. Tools that run their own model calls set it.

  The nested-call recorder carries it: `NestedToolCallInput.usageIncomplete` is kept on the call's `NestedToolCallRecord.usageIncomplete`, and `recordNestedToolCall` ORs it over every call, dropped ones included, so `nestedToolCallResultFields` returns `usageIncomplete: true` beside the summed `usage`. The result boundary, file capture and the tool ledger (its stored copy, the typed-too-large copy and replays) keep it with `usage`.

  `collectModelTurn` and `collectModelTurnAttempt` carry a marked `LLMStreamEnd` as `ModelTurnResult.usageUnavailable: true` (absent otherwise), so a tool that runs child model turns can set `usageIncomplete` from them. Harness `attemptModelTurn` carries it on `StepOutcome.Completed` and `Continue`.

  Code mode copies each nested result's `usageIncomplete` onto its record and the script's result. `makeClassifierTool` marks a classification the classifier answered without usage (a result, or `ClassificationResponseInvalid`) as `usageIncomplete`; request and provider errors are not marked. It assumes a classifier that reports the usage it spends: one that never does marks every answered call.

  The fields are absent when every report arrived and on results recorded before they existed, so stored results and ledger entries decode unchanged.

### Patch Changes

- Updated dependencies [0e5d1ac]
  - @yolk-sdk/conformance@0.1.0-canary.159

## 0.1.0-canary.158

### Patch Changes

- d4141e3: Advance in lockstep with `@yolk-sdk/connectors`, which adds Fortnox bookkeeping actions (financial years, accounts, voucher series, vouchers, voucher file connections, and SIE files). These packages have no direct changes in this release.
- Updated dependencies [d4141e3]
  - @yolk-sdk/conformance@0.1.0-canary.158

## 0.1.0-canary.157

### Patch Changes

- 7892f30: Advance in lockstep with `@yolk-sdk/connectors`, whose Fortnox supplier invoice reads now accept the JSON forms Fortnox sends beyond its OpenAPI types, and whose Fortnox reads fail an amount past the double range as `validation_failed`. These packages have no direct changes in this release.
- Updated dependencies [7892f30]
  - @yolk-sdk/conformance@0.1.0-canary.157

## 0.1.0-canary.156

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.156

## 0.1.0-canary.155

### Patch Changes

- d4d8714: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.5 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.5 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [d4d8714]
  - @yolk-sdk/conformance@0.1.0-canary.155

## 0.1.0-canary.154

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.154

## 0.1.0-canary.153

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.153

## 0.1.0-canary.152

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.152

## 0.1.0-canary.151

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.151

## 0.1.0-canary.150

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.150

## 0.1.0-canary.149

### Minor Changes

- c112350: The OpenAI chat provider (`makeOpenAiProviderLayer`, `OpenAiProviderLayer`) no longer drops `LLMRequest.reasoningEffort` silently. On the native OpenAI endpoint (no `chatCompletionsUrl`, or `https://api.openai.com/v1/chat/completions`) `reasoningEffortFormat` now defaults to `reasoning-effort`, so the effort is sent as `reasoning_effort` (`reasoning_effort` is now a reserved key there, dropped from `extraBody`: a host that sent `extraBody.reasoning_effort` to the native endpoint as a workaround must move it to `LLMRequest.reasoningEffort`). Models without reasoning reject that field: stop sending an effort to them, or set the new `reasoningEffortFormat: 'omit'`, which never sends the effort and never fails (on any endpoint). Other endpoints stay opt-in: without `reasoningEffortFormat`, a request with an effort now fails with a non-retryable `validation_error` `LLMError` before any request (the same for `toOpenAiRequestBody` called without a format). Vercel AI Gateway and OpenCode Go chat set their format and are unchanged; the Gateway's `reasoningEffortFormat` also accepts `'omit'`.
- c112350: `AgentReasoningEffort` adds `none` and `max`, which OpenAI, Anthropic and Vercel AI Gateway document for reasoning models (support is model dependent). Earlier values keep decoding; data written with the new values does not decode on an earlier canary. OpenAI chat, Responses (Codex, Grok, OpenCode Go `responses`) and Gateway pass both through. Anthropic Messages (Claude, OpenCode Go `messages`) sends `max` as `output_config.effort` and rejects `none` with a non-retryable `validation_error` `LLMError` before any request, since leaving it out would apply the model's default effort, which reasons. Exhaustive matches or `Record`s keyed by `AgentReasoningEffort` need the two new cases. Passing the wider type into APIs typed for a narrower effort set (array `indexOf`/`includes`, narrower parameters) also breaks at compile time.
- 22f42c0: The `@yolk-sdk/emulators/openai` emulator now emulates OpenAI reasoning models as the three new synthetic reasoning fixtures record them. `reasoningModels` (new option, default `openAiEmulatorDefaultReasoningModels`: `gpt-6-luna`, also added to `openAiEmulatorDefaultModels`) take `reasoning_effort` and `max_completion_tokens`, send no reasoning text, and report `usage.completion_tokens_details.reasoning_tokens`, counted in `completion_tokens` (synthetic, not fixture-backed: 0 for `reasoning_effort: 'none'`); `/_emulate/state` lists them. A reasoning model answers a non-null `max_tokens` with the fixture's 400 `{ error: { message, type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } }` (after model validation, never for a scripted turn, using up no fault; recorded as the ledger's new `unsupportedParameter`). Sampling parameter rules, `reasoning_effort` on a model that does not reason (still recorded and ignored), and per-model effort values are not emulated until a fixture backs them. Models that do not reason keep their wire unchanged, and the Gateway emulator is unchanged. Scripted turns still reject reasoning text fields; script reasoning as `usage.reasoningTokens`.

  `@yolk-sdk/agent/providers/openai/conformance` adds three `read` cases for a reasoning model, with synthetic fixtures whose notes cite the OpenAI docs: `openAiChatReasoningEffortCase` (`openai.chat.stream.reasoning-effort`) and `openAiChatJsonReasoningUsageCase` (`openai.chat.json.reasoning-usage`) send `reasoning_effort` and require no reasoning text and a usage report counting reasoning tokens, and `openAiChatUnsupportedParameterCase` (`openai.chat.stream.unsupported-parameter`) sends `max_tokens` and requires a non-retryable 400 with provider code `unsupported_parameter`. `OpenAiConformanceModels` gains a required `reasoning` model id (default `gpt-6-luna`) and `OpenAiConformanceSettings` the required `reasoningMaxCompletionTokens` and `reasoningEffort`. `pnpm conformance:openai` takes `--reasoning-model`, `--reasoning-max-tokens` (default 1024), and `--reasoning-effort` (default `medium`; `low` to `xhigh`).

  Both packages take a minor bump because hosts see behaviour or type changes they must act on: `@yolk-sdk/agent` because hosts that build `OpenAiConformanceModels` or `OpenAiConformanceSettings` must add the new required fields; `@yolk-sdk/emulators` because the default `/openai` emulator now answers `gpt-6-luna` (a 404 unknown model before) and rejects `max_tokens` on it with a 400.

### Patch Changes

- 5039d29: Responses provider follow-ups (#363, #365, #370).

  - A Grok or OpenCode Go `responses` stream that ends before `response.completed` without emitting `Done` (a cut connection, an empty body) now fails with `responseIssue: 'missing_done'`, the loop's incomplete stream, as Claude and native Messages do for a missing `message_stop`. It stays non-retryable `invalid_response` with `providerCode: 'incomplete_stream'`, so OpenCode Go still re-routes a cut that came before any event, and host checks on that code are unchanged. Harness hosts now get `Continue` (output started) or `RecoverFull` (none) instead of a failed run. Codex is unchanged: its EOF compatibility completes such a stream with a `Done` marked `usageUnavailable`, so it never reports `missing_done`.
  - In-stream error events (Chat Completions error envelopes, which covers generic OpenAI-compatible chat, Vercel AI Gateway and OpenCode Go `chat-completions`; Responses `error` and `response.failed`; Claude and native Messages `error`) remove the requested model id (and Chat Completions and Responses `error.param` object values) from their text before classifying it, as HTTP errors already did, so a model id containing "overload" or "rate_limit" never makes an in-stream error retryable or decides its kind. Structured codes still win, and a failure named in the text beside the model id still counts.
  - Codex's recovery of a final response whose `output` is missing or misses a required key now reads the output items one by one, for streamed `response.completed` and JSON bodies alike: valid items still count, so a function call the stream never emitted still runs (`tool_use`) instead of being dropped with the whole response and ending the turn as `stop`; items that do not decode are dropped. A `function_call` that does not decode must replay a call the stream already emitted (same `call_id` or item `id`), and a `message` that does not decode and carries text must be one whose text already streamed (a broken message without text, such as an empty preamble, is dropped); otherwise the response fails as non-retryable `invalid_response` rather than lose that call or answer (earlier releases completed the turn without it, and a JSON body with one completed empty). The recovered response's `usage` is now read when it decodes on its own: `Usage` is emitted and `Done` is left unmarked, and a streamed `Done` is marked `usageUnavailable` only when that usage is missing or does not decode (earlier releases never read it and always marked the streamed `Done`). Recovery is decided from the decode issue (a missing key under `output`), never from the error message text. Every Responses provider (Codex, Grok, OpenCode Go `responses`) now also drops a final `function_call` that repeats a streamed call under the same output item `id`, not only the same `call_id`, so it is never emitted twice.
  - @yolk-sdk/conformance@0.1.0-canary.149

## 0.1.0-canary.148

### Minor Changes

- 1cd7e4c: Signal when a streamed model call completes without the usage report it asked for (#109). `LLMDone` and the protocol `LLMStreamEnd` gain an optional `usageUnavailable: true`, which the loop forwards from the provider's `Done` onto that model stream's `LLMStreamEnd`. Providers set it when:

  - streamed chat (generic OpenAI-compatible chat, Vercel AI Gateway with `streaming: true`, OpenCode Go `chat-completions`): the stream ends after its finish chunk without the usage chunk `stream_options.include_usage` requested;
  - streamed Responses (Codex, Grok, OpenCode Go `responses`): `response.completed` carries no `usage`;
  - Codex: its EOF-completion compatibility completes a stream without `response.completed` (including a premature cut, which it has always accepted), or it recovers a streamed `response.completed` whose `output` is missing or misses a required key (such as a function call's `call_id`), so the response, usage included, cannot be decoded;
  - Claude and native Messages (OpenCode Go `messages`): `message_stop` arrives without a `message_delta` carrying an output count, so only the partial `message_start` usage (if any) was reported.

  These turns kept their existing successful completion, since failing them would re-run and re-bill the model; hosts can now tell "usage was requested but never arrived" from "no usage" and decide how to account for it. Grok and OpenCode Go Responses streams fail without `response.completed`, and Messages streams fail without `message_stop`, so they never complete without a terminal event. Non-streamed (JSON) responses are never marked, including a Codex JSON response recovered without output. The field is absent when the report arrived and on events recorded before it existed, so persisted event streams decode unchanged, and no event or `LLMEvent` tag is added.

- b501399: Add `stepAgentChatProjection` and `AgentChatProjectionStep` (`@yolk-sdk/agent/react`) for hosts that fold a run's status beside the chat projection (#351). It applies an event as `applyAgentEventToChatProjection` does and returns `{ projection, statusEvent }`: `statusEvent` is the event the `useAgentChat` reducer's status follows, so a host folding it with `nextAgentStatus` or `agentStatusFromEvents` gets the same status. A replayed `AgentAwaitingInput` whose every request names a call already answered, cancelled, denied or finished gives `undefined` (the status stays instead of showing `Blocked` with no card to answer), and a pause naming some such calls comes back with only its pending requests, read in the turn the event acted in; an event seen before, an event of a superseded, settled or stale model step, and a replayed start of a finished call also give `undefined`. The `useAgentChat` reducer now folds its status from the same step.

### Patch Changes

- e5bcedb: A replayed earlier turn's event no longer lands on a later turn's call reusing its id in the chat projections (#361). After turn 1 settled `call_0` (`deploy { env: 'prod' }`) and turn 3 asked another `call_0` (`deploy { env: 'staging' }`), a replay without event id (or under a new one) of turn 1's request, `AgentAwaitingInput`, `ToolExecutionStarted`/`Completed`/`Error`, or answer acted on turn 3's part in `applyAgentEventToChatProjection` and the `useAgentChat` reducer: the pending staging card became the prod call (pending again, running, completed or answered), and the status (`useAgentChat`, `stepAgentChatProjection`'s `statusEvent`) blocked on the prod request or moved to running. The latest turn's part now gives way to the last earlier part holding the event's exact call (id, name and arguments; an answer: its request id) when it is known not to be the one: another call, or, for an answer, a part holding another request or its result; the earlier settled part keeps its state, and the later card and the status blocked on it stay. A later turn's own request still asks on its own part, a pending request re-pended with a new preview still replaces it, a part still streaming its input keeps the event, and with no earlier part holding the call a request or tool-batch event acts on the latest turn's part as before. A question, input or interaction answer that reaches a part holding another request, when no part holds its own (a stale answer, for example after hydration), now changes nothing in the chat projections (in `applyAgentEventToChatMessages` too); it used to answer that other request. The chat reads a part's request as `reduceAgentEvents` reads a run's: an answered or cancelled part by its response's request id (also when it kept no request: an answer applied before its request, or a snapshot run holding only its response), and a denied part by the approval request it denies (`ChatToolState.Denied` gains an optional `request`, kept from the pending approval). In both the chat projections and `reduceAgentEvents`, an answer reaching a part or run with its result (completed, accepted, errored or provider-completed) is a replay (the loop asks only before a result): it acts on an earlier part or run holding its request, else changes nothing, instead of turning the finished call into an answered one (which for an accepted background call dropped its fence); a running call still takes an answer that precedes its request. In both the chat projections and `reduceAgentEvents`, an approval denial answers only a pending approval: one reaching a part or run with its result, or one holding a question, input or interaction request or answer, acts on an earlier pending approval, else changes nothing, instead of turning a later turn's pending question, or a finished call (an accepted one losing its background fence), into a denied one; a call holding no request (called or running) still takes the denial. Request ids are built from the tool name and call id, so a later turn's call of the same tool reusing the id still cannot tell an earlier turn's replayed answer from its own, nor a replayed denial from a denial of its pending approval or running call: dedupe answers by `eventId`. A replay that gives way to an earlier part still acknowledges the latest turn's provisional call with the same id (execution routing matches ids), so a superseded execution of that turn no longer discards that call.
- 2c8e618: Fail Claude streams that end before `message_stop` instead of completing them.

  Compatibility change: the Claude provider (`makeAnthropicClaudeProviderLayer`, `streamAnthropicClaudeResponse`) used to treat a stream that ended without `message_stop` (a cut connection, an empty body) as a normal answer and emitted `Done`. Like native Messages it now requires the terminal event: such a stream emits no `Done` and fails as non-retryable `invalid_response` with `responseIssue: 'missing_done'`, the loop's incomplete stream, even when a `message_delta` with a stop reason arrived (only `message_stop` ends a message). A `max_tokens` or `content_filter` stop reason still fails as that terminal, without `responseIssue`. Hosts that fold provider events directly now see an error instead of a short answer; harness hosts get the incomplete-stream recovery (`RecoverFull` / `Continue`). Native Messages (OpenCode Go `messages`), which already failed here, now also sets `responseIssue: 'missing_done'` on that error. Claude's JSON fallback still accepts a body without `stop_reason`.

- cb15a7b: Classify provider failures from structured fields, and name the native Messages error type.

  Provider failures used to be classified by scanning the error body text before the HTTP status, so an echoed request value could decide the kind. The Vercel AI Gateway answers an unknown model with a 404 `model_not_found` whose message and `param.modelId` repeat the model id; a model id containing "overload" or "rate_limit" turned that 404 into a retryable `overloaded` or `rate_limit` failure, and the same happened on the OpenAI-compatible chat, Responses (Codex, Grok, OpenCode Go), Claude and native Messages providers (Anthropic's 404 message is `model: <id>`). The kind now comes from the provider code (`error.type`/`code`) when it names one, then the HTTP status; a 408 request timeout is now a retryable `network` failure. Claude and native Messages errors that report a specific `details.error_code` still classify from their `error.type` (so an `overloaded_error` stays retryable) while reporting the specific code. Upstream text only refines a status (an Anthropic 400 "prompt is too long" is still `context_overflow`, a 503 "service unavailable" still `overloaded`) and decides alone only when there is no status (stream error events); it never makes a 4xx retryable. OpenAI-compatible errors likewise classify from `error.type` when their `code` (for example a numeric string) names no kind. A JSON error body is read as its decoded strings (only its first 64 KiB, and as raw text when it nests deeper than 32 levels, so a hostile body classifies by status instead of overflowing the stack), and the requested model id and the Gateway's `param.modelId` are removed from that text first; a string `param` such as OpenAI's `"input"` names the rejected parameter and is not removed, nor is any echoed value shorter than three characters. Genuine 429, 5xx and `overloaded_error` failures stay retryable.

  The native Messages layer (OpenCode Go `protocol: 'messages'`) now reports the error envelope's type as `provider.providerCode` on HTTP errors, as the Claude provider does (`error.details.error_code`, then `error.type`, then `error.code`), so an unknown model reads `not_found_error`. The LLMError message stays sanitized.

  - @yolk-sdk/conformance@0.1.0-canary.148

## 0.1.0-canary.147

### Minor Changes

- e7bb9e6: Add `markChatRunStart` (`@yolk-sdk/agent/react`) and `markAgentRunStart` (`@yolk-sdk/agent/client`) for hosts that rebuild chat or client state from a snapshot (#355). Each sets the run start `AgentStart` sets (`turnStart`: turn `0`, `run: true`; chat: after the last message, either chat state; client: `firstRun` = `toolRuns.length`). A host that reads a resumed run from a cursor past its `AgentStart` (for example a projection rebuilt from a snapshot after a HITL answer) had no turn start, so the resumed tool batch acted on the last card or run holding its call id, which could be an earlier turn's call reusing it. With the run start, the batch reaches the snapshot's cards and runs only as the same call or, for answers, the one holding their request, and adds its own otherwise. A snapshot taken mid-turn keeps working for that turn's host events; its later model events before the next `LLMStreamStart` still count as replays, as for a client that connected mid-turn (documented in `client-react.mdx` and the READMEs).

### Patch Changes

- e7bb9e6: `buildAgentChatMessages` no longer gives one tool run to every card with its call id, across turns (#356). `toolRuns` can hold one run per turn for a reused id (`reduceAgentEvents`), and snapshot hosts pass runs of several turns (pending requests from `toolRunsFromHitlRequests`, accepted interaction receipts); the last run by id used to show on every card with the id, so an earlier turn's accepted interaction and a later turn's pending approval on `call_0` both showed the approval (or, in the other order, the actionable card was hidden).

  - Each run goes to one card, later runs first, each card taking at most one, so one run per turn of the same call lands on its own turn. A run holding a call (its own, or its request's) takes the last card holding the same call (id, name and arguments equal); when no card holds it (arguments a host normalized), the last card with its id and name that no run took and that has no result message, so a pending request is never hidden; a run whose call has another name (another turn's call, not in `messages` yet) shows nowhere (before, it showed on the last card with the id). A run holding no call (an input still streaming, an answer or denial without its request) that answers an earlier run's request takes that run's card, so a later denial still wins over the approval it denies; otherwise it takes the last card with its id that no run took (as before for a single card), one without a result message first while the run still waits on its result (an input streaming, a submitted interaction).
  - A `ToolResult` message now belongs to the last card with its id before it: a later turn's call reusing the id no longer shows an earlier turn's result (or its background acceptance, which hid the later call's pending request), and an earlier call no longer shows a later turn's result. A result with no card before it shows as its own message instead of attaching to a later call.

- 6dc0b32: A resumed run's tool batch no longer lands on an earlier turn's call that reused its id (#352). The loop resumes a pause with `AgentStart`, then the paused batch (answers, starts, results) before its first model turn; `AgentStart` cleared the turn start, so `reduceAgentEvents`, `applyAgentEventToChatProjection` and the `useAgentChat` reducer acted on the last run or part holding the id, in any turn: a resumed result replaced an earlier turn's `Accepted` background run or `Completed` call, and a resumed answer overwrote an earlier turn's completed run.

  - `AgentStart` now records a run start instead of clearing the turn start, after the runs or messages kept so far. `AgentClientTurnStart` is now a union of `AgentClientModelTurnStart` (the existing shape) and the new `AgentClientRunStart` (`run: true`, turn `0`, no `closed` or `earlier`); `AgentChatTurnStart` gains an optional `run: true`. `submitAgentUserMessage` and the `useAgentChat` reducer's local submit, HITL answer, regenerate and edit record one too, for hosts that stream without `AgentStart`. Host events then reach an earlier turn's run or part only as the same call (id, name and arguments equal) or, for answers, the run or part holding the request they answer; otherwise they add their own. The run's first `LLMStreamStart` always starts a new turn (also a host's turn `0`), and the run start stays in `earlier` as turn `0`. States without `run` (built before it) behave as before.
  - The model's events before the run's first `LLMStreamStart` replay an earlier run's: they act on a run or part from before the run start that holds their id, else on the run's own (hosts that stream without `LLMStreamStart`), never on the resumed batch's call reusing the id, so replays of an accepted call keep their fence and a replayed model event of it no longer removes or resets the resumed call. The client's transcript fence drops only stale active runs from before the run start.
  - `reduceAgentEvents`: an answer whose call the latest turn lacks and whose request no run holds now adds a run (a resumed answer whose pending run `AgentStart` dropped) instead of being dropped when another turn holds the id; an answer reaching a latest-turn run that holds another request still changes nothing. The added run carries only the response (the client no longer holds the request or call), so a replay without event ids of a whole finished resumed run adds a second answered run that its replayed start and result complete again; dedupe such replays by `eventId`.
  - The chat's replayed-start fence now matches the client's: a `ToolExecutionStarted` of the same call (id, name and arguments equal) leaves a `Completed`, `Accepted` or `Errored` part, and the `useAgentChat` reducer's status, alone (before: `Completed`/`Accepted` by id; an errored call went back to `Running`). A start whose arguments differ is another call's: it now reopens a completed or errored part (the by-id rule is gone; an accepted part keeps ignoring every open state, as before), so hosts must send tool-batch events with the call exactly as the model emitted it.
  - @yolk-sdk/conformance@0.1.0-canary.147

## 0.1.0-canary.146

### Minor Changes

- 0de4b07: The client names the pause a durable HITL answer is for (#338), so hosts no longer build `?pause=` into the endpoint by hand. `StreamAgentRunHitlResponseEventsRequest` takes an optional `pause` (the `eventId` of the `AgentAwaitingInput` that asked): the HITL resume helpers send it as the `pause` query parameter of the POST only, and the continuation reads that follow use `endpoint` as given (a blank `pause` fails before the POST). Endpoints the client rewrites (adding `startIndex`, `pause` or a run id) keep a network-path `//host/path` form, where the host was dropped before; write them absolute, `//host/path` or `/path` (a path-relative one resolves against the root), and expect the query re-serialized. `@yolk-sdk/agent/client` adds `HitlPauses` (an Effect Schema: request id -> pause id, `emptyHitlPauses`) with the pure `rememberHitlPause(pauses, event)`, which records the pause of each request an `AgentAwaitingInput` holds (the latest wins; a pause without an `eventId` forgets the earlier one), and `hitlPauseFor(pauses, response)`. `useAgentChat` keeps that map in its state (`AgentChatState.hitlPauses`, from every `AgentAwaitingInput` it receives, seen or not, `applyEvent` replays included, so a replay from an earlier index ends at the latest pause; reset with `seenEventIds` when a new stream starts) and puts the answer's pause on its transport request (`AgentChatTransportRequest.pause`, absent when no pause with an `eventId` asked); the default transport ignores it. Hosts that already put `?pause=` in the endpoint keep working; pass `pause: request.pause` instead.

### Patch Changes

- 964b602: A replayed request no longer reopens a settled call in the chat projections (#346). In `applyAgentEventToChatProjection`, the `useAgentChat` reducer and `applyAgentEventToChatMessages`, a `ToolApprovalRequested`, `QuestionRequested`, `InputRequested` or `InteractionRequested` event (or an `AgentAwaitingInput` request) that reached a call already answered, cancelled, denied or finished set it back to pending with an actionable card, for example a replay without event id landing on an earlier turn's call. Such a request now leaves the part as it is when it names the same call (id, name and arguments), with or without event id, and the `useAgentChat` reducer keeps its status when a replayed `AgentAwaitingInput` names only such calls (it no longer blocks the run with no card to answer), and a pause that names some blocks only on its pending requests (`Blocked.requests` and `kind` leave the settled ones out). The loop asks for a call only until it has a result or used an answer, so a legitimate re-pend still shows: a running call has no result, so after an abort the next run that resumes it asks again and the card shows; an invalid input answer re-pends the same request while the part is still pending (the server emits `InputSubmitted` only for a valid payload and the chat never applies an input answer locally), a pending request is still replaced by a newer one (a recomputed approval preview), and a later turn reusing the call id asks on its own part. Hosts must not re-ask a call whose question answer or approval denial the client already applied locally: reject the response and keep the pause pending instead.
- ad085cd: `reduceAgentEvents` no longer merges two turns' tool runs when a provider reuses a call id across turns (#343). It kept one `toolRuns` entry per call id, so a later turn's `call_0` replaced the earlier turn's run, and a later call reusing the id of an accepted (background) call was taken for a replay of it: its input, approval and start were ignored and its result replaced the `Accepted` run (within a run), or all its events were dropped (after the transcript acknowledged the earlier call, for example across a pause resumed without `AgentStart`, or in the next run). A resumed run that starts with `AgentStart` clears the turn start, so its tool batch before the next model turn still acts on the last run holding the id (#352).

  - `AgentClientState` records where the latest model turn's runs start (`turnStart`, new `AgentClientTurnStart` type: `streamId`, `turn`, `firstRun`, `closed`, and `earlier`, the earlier turns' starts as `AgentClientEarlierTurnStart`), at each `LLMStreamStart`, tagged or not; a start of the same stream and turn with no terminal event or user message since retries the turn and keeps its runs. `AgentStart` and `submitAgentUserMessage` clear it. Carry `turnStart` with `toolRuns` when you keep client state yourself.
  - The model's events (input, provider results) act only on the latest turn's runs, so a later turn's call gets a run of its own. Host events act on the latest turn's run first, else, as a replay without event id or a late tool-batch event: a request or tool-batch event on the last earlier run holding the same call (id, name and arguments equal), an answer on the last earlier run holding the request it answers (a denial: a pending approval); an answer for a call id another run holds under another request changes nothing, also when the only run for the id holds another request (a stale answer whose request's run was never seen, for example after hydration).
  - The background-replay fences stay: a replayed start or request of an accepted call leaves its `Accepted` run alone, and the transcript's acknowledgement still fences replays of that call; with a turn start known it fences only events naming the acknowledged call, never a later call reusing its id or the model's events of the latest turn.
  - A replayed request no longer reopens a settled run (as #346 does for the chat projections): a `ToolApprovalRequested`, `QuestionRequested`, `InputRequested` or `InteractionRequested` event that reaches a run past its request (denied, answered, cancelled, submitted, completed, accepted, errored or provider-completed) and names the same call (id, name and arguments equal), with or without event id, leaves the run as it is. A request for another call with the id, for a call still pending (an invalid input re-pends it), or for a running call applies: a run stopped (aborted, failed or paused) while the call ran asks it again when it resumes, an approval or an interaction under the same request id. A replayed `ToolExecutionStarted` of the same call no longer reopens a completed or errored run either (as the `Accepted` fence already did). `Denied` runs now keep the approval request they deny (`request`, optional, as answered runs keep theirs: absent when the event carried none) for this check.
  - The status follows only what was applied: a pause (`AgentAwaitingInput`) blocks only on its requests whose call is not past its request (`Blocked.requests` and its kind list only those), and leaves the status as it was when none is; a replayed start of a finished call leaves it too.
  - When the latest turn's run is known to be another call (or to hold another request) than the one a host event names, and an earlier run holds that call (or request), the event acts on the earlier run: a replayed answer or start of an earlier turn's call no longer lands on a later turn's call reusing the id.
  - A superseded or uncommitted execution's tool runs are removed or restored within its own turn, not in other turns holding the id: a turn reconciled at `AgentAwaitingInput` or `AgentEnd` after later turns started changes only the runs between its start and the next (`turnStart.earlier`); an earlier turn whose start the state did not see is left alone.
  - `toolRuns` keeps its type (`Denied` only gains the optional `request`). It can now hold one run per turn for a reused call id, in call order: read a call's run by id with the last match, as `buildAgentChatMessages` does. Until a start is seen, and for states built before `turnStart`, tool events act on the last run holding a call id, as before, except the fences above: an answer to another request is dropped, and a replayed request or start of a settled call leaves it alone.
  - @yolk-sdk/conformance@0.1.0-canary.146

## 0.1.0-canary.145

### Patch Changes

- c1aaaeb: Chat projections no longer let a later turn's tool call overwrite an earlier turn's call when a provider reuses the call id across turns (#335). `applyAgentEventToChatProjection` and the `useAgentChat` reducer matched a tool event's call by id in the last message holding it, even an earlier turn's, so (for example) turn 1's completed `call_0` became turn 3's `Called` call, with or without `executionId`.

  - Both chat states record where the latest model turn starts (`turnStart`, new `AgentChatTurnStart` type), at each `LLMStreamStart`, tagged or not (an untagged retry of the latest turn keeps its start; `AgentStart` and the chat reducer's local submit, HITL answer, regenerate and edit clear it). A turn's tool events (input, its `AssistantMessage`'s calls, provider results, the tool batch, approvals, questions and answers) match and place a call only after it: an execution's own turn start for its events, the latest turn's for host events, which keep finding the call they act on across a pause and resume. Carry `turnStart` with `seenEventIds` when you keep projection state yourself.
  - A later turn's call no longer joins an earlier turn's message, and a later turn's `AssistantMessage` no longer replaces it; question, input, interaction and approval-denied answers update the one call they answer, not every part with its id.
  - Before a start is seen, after `AgentStart`, and always in `applyAgentEventToChatMessages`, tool events match the last message holding the call, as before, except that answers, approval denials and an added acceptance or `interaction_outcome` result (`appendProtocolMessage`, `HydrateMessage`, `AppendMessage`) update that one call instead of every call with the id. When the turn does not hold the call (a replay without event id, a batch event after the next turn started), a request or tool-batch event updates the last earlier part holding the same call (id, name and arguments equal) and an answer the last earlier part holding the request it answers (a denial: a pending approval), else nothing, instead of adding a part; the replay status fence checks that call. Tool-batch and request events must carry the call exactly as the model emitted it: a host that normalizes arguments between sources gets a second card for a replayed or late event.
  - Reconciling a turn that ran more than once: without its anchor, the turn starts after the user message before its first message (a steer after the turn no longer keeps both answers); without `Until`, the first later turn's start the chat saw without `executionId` ends it; restoring a message the discarded execution replaced keeps the parts the tool batch updated since.
  - `reduceAgentEvents` is unchanged: it keeps one tool run per call id (the latest turn's) and takes a later call reusing the id of an accepted call for a replay of it.
  - @yolk-sdk/conformance@0.1.0-canary.145

## 0.1.0-canary.144

### Patch Changes

- 0bd8166: The `@yolk-sdk/agent/client` README (linked from the package README) now says how a Workflow HITL answer names its pause (#334): a request id alone is ambiguous, so put the pause (the `eventId` of the `AgentAwaitingInput` that asked) in the `endpoint` passed to the HITL resume helpers, for example `?pause=<eventId>`. Continuation reads reuse that endpoint, so the tail route ignores the parameter.
- d8758cf: `@yolk-sdk/codemode`: a code mode call abandoned after its script saved a staged plan now names that plan. Before, the re-execution's interrupted result listed the ledgered nested calls but never the plan, so the model never learned its id and digest and could not `review_plan` it. The interrupted result now carries `structuredContent.codemode.plan` (`{ id, digest, count, reviewToolName }`) and the plan notice (`stagedToolPlanNotice`) after the bounded listing, before any input-required notice, as a finished script writes them, so the ledger's bounding keeps them too. `@yolk-sdk/agent/tools`: `ToolLedgerAbandonedInput` gains an optional `plan` (`StagedToolPlanRef`), which `resolveTools` sets for nested-access registrations of a resolution with staged tool plans when the plan store holds an unclaimed, intact plan in its scope under the call's plan id (`plans.planId({ call })`, default the call id); it is never read from model data, and a host plan id that throws or is invalid leaves it unset, and a plan store failure or a read slower than 5 s (`toolLedgerCompleteTimeoutMs`) is logged and leaves it unset.
- 6afa1c5: Advance in lockstep with `@yolk-sdk/sandbox`, which adds a Cloudflare Containers backend (`@yolk-sdk/sandbox/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [6afa1c5]
  - @yolk-sdk/conformance@0.1.0-canary.144

## 0.1.0-canary.143

### Minor Changes

- 83e4a7b: Clients show the committed answer for each turn of a run in which a newer execution superseded an older one, not only the final turn (#322). When a non-final turn's older execution committed while a newer one streamed, `reduceAgentEvents`, `applyAgentEventToChatProjection` and the `useAgentChat` reducer kept the newer answer and its tool calls until reload, beside the calls the tool batch actually ran. At `AgentEnd` and `AgentAwaitingInput` they now replace it with the committed assistant message from the event's `messages` (the one an execution of that turn streamed, found by value), at the turn's place in the chat (before a user message that followed the turn), keeping each committed call's state; the uncommitted execution's calls no host event acted on are removed (from `toolRuns` too). A turn already showing the committed answer is unchanged, and a later turn's output is never taken or removed by it. Until that event, the newer answer stays shown.

  - `AgentExecution` has an optional `answer` (its `AssistantMessage`); the shown execution of such a turn keeps `calls`, `output` and `answer` after it settles, and a superseded one keeps `answer`, until its run's terminal event. A host event acknowledges a kept execution's call only while its turn is the run's latest.
  - `AgentChatExecutionOutput` has new `After` and `Until` variants (where an execution's turn starts and ends in the chat); exhaustive matches on it need cases. An execution's events never change a chat message another execution keeps for reconciling, even through a reused call id: its output goes to a message of its own.
  - An `AssistantMessage` no longer deletes a tool part a host event acted on (running, completed, pending approval or question) that it does not name: a tool batch that ran another execution's call while this one streamed placed it in its message.
  - Limits (vercel-workflows README, "One step, several executions"): a turn retried after a user message (including a promoted steer with a new `eventId` between its two executions) shows both answers; a client that connects mid-turn sees the earlier execution as plain events; the committed answer is matched by value across the run, so an uncommitted answer equal to another committed message counts as committed; call ids reused across turns can let a later turn's events update an earlier, non-reconciled turn's call.

### Patch Changes

- bfbc4e9: `@yolk-sdk/agent/tools`: the tool ledger keeps a code mode result's staged plan when the result is over `maxResultBytes`. `toolLedgerResult` now keeps `structuredContent.codemode.plan` (`{ id, digest, count, reviewToolName }`, with `ok` and any kept `inputRequired`) and its plan notice as uncut text, only when the text ends with that notice where code mode writes it (last, or followed by the kept input-required notice). Before, it dropped the plan and cut its notice off the end of the text, so a replayed script (a redelivered step) no longer named the plan id and digest `review_plan` needs. Another tool's result with that shape but no notice keeps neither (the ledger never writes the notice itself). The notice text now comes from the new `stagedToolPlanNotice` export, and the plan shape from the new `StagedToolPlanRef` Schema export (`@yolk-sdk/codemode`'s `CodeModeStagedPlan` is now its type); code mode uses both, and its result text is unchanged. Ledger entries recorded before this fix are not repaired: their stored copies stay as they were recorded.
  - @yolk-sdk/conformance@0.1.0-canary.143

## 0.1.0-canary.142

### Patch Changes

- 8a3c032: Advance in lockstep with `@yolk-sdk/vercel-workflows` and `@yolk-sdk/codemode`, which add Cloudflare Workers runtimes (`@yolk-sdk/vercel-workflows/cloudflare*` and `@yolk-sdk/codemode/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [8a3c032]
  - @yolk-sdk/conformance@0.1.0-canary.142

## 0.1.0-canary.141

### Minor Changes

- 38f38cf: Retried and redelivered model steps no longer splice two answers in the client, and a final turn that ran more than once shows the committed answer, when the host tags its model events with `executionId` and clients are on this release (#305). Open cases remain (below).

  - `@yolk-sdk/vercel-workflows`: `sequenceDurableAgentEvent`, `writeDurableAgentEvent` and `durableAgentEventId` take an optional `executionId`. It is appended to the id (`${streamId}:${turn}:${eventSequence}:${executionId}`) and set as the event's `executionId` field (removed without it; ids are then unchanged). Every written event now also carries a `streamId` field, so a terminal event closes its own run. A blank or padded `executionId` or (with it) `streamId` throws (a defect in `writeDurableAgentEvent`). Every execution of a step starts from the same `eventSequence`, so before, a retried model step (`modelStepRetry`, platform `fn.maxRetries`, queue redelivery) wrote a different answer under the first execution's ids and `eventId` de-dupe showed parts of both.
  - `@yolk-sdk/agent`: events have optional `executionId` and `streamId`. `reduceAgentEvents`, `applyAgentEventToChatProjection` and the `useAgentChat` reducer keep the executions they saw (`executions` on their state, typed `AgentExecution`), per run (`streamId`) and turn (`LLMStreamStart.turn`):
    - a newer execution's `LLMStreamStart` removes the older one's provisional output (streaming text, its `AssistantMessage`, tool calls nothing acknowledged; a call or earlier message it overwrote through a reused call id is restored) and drops its later events;
    - only terminal events close a run: a start after its `AgentEnd`/`AgentError`, at or below an `AgentAwaitingInput`'s turn, or for a turn older than one its run already started is dropped with its later events (the run is known from the terminal's `streamId` even when no execution was seen); `AgentStart` begins a fresh run;
    - a later turn, another run, a terminal event, a user message or `AgentStart` settles executions (output kept, later events dropped);
    - at `AgentEnd` and `AgentAwaitingInput`, a final turn that ran more than once shows the committed answer from the event's messages, keeping its tool calls' state;
    - events without `executionId` only discard output still streaming at the next `LLMStreamStart`.
  - Hosts must: pass `executionId` unique per execution (for example `${stepId}:${attempt}` from `getStepMetadata()`) on every event the model call produces, `LLMStreamStart` included; leave it off host events (promoted user messages, the terminal event written after the commit; a receipt replay rewrites only that terminal event); upgrade clients and servers together; keep a projection's `executions` with its `seenEventIds` (and reset it per run if events carry no `streamId`); feed one state one run at a time; use a `streamId` unique per workflow run unless the stream emits `AgentStart` (a run's ended state sticks to its `streamId`); write `AgentError` only from the final failure path, never before a retry (it ends its run for good).
  - Caveats: an older client ignores the fields and shows both executions back to back. `reduceAgentEvents` keeps one draft buffer that every `LLMStreamStart` clears, so a stopped run's unfinished draft is not kept there. Open: a non-final turn whose older execution committed while a newer one streamed keeps the newer answer and its tool calls until reload, though the tool batch ran the older execution's calls; a terminal on a namespaced child stream (for example `workflow:<run>:tool:<ns>`) does not fence the main run's paused turn ([README, One step, several executions](https://github.com/magoz/yolk-sdk/blob/main/packages/vercel-workflows/README.md#one-step-several-executions)). Tool-batch steps are out of scope: read calls are not ledgered and can rerun with different results under the same ids.

### Patch Changes

- d634a02: `@yolk-sdk/agent/tools`: the tool ledger keeps a renewal margin for one failed or hung heartbeat whatever the `heartbeatIntervalMs`, at any `leaseMs` of 4 ms or more. Each heartbeat is now bounded by `toolLedgerCompleteTimeoutMs` (5 s) or a sixth of `leaseMs`, whichever is shorter, and `heartbeatIntervalMs` is clamped to half the lease minus that bound (it was clamped to half the lease). Before, a lease of about 15 s or less, or an interval near half the lease, let one heartbeat that failed or timed out lapse the lease of a running call: a concurrent duplicate then reported the call as abandoned ("may already have been applied") while it ran and recorded its success. The margin covers one late heartbeat when the claim and the other heartbeats are fast; it is exactly zero at the defaults (30 s lease, 10 s interval, 5 s heartbeat timeout, unchanged), and several slow heartbeats or a stalled process can still let the lease lapse. On short leases, heartbeat (and claim) latency must now stay under `min(5 s, leaseMs / 6)`: a store whose heartbeats took between a sixth of the lease and 5 s used to renew and now times out every heartbeat (for example a 6 s lease with 1.2 s heartbeats), so give a slow store a longer lease.
- 3fe00ec: `@yolk-sdk/agent/tools`: the tool ledger keeps an input-required result's marker and its review call when the result is over `maxResultBytes`. `toolLedgerResult` now keeps the `{ code: 'input_required', inputRequired }` marker (dropping only other `structuredContent` fields) and cuts the text before the review call, which it keeps (or rebuilds from the marker). Before, it dropped the marker and cut the review call off the end of the text, so a replayed call (a redelivered step, an interrupted plan apply's listing, code mode's abandoned-script listing) read as an ordinary failure and its pauses were never reviewed. A code mode result over the bound likewise keeps `structuredContent.codemode.inputRequired` (with `ok`) and its input-required notice, only when its text ends with that notice; another tool's result with that shape but no notice keeps neither (the ledger never writes the notice itself). The kept refs and review text are never cut, so a result naming many pauses can be stored over `maxResultBytes`. Ledger entries recorded before this fix are not repaired: their stored copies stay as they were recorded.
  - @yolk-sdk/conformance@0.1.0-canary.141

## 0.1.0-canary.140

### Minor Changes

- 8998b9e: Finish tool calls that paused for a person's input (ADR 0014). A tool whose remote call paused (an MCP server asking a form over `2026-07-28` multi round-trip requests) stores the pause and returns `makeInputRequiredToolResult`: an error result carrying `{ code: 'input_required', inputRequired: { reviewToolName, pauseIds } }` (`toolInputRequired` reads it back). The new `makeInputReviewTool` interaction (`review_input({ pauseIds })`, renderer `input_review`) loads the stored pauses through a host `InputReviewHost`, admits one answer per pause, and resumes each pause once; its result lists every pause as `completed`, `input_required` (asked again), `not_sent` or `unknown` (`InputReviewOutcome`). Plan apply reports such calls with the new `input_required` status (with their ref, never stopping the apply; `ToolPlanCallCounts.input_required` is optional so earlier outcomes still decode), and code mode reports them in `structuredContent.codemode.inputRequired` and a notice even when the script caught the rejection. Yolk's MCP server gains forwarding tools (`forward: true`, optional `approval`): a remote tool's pause is asked of the server's own client under a signed, stateless forward state and resumed with its answers (`McpForwardRound`).

  Breaking for exhaustive consumers: `ToolPlanCallStatus` gains `input_required` and `McpServerTool` gains `McpServerForwardingTool`, so exhaustive `switch`es and `Record<ToolPlanCallStatus, …>` maps need a new case. `maxInputReviewPauses` is also exported from `@yolk-sdk/agent/protocol`. MCP clients keep a remote error result's structured content that decodes as the input-required marker under `remoteStructuredContent`.

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.140

## 0.1.0-canary.139

### Patch Changes

- 7c3a30d: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.4 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.4 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [7c3a30d]
  - @yolk-sdk/conformance@0.1.0-canary.139

## 0.1.0-canary.138

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.138

## 0.1.0-canary.137

### Patch Changes

- 41ba67b: `@yolk-sdk/agent/tools`: a call of a `makeTool` tool with `isReadCall` whose arguments do not decode now counts as a read (`toolCallAccess` is `read`, ledger policy input `readCall: true`). Its `execute` runs nothing and answers the validation error, so that error now reaches the model even when a host ledger refuses the tool's writes; before, the call counted as a write and such a ledger answered its own refusal instead. Raw `isReadCall` registrations, failing or dying classifiers, applied plan calls and background activations are unchanged.
  - @yolk-sdk/conformance@0.1.0-canary.137

## 0.1.0-canary.136

### Patch Changes

- 12dfd4e: `@yolk-sdk/agent/client`: blank NDJSON lines are heartbeats. They are still never events and never move the stream index, but each one restarts the `idleReconnect` wait, so a durable run whose server sends them while the model thinks or a tool runs keeps its connection instead of reconnecting every `idleTimeoutMs` (and spending `maxAttempts`). Servers that send none behave as before. The Workflow routes guide documents the route side: a leading blank line commits Next.js response headers before the first event, and periodic ones keep a quiet run's connection alive.
  - @yolk-sdk/conformance@0.1.0-canary.136

## 0.1.0-canary.135

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.135

## 0.1.0-canary.134

### Patch Changes

- 21fd3fe: A tool argument validation error now names a number or boolean the model sent as a JSON string, with the literal to send instead.

  Effect's issue text said only `Expected number | null at ["offset"]`. A model that quoted its numbers (seen in production on a DeepSeek model, inside a tool whose parameters are a union of operations) read that as a broken system and gave up paginating. `withToolArgumentsErrorHint`, used by the default `makeTool` message and by callbacks that append it, now adds one line per such argument, for example `Argument "offset" must be a JSON number, but it was the string "120": send 120 without quotes.` A string whose contents are not a value the schema takes (`"abc"`, or `"5"` where only 1 to 3 are allowed) is named without a literal, and long strings are not quoted. No line is added for a string the schema could take on the wire (a `String` member, a string-encoded codec) or that another union member accepted; where the schema also takes string literals, only a quoted number or boolean is named. The hint covers argument errors from every `makeTool` tool, interaction and input calls, and the loop's `question` decode; validation itself is unchanged.

- Updated dependencies [dc74275]
  - @yolk-sdk/conformance@0.1.0-canary.134

## 0.1.0-canary.133

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.133

## 0.1.0-canary.132

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.132

## 0.1.0-canary.131

### Patch Changes

- 59c9747: A provider tool call with an empty or padded id or name now fails the request with a typed `LLMError` (`invalid_response`) instead of a defect.

  The OpenAI-compatible chat, Responses (Codex, Grok, OpenCode Go `responses`) and Anthropic providers built their calls with `ToolCall.make`, which throws when the id or name is not a non-empty trimmed string. Models do return such calls (seen in production on a DeepSeek model over OpenCode Go chat completions); the throw escaped as a defect, past the loop's error handling, a host's fallback model and its failure handling. The failure is non-retryable, so the loop does not retry it. The chat provider's failure carries `providerCode: 'invalid_tool_call'` (streamed or not), so OpenCode Go's one-time re-route applies to it when the stream fails before emitting any event.

  The chat stream also keeps a call's id and name when a later chunk of that call repeats them as an empty string, rather than erasing them.

- Updated dependencies [6e9bd7d]
  - @yolk-sdk/conformance@0.1.0-canary.131

## 0.1.0-canary.130

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.130

## 0.1.0-canary.129

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.129

## 0.1.0-canary.128

### Patch Changes

- cae5998: Advance in lockstep with `@yolk-sdk/connectors`, which adds Microsoft Teams chats, channels, meeting lookup and transcripts to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [cae5998]
  - @yolk-sdk/conformance@0.1.0-canary.128

## 0.1.0-canary.127

### Patch Changes

- 5a12835: Advance in lockstep with `@yolk-sdk/connectors`, which adds SharePoint site search, site drive listing and sharing-link resolution to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [5a12835]
  - @yolk-sdk/conformance@0.1.0-canary.127

## 0.1.0-canary.126

### Minor Changes

- bcb26c8: Typed tool results (ADR 0013): a tool's typed output is the single contract for code mode scripts, files are typed fields of that output, and script values never contain file labels.

  - `@yolk-sdk/agent`: `makeTool` overloads. With `output`, `execute` returns `{ output }`; Yolk encodes it with `Schema.toCodecJson(output)` (a value that does not encode is a value-free `execution` `ToolError`) and shows the model `render(value, files)` when given, else a string output as is, else the compact JSON of the encoding with file labels. Without `output`, `execute` returns `{ content }`. Returning a raw `ToolResult` still works this canary but is deprecated. `resolveTools` checks every successful result of a registration with an output schema through `ToolRegistration.decodeOutput` (`makeTool` sets it from `output`; `toolOutputDecoder` for raw registrations): excess properties rejected, plain JSON only, the checked value passed on, a mismatch dropped with a value-free warning; a registration with `def.outputSchema` but no decoder fails `output_validation_required`. Encodings that are not plain JSON (bytes in a `Schema.Any` field) fail closed; `Schema.Void` encodes as `null`. `output` schemas must encode without services (`ToolOutputSchema`). With explicit type arguments the typed `makeTool` takes three (context, parameters, output); `ToolFile` in `parameters` throws. Files returned as `FilePart` by tools without `output` no longer reach scripts. New protocol file fields: `ToolFile` (tools return `FileBytes`, optionally `view: true`; the encoding holds `FileRef` or `FileUnavailable`), `ToolFileCapture` (provided by `resolveTools` to every registration; `makeToolFileCapture`), `typedToolResult`, `encodeToolOutput`, `toolFileJsonSchemaDefinitions`. `ToolResult.files` is derived from file fields. Capture no longer inserts text labels: captured image/document/audio parts are followed by a `File` part with a `Ref` source, an inline image/document/audio part that cannot be stored stays inline (without a `File` part), and unstored `File` parts become `File` parts with the new `Omitted { reason }` source (`FileSource`); providers render the same text, but readers older than this release cannot decode transcripts holding `Omitted`. Capture is idempotent. `ModelVisibleToolError` gains `code`. For raw interaction registrations, `def.outputSchema`/`decodeOutput` describe the completed action's own value (`structuredContent.result`), checked before the receipt is settled (bounded to 5 s; past it the value is dropped). The tool ledger stores typed values whole (content cut first) or, when the value alone is over the bound, a fixed error result, and keeps `File` parts structural through every reduction.
  - `@yolk-sdk/codemode`: typed tools resolve to their declared value (arrays and primitives included, nothing merged); a typed result without a value rejects `<label>: returned an invalid result`; untyped tools resolve to their text parts only; failures reject with the text and `error.code` (also through the pi executor). Breaking for scripts: no more `files` merged into values or `{ text, files }`. The description declares `FileRef`/`FileUnavailable` and says `string` results are text; signatures show file fields by name.
  - `@yolk-sdk/mcp`: adapted tools declare `{ value, files }` and `callRemoteMcpServerTool`/`callLocalMcpServerTool`/resumable calls return `mcpToolResult`: `value` is `structuredContent`, else the text of text blocks and embedded text resources parsed once when it is one JSON object or array, else the text; blobs, images and audio are file fields, stored through the new `fileCapture` call option or the ambient capture. Hosts building registrations from `mcpToolToToolDef` defs must set `decodeOutput: mcpToolOutputDecoder`: `resolveTools` requires a decoder for a declared `outputSchema` (`output_validation_required`). Local calls now list tools in the same session and validate `structuredContent` against the listed `outputSchema`. Breaking for scripts and for hosts reading MCP `structuredContent`.
  - `@yolk-sdk/connectors`: `fileOutput` actions (`gmail`/`outlook`/`email` `get_attachment`) declare `{ value, files }` with file fields instead of trailing `FilePart`s, and their descriptions say so. Breaking for scripts reading `{ ...metadata, files }`. Their tool listings (output schemas and descriptions) change once, so hosts that key grants or caches on a tool's listing see one change.

### Patch Changes

- Updated dependencies [74c1fe5]
  - @yolk-sdk/conformance@0.1.0-canary.126

## 0.1.0-canary.125

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.125

## 0.1.0-canary.124

### Minor Changes

- 4f6cd82: Some boundary failures are now typed instead of the global `Error` or `unknown`. Each error keeps the original failure as `cause` when one exists.

  - `@yolk-sdk/agent/client`: `textFromBlob` and `documentPartFromTextFile` fail with the new `BlobTextReadError` instead of `Error`, with the same message (`Could not read text`).
  - `@yolk-sdk/agent/protocol`: `attachmentSourceText` fails with the new `AttachmentTextDecodeError` instead of the raw decoding error; its `message` is that error's message (or `String(cause)` when it is not an `Error`).
  - `@yolk-sdk/vercel-workflows`: `writeDurableAgentEvent` fails with the new `DurableAgentEventWriteError` instead of the writer's raw rejection. Its `message` is the rejection's message (or `String(rejection)` when it is not an `Error`), and `cause` is the rejection itself, so code that inspected the raw rejection reads `cause`.

### Patch Changes

- 6a1c1d4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.2. Hosts must use the matching Effect version, and adopt Effect 4.1's own breaking changes where their code uses the affected APIs (`effect/Crypto`, `HttpClientRequest.method` as `string`, `KeyValueStore`, `FileSystem.make`, `ChildProcess` templates, `McpServer` registrations). `@effect/platform-node` 4.1 requires `ws` ^8.22.1; dedupe `ws` if a Workflow build reports duplicate step ids.

  Tool JSON Schemas generated from Effect schemas are flatter: Effect 4.1 merges a nested `anyOf` into its parent and no longer duplicates a named definition used by both a required and an optional property. What a schema admits is unchanged, and the `yolk:null-means-omitted` marker still tells the codec-added `null` from a `Schema.NullOr` `null`. Hosts that list tools over MCP serve changed tool schemas once, so grants keyed on a tool snapshot digest return to their default for the affected tools.

- Updated dependencies [6a1c1d4]
  - @yolk-sdk/conformance@0.1.0-canary.124

## 0.1.0-canary.123

### Patch Changes

- fc21cd8: Read `null` as absent in optional Chat Completions fields, and name the field a malformed stream chunk failed.

  OpenAI-compatible hosts send `null` for optional fields they leave unset: `"tool_calls": null`, `"id": null` and `"name": null` on continuation tool-call deltas, `"delta": null`, `"usage": null` on chunks, and `null` usage details. The chat parser failed the turn on these: streamed chunk fields with `invalid_stream_chunk`, a `"usage": null` after (or without) the usage chunk and `null` usage details with `invalid_usage`, and non-streaming `null` `usage` or `tool_calls` with `invalid_response_body`. Every optional field in stream chunks, tool-call deltas, `message.tool_calls`, `usage`, and the usage details now reads `null` as absent. Required fields and `choices` stay strict, and a streamed tool call whose id or name never arrives still fails `invalid_tool_call`.

  `ProviderStreamDiagnostics` gains optional `invalidField` (`ProviderStreamInvalidField`: `path`, `received`), set on `invalid_stream_chunk`. `path` names the first rejected field in the schema's own field names (`$.choices[].delta.tool_calls[].id`) and `received` its JSON type (`ProviderStreamFieldType`), never the value, so hosts can log which field broke.

  - @yolk-sdk/conformance@0.1.0-canary.123

## 0.1.0-canary.122

### Patch Changes

- 6d9787f: Advance in lockstep with `@yolk-sdk/connectors`, whose action inputs now advertise only finite numbers (integer counts and page sizes of at least 1, some with upper bounds, and finite GitHub issue-field numbers and Fortnox nullable amounts). These packages have no direct changes in this release.
- Updated dependencies [6d9787f]
  - @yolk-sdk/conformance@0.1.0-canary.122

## 0.1.0-canary.121

### Patch Changes

- 59d338d: Advance in lockstep with `@yolk-sdk/mcp`, whose `makeMcpToolServer().handleHttpRequest` now finishes every exchange before it returns, so no tool call runs after the caller's scope has closed. These packages have no direct changes in this release.
- Updated dependencies [59d338d]
  - @yolk-sdk/conformance@0.1.0-canary.121

## 0.1.0-canary.120

### Patch Changes

- a9eee1b: Advertise `Schema.optional(X)` tool params to Claude (compatibility mode) as `X` instead of an unconstrained `{}`, including named optional schemas (`$ref` to a definition). `makeTool`/`toolJsonSchemaFromSchema` now mark the `{ type: 'null' }` member that the JSON codec adds for `Schema.optional(X)` with `$comment: toolJsonSchemaOmittedNullComment` (new `@yolk-sdk/agent/protocol` export; stable value `'yolk:null-means-omitted'`). Otherwise the lowering is unchanged: it equals `Schema.toJsonSchemaDocument`, and schema-authored `$comment` annotations are not emitted. Only Claude compatibility uses the marker: on non-required properties it drops only these marked nulls (they decode as "not sent"), and root union properties that are required in one variant and optional in another now merge to their type. OpenAI-compatible chat, Responses (Codex, Grok, OpenCode Go), Anthropic Messages without compatibility, and OpenAI Realtime (including `openAiRealtimeToolParameters`) remove the marker, so their request bodies are unchanged. `outputSchema` keeps it; HITL response schemas (`makeInputTool`, `makeInteractionTool`, plan review) are lowered without it, exactly as before, because user responses decode with the type-side schema. Meaningful nulls keep today's widened `{}`: `Schema.optionalKey(Schema.NullOr(X))`, `Schema.optional(Schema.NullOr(X))`, required `Schema.NullOr(X)`, array items, and third-party raw/MCP `anyOf [X, null]` schemas. Describe what a meaningful `null` does in the tool description. Tools served by `@yolk-sdk/mcp` list the marker in `inputSchema`.
- Updated dependencies [79595fc]
  - @yolk-sdk/conformance@0.1.0-canary.120

## 0.1.0-canary.119

### Minor Changes

- 67cfa52: Read-only calls of `write` tools stay retryable under the tool ledger. `makeTool({ isReadCall })` (registration `isReadCall(call)`) marks a non-`read` tool's read-only calls, for example the list operations of a tool that also updates; their effective access (`toolCallAccess`) is `read`. `ToolLedgerPolicyInput.readCall` carries it and `defaultToolLedgerPolicy` no longer ledgers such calls, so a read that crashed before recording its outcome is re-run instead of refused on every retry as possibly applied. Arguments that do not decode, and an `isReadCall` that fails or dies, mean not a read. `NestedToolExecutor.access(call)` exposes a nested call's effective access, and code mode records it on the new optional `NestedToolCallRecord.access` (`NestedToolCallAccess`), so hosts can audit nested writes without parsing arguments. Hosts that build `NestedToolExecutor` objects themselves must add `access`.

### Patch Changes

- @yolk-sdk/conformance@0.1.0-canary.119

## 0.1.0-canary.118

### Patch Changes

- f7f6d58: Republish every public package in lockstep after an incomplete `0.1.0-canary.117` publish: npm held `@yolk-sdk/extractors@0.1.0-canary.117`, so `@yolk-sdk/extractors`, `@yolk-sdk/pool`, `@yolk-sdk/sandbox` and `@yolk-sdk/vercel-workflows` were never published at that version. This release contains no implementation changes beyond `0.1.0-canary.117`; install this version (with all `@yolk-sdk/*` packages on it) instead of `0.1.0-canary.117`.
- Updated dependencies [f7f6d58]
  - @yolk-sdk/conformance@0.1.0-canary.118

## 0.1.0-canary.117

### Minor Changes

- 190c928: Fix attachments above ~3 MB. `gmail.get_attachment`, `email.get_attachment` and `outlook.get_attachment` no longer pattern-check the attachment base64: the grouped regex overflowed V8's regexp stack somewhere past ~3.7–4.4M characters (`RangeError: Maximum call stack size exceeded`; the threshold varies with the environment), so every larger attachment failed. `GmailAttachmentBase64Url`, `GmailAttachmentBase64` and `EmailAttachmentBase64` are now plain strings (no published `pattern`); whoever decodes the bytes validates them. `downloadGmailAttachment` keeps its alphabet, padding and size checks but no longer re-encodes to compare (unused pad bits are accepted). Tool file capture, `attachmentSourceText` and the Gmail decoders copy decoded bytes into one preallocated array instead of `Uint8Array.from(binary, mapFn)` (about 0.7 GB of memory for a 20 MiB file). New `base64ToBytes` in `@yolk-sdk/agent/protocol`.

### Patch Changes

- Updated dependencies [47827d8]
  - @yolk-sdk/conformance@0.1.0-canary.117

## 0.1.0-canary.116

### Minor Changes

- 995762e: Report subscription quota exhaustion and model-scoped usage windows (ADR 0011).

  - `ProviderErrorInfo.quotaResetsAtMs` (epoch milliseconds): when an exhausted subscription quota resets. The Claude subscription provider reads it from the unified rate-limit headers of a `429` (the latest reset among the rejected five-hour and weekly windows, else the unified reset when the account is rejected; model-scoped weekly and overage-only rejections carry none, so a model limit never reads as account exhaustion). The Responses providers read it from a `429` whose error type is `usage_limit_reached` (`resets_at`, else `resets_in_seconds`), which ChatGPT Codex sends. Resets in the past or more than a year ahead are dropped. Transient rate limits never carry it; the failure kind stays `rate_limit` and retry behavior is unchanged. `classifyProviderFailure` accepts a parsed `quotaResetsAtMs` and keeps it only on `rate_limit`.
  - `ProviderSubscriptionUsageWindow.models`: lowercase model id substrings a model-scoped window limits; absent means every model of the account.
  - Claude subscription usage now sets `windowDurationMinutes` (300 for `five-hour`, 10080 for `seven-day`) and parses the model-scoped weekly limits in `limits[]` (`kind: "weekly_scoped"`) as `seven-day-<model>` windows with `models: [<model>]`, keyed by the lowercase model id or else the display name slugged; a non-string model id or a numeric `resets_at` (epoch seconds) is accepted. Window JSON gains these keys after `resetsAt`.
  - OpenCode Go usage sets `windowDurationMinutes` on its fixed rolling windows (300 for `five-hour`, 10080 for `seven-day`); `monthly` follows the billing month and stays without a length.
  - The Claude usage conformance case accepts and checks those scoped windows (`scopedWindowIdPrefix` on the shared usage case builder), and its synthetic fixture reports one.
  - The `/anthropic` usage route's recorded body matches the updated fixture.

### Patch Changes

- 02953b4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.0.5. Hosts must use the matching Effect version.

  Effect 4.0.5 drops a typed failure when an interruption skipped its recovery handler, so a connector conformance run interrupted while a case's cleanup fails, a write's outcome is unknown, or a cleanup is refused now ends interrupt-only instead of with the case's error. The problem still reaches `ConformanceCleanupReporter`. See the migration guide.

- Updated dependencies [02953b4]
  - @yolk-sdk/conformance@0.1.0-canary.116

## 0.1.0-canary.115

### Minor Changes

- 5f08b0f: Add `AgentStatus` to `@yolk-sdk/agent/protocol` (ADR 0010): one typed run status in the OSC 7501 Program Status vocabulary, `Idle`, `Working` with an activity (`Busy`, `Generating`, `Tools`, `Compacting`, `Retrying`), `Blocked` with a kind (`permission` for approvals and interactions, `question` for questions and inputs, `auth` reserved) and its requests, `Done`, and `Failed`. `nextAgentStatus`/`agentStatusFromEvents` fold events; `reconcileAgentStatus` drops `Working`/`Blocked` for runs the host proves are not active; `AgentStatusTree` adds per-subagent statuses (`nextAgentStatusTree`, `withSubagentStatus` for host-owned background subagents). `isSubagentAcceptedToolResult`/`isSubagentObservationToolResult` expose the loop's subagent acknowledgement checks. `AgentError` gains an optional `abortReason` (`user`, `system`, `max_turns`), set by the loop. Breaking: `AgentRunStatus` is removed; `AgentClientState` and `AgentChatState` carry `status: AgentStatus` and `subagents` instead of the string status and `error`, `errorInfo`, and `retryInfo` (use `Failed` statuses and `agentStatusRetry`); `useAgentChat` no longer returns `error` and adds `subagents`; `markAgentError` takes an optional `AgentError` instead of `AgentError | null`; a stopped run is `Idle`.

### Patch Changes

- Updated dependencies [e662c70]
  - @yolk-sdk/conformance@0.1.0-canary.115

## 0.1.0-canary.114

### Minor Changes

- fddf4a6: File claim check (ADR 0009): agents move files between tools by `fileId`; `File` bytes never reach
  the model, scripts, the tool ledger or the transcript (inline images, documents and audio the model
  views keep their inline source for now).

  - `@yolk-sdk/agent/protocol`: `FilePart` joins `ContentPart` (bytes to move, lowered by every
    provider as its text label only), `filePartFromBytes`, `bytesToBase64`, `filePartText`,
    `FileDescriptor`, `FileId`, `fileLabel`, `fileNotCapturedLabel`, `formatFileSize`, `isFileId`, `normalizeFileMimeType`,
    and `ToolResult.files` (captured descriptors, not sent to providers).
  - `@yolk-sdk/agent/tools`: `resolveTools(modules, context, { files: { store, maxFileBytes? } })`
    captures every executed result (direct, nested and staged) before the ledger: inline `File`
    parts are stored through the host `FileStoreApi` and rewritten to `Ref { id: fileId }`; inline
    image, document and audio parts are stored and followed by their label (the model still sees
    them). Without `files`, or when storing fails or a file is over the bound (default 100 MiB),
    inline `File` parts become a "file not captured" label. Exports `FileStoreApi`,
    `FileStoreError`, `ToolFileCaptureOptions`, `captureToolResultFiles`, and
    `defaultMaxCapturedFileBytes`. The tool ledger keeps `files` through every reduction step and on
    replay.
  - `@yolk-sdk/codemode`: a nested call that captured files also resolves `files: [{ fileId, name,
mimeType, size }]`, merged into an object result or as `{ text, files }`; the code mode
    description says so.
  - `@yolk-sdk/mcp`: embedded resource blobs in tool results become `FilePart`s instead of base64
    text; the MCP server lowers a `FilePart` with inline bytes to an embedded resource blob and a
    captured one to its label.
  - New `@yolk-sdk/files`: `makeObjectStorageFileStore` (a `FileStoreApi` over a host
    `ObjectStorageApi`: keys `<prefix>/<scope>/<fileId>`, `fileId` derived from scope and content
    hash, no database), `deleteScopeFiles`, `fileIdFor`, `isValidFileScope`, and `makeFileToolModule` with `file_upload`
    (`PUT` to an https URL over a host `FileUploadTransportApi`) and `file_url` (signed download
    link).
  - New `@yolk-sdk/files` tools `file_to_sandbox` (copy a file into the workspace, default
    `files/<fileId>/<name>`) and `file_from_sandbox` (turn a workspace file into a `fileId`, MIME type inferred
    from the extension), present when the host passes a sandbox with file transfer (the structural
    `FileSandboxApi`/`FileSandboxError` port, which `@yolk-sdk/sandbox` `SandboxApi` satisfies).
  - `@yolk-sdk/sandbox`: optional binary `SandboxApi.writeFile`/`readFile` on workspace-relative
    paths (`normalizeWorkspacePath`, `NormalizedWorkspacePath`), implemented by the Vercel layer (streamed, bounded reads) and
    `makeFakeSandboxFiles`; `SandboxInputErrorCause` gains `invalid_path`, `file_not_found` and
    `file_too_large`; `VercelSandboxHandle` gains `readFile` and `VercelSandboxFile.content` accepts
    bytes.
  - `@yolk-sdk/connectors`: actions may declare `fileOutput` (a byte-free tool output schema and a
    `split` into files). The agent bridge declares that schema and returns the bytes as `FilePart`s.
    `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` use it, so as agent
    tools they return a file instead of base64 (`connector.invoke` is unchanged).
    `gmail.get_attachment` takes optional `filename` and `mimeType` (from `gmail.list_attachments`,
    echoed unverified in the output) to name and type the file. New
    `connectorActionFile`, `sniffBase64MimeType`, `GmailGetAttachmentFileOutput`,
    `OutlookGetAttachmentFileOutput` and `EmailGetAttachmentFileOutput`.

  Host migration:

  - `ContentPart` has a new `File` member: exhaustive `Match`es over content parts need a case
    (render `filePartText`).
  - Custom `VercelSandboxHandle` implementations and fakes need `readFile`.
  - As agent tools, `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` now
    return a file instead of base64 (`structuredContent` keeps only metadata), and connector sinks
    such as Gmail draft attachments do not take `fileId`s yet: hosts that forwarded attachment
    base64 through the model need their own file-aware tool.
  - MCP embedded blobs reach the model as a file label instead of base64 text.
  - The code mode description gains one line (one cache prefix change).

### Patch Changes

- Updated dependencies [e2de782]
  - @yolk-sdk/conformance@0.1.0-canary.114

## 0.1.0-canary.113

### Minor Changes

- 67ec15e: Show Claude thinking, and send it back so the model keeps its reasoning.

  Newer Claude models (Opus 5 and later) think by default but return thinking blocks with empty text unless the request asks for summaries, and the Claude provider never sent a `thinking` field, so hosts received no reasoning. `AnthropicClaudeProviderConfig.thinking` now requests adaptive thinking: `display: 'summarized'` streams readable summaries as `ReasoningDelta`, and `prefixMismatchBehavior` (`'drop_block'` or `'error'`, sent as `block_binding.prefix_mismatch_behavior` with the `thinking-binding-controls-2026-08-01` beta) decides what Anthropic does with a replayed thinking block whose earlier system prompt, tools or messages changed. Without `thinking`, no `thinking` field is sent and the model's default applies.

  Thinking signatures were dropped, so tool-use turns lost the reasoning behind each call, and `redacted_thinking` blocks failed to decode in JSON responses. `AssistantReasoningPart` gains an optional `replay` (`AssistantReasoningReplay`: `SignedReasoningReplay` with the block's signature, or `RedactedReasoningReplay` with its encrypted data, each naming the producing provider). A new `LLMReasoningReplay` closes a reasoning block with that state, as a provider event and as an agent event, so `accumulateAssistantMessage` and the partial message of a failed turn (`collectModelTurnAttempt`) both keep it; a closed part never takes later text. Hosts that match `AgentEvent` or `LLMEvent` exhaustively must handle the new tag; live chat projections ignore it, and React `toAgentMessages` rebuilds reasoning without it, so hosts that resend chat-derived history should resend the protocol messages instead. Replay state alone does not count as started output, so a turn that failed after only signed thinking is redone (harness `RecoverFull`), not continued. Upgrade note: Claude turns emit the event on almost every thinking block and older SDKs reject unknown event tags, so deploy servers and clients together, reload open tabs, and do not roll back to an older SDK over durable logs that contain it.

  With or without `thinking`, the Claude provider captures signatures and redacted blocks, and fails a turn whose thinking block ends unsigned (`invalid_response`; a `max_tokens` or `content_filter` stop takes precedence). Its lowering sends an assistant message that holds its own replay state back exactly as produced (thinking, text, tool calls in order, exact text and signature, no envelope context text). Other assistant messages keep their existing byte-identical shape, and reasoning from another provider is never sent. Native Messages backends (OpenCode Go) neither capture nor replay signatures. Thinking blocks never carry a `cache_control` marker. `anthropicClaudeReasoningReplayProvider` names the Claude replay provider, so hosts that rewrite history per request can leave those parts untouched.

### Patch Changes

- Updated dependencies [2b74f9c]
  - @yolk-sdk/conformance@0.1.0-canary.113

## 0.1.0-canary.112

### Patch Changes

- c3da661: Name the failed check on malformed Chat Completions responses, and re-route OpenCode Go once.

  Parser rejections in the OpenAI-compatible chat provider (stream payloads that are not JSON, chunks of the wrong shape, non-text reasoning, streamed tool calls without an id or name, tool arguments that are not JSON, usage without token counts, malformed JSON bodies, no choices) failed `invalid_response` without `provider` metadata, so hosts could not tell what went wrong. They now carry `provider.kind: 'invalid_response'` and a fixed `providerCode` from the new `openAiChatResponseIssues` (plus `stream` diagnostics when streamed). The generic chat provider and Vercel AI Gateway keep their messages. OpenCode Go sanitizes every error with provider metadata, so its chat parser rejections now read `OpenCode Go invalid_response` instead of the parser text; read `provider.providerCode` for the failed check.

  OpenCode Go pins `x-opencode-session` to one upstream server, so retrying a malformed response under the same session reaches the server that just failed. `makeOpenCodeGoProviderLayer` now sends a request once more under `<session>.reroute` (the request `cacheKey`, else the host's `x-opencode-session` header; unchanged without either) when it fails with a malformed-response code (`openAiChatResponseIssues`, `incomplete_stream`, `unexpected_content_type`) before emitting any event. Errors after the first event, model decisions such as `length`, and the second attempt's failure still propagate.

- c3da661: Default OpenCode Go to its documented base, `https://opencode.ai/inference/go/v1`.

  `openCodeGoBaseUrl` and `openCodeGoSubscriptionUsageUrl` moved from `/zen/go/v1` to `/inference/go/v1`, the base OpenCode's Go docs list for every endpoint. The earlier base still answers; hosts pinning it through `baseUrl` or `url` are unaffected. The OpenCode Go conformance fixtures and `makeOpenCodeGoEmulator` routes follow the new paths.

  - @yolk-sdk/conformance@0.1.0-canary.112

## 0.1.0-canary.111

### Patch Changes

- a1e32bb: Advance unchanged public packages in lockstep with `@yolk-sdk/codemode`, whose description now tells the model to call known tools without searching again. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [a1e32bb]
  - @yolk-sdk/conformance@0.1.0-canary.111

## 0.1.0-canary.110

### Patch Changes

- 47e7fb3: Advance unchanged public packages in lockstep with `@yolk-sdk/codemode`, whose `searchTools` hits now include each tool's call signature. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [47e7fb3]
  - @yolk-sdk/conformance@0.1.0-canary.110

## 0.1.0-canary.109

### Patch Changes

- 8bb8c83: Advance unchanged public packages in lockstep with the `@yolk-sdk/codemode` fix that makes every stageable tool searchable and describable from code mode scripts, including model-callable and deferred ones. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [8bb8c83]
  - @yolk-sdk/conformance@0.1.0-canary.109

## 0.1.0-canary.108

### Minor Changes

- 013b918: Add host instructions and the code mode catalog as an instruction (ADR 0007). `RunInstruction` (`{ key, state, render(current) }`) and `RunConfig.instructions` keep an instruction current in the conversation: before each model request the loop appends a user-role instruction message (a `UserMessage` with the non-model-visible `instruction: { key, state }` envelope) only when its state changed, never rewriting earlier messages, so a changing instruction never invalidates the cached request prefix. Durable hosts driving `runModelTurn` append and persist `instructionMessages(transcript, instructions)` themselves; `runModelTurn` does not accept `instructions`. Nested-access registrations contribute through `instruct`, collected in `ResolvedToolSet.instructions`. `makeCodeModeTool({ catalog: 'instructions' })` keeps the `codemode` description invariant and delivers the catalog (every namespace with its tool count and description, listed tools within the inline budget) as such an instruction, rendered in full on every change: `render` never sees the previous state, because compaction keeps only the latest message of each key. `ToolDiscovery` gains `pinned`: always listed, outside the inline budget. The React chat projection (`buildAgentChatMessages`, `appendProtocolMessage`) never shows instruction messages as user messages. Hosts that cannot append messages to their persisted conversation may render an instruction into their system prompt instead. A removal is recorded as an instruction message without `state`, so any JSON state, `null` included, compares normally; `latestInstructionMessages` returns the current message of each key, and window compaction keeps them after its summary. `RuntimeConfig.instructions` forwards instructions to the loop. Duplicate instruction keys are rejected (`duplicate_instruction`), as is `instruct` without nested access. The chat projection keeps hidden instruction messages on the previous chat message (`instructionsAfter`) so `toAgentMessages` round-trips them. In instructions mode the `codemode` description documents `stage()` whenever staging is offered, so it stays invariant when the first stageable tool connects.
- 013b918: Add deferred tool loading (ADR 0007). `ToolDef.loading: 'deferred'` keeps a model-callable tool out of provider requests until the package `tool_search` tool (added by `resolveTools` when deferred tools resolve; opt out with `toolSearch: false`) activates it; the loop then declares it from the next request on (`declaredToolDefs`). Activation is derived from `tool_search` results in the transcript, never stored, so every step and redelivery declares the same tools. Approval-gated tools may be deferred and keep their approval. `rankToolSearchDocuments` (BM25) is shared by `tool_search` and code mode `searchTools`; code mode treats deferred tools like `search` tools. Activation counts only results answering a `tool_search` call of the assistant message they follow, so reused call ids never activate tools. `ToolExposure` (the `makeTool`, connector, and MCP `exposure` options) gains `loading`, typed only for model-callable tools; `mcpToolToToolDef` passes it through. `resolveTools` rejects `loading` on raw `callableBy: 'codemode'` definitions (`invalid_tool_exposure`) and deferral of `tool_search`, `question`, `subagent`, input, interaction, plan-review, background, and nested-access tools (`deferred_unsupported_tool`). `tool_search` rejects unknown arguments like other tools. New exports: `ToolLoading`, `isDeferredTool`, `declaredToolDefs`, `activatedToolNames`, `ToolSearchActivation`, `toolSearchToolName` (protocol); `makeToolSearchTool`, `rankToolSearchDocuments`, `toolSearchTokens`, `defaultToolSearchLimit`, `maxToolSearchLimit` (tools).
- 013b918: Add stage-only tools (ADR 0007): a stageable approval-gated tool may be `callableBy: 'codemode'` (usually with `discovery: 'search'`), so it is never declared to providers and costs no model context. Code mode scripts find it with `searchTools()` (hits marked `stageOnly: true`), read it with `describeTool()` (rendered as the `stage()` call), and can only `stage()` it for `review_plan`; direct calls stay fail-closed and plan review and apply are unchanged. `stage()` accepts the raw name or the catalog identifier, and an unknown name suggests at most five close stageable tools. The code mode description never names stage-only `search` tools, so they leave it byte-identical once any stageable tool exists. `resolveTools` warns when a stage-only tool resolves without staged tool plans. A direct `tools.<name>()` call of a stage-only tool rejects with a hint to `stage()` it (`CodeModeExecuteOptions.unbound`), and `pinned` stage-only tools are always named in the Stageable section.

### Patch Changes

- 3e34c1b: Identify the Claude subscription transport as Claude Code 2.1.299 (was 2.1.112). Anthropic gates newer models by the Claude Code version in the user agent and billing header: Claude Opus 5.5 answered HTTP 400 `claude_code_version_too_old` (needs 2.1.280 or newer). The billing header algorithm (salt, sampled positions, version suffix) is unchanged in 2.1.299.

  Anthropic HTTP error bodies and in-stream `error` events report `error.details.error_code` (for example `claude_code_version_too_old`) as `providerCode` when present, falling back to `error.type`, then `error.code`, so hosts can explain the failure.

- Updated dependencies [013b918]
  - @yolk-sdk/conformance@0.1.0-canary.108

## 0.1.0-canary.107

### Minor Changes

- 8972e3c: Enable provider prompt caching (ADR 0008). `LLMRequest` gains `cacheKey` (also on `RunConfig` and
  `RuntimeConfig`), `turnContext` and `toolChoice`. Anthropic requests always carry `cache_control`
  breakpoints (last tool, conversation end, previous request's end; native Messages also the system
  prompt) with a configurable `promptCacheTtl` on the Claude provider, and the Claude session header
  is derived from `cacheKey`. Codex and Grok send `prompt_cache_key` plus their session headers,
  Vercel AI Gateway sends `caching: 'auto'` and `x-session-affinity`, and OpenCode Go sends
  `x-opencode-session`. `turnContext` is appended after the conversation (after every Anthropic breakpoint); `toolChoice: 'none'` keeps
  tool definitions while forbidding calls (on Anthropic it invalidates cached messages). The generic OpenAI-compatible chat provider sends nothing unless its new
  optional `cacheKeyHeaders` config is set. The `@yolk-sdk/emulators` OpenCode Go Messages recording
  now expects the cache markers.

### Patch Changes

- Updated dependencies [d3c2f98]
  - @yolk-sdk/conformance@0.1.0-canary.107

## 0.1.0-canary.106

### Patch Changes

- 1cc86e7: Bind tool approval to the call instead of the tool's current policy when a pause resumes. Previously `prepareApprovalCall` checked whether the tool still required approval before reading the recorded answer, so a tool whose policy flipped to automatic between the request and the answer ran even when the human denied it. In a resume batch, an exact-match recorded `ToolApprovalResponse` now wins (denied: the denied result, never executed; approved: executed), and a denial under another approval id of the same call (after an execution-mode change) also denies. New optional `awaitingRequests` (the resumed pause's `AgentAwaitingInput.requests`) on `run`, `runToolBatch` and `prepareToolBatch` keeps an unanswered approval request pending even when the tool no longer requires approval: the same request while it still names the call, else a fresh one, its preview recomputed (or dropped without a previewer). A fresh batch (a new model turn) never settles an approval from recorded answers: the current policy decides and a gated call asks again, because a provider may reuse call ids. This closes a consent bypass that predates this change, where a new gated call reusing an earlier approved id executed. Answers consumed by a resumed batch no longer reach later model turns of the same run, and a call is settled only by a result in its own result window, so a provider-reused call id stays pending. `run`, `prepareToolBatch` and `runToolBatch` take an explicit `resume` (default: transcript pending calls with responses, `awaitingRequests` or an interaction host for `run`; `awaitingRequests` or responses given for the batch functions). Append-backed `runRuntime` forwards its logged pause automatically with only the paused batch's responses (sibling answers included, never an earlier batch's, even within one run). Transcript-mode and stateless hosts must pass `awaitingRequests` and only the responses of the batch being resumed (non-empty `hitlResponses` means resume), or set `resume` explicitly. `@yolk-sdk/vercel-workflows` passes each resumed tool step the pause's requests (`VercelAgentWorkflowToolBatchStepInput.awaitingRequests`) for hosts to forward.
  - @yolk-sdk/conformance@0.1.0-canary.106

## 0.1.0-canary.105

### Patch Changes

- c1b73d3: Advance unchanged public packages in lockstep with Gmail draft attachments in `@yolk-sdk/connectors` (optional `attachments` on `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply`) and the matching `@yolk-sdk/emulators` README note: the Google emulator does not emulate the Gmail draft media upload, so a draft with attachments answers its unrecognised 400. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [c1b73d3]
  - @yolk-sdk/conformance@0.1.0-canary.105

## 0.1.0-canary.104

### Minor Changes

- d5d557e: Add tool change previews (ADR 0006): one tool-agnostic before → after diff for every approval-gated call, rendered the same way for direct approvals, sibling approvals, and staged plan reviews.

  - New Effect Schemas in `@yolk-sdk/agent/protocol` (re-exported from `/tools`): `ToolChangePreview` (`target`, `summary?`, `changes`, `warnings?`, `blocked?`), `ToolFieldChange` (`Value`, `Text`, `Set`, `List`, `Structured`), `ToolChangeTarget`, `ToolChangeItem`, `ToolChangeScalar`, cut markers `ToolChangeCut`/`ToolChangeSideCuts`/`ToolChangeSetCuts`, `ToolChangePreviewError` with `ToolChangePreviewErrorCause`, its wire form `ToolChangePreviewFailure` (`{ cause, message }`, the `previewError` shape), and the `ToolApprovalPreviewer` loop seam.
  - One hook: `makeTool({ approval, changePreview })` (decoded arguments) or `ToolRegistration.changePreview`, only on approval-gated tools (new `ToolRegistryError` cause `change_preview_unsupported_policy`). `resolveTools(..., { changePreview: { maxBytes, timeoutMs } })` bounds previews (default 16 KiB, at least 1 KiB, 5 s). Also exported: `ToolChangePreviewHandler`, `ToolChangePreviewOptions`, `ToolChangeGroup`, `defaultToolChangePreviewMaxBytes`, `defaultToolChangePreviewTimeoutMs`, `minToolChangePreviewMaxBytes`.
  - Approvals: pass `ResolvedToolSet.approvalPreviews` as `approvalPreviews` to `run`, `runToolBatch`, `prepareToolBatch`, or `RuntimeConfig`; pending `ToolApprovalRequest`s (and their `ToolApprovalRequested` events) then carry `preview` or `previewError`. A failing preview never blocks the approval, and approval ids are unchanged. Voice ignores previews.
  - Staged plans: `previewToolPlan`/`previewStoredToolPlan` run the same hook. `ToolPlanPreview` `ok` entries carry `params` plus `preview: ToolChangePreview`, `previewError`, or neither (the tool has no `changePreview`); never both (separate Schema members). Narrow with `entry.status === 'ok' && entry.preview !== undefined`. A failing or oversized preview no longer becomes an error entry.
  - Large previews are truncated deterministically with `truncated` markers (original size, unit, window offset), never silently; `boundToolChangePreview` is exported. `toolChangeSignature`, `groupToolChangePreviews`, and `isToolChangePreviewTruncated` group identical changes per tool.
  - Breaking (canary): `staging.preview` (`ToolStaging`/`ToolStagingHandlers`) and `maxToolPlanPreviewBytes` are removed (`staging` keeps only `precheck`); move previews to `changePreview` returning a `ToolChangePreview` and use `defaultToolChangePreviewMaxBytes`. `ResolvedToolSet` has a new required `approvalPreviews` field.

### Patch Changes

- Updated dependencies [31b7e48]
  - @yolk-sdk/conformance@0.1.0-canary.104

## 0.1.0-canary.103

### Minor Changes

- e4ca456: Add staged tool plans (ADR 0005): code mode scripts stage approval-gated writes for one human review instead of running them, and Yolk applies exactly the calls the person selects.

  - Mark tools stageable with `makeTool({ approval, staging })` (`ToolDef.staging`, `isToolStageable`; optional `staging.precheck`/`staging.preview` hooks). Stageable tools need `approval` and side-effect-free validation (new `ToolRegistryError` causes `staging_unsupported_policy`, `staging_validation_required`). Direct script calls of approval-gated tools stay fail-closed.
  - Staging requires `resolveTools(..., { interactionHost, plans: { store } })` and one `makePlanReviewTool` registration (multiple registrations fail with `plan_review_duplicate`); voice and subagent resolutions without them never get it. New `ToolPlanStore` port with `makeInMemoryToolPlanStore`, `ToolPlan`/`StagedCall` Schemas, `NestedToolExecutor.staging`, and `ResolvedToolSet.plans`. `plans.planId({ call })` sets plan ids (default the code mode call id; staged keys are `<planId>/s<n>`).
  - Code mode scripts get a `stage(name, args)` global (`makeCodeModeTool({ staging })`; `false` turns it off, `{ maxCalls }` lowers the cap). `stage` validates the arguments and executes or ledgers nothing. It rejects duplicates, calls past `maxCalls`/`maxArgsBytes`, and mixing with direct writes in one script. Only a successful script saves its plan, reported in `CodeModeStructuredContent.codemode.plan`; a failed script discards its staged calls.
  - A person reviews once through `review_plan({ planId, planDigest })` (response `{ selectedKeys }`, untick only). Yolk applies exactly the selected calls, in staged order and at most once, through the normal execute path and tool ledger (`<reviewCallId>/<n>`), with `onFailure: 'stop' | 'continue'`. A partial apply is `completed` with per-call statuses. `previewToolPlan`, `previewStoredToolPlan`, and `toolPlanKeyPages` page bounded previews; `ToolPlanOutcome`, `ToolPlanCallOutcome`, `ToolPlanPreview`, and `ToolPlanPreviewPage` are Effect Schemas.
  - `beforeCall` is the only per-call host authority hook for applied calls: they bypass `beforeNestedCall` and `ToolExecutor` decorators.
  - With a tool ledger, each apply runs behind a ledger entry for its review call, so a redelivered step waits for an in-flight apply and returns its real outcome; listings report a call `not_run` only when provable, else `unknown`. Resolve the review step with the same ledger scope on every delivery and keep ledger entries as long as the review receipts.
  - Interactions: an optional `unknownOutcome({ call, submissionId, phase })` hook (`'replay' | 'seal'`; only `replay` may report a proven `outcome`), and raw registrations' action `validate` (`InteractionActionHandler.validate`) now receives the normalized `call` (`makeInteractionTool` action `validate` is unchanged). An accepted receipt whose call no longer validates is dispatched, so the executor reports a receipt another delivery already started or settled instead of invalid arguments.
  - Breaking types: interaction call validators (`InteractionCallValidator`) and `InteractionPreflight.validateAction` may fail with `InteractionHostError` when host storage is unavailable. `prepareToolBatch` then fails with `ToolError` `unavailable` (a new error channel; retry the step), `validateInteractionSubmission` answers the new `InteractionAdmissionError` cause `unavailable`, and execution fails closed.

### Patch Changes

- Updated dependencies [1d51430]
  - @yolk-sdk/conformance@0.1.0-canary.103

## 0.1.0-canary.102

### Patch Changes

- b3584f5: Advance unchanged public packages in lockstep with the Gmail draft `multipart/alternative` bodies, the optional draft `contentType`, and the `gmail.get_thread` decoding fix in `@yolk-sdk/connectors`, and the matching Google emulator draft MIME in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [b3584f5]
  - @yolk-sdk/conformance@0.1.0-canary.102

## 0.1.0-canary.101

### Patch Changes

- 6afe855: Advance unchanged public packages in lockstep with the `gmail.list_threads` thread listing and `metadataHeaders` selections in `@yolk-sdk/connectors` and the matching Google emulator support in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [6afe855]
  - @yolk-sdk/conformance@0.1.0-canary.101

## 0.1.0-canary.100

### Patch Changes

- 36620a8: Advance unchanged public packages in lockstep with the Google Calendar `sendUpdates` support in `@yolk-sdk/connectors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [36620a8]
  - @yolk-sdk/conformance@0.1.0-canary.100

## 0.1.0-canary.99

### Minor Changes

- c248eb0: Add a durable tool-call ledger, so a re-executed step never runs a ledgered tool call twice under the same ledger key. Details: [`@yolk-sdk/agent/tools` README, Durable tool ledger](https://github.com/magoz/yolk-sdk/blob/main/packages/agent/src/tools/README.md#durable-tool-ledger).

  - `@yolk-sdk/agent/tools`: `resolveTools(modules, context, { ledger: { store } })` takes a host-implemented `ToolLedgerStore` scoped by the host (for example the Workflow run id plus turn): an atomic `claim` returning `ToolLedgerClaim` (`Fresh | Completed | InFlight | Abandoned`), `heartbeat`, `complete`, and `list(parentKey)`. Ledgered calls (`defaultToolLedgerPolicy`: every non-`read` tool plus the built-in `subagent` tool; override with `isLedgered`, composing the default to keep `subagent`) share one seam for top-level calls (`call.id`) and nested code mode calls (`<parentCallId>/<seq>`). Input and interaction tools are never ledgered; their at-most-once guarantee is the host's `InteractionHost` receipts. A completed call returns its stored result without executing; an in-flight one waits until it completes or `maxWaitMs`/`deadline` passes, then returns a model-visible timeout; an abandoned one (lease expired, no result) is never re-run and tells the model it may already have been applied; the same key holding a different call is a model-visible conflict. Claim failures fail closed. Without `ledger`, behavior is unchanged.
  - Host obligations: persist `args` (an 8 KiB audit preview), `argsTruncated`, and `argsDigest` from each fresh claim and return them on every entry (`argsDigest` is lower-case hex SHA-256 of the canonical JSON of the raw `call.params`; store it as `char(64)`); keep store operations interruptible, since the ledger's per-attempt timeouts cannot cut uninterruptible store work; reserve about 15 s of the step budget after `deadline` for recording outcomes; keep call ids unique within a ledger scope.
  - Tool executors receive `idempotencyKey` (`<scope>:<ledger key>`) in `ToolExecutionInput` whenever a ledger is configured; `makeTool` and the built-in subagent registration (`SubagentExecutionInput.idempotencyKey`) forward it, and custom wrappers must forward it like `nested`. Registrations accept `abandonedResult` to describe an abandoned call; its `nested` input is `undefined` when the store cannot list the nested entries.
  - New ledger options: `leaseMs`, `heartbeatIntervalMs`, `pollIntervalMs`, `maxWaitMs`, `deadline`, `maxResultBytes`, and `onLedgerDecision` (one `ToolLedgerDecision` per ledgered call for logs and metrics; it never affects execution).
  - New exports: `ToolLedgerStore`, `ToolLedgerOptions`, `ToolLedgerClaim`, `ToolLedgerClaimRequest`, `ToolLedgerHeartbeatRequest`, `ToolLedgerEntry` (persist with `Schema.toCodecJson`), `ToolLedgerOutcome`, `ToolLedgerSucceeded`, `ToolLedgerFailed`, `ToolLedgerFailure`, `ToolLedgerError`, `ToolLedgerErrorDetails`, `ToolLedgerArgs`, `ToolLedgerPolicyInput`, `ToolLedgerAbandonedInput`, `ToolLedgerDecision`, `ToolLedgerDecisionEvent`, `InMemoryToolLedgerStore`, `makeInMemoryToolLedgerStore` (reference store; not durable), `classifyToolLedgerEntry`, `sortToolLedgerEntries`, `toolLedgerArgs`, `toolLedgerResult`, `toolIdempotencyKey`, `defaultToolLedgerPolicy`, `abandonedToolCallResult`, and the defaults `defaultToolLedgerLeaseMs`, `defaultToolLedgerPollIntervalMs`, `defaultToolLedgerMaxWaitMs`, `defaultToolLedgerMaxResultBytes`, `toolLedgerCompleteTimeoutMs`, and `toolLedgerMaxArgsBytes`.
  - `@yolk-sdk/agent/protocol`: `NestedToolCalls` gains optional per-status `counts` (`NestedToolCallCounts`) covering every call, dropped ones included. `makeNestedToolCallRecorder({ maxCalls })` sizes the record (default `nestedToolCallMaxCalls`, 256; clamped by `nestedToolCallRecordLimit` to at most `nestedToolCallMaxRecordedCalls`, 4096). New exports `truncateCodePoints`, `boundNestedToolCallArgs`, and `BoundedNestedToolCallArgs`.
  - `@yolk-sdk/codemode`: with a ledger, the `codemode` call itself is ledgered, so a re-executed call never re-runs its script. When the earlier execution was abandoned it returns an interrupted error result that lists the script's ledgered nested calls as applied, failed, or unknown (`structuredContent.codemode.interruptedCalls`, or `interruptedCallsUnavailable: true` when the store cannot list them). The `nestedCalls` record is sized from `limits.maxNestedCalls` (up to 4096) instead of a fixed 256 and carries per-status counts. New `afterNestedCall({ call, outcome, durationMs, context, result? })` hook reports `success`, `failure`, or `interrupted` for each nested call; a failing hook is logged and never changes the call's result.
  - `@yolk-sdk/vercel-workflows`: documents that tool-batch steps are at-least-once (redelivered after crashes and concurrently with a running execution, even with `noWorkflowStepRetry`), so hosts that resolve tools in a step must supply a durable ledger. No API change.

### Patch Changes

- Updated dependencies [ee80a4a]
  - @yolk-sdk/conformance@0.1.0-canary.99

## 0.1.0-canary.98

### Patch Changes

- def9f9c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/extractors` package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [def9f9c]
  - @yolk-sdk/conformance@0.1.0-canary.98

## 0.1.0-canary.97

### Minor Changes

- b5c2b69: Upgrade the coordinated Effect runtime and platform dependencies to the stable Effect 4.0.0 release. Hosts must use the matching Effect version.

  Effect 4.0.0 removes the `effect/unstable/*` entrypoints: import from `effect/http`, `effect/socket`, `effect/sql`, `effect/process` and the other `effect/<area>` paths, and take `Arbitrary` from `effect`. The former `effect/Encoding` module is split into `effect/encoding/*` (for example `Base64.encode` from `effect/encoding/Base64`).

  Effect 4.0.0 exports `Schema.isPattern` to JSON Schema only when the regex flags are `u` (optionally with `d`, `g` or `y`; not `v`, and not `u` with `i`, `m` or `s`). Yolk's connector, emulator and conformance patterns now use `u`, so connector tool parameters keep their model-visible `pattern` hints with unchanged runtime validation; the Fortnox identifier pattern is advertised as its equivalent BMP-only character class. Add `u` to `Schema.isPattern` regexes in host tool parameter schemas to keep their patterns. String `Schema.isMinLength(n)` and the `Schema.isBetweenLength` minimum (n ≥ 2) are now advertised as `minLength: ceil(n / 2)`. See the migration guide.

- 4f24fe8: Accept tool arguments exactly as advertised: `null` for optional fields is accepted, and unknown keys are rejected. `ToolDef.parameters` describes the schema's canonical JSON codec, which advertises every `Schema.optional(X)` field as `X | null` and every object as closed (`additionalProperties: false`), but `makeTool` decoded calls with the type-side schema: it rejected the advertised `null`, so models (especially strict-mode providers) failed validation on unused optional fields, and it silently stripped unknown keys.

  `makeTool` (`validate` and `execute`, so background calls too), `makeInputTool`/`makeInteractionTool` call parameters, and the loop-owned `question` decode now use `Schema.toCodecJson(parameters)`. `null` on `Schema.optional(X)` decodes as omitted and `Schema.withDecodingDefault` still applies; `Schema.optional(Schema.NullOr(X))` keeps `null`; required non-nullable fields still reject it with a model-visible validation error. Non-finite numbers, which the JSON codec decodes from `"NaN"`/`"Infinity"`/`"-Infinity"`, remain validation errors. `undefined`-valued keys from in-process callers count as absent. Advertised schemas are unchanged.

  Breaking (0.x minor): unknown keys at any depth are now model-visible validation errors (`onExcessProperty: 'error'`) instead of being silently stripped, so a model never believes it set a field (a filter, a start time) that was ignored. This also selects the union member that declares every sent key and keeps closed-input declarations closed through the JSON codec. Callers or fixtures that sent extra keys now get a validation error. Argument errors (the default `makeTool` message, interaction/input/`question` errors, and Yolk's own tool overrides) report every issue at once and name each unknown key with the allowed keys at that path; the new `withToolArgumentsErrorHint` export lets custom `invalidParamsMessage` callbacks do the same.

  `resolveTools` also drops `null` where the advertised schema marks a property optional without admitting `null` (`Schema.optionalKey(X)`, the subagent `model`/`reasoning_effort`, raw MCP schemas) before any registration validates, executes, or forwards the call. The new `omitNullOptionalToolArguments` export on `@yolk-sdk/agent/tools` exposes that step for hosts that dispatch registrations themselves. User-submitted input/interaction responses keep strict decoding.

  Connector agent tools (`makeConnectorToolModule`) follow the same policy: unknown keys are rejected instead of stripped. For example, `outlook.list_messages` rejects the search-only `query`, and Fortnox invoice update tools reject provider-managed fields such as `Booked` or `Sent`. `execute` and `executeTyped` are unchanged.

  The knowledge (`knowledge_lookup`, `knowledge_manage`) and sandbox agent tools follow the same policy: unknown keys are rejected with a hint instead of being stripped.

### Patch Changes

- Updated dependencies [6567cc9]
- Updated dependencies [b5c2b69]
  - @yolk-sdk/conformance@0.1.0-canary.97

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
