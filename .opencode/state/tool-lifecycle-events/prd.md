# PRD: Rich Tool Lifecycle Events

**Date:** 2026-05-12

---

## Problem Statement

### What problem are we solving?

Yolk currently models tools as a coarse lifecycle: model emits `LLMToolCall`, runtime emits `ToolExecutionStart`, then `ToolExecutionEnd` and `ToolResult`. This works for simple loop-owned tool execution, but it cannot represent streamed tool arguments, user approval/denial, provider-executed tools, output errors, or step-level metadata. UI clients and durable runtimes therefore cannot faithfully display or persist modern tool behavior from OpenAI Responses, AI SDK-style streams, MCP hosted tools, or future approval flows.

### Why now?

Reference repo review showed tool lifecycle richness as a foundational gap. The durable append-store design also needs a stable event vocabulary before implementation so runtime persistence does not bake in the current too-simple `Called → Running → Completed` model.

### Who is affected?

- **Primary users:** Package consumers building chat UIs, durable runtime adapters, and tool approval flows.
- **Secondary users:** Provider adapters that need to normalize streamed/provider-executed tool behavior without losing fidelity.

---

## Proposed Solution

### Overview

Define a richer provider-neutral tool lifecycle in `@yolk-sdk/agent/protocol` and package projections. The lifecycle should replace the current too-coarse called/running/completed event vocabulary with explicit states for streamed tool input, approval, denial, execution errors, provider-executed tools, and step metadata. Breaking changes are acceptable; prefer the best long-term protocol shape over compatibility shims. The model must stay domain-free and generic; app-specific approval policy, UI rendering, and provider quirks remain outside protocol.

### Resolved Design Decisions

- **Tool input deltas:** use raw JSON string fragments. Provider adapters append deltas and final `ToolCall` validation happens at the boundary.
- **Approval events:** live in protocol `AgentEvent`. Host apps own policy and enforcement.
- **Provider-executed tools:** move toward ordered assistant transcript parts. Provider-executed call/result parts belong inside the assistant turn because they are provider-owned context for replay/handoff. Host-executed tools keep separate `ToolResultMessage` entries.
- **Tool execution errors:** emit a distinct `ToolExecutionError` event. Transcript persistence of safe error output is host/runtime policy, not automatic fabrication.
- **Compatibility:** breaking changes are acceptable. Remove/rename old lifecycle events and migrate call sites in one package-wide change. Do not add aliases solely for backwards compatibility.

### User Experience

Users should see tools progress through understandable states instead of a binary “called/running/completed” indicator.

#### User Flow: Streamed Tool Arguments

1. Model starts constructing a tool call.
2. UI shows a tool call placeholder and incrementally updates arguments.
3. When arguments are complete, UI shows the final tool call.
4. Runtime executes or requests approval based on host policy.

#### User Flow: Approval Required

1. Model requests a write/destructive tool.
2. UI shows a pending approval state with tool name and arguments.
3. User approves or denies.
4. Runtime either executes the tool or emits a denial event.

#### User Flow: Provider-Executed Tool

1. Provider reports a hosted tool call/result.
2. Runtime records/display events without dispatching local `ToolExecutor`.
3. UI shows provider-executed metadata and result.

---

## End State

When this PRD is complete, the following will be true:

- [x] Protocol can represent tool input start/delta/end.
- [x] Protocol can represent approval requested, approved, and denied outcomes.
- [x] Protocol can represent output success and output error distinctly.
- [x] Protocol can represent provider-executed tools without local dispatch.
- [x] Client and React projections preserve richer lifecycle states.
- [x] Agent loop preserves semantics for simple local tools using the new event names/states.
- [x] Tests cover event ordering, projection, error states, and removal of old lifecycle events.
- [x] Docs explain host-owned policy and provider adapter responsibilities.

---

## Success Metrics

### Quantitative

| Metric                             | Current     | Target                                                            | Measurement Method        |
| ---------------------------------- | ----------- | ----------------------------------------------------------------- | ------------------------- |
| Tool lifecycle states represented  | 3           | input/approval/executing/completed/error/denied/provider-executed | Protocol tests            |
| Projection coverage                | simple only | all lifecycle events                                              | Client/React tests        |
| Old lifecycle event usages removed | 0%          | 100%                                                              | Package tests + typecheck |

### Qualitative

- Provider adapters can normalize modern tool streams without lossy fake states.
- UI packages can display pending, approval, denied, error, and provider-executed tools without app-local protocol forks.

---

## Acceptance Criteria

### Feature: Tool Input Lifecycle

- [x] Protocol includes events for tool input start, delta, and end.
- [x] Events preserve call id, tool name when available, and raw JSON string fragments.
- [x] Final tool call remains representable as `ToolCall` for existing loop/tool execution.
- [x] Client projections can derive current streamed input for a tool call.

### Feature: Approval Lifecycle

- [x] Protocol can represent approval requested for a tool call.
- [x] Protocol can represent approval granted and denied.
- [x] Denied tools do not require a local `ToolExecutor` call.
- [x] Approval policy is host-owned; packages only model events/states.

