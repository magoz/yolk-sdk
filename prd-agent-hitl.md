# PRD: Agent Human-in-the-Loop

**Date:** 2026-05-21

---

## Problem Statement

### What problem are we solving?

Yolk agents can ask users questions only as ordinary assistant text, and tool calls execute immediately once emitted by the model. This is insufficient for agents that need structured user decisions during a run, or that must pause before sensitive actions such as writes, deletes, external API mutations, credential changes, shell commands, or MCP tool calls.

Current protocol already contains partial approval lifecycle events, but the loop does not emit or await them. This creates an incomplete platform contract: UI code can display approval states, but no runtime can reliably request, persist, resume, or replay a decision.

### Why now?

The agent package is becoming the shared foundation for Next, Cloudflare, Workflow, voice, tools, and subagents. Adding HITL after app-specific approval flows diverge would create duplicated policy logic and incompatible transcripts.

### Who is affected?

- **Primary users:** developers building Yolk agents that need safe tool execution and structured user input.
- **Secondary users:** end users approving agent actions, answering clarifying questions, or reviewing tool inputs before execution.
- **Internal maintainers:** package and app authors who need one protocol contract across all runtimes.

---

## Proposed Solution

### Overview

Add package-level HITL primitives to `@yolk-sdk/agent`: a single protocol for tool approvals and user questions, loop/runtime support to pause before execution, client helpers to submit decisions, and headless React projections to render pending requests. Runtime adapters may differ in storage and transport, but all use the same message/event semantics.

### User Experience

#### User Flow: Tool Approval

1. Agent emits a tool call that matches an approval policy.
2. System emits an approval request with tool name, call id, input preview, and optional policy metadata.
3. UI renders approve/deny controls.
4. User approves or denies, optionally with a reason.
5. Approved calls execute and feed normal `ToolResult` messages into the loop.
6. Denied calls produce an error/denial result visible to the model so it can continue safely.

#### User Flow: Structured Question

1. Agent calls a package-owned question tool with one or more prompts and options.
2. System emits a question request and pauses tool completion.
3. UI renders selectable options and optional custom answer controls.
4. User submits answers or cancels.
5. The question tool returns structured answers to the agent as a normal tool result.

#### User Flow: Durable Resume

1. A Cloudflare or Workflow run reaches an approval/question request.
2. Runtime persists the pending request and marks the run paused.
3. Client reconnects or later opens the session and sees the same pending request.
4. User submits a response.
5. Runtime resumes from the persisted pending state without duplicating prior messages.

### Design Considerations

- Approval/question UI must be accessible: keyboard-operable, clear labels, status announced via `aria-live`.
- Pending requests must show enough context to make a safe decision: tool name, arguments, description, risk/source if available.
- The transcript must remain replayable and provider-neutral.
- Same-turn parallel tool calls must preserve ordering for tool results while allowing independent approvals.

---

## End State

When this PRD is complete, the following will be true:

- [x] `@yolk-sdk/agent/protocol` defines stable HITL request/response schemas for approvals and questions.
- [x] `@yolk-sdk/agent/loop` can pause tool execution until a required approval/question response exists.
- [x] `@yolk-sdk/agent/tools` exposes a reusable structured question tool.
- [x] `@yolk-sdk/agent/runtime` supports pending HITL state for durable runtimes.
- [x] `@yolk-sdk/agent/client` exposes helpers for submitting HITL responses over supported transports.
- [x] `@yolk-sdk/react` projects pending HITL state into headless render models.
- [x] Next, Cloudflare, and Workflow runtimes share the same HITL protocol semantics.
- [ ] Tests cover approval, denial, question response, replay, resume, cancellation, and parallel tool calls.
- [x] Package and app documentation describe how to configure approval policy and render requests.

---

## Success Metrics

### Quantitative

| Metric | Current | Target | Measurement Method |
| --- | --- | --- | --- |
| Package-level HITL coverage | Protocol-only approval events | Loop/runtime/client/react covered | Unit test matrix |
| Runtime semantic drift | App/runtime-specific behavior | One protocol contract | Shared protocol tests reused by runtimes |
| Unsafe tool auto-execution | All configured tools execute immediately | Policy-gated tools pause first | Tool approval tests |
| Durable pending recovery | Not supported | Pending request survives reconnect/resume | Cloudflare/Workflow tests |

