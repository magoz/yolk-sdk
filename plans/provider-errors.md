# Provider errors, retries, overload surfacing

Written against `37dc8a0d`.

Execution status: IMPLEMENTED LOCAL. Yolk phases 1-4/6 are in this worktree and passed gates. Speldosa phase 5 is implemented in sibling `../speldosa` against local package tarballs; do not commit those tarball paths. Publish or version a lockstep canary before final Speldosa commit/release.

Scope: `yolk-sdk` first, then sibling consumer `../speldosa`.

## Motivation

Users must know when the model provider is overloaded, rate-limited, retrying, or terminally failed.
Today Yolk has protocol primitives, but the signal is weakened before it reaches apps.

Observed gaps:

- Yolk `LLMError` has `cause` + `retryable`, and protocol has `AgentError` + `AgentRetry`.
  Evidence: `packages/agent/src/loop/error.ts:4`, `packages/agent/src/protocol/event.ts:47`, `packages/agent/src/protocol/event.ts:77`.
- Loop retries retryable provider errors only before a provider event, with fixed exponential delay.
  Evidence: `packages/agent/src/loop/run.ts:310`, `packages/agent/src/loop/run.ts:295`.
- HTTP 429/5xx are classified, but `Retry-After` is ignored.
  Evidence: `packages/agent/src/providers/openai/provider.ts:358`, `packages/agent/src/providers/anthropic/claude-provider.ts:820`.
- Codex/Anthropic stream read errors are non-retryable.
  Evidence: `packages/agent/src/providers/openai/codex-provider.ts:917`, `packages/agent/src/providers/anthropic/claude-provider.ts:1275`.
- Codex SSE overload is currently locked as non-retryable provider error.
  Evidence: `examples/next/lib/agents/providers/openai-codex-provider.test.ts:607`.
- Client/react state keeps only `error: string | null` and ignores `AgentRetry`.
  Evidence: `packages/agent/src/client/state.ts:58`, `packages/agent/src/client/state.ts:265`, `packages/agent/src/client/state.ts:408`, `packages/agent/src/react/chat-core.ts:192`.
- Speldosa Workflow bypasses typed stream error mapping and turns all step failures into `unknown`, `retryable: false`.
  Evidence: `../speldosa/app/staff/w/staff-task-workflow-runtime.ts:397`, `../speldosa/app/staff/w/staff-task-workflow-runtime.ts:1068`.
- Speldosa clears `workflowRunId` only on successful done, so provider failure can leave tasks stuck running.
  Evidence: `../speldosa/app/staff/w/staff-task-workflow-runtime.ts:501`, `../speldosa/app/staff/w/[workspaceId]/tasks/[taskId]/revalidate-staff-task-action.ts:73`.

Reference patterns:

- AI SDK keeps status/headers/body/retryable in `APICallError` and respects retry headers.
  Evidence: `.repos/ai/packages/provider/src/errors/api-call-error.ts:7`, `.repos/ai/packages/ai/src/util/retry-with-exponential-backoff.ts:10`.
- AI SDK maps Anthropic `overloaded_error` stream errors to retryable 529.
  Evidence: `.repos/ai/packages/anthropic/src/anthropic-language-model.ts:2514`.
- opencode exposes retry status with attempt/message/action/next and UI countdown.
  Evidence: `.repos/opencode/packages/opencode/src/session/status.ts:8`, `.repos/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1647`.
- pi emits `auto_retry_start/end`, supports cancellation, and keeps retry history while removing failed assistant from active context.
  Evidence: `.repos/pi/packages/coding-agent/src/core/agent-session.ts:145`, `.repos/pi/packages/coding-agent/src/core/agent-session.ts:2424`.

## Decisions

1. Provider adapters classify failures; loop schedules retries; clients render state.
2. Keep raw provider bodies out of protocol/UI. Preserve safe metadata only.
3. Add overload as first-class protocol error: `AgentErrorCode` includes `overloaded`.
4. Use opencode-style retry backoff:
   - no provider hint: `2000ms * 2 ** (attempt - 1)`, capped at `30_000ms`;
   - `retry-after-ms`: honor milliseconds;
   - `retry-after`: honor seconds or HTTP-date;
   - hinted delays cap at JS timer max `2_147_483_647ms`;
   - expose exact chosen delay on `AgentRetry.delayMs`.