### Feature: Execution Outcome Lifecycle

- [x] Protocol distinguishes successful output from tool execution error.
- [x] Tool error events preserve safe error message/code.
- [x] Existing `ToolExecutionStart`/`ToolExecutionEnd` events are removed or renamed into the new event vocabulary without aliases.
- [x] `ToolResult` continues to carry agent-readable content and optional structured content.

### Feature: Provider-Executed Tools

- [x] Assistant transcript can preserve ordered provider-executed call/result parts.
- [x] Host-executed tool calls still produce separate `ToolResultMessage` entries.
- [x] Agent loop can avoid local dispatch for provider-executed results.
- [x] UI/client can display provider-executed state without pretending a local run occurred.

### Feature: Step Metadata

- [x] Events can be correlated to turn/step/run where needed.
- [x] Step metadata is optional and does not require durable runtime adoption.
- [x] Durable append-store PRD can consume the lifecycle vocabulary without redesign.

---

## Technical Context

### Existing Patterns

- `packages/agent/src/protocol/event.ts` — current stream events: `LLMToolCall`, `ToolExecutionStart`, `ToolExecutionEnd`, `ToolResult`.
- `packages/agent/src/protocol/tool.ts` — `ToolCall`, `ToolDef`, `ToolResult` schemas.
- `packages/agent/src/loop/run.ts` — local tool execution stream emits start/end/result after full LLM turn.
- `packages/agent/src/client/state.ts` — client tool run state: `Called`, `Running`, `Completed`.
- `packages/agent/src/react/chat-messages.ts` — render projection mirrors the current tool states.
- `packages/agent/src/voice/tool-bridge.ts` — realtime voice bridge has provider-normalized tool call/result envelope.

### Key Files

- `packages/agent/src/protocol/event.ts` — event vocabulary changes.
- `packages/agent/src/client/state.ts` — generic reducer state changes.
- `packages/agent/src/react/chat-messages.ts` — headless UI state changes.
- `packages/agent/src/loop/run.ts` — local execution compatibility path.
- `@yolk-sdk/agent/providers/openai/provider` and `@yolk-sdk/agent/providers/openai/codex-provider` — provider adapter normalization later.

### System Dependencies

- `@yolk-sdk/agent/protocol` schema compatibility.
- `@yolk-sdk/agent/client` and `@yolk-sdk/agent/react` projection compatibility.
- `@yolk-sdk/agent/loop` local tool execution semantics.
- Future append store PRD for durable persistence of lifecycle events.

### Data Model Changes

Expected protocol additions are generic event/state shapes, not app database schema.

The assistant transcript should evolve from separated `content` / `reasoning` / `toolCalls` fields toward ordered assistant parts so reasoning, text, hosted tool calls, and hosted tool results preserve provider order. This is a larger protocol change, but it is the cleanest fit for provider-executed tools and future provider handoff.

Candidate semantic states:

- **InputStreaming:** call id/name known, arguments/input not final.
- **InputReady:** final `ToolCall` available.
- **ApprovalRequested:** host policy requires user/system decision.
- **Approved:** execution may proceed.
- **Denied:** execution skipped with reason.
- **Executing:** local runtime executing.
- **Completed:** tool result available.
- **Errored:** tool execution failed safely.
- **ProviderExecuted:** provider handled execution/result externally.

---

## Risks & Mitigations

| Risk                                               | Likelihood | Impact | Mitigation                                                                |
| -------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------- |
| Protocol becomes provider-specific                 | Medium     | High   | Use generic names; keep OpenAI/MCP details in adapters.                   |
| Existing consumers break                           | High       | Medium | Accept breakage; migrate package/app call sites in one change.            |
| Approval policy leaks into packages                | Medium     | Medium | Protocol models decisions only; host owns policy/enforcement.             |
| Too many states too early                          | Medium     | Medium | Add only states needed by reference gaps; defer artifacts/output schemas. |
| Durable append store duplicates lifecycle concepts | Medium     | High   | Align PRDs before implementation.                                         |

---

## Alternatives Considered

### Alternative 1: Keep current simple lifecycle

- **Description:** Continue with `Called → Running → Completed`.
- **Pros:** Simple and stable.
- **Cons:** Loses streamed args, approvals, denied/error states, provider-executed metadata.
- **Decision:** Rejected. Too lossy for target runtime/UI.

### Alternative 2: Copy AI SDK UIMessage parts exactly

- **Description:** Adopt AI SDK message chunks and UI part model wholesale.
- **Pros:** Proven rich UI semantics.
- **Cons:** Yolk protocol is provider/runtime-neutral and Effect/schema-first; wholesale copy may overfit UI concerns.
- **Decision:** Rejected. Borrow semantics, not shape.

### Alternative 3: Model richness only in app UI