### Qualitative

- Developers can implement approval UI without understanding provider-specific tool internals.
- Users can confidently approve or deny sensitive tool actions.
- Maintainers can add new runtimes without inventing a new HITL model.

---

## Acceptance Criteria

### Feature: Protocol Contract

- [x] Protocol has typed approval request/response data with request id, tool call id, decision, optional reason, and automatic/manual source metadata.
- [x] Protocol has typed question request/response data with prompts, options, multiple-choice support, custom-answer support, answers, and cancel/deny outcome.
- [x] HITL responses are replayable across stateless request cycles.
- [x] `AgentEvent` includes request/response lifecycle events for both approval and question flows.
- [x] Existing `ToolApprovalRequested`, `ToolApprovalGranted`, and `ToolApprovalDenied` are either preserved compatibly or migrated with a documented path.

### Feature: Loop Behavior

- [x] Tool calls that do not require approval execute as today.
- [x] Tool calls requiring manual approval do not execute until approved.
- [x] Approved tool calls execute once, even after replay/resume.
- [x] Denied tool calls become model-visible tool results with `isError = true` or an equivalent explicit denial state.
- [x] Parallel tool calls can produce multiple pending approvals without deadlocking the turn.
- [x] Loop termination distinguishes final completion from waiting-on-user.

### Feature: Question Tool

- [x] Package-owned question tool accepts one or more questions with options and multiple-choice flags.
- [x] Question tool can allow or disallow custom answers.
- [x] Question cancellation produces a clear model-visible cancellation/denial result.
- [x] Question responses are structured and serializable in `ToolResult.structuredContent`.

### Feature: Runtime and Transport

- [x] Stateless HTTP can continue from transcript-carried HITL responses.
- [x] Cloudflare append-log runtime can persist pending HITL requests and reject conflicting inputs while paused.
- [x] Workflow runtime can pause durably and resume from a response.
- [x] Client helpers submit responses without fabricating assistant text.
- [ ] Cancellation/abort clears or marks pending requests deterministically.

### Feature: React Headless UI

- [x] `@yolk-sdk/react` exposes pending approval/question state in chat parts or request selectors.
- [x] UI state distinguishes input streaming, waiting for approval, approved, denied, executing, completed, errored.
- [x] Existing app conversation rendering can add buttons/forms without protocol mutation.

---

## Technical Context

### Existing Patterns

- `packages/agent/src/protocol/event.ts` — current lifecycle events, including partial tool approval events.
- `packages/agent/src/protocol/message.ts` — replayable message union and assistant tool-call parts.
- `packages/agent/src/protocol/tool.ts` — `ToolCall`, `ToolDef`, and `ToolResult` wire schemas.
- `packages/agent/src/loop/run.ts` — stateless tool execution loop and same-turn parallel tool handling.
- `packages/agent/src/loop/services/tool-executor.ts` — tool execution seam for policy/interception.
- `packages/agent/src/runtime/run-runtime.ts` — transcript vs append-backed runtime execution.
- `packages/agent/src/runtime/session-event-store.ts` — append-log replay model for durable sessions.
- `packages/agent/src/client/transport.ts` — NDJSON and WebSocket client transports.
- `packages/react/src/chat-messages.ts` — headless projection already models approval-requested and denied tool states.
- `packages/agent/src/tools/registry.ts` — generic tool registration metadata, including `ToolAccess`.
- `examples/next/app/agent/agent-conversation.tsx` — current app renderer for approval-labeled tool states.
- `cloudflare/agent/src/yolk-agent.ts` — durable WebSocket runtime and active-run conflict behavior.

### Reference Patterns

- `.repos/opencode/packages/opencode/src/permission/index.ts` — pending permission requests backed by `Deferred`, `once|always|reject` replies.
- `.repos/opencode/packages/opencode/src/question/index.ts` — structured question service with pending requests and replies.
- `.repos/opencode/packages/opencode/src/tool/question.ts` — question as a tool returning model-visible answers.
- `.repos/ai/packages/ai/src/generate-text/execute-tools-from-stream.ts` — approval request emitted before tool execution.
- `.repos/ai/packages/provider-utils/src/types/tool-approval-request.ts` — replayable approval request shape.
- `.repos/ai/content/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx` — client-side confirmation and server-side approval UX.
- `.repos/pi/packages/coding-agent/examples/extensions/permission-gate.ts` — direct interactive pre-tool confirmation.
- `.repos/executor/packages/core/sdk/src/elicitation.ts` — structured elicitation request/response contract.
- `.repos/executor/packages/core/sdk/src/policies.ts` — policy resolution combining user rules and tool annotations.

