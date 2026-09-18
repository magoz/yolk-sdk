# Agent HITL

Repo-wide contract for human-in-the-loop agent pauses. Package owns protocol semantics; apps own storage, transport wiring, and UI.

## Ownership

| Layer                      | Owns                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/agent/protocol` | `HitlRequest`, `HitlResponse`, approval/question/input events, `AgentAwaitingInput`                  |
| `@yolk-sdk/agent/loop`     | Pauses before gated tool execution; resumes from `hitlResponses`                                     |
| `@yolk-sdk/agent/runtime`  | Transcript replay and append-log pending/resume events                                               |
| `@yolk-sdk/agent/client`   | HTTP/WS response submission helpers                                                                  |
| `@yolk-sdk/agent/tools`    | Domain-free `question` and generalized typed input (`makeInputTool`) contracts                       |
| `@yolk-sdk/agent/react`    | Headless waiting/tool/question render state                                                          |
| `@yolk-sdk/agent/voice`    | Voice approval gating (`handleVoiceToolCall`), controller pause/resume, `AwaitingInput` voice events |
| `@yolk-sdk/harness`        | Payload-free park generation, sibling readiness, pause/resume/stop admission                         |
| App adapters               | Typed HITL payload persistence, auth, concrete routes, hooks, buttons/forms                          |

## Semantics

- Tool approval policy lives on `ToolDef.approval` and can be sourced from `ToolRegistration.approval`.
- Manual approval emits `ToolApprovalRequested`, ends the run with `AgentAwaitingInput`, and never dispatches the tool until approved.
- Denied approval becomes a model-visible `ToolResultMessage` with `isError = true`.
- `question` is a package-owned tool name. The loop intercepts it, emits `QuestionRequested`, and resumes with structured answers in `ToolResult.structuredContent`.
- Generalized typed input tools (`makeInputTool`) share the same HITL lifecycle under their own interception branch. `ToolDef.input` carries display metadata only (`kind` stable renderer key, `title?`, `description?`, display-only JSON Schema hint); the registration's original Effect Schema owns server validation. Payloads and results are JSON-only (`Schema.Json`).
- Input correlation is `input:<name>:<callId>` (distinct from `question:<callId>` / `approval:<callId>`); outcomes are `submitted | cancelled`. Hosts echo `requestId`/`toolCallId` opaquely and never rebuild ids.
- Resolved input validators live in `ResolvedToolSet.inputs` and must be passed explicitly to `prepareToolBatch`/`runToolBatch`/`run`/`runRuntime` configs. Without them, input tools fail closed as model-visible `unavailable` errors (no prompt, no dispatch, no executor call). Input tools never take approval/background policy and never execute through direct dispatch.
- Validate input call parameters against their original schema before prompting; malformed calls produce model-visible errors. Validate user data against its original response schema (excess fields rejected by `makeInputTool`), not the display hint.
- Invalid input payloads re-pend the same `InputRequest` (no result message or execution). The first valid submission or cancellation settles the request; earlier invalid attempts allow correction, later stale/duplicate responses cannot overwrite it. Durable hosts admit only currently pending request/call/type matches. Workflow filters responses at its durable hook boundary before adding them to batch history.
- Question resume `ToolResult.content` must include selected answer values/labels and continuation guidance, not only `answered`; providers reliably see text output.
- Input resume `ToolResult.content` is the registration's `formatContent` projection with `structuredContent` `{ type: 'input_response', ... }`, so replay stays provider-neutral through normal tool result messages.
- Full `run` streams publish canonical synthetic `ToolExecutionCompleted` results for preflight rejection and resolved HITL, including while other siblings remain pending. These events do not dispatch executors. Response markers and terminal transcript snapshots alone cannot preserve server formatting or settle every call in an already-streamed React turn.
- Question `structuredContent` must be plain JSON-serializable; use `questionResponseStructuredContent`/`plainHitlResponse` at persistence and workflow boundaries.
- Preserve unchosen options in `ToolCall.params`/UI input; model-visible question results should emphasize chosen answers.
- HITL responses are control inputs (`ToolApprovalResponseInput`, `QuestionResponseInput`, `InputResponseInput`, `hitlResponses`), not user/assistant text.
- Submitted approval/question responses can be mapped to optimistic UI/protocol events with `hitlResponseEvent`. Typed input acceptance must come from the server; never project unvalidated input as an accepted result.
- Replay stays provider-neutral through normal assistant tool calls and tool result messages.
- Same-turn sibling tools may yield multiple pending requests; submit responses one at a time unless a runtime adds batching later.
- Voice sessions support tool approvals only in v1; the `question` tool and generalized input tools are deferred for voice and voice `submitHitlResponse` ignores both response kinds.
- Voice approvals never execute server-side without a matching approved response (`requestId` = `approval:<callId>`, matching `toolCallId`); denials return model-visible denial output.
- Background-activated tool calls (`ToolDef.execution === 'background-v1'`) bind approval identity to the exact name, execution mode, and canonical arguments (`approval:<callId>:background-v1:<canonical JSON>`); a changed payload or mode needs a fresh approval, malformed envelopes are rejected before any prompt, and non-activated tools keep `approval:<callId>`. Hosts echo `requestId` opaquely and never rebuild it. IDs intentionally retain the full canonical payload for lossless exact binding; hosts must accommodate potentially long opaque IDs or enforce input bounds before admission (no truncation/hashing).

## Runtime adapters

| Runtime         | Resume contract                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateless Next  | Client sends full transcript plus `hitlResponses` to `/api/agent`; route passes `toolSet.inputs` through so input tools can resume                                                                        |
| Cloudflare DO   | WebSocket accepts typed HITL response input; append log persists `RunAwaitingInput` and `HitlResponseAppended`                                                                                            |
| Vercel Workflow | Tool step writes `AgentAwaitingInput`, waits on `createHook`, route resumes with `resumeHook`                                                                                                             |
| Voice session   | Server tool endpoint returns `ApprovalRequired`; controller emits voice `AwaitingInput` and resumes by re-posting the call with the approval response; session death keeps the approval pending host-side |

## UI rules

- Disable normal submit/edit/regenerate/delete while `status === 'waiting'`.
- Render approve/deny, question, and typed input controls from headless tool states; keep UI app-owned.
- Render typed inputs by `InputRequest.input.kind` through an app-owned renderer registry; unknown kinds fall back to an explicit unsupported notice with cancel (never a silent drop). Show server re-pends by keeping the form open; invalid payloads carry no validation detail in events.
- Keep custom input forms pending during submission; only server acceptance may produce a replayable input result. A transport failure must not turn unvalidated user data into a tool result. `AgentAwaitingInput.requests` restores headless pending state on replay.
- Show denial/cancel reason when available.
- Use accessible controls: labels, keyboard operation, and polite status updates.

## Tests

- Protocol wire round-trips: approval/question/input request + response.
- Plain serialization helpers: no Schema/Class instances in durable HITL payloads.
- Loop: pause, approve, deny, question answer/cancel, input call validation/submit/cancel/invalid-repend/first-valid-wins, parallel pending, no duplicate execution.
- Runtime: append pending state, replay responses, durable resume.
- React: waiting status, submit helpers, projection/replay.
- App adapters: route/WS/Workflow resume and toolset inclusion.