- **Description:** Keep protocol simple; app/provider adapters create local UI events.
- **Pros:** Avoids package API churn.
- **Cons:** Prevents reusable client/runtime durability and duplicates logic per app.
- **Decision:** Rejected. Lifecycle belongs in reusable protocol.

### Alternative 4: Provider-executed tools as normal `ToolResultMessage`s

- **Description:** Store provider-executed calls in `Assistant.toolCalls` and results as normal `ToolResultMessage`s with metadata.
- **Pros:** Minimal change to current transcript shape; aligns with some hosted-tool implementations.
- **Cons:** Treats provider-owned assistant context as host/user-side tool output and loses ordered assistant part fidelity.
- **Decision:** Rejected for the target design. Provider-executed tools should be assistant-owned ordered parts; host-executed tools keep `ToolResultMessage`.

---

## Non-Goals (v1)

- Implement host approval UI or policy engine.
- Add database schema or durable append-store implementation.
- Add file/resource/artifact typed rendering beyond existing `Content`/`structuredContent`.
- Add provider SDK imports to packages.
- Add sandbox/runtime isolation for tool execution.
- Add MCP output schemas/annotations; separate future work.

---

## Interface Specifications

### Package API

Exact names are not specified by this PRD, but protocol must be able to express:

```ts
type ToolLifecycleEvent =
  | { readonly _tag: 'ToolInputStart'; readonly id: string; readonly name?: string }
  | { readonly _tag: 'ToolInputDelta'; readonly id: string; readonly delta: string }
  | { readonly _tag: 'ToolInputEnd'; readonly call: ToolCall }
  | { readonly _tag: 'ToolApprovalRequested'; readonly call: ToolCall }
  | { readonly _tag: 'ToolApprovalGranted'; readonly toolCallId: string }
  | { readonly _tag: 'ToolApprovalDenied'; readonly toolCallId: string; readonly reason: string }
  | { readonly _tag: 'ToolExecutionStarted'; readonly call: ToolCall }
  | {
      readonly _tag: 'ToolExecutionCompleted'
      readonly call: ToolCall
      readonly result: ToolResult
    }
  | { readonly _tag: 'ToolExecutionError'; readonly call: ToolCall; readonly message: string }
  | { readonly _tag: 'ProviderToolResult'; readonly call: ToolCall; readonly result: ToolResult }

type AssistantPart =
  | { readonly _tag: 'Text'; readonly content: Content }
  | { readonly _tag: 'Reasoning'; readonly text: string }
  | { readonly _tag: 'HostToolCall'; readonly call: ToolCall }
  | {
      readonly _tag: 'ProviderToolCall'
      readonly call: ToolCall
      readonly providerMetadata?: unknown
    }
  | {
      readonly _tag: 'ProviderToolResult'
      readonly toolCallId: string
      readonly result: ToolResult
      readonly providerMetadata?: unknown
    }
```

The final API may differ, but it must preserve these semantics.

---

## Documentation Requirements

- [x] Update `packages/agent/AGENTS.md` event guidance.
- [x] Update `packages/agent/AGENTS.md` tool reducer guidance.
- [x] Update `packages/agent/AGENTS.md` render-state guidance.
- [x] Update `packages/agent/AGENTS.md` local execution semantics.
- [x] Update `packages/AGENTS.md` reference gap TODO after implementation.

---

## Open Questions

| Question                                                                                                                | Owner         | Due Date   | Status                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| Should streamed tool input deltas be raw JSON string deltas or structured partial values?                               | Package owner | 2026-05-12 | Resolved: raw JSON string deltas.                                                                         |
| Should approval events live in protocol or tool-registry package exports?                                               | Package owner | 2026-05-12 | Resolved: protocol events.                                                                                |
| Should provider-executed tools create assistant `toolCalls`, `ToolResultMessage`, both, or separate transcript entries? | Package owner | 2026-05-12 | Resolved: ordered assistant parts for provider-executed call/result; host tools keep `ToolResultMessage`. |
| Should `ToolExecutionError` become a `ToolResult` with `isError`, or a distinct event only?                             | Package owner | 2026-05-12 | Resolved: distinct event; transcript error output remains host/runtime policy.                            |
| Which existing event names stay as compatibility aliases?                                                               | Package owner | 2026-05-12 | Resolved: rename now, no long-term aliases.                                                               |

---

## Appendix

### Glossary

- **Tool input:** The arguments or input being constructed by a model/provider for a tool call.
- **Provider-executed tool:** A hosted tool executed by the model provider rather than Yolk `ToolExecutor`.
- **Approval:** Host-owned decision to allow/deny a requested tool call.
- **Step metadata:** Optional turn/step/run correlation fields for projection and durability.

### References

- `.repos/ai/packages/ai/src/ui/ui-messages.ts`
- `.repos/ai/packages/ai/src/ui-message-stream/ui-message-chunks.ts`
- `.repos/opencode/packages/llm/src/schema/events.ts`
- `.repos/opencode/packages/llm/src/protocols/utils/tool-stream.ts`
- `.repos/pi/packages/agent/src/agent-loop.ts`