### Key Files

- `packages/agent/src/protocol/event.ts` — add or refine HITL events.
- `packages/agent/src/protocol/message.ts` — decide whether HITL responses are messages, parts, or typed tool results.
- `packages/agent/src/protocol/tool.ts` — add approval metadata or keep tool calls minimal.
- `packages/agent/src/loop/run.ts` — pause before execution and continue after response.
- `packages/agent/src/tools/registry.ts` — expose approval policy metadata without app concepts.
- `packages/agent/src/tools/index.ts` — export package-owned question tool.
- `packages/agent/src/runtime/session-event-store.ts` — persist pending/resolved HITL events.
- `packages/agent/src/client/transport.ts` — response submission for HTTP/WS.
- `packages/react/src/chat-messages.ts` and `packages/react/src/chat-items.ts` — render-state projection.
- `examples/next/lib/agents/route-handler.ts` — stateless route boundary.
- `cloudflare/agent/src/yolk-agent.ts` — durable direct-WS adapter.
- `examples/next/lib/agents/workflow-runtime/run-agent-workflow.ts` — Workflow adapter.

### System Dependencies

- No new provider dependency required.
- No app auth model belongs in package APIs.
- Durable runtimes need an adapter-owned persistence layer for pending requests.
- UI rendering remains app-owned; packages expose state and helpers only.

### Data Model Changes

- Package protocol: new schema classes/unions for HITL requests and responses.
- Runtime append log: new runtime session events for pending and resolved HITL requests may be required.
- Cloudflare Durable Object storage: existing event-log storage may need schema migration or compatibility decode for new events.
- Workflow runtime: durable step state must include pending request metadata and response correlation ids.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Replay executes approved tool twice | Medium | High | Correlate response id to tool call id; persist executed result; test replay/resume idempotency |
| Parallel approvals deadlock turn | Medium | High | Model pending requests as independent by id; allow batch/multiple responses; test sibling calls |
| Protocol grows app-specific concepts | Medium | High | Keep package schema domain-free: request, response, tool call, reason; app owns labels/policy UI |
| Denial invisible to model | Medium | Medium | Always create model-visible denial result or explicit response part before next turn |
| Durable and stateless semantics diverge | High | High | Shared protocol tests for transcript replay and append-log resume |
| Approval policy too coarse | Medium | Medium | Support tool metadata/access and host-provided policy resolver; defer product permissions |
| Pending requests leak after abort | Medium | Medium | Runtime must mark pending as cancelled/interrupted on abort; tests cover interruption |

---

## Alternatives Considered

### Alternative 1: App-only approval UI

- **Description:** Keep current protocol and add custom approval logic in Next/Cloudflare apps.
- **Pros:** Fastest for one app path.
- **Cons:** Duplicates logic, breaks package reuse, makes Workflow/Cloudflare incompatible.
- **Decision:** Rejected. HITL is agent-core behavior.

### Alternative 2: Assistant text asks for confirmation

- **Description:** Prompt the model to ask users before acting.
- **Pros:** Works today; no protocol changes.
- **Cons:** Not enforceable; unsafe tools can still execute; no structured responses; poor replay.
- **Decision:** Rejected for tool safety. Still acceptable for informal conversation.

### Alternative 3: UI-only client-side tools for all confirmations

- **Description:** Use a question/confirmation tool that runs only in the browser.
- **Pros:** Simple for chat UX; replayable if encoded as tool output.
- **Cons:** Does not gate server-side tool execution unless the model voluntarily calls it first.
- **Decision:** Rejected as the only mechanism. Useful as part of structured question tooling.

### Alternative 4: Executor-style durable pause only