5. Keep Yolk's capped retry count: `LoopConfig.maxRetries` defaults to `2` retry attempts, i.e. up to `3` total provider calls.
6. Do not copy opencode's apparent unbounded retry schedule; Yolk apps need bounded cost and predictable failure.
7. Retry only pre-emission provider failures; post-emission failures remain terminal to avoid duplicating partial assistant/tool output.
8. Client/react state stays backward-compatible: keep `error: string | null`, add typed `errorInfo` and `retryInfo`.
9. Speldosa Workflow must persist terminal provider failures and clear `workflowRunId`.
10. Speldosa gets explicit task event kind `workflow_failure` for durable failure history.

## Target model

Yolk internal provider error metadata:

```ts
type ProviderFailureKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'network'
  | 'stream'
  | 'auth'
  | 'context_overflow'
  | 'invalid_response'
  | 'unknown'

type ProviderErrorInfo = {
  readonly provider: string
  readonly kind: ProviderFailureKind
  readonly status?: number
  readonly providerCode?: string
  readonly retryAfterMs?: number
}
```

Protocol-safe projection:

- `LLMError` gets optional `provider?: ProviderErrorInfo`.
- `AgentError` gets optional `provider?: ProviderErrorInfo`.
- `AgentRetry` gets optional `provider?: ProviderErrorInfo`.
- `AgentErrorCode` adds `overloaded`; overload final failures use `code: 'overloaded'`.
- Existing `code`, `message`, `retryable`, `attempt`, `reason`, `delayMs` remain source-compatible.

If schema naming differs during implementation, preserve the semantics above.

## Implementation plan

### Phase 1 — Yolk protocol + loop

- Add provider error schemas in `packages/agent/src/protocol/event.ts` or a focused protocol helper file.
- Add `overloaded` to `AgentErrorCode`.
- Add `overloaded` to `LLMError.cause` if implementation keeps cause/code aligned.
- Extend `LLMError` in `packages/agent/src/loop/error.ts` with optional provider metadata.
- Extend `agentLoopErrorToAgentError` to pass metadata through.
- Change retry delay calculation in `packages/agent/src/loop/run.ts`:
  - use `error.provider.retryAfterMs` when present and valid;
  - otherwise `2000ms * 2 ** (attempt - 1)`;
  - cap unhinted delay at `30_000ms`;
  - cap hinted delay at `2_147_483_647ms`;
  - emit same delay in `AgentRetry`.
- Preserve `LoopConfig.maxRetries` semantics: retry attempts are capped; default remains `2`.
- Add loop tests:
  - retry uses provider `retryAfterMs`;
  - metadata appears on `AgentRetry` and terminal `AgentError`;
  - `maxRetries: 2` performs at most three provider calls;
  - post-emission retryable failure still does not retry.

### Phase 2 — Yolk provider classification

- Add shared provider helpers under `packages/agent/src/providers/*` without cross-provider coupling:
  - parse `retry-after-ms`;
  - parse `retry-after` seconds/date;
  - classify status 429, 529, 5xx, 413;
  - classify provider code/message strings for `rate_limit`, `overloaded`, `too_many_requests`, `service unavailable`.
- Update OpenAI Chat provider:
  - attach provider metadata on non-OK responses and request failures.
- Update OpenAI Codex provider:
  - attach metadata on non-OK responses;
  - classify SSE `type: 'error'` and `response.failed` payloads;
  - mark stream read failures retryable with kind `stream`.
- Update Anthropic Claude provider:
  - attach metadata on non-OK responses;
  - classify SSE `type: 'error'`, especially `overloaded_error`;
  - mark stream read failures retryable with kind `stream`.
- Update Cloudflare Codex provider:
  - classify `response.failed` and `error` WS payloads consistently;
  - proxy response errors include safe metadata.
- Replace existing test that expects Codex overload non-retryable with retryable overload expectation.
- Add package-level provider tests, not just example tests.

### Phase 3 — Yolk client/react surfacing

