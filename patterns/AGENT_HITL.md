# Agent HITL

Repo-wide contract for human-in-the-loop agent pauses. Package owns protocol semantics; apps own storage, transport wiring, and UI.

## Ownership

| Layer | Owns |
| --- | --- |
| `@yolk-sdk/agent/protocol` | `HitlRequest`, `HitlResponse`, approval/question events, `AgentAwaitingInput` |
| `@yolk-sdk/agent/loop` | Pauses before gated tool execution; resumes from `hitlResponses` |
| `@yolk-sdk/agent/runtime` | Transcript replay and append-log pending/resume events |
| `@yolk-sdk/agent/client` | HTTP/WS response submission helpers |
| `@yolk-sdk/agent/tools` | Domain-free `question` tool contract |
| `@yolk-sdk/react` | Headless waiting/tool/question render state |
| App adapters | Storage, auth, concrete routes, hooks, buttons/forms |

## Semantics

- Tool approval policy lives on `ToolDef.approval` and can be sourced from `ToolRegistration.approval`.
- Manual approval emits `ToolApprovalRequested`, ends the run with `AgentAwaitingInput`, and never dispatches the tool until approved.
- Denied approval becomes a model-visible `ToolResultMessage` with `isError = true`.
- `question` is a package-owned tool name. The loop intercepts it, emits `QuestionRequested`, and resumes with structured answers in `ToolResult.structuredContent`.
- Question resume `ToolResult.content` must include selected answer values/labels, not only `answered`; providers reliably see text output.
- HITL responses are control inputs (`ToolApprovalResponseInput`, `QuestionResponseInput`, `hitlResponses`), not user/assistant text.
- Replay stays provider-neutral through normal assistant tool calls and tool result messages.
- Same-turn sibling tools may yield multiple pending requests; submit responses one at a time unless a runtime adds batching later.

## Runtime adapters

| Runtime | Resume contract |
| --- | --- |
| Stateless Next | Client sends full transcript plus `hitlResponses` to `/api/agent` |
| Cloudflare DO | WebSocket accepts typed HITL response input; append log persists `RunAwaitingInput` and `HitlResponseAppended` |
| Vercel Workflow | Tool step writes `AgentAwaitingInput`, waits on `createHook`, route resumes with `resumeHook` |

## UI rules

- Disable normal submit/edit/regenerate/delete while `status === 'waiting'`.
- Render approve/deny and question controls from headless tool states; keep UI app-owned.
- Show denial/cancel reason when available.
- Use accessible controls: labels, keyboard operation, and polite status updates.

## Tests

- Protocol wire round-trips: approval/question request + response.
- Loop: pause, approve, deny, question answer/cancel, parallel pending, no duplicate execution.
- Runtime: append pending state, replay responses, durable resume.
- React: waiting status, submit helpers, projection/replay.
- App adapters: route/WS/Workflow resume and toolset inclusion.