- **Description:** All HITL requests suspend durable runtime state until resumed.
- **Pros:** Strong resume semantics.
- **Cons:** Overfits durable runtimes; less suitable for stateless Next transcript mode.
- **Decision:** Rejected as the only mechanism. Durable runtimes should implement this under the shared protocol.

---

## Non-Goals (v1)

- Product permission system for users/teams/orgs — app-owned and deferred.
- Provider-specific MCP approval passthrough beyond normalized protocol mapping — defer until provider integrations need it.
- Visual UI components in `@yolk-sdk/react` — package stays headless.
- Long-running multi-review workflows with assigned reviewers — future product layer.
- Approval analytics dashboards — future observability/product work.
- Voice-first approval UI beyond protocol compatibility — app voice UX can adapt later.
- Recursive subagent approval delegation policy — defer until subagent capability model matures.

---

## Interface Specifications

### Package API

The exact names remain open, but the package surface must provide:

```ts
// @yolk-sdk/agent/protocol
ToolApprovalRequest
ToolApprovalResponse
QuestionRequest
QuestionResponse
HitlRequest
HitlResponse
AgentEvent // includes HITL lifecycle events
AgentWebSocketClientMessage // includes HITL response messages where needed
```

```ts
// @yolk-sdk/agent/tools
makeQuestionToolRegistration(...)
questionToolName
```

```ts
// @yolk-sdk/agent/client
submitToolApprovalResponse(...)
submitQuestionResponse(...)
```

```ts
// @yolk-sdk/react
pendingApprovals / pendingQuestions selectors or chat part states
```

### API / Transport

Stateless HTTP must support either:

```txt
POST /api/agent
Request: { sessionId, messages, hitlResponses?, model?, reasoningEffort? }
Response: NDJSON AgentEvent stream
```

or a transcript-only equivalent where HITL responses are encoded as protocol messages.

Durable WebSocket must support typed client messages:

```txt
UserInput | ToolApprovalResponseInput | QuestionResponseInput
```

### UI

- Approval request states: requested, approved, denied, executing, completed, errored, cancelled.
- Question request states: requested, answered, cancelled.
- Pending controls disabled while submitting.
- Denial/cancel reason visible when available.

---

## Documentation Requirements

- [x] `packages/agent/README.md` or subpath docs explain HITL protocol.
- [x] `packages/react/README.md` documents headless rendering states.
- [x] Next example docs describe rendering approval/question controls.
- [x] Cloudflare/Workflow docs describe durable pending/resume behavior.
- [x] Package tests document replay and idempotency expectations.

---

## Open Questions

| Question | Owner | Due Date | Status |
| --- | --- | --- | --- |
| Should HITL responses be `AgentMessage`s, client control messages, or both? | Package owner | Before implementation | Resolved: control messages + replayed tool results |
| Should approval policy live on `ToolRegistration`, `ToolDef`, or a separate `ToolPolicy` service? | Package owner | Before implementation | Resolved: `ToolDef.approval`, sourced from registration |
| Should denial be encoded only as `ToolResult.isError` or also as an explicit assistant/tool part? | Package owner | Before implementation | Resolved: model-visible `ToolResult.isError` |
| How should stateless Next submit responses without a separate resume endpoint? | App/runtime owner | Before implementation | Resolved: request `hitlResponses` |
| Do multiple simultaneous pending approvals require batch response APIs? | Package owner | Before implementation | Resolved: multiple pending requests, one response submit helper |

---

## Appendix

### Glossary

- **HITL:** Human-in-the-loop; user input required before the agent can continue.
- **Approval:** User decision to allow or deny a tool call before execution.
- **Question:** Structured prompt from the agent to gather user input.
- **Durable runtime:** Runtime that persists execution state and can resume after reconnect or process interruption.
- **Stateless replay:** Runtime model where the client sends the full transcript each request.

### References

- `AGENT_LOOP.md` — original loop design notes and approval as consumer-layer assumption.
- `.repos/opencode/packages/opencode/src/permission/index.ts`
- `.repos/opencode/packages/opencode/src/question/index.ts`
- `.repos/ai/packages/ai/src/generate-text/execute-tools-from-stream.ts`
- `.repos/ai/content/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx`
- `.repos/pi/packages/coding-agent/examples/extensions/permission-gate.ts`
- `.repos/executor/packages/core/sdk/src/elicitation.ts`