- In `packages/agent/src/client/state.ts`:
  - add `errorInfo: AgentError | null`;
  - add `retryInfo: AgentRetry | null`;
  - keep `error: string | null` for compatibility;
  - on `AgentStart`, clear both;
  - on `AgentRetry`, set `retryInfo`;
  - on any provider event after retry or `AgentEnd`, clear `retryInfo`;
  - on `AgentError`, set both `error` and `errorInfo`.
- In `packages/agent/src/react/chat-core.ts`:
  - mirror typed error/retry fields in `AgentChatState`;
  - keep existing `error` string.
- Decide whether chat message parts need typed error metadata. If not, keep `markChatError` string-only for minimal churn.
- Add client/react tests for `AgentRetry`, `AgentError.code`, and `retryable` preservation.

### Phase 4 — Example UI proof

- Update `examples/next/app/agent/agent-activity-model.ts` to show:
  - overload vs rate limit;
  - retry countdown delay;
  - provider/status when present.
- Update `examples/next/app/agent/agent-activity.tsx` or status panel to expose current retry state from hook/core once available.
- Keep core conversation clean; retry/diagnostic UI belongs in activity/status chrome.
- Add tests where existing agent UI tests fit; otherwise pure model tests for retry formatting.

### Phase 5 — Speldosa Workflow hardening

In `../speldosa` after Yolk changes are published or linked:

- Update `@yolk-sdk/*` versions together.
- In `app/staff/w/staff-task-workflow-runtime.ts`:
  - import `agentLoopErrorToAgentError` and loop error tags;
  - replace `workflowErrorEvent(error)` with typed mapping for `LLMError`, `ToolError`, `AbortError`, `ContextTransformError`, `FauxExhaustedError`;
  - preserve `code`, `retryable`, provider metadata.
- Add `persistTaskWorkflowFailure`:
  - sets `agentTask.status = 'failed'` when current status is `in_progress`;
  - sets `workflowRunId = null`;
  - persists the latest conversation state if safely available;
  - inserts `agentTaskEvent` with new `kind: 'workflow_failure'`, `role: 'system'`, safe content, and metadata with `runId`, `code`, `retryable`, and provider metadata.
- Add a Drizzle migration for `AgentTaskEventKind.workflow_failure`.
- Call failure persistence in model/tool/HITL workflow catches before closing the writer.
- Update task UI:
  - error card shows `rate limited`, `provider overloaded`, or generic provider failure;
  - retryable errors show “Retry” / “Run again” copy;
  - composer unlocks after failed Workflow because `workflowRunId` is cleared.
- Add route/workflow tests:
  - model step `LLMError(rate_limit, retryable true)` writes `AgentError{code:'rate_limit', retryable:true}`;
  - task becomes `failed`; `workflowRunId` is null;
  - revalidate returns `isTaskRunning: false`.

### Phase 6 — Docs

- Update `packages/agent/AGENTS.md` provider note: providers classify retryable failures and attach safe provider metadata.
- Update `examples/next/lib/agents/AGENTS.md`: retry state is protocol-visible and UI-visible.
- Update `../speldosa/lib/services/ai-chat/AGENTS.md`: Workflow failures must preserve typed `AgentError` and clear active `workflowRunId`.

## Trackable TODO

### Yolk SDK

- [x] YOLK-01 Add provider failure metadata schemas.
- [x] YOLK-02 Add `overloaded` `AgentErrorCode` and aligned loop/provider cause.
- [x] YOLK-03 Extend `LLMError`, `AgentError`, `AgentRetry` with metadata.
- [x] YOLK-04 Respect provider `retryAfterMs` in loop retry delay.
- [x] YOLK-05 Use opencode-style backoff: 2s base, factor 2, 30s unhinted cap.
- [x] YOLK-06 Cap hinted retry delays at `2_147_483_647ms`.
- [x] YOLK-07 Preserve `LoopConfig.maxRetries` default `2` retry attempts.
- [x] YOLK-08 Test retry metadata + retry-after behavior.
- [x] YOLK-09 Test `maxRetries: 2` caps at three total provider calls.
- [x] YOLK-10 Classify OpenAI Chat HTTP failures with metadata.
- [x] YOLK-11 Classify OpenAI Codex HTTP/SSE/stream failures.
- [x] YOLK-12 Classify Anthropic HTTP/SSE/stream failures.
- [x] YOLK-13 Classify Cloudflare Codex proxy/WS failures.
- [x] YOLK-14 Replace overload-is-non-retryable regression.
- [x] YOLK-15 Add provider package tests for rate limit/overload/stream read failures.
- [x] YOLK-16 Add client `errorInfo` + `retryInfo`.
- [x] YOLK-17 Add React `errorInfo` + `retryInfo`.
- [x] YOLK-18 Add client/react state tests.
- [x] YOLK-19 Surface retry/provider info in Next example activity/status UI.
- [x] YOLK-20 Update Yolk docs/AGENTS notes.
- [x] YOLK-21 Run `pnpm tsc`.
- [x] YOLK-22 Run `pnpm lint`.
- [x] YOLK-23 Run `pnpm packages:check`.
- [x] YOLK-24 Run `pnpm cloudflare:check`.
- [x] YOLK-25 Run `pnpm test:run` if changes are broad.

### Speldosa

- [ ] SPEL-01 Update all `@yolk-sdk/*` versions together.
- [ ] SPEL-02 Map Workflow loop failures with `agentLoopErrorToAgentError`.
- [ ] SPEL-03 Persist Workflow failures as task `failed`.
- [ ] SPEL-04 Clear `workflowRunId` on Workflow failure.
- [ ] SPEL-05 Add `workflow_failure` to `AgentTaskEventKind` with migration.
- [ ] SPEL-06 Insert `workflow_failure` event on terminal Workflow failure.
- [ ] SPEL-07 Preserve typed provider error in task stream UI.
- [ ] SPEL-08 Unlock composer after failed provider run.
- [ ] SPEL-09 Add Workflow failure persistence tests.
- [ ] SPEL-10 Add task UI/provider-error display tests if practical.
- [ ] SPEL-11 Update Speldosa AI chat docs/AGENTS.
- [ ] SPEL-12 Run `pnpm tsc` in `../speldosa`.
- [ ] SPEL-13 Run `pnpm lint` in `../speldosa`.
- [ ] SPEL-14 Run focused tests for staff task Workflow.

## Verification gates

Yolk:

```bash
pnpm tsc
pnpm lint
pnpm packages:check
pnpm cloudflare:check
pnpm test:run
```

Speldosa:

```bash
pnpm tsc
pnpm lint
pnpm test
```

Run focused Speldosa tests first while iterating:

```bash
pnpm vitest run app/staff/w/[workspaceId]/tasks/[taskId]/workflow/route.test.ts
pnpm vitest run app/staff/w/[workspaceId]/tasks/[taskId]/revalidate-staff-task-action.test.ts
```

## Done criteria

- 429 emits `AgentRetry{reason:'rate_limit'}` before retry and terminal `AgentError{code:'rate_limit', retryable:true}` after exhaustion.
- Provider overload emits `AgentRetry{reason:'overloaded'}` before retry and terminal `AgentError{code:'overloaded', retryable:true}` after exhaustion.
- `Retry-After` headers affect `AgentRetry.delayMs`.
- Unhinted retry delays are `2000ms`, `4000ms`, `8000ms`, capped at `30000ms`.
- Default retry count is capped at two retries / three total provider calls.
- Pre-emission stream read failure retries; post-emission failure does not retry.
- Client/react consumers can read typed current retry and typed last error.
- Speldosa task Workflow provider failure never leaves `in_progress + workflowRunId` stuck.
- Speldosa staff UI shows useful provider failure state and unlocks after failure.

## Out of scope

- Account quota dashboards.
- Persistent automatic rerun after terminal failure.
- Retrying tool side effects.
- Full provider raw body persistence.

## Resolved questions

- Add `overloaded` AgentErrorCode? yes.
- Retry max cap value? opencode-style: 30s cap without headers; JS timer max with provider retry headers.
- Retry count cap? yes: keep Yolk default `maxRetries: 2` retry attempts / `3` total provider calls.
- Speldosa failure event kind? yes: `workflow_failure`.
