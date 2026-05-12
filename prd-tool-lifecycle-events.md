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

Define a richer provider-neutral tool lifecycle in `@yolk/protocol` and package projections. The lifecycle should preserve backwards-compatible called/running/completed semantics while adding explicit states for streamed tool input, approval, denial, execution errors, provider-executed tools, and step metadata. The model must stay domain-free and generic; app-specific approval policy, UI rendering, and provider quirks remain outside protocol.

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

- [ ] Protocol can represent tool input start/delta/end.
- [ ] Protocol can represent approval requested, approved, and denied outcomes.
- [ ] Protocol can represent output success and output error distinctly.
- [ ] Protocol can represent provider-executed tools without local dispatch.
- [ ] Client and React projections preserve richer lifecycle states.
- [ ] Agent loop maintains current behavior for simple local tools.
- [ ] Tests cover event ordering, projection, error states, and backwards compatibility.
- [ ] Docs explain host-owned policy and provider adapter responsibilities.

---

## Success Metrics

### Quantitative

| Metric | Current | Target | Measurement Method |
| --- | --- | --- | --- |
| Tool lifecycle states represented | 3 | input/approval/executing/completed/error/denied/provider-executed | Protocol tests |
| Projection coverage | simple only | all lifecycle events | Client/React tests |
| Backcompat failures | N/A | none | Existing package tests |

### Qualitative

- Provider adapters can normalize modern tool streams without lossy fake states.
- UI packages can display pending, approval, denied, error, and provider-executed tools without app-local protocol forks.

---

## Acceptance Criteria

### Feature: Tool Input Lifecycle

- [ ] Protocol includes events for tool input start, delta, and end.
- [ ] Events preserve call id, tool name when available, and argument/input fragments.
- [ ] Final tool call remains representable as `ToolCall` for existing loop/tool execution.
- [ ] Client projections can derive current streamed input for a tool call.

### Feature: Approval Lifecycle

- [ ] Protocol can represent approval requested for a tool call.
- [ ] Protocol can represent approval granted and denied.
- [ ] Denied tools do not require a local `ToolExecutor` call.
- [ ] Approval policy is host-owned; packages only model events/states.

### Feature: Execution Outcome Lifecycle

- [ ] Protocol distinguishes successful output from tool execution error.
- [ ] Tool error events preserve safe error message/code.
- [ ] Existing `ToolExecutionStart`/`ToolExecutionEnd` behavior remains compatible or is migrated with aliases/adapters.
- [ ] `ToolResult` continues to carry agent-readable content and optional structured content.

### Feature: Provider-Executed Tools

- [ ] Protocol can mark a tool call/result as provider-executed.
- [ ] Agent loop can avoid local dispatch for provider-executed results.
- [ ] UI/client can display provider-executed state without pretending a local run occurred.

### Feature: Step Metadata

- [ ] Events can be correlated to turn/step/run where needed.
- [ ] Step metadata is optional and does not require durable runtime adoption.
- [ ] Durable append-store PRD can consume the lifecycle vocabulary without redesign.

---

## Technical Context

### Existing Patterns

- `packages/protocol/src/event.ts` — current stream events: `LLMToolCall`, `ToolExecutionStart`, `ToolExecutionEnd`, `ToolResult`.
- `packages/protocol/src/tool.ts` — `ToolCall`, `ToolDef`, `ToolResult` schemas.
- `packages/agent-loop/src/run.ts` — local tool execution stream emits start/end/result after full LLM turn.
- `packages/client/src/state.ts` — client tool run state: `Called`, `Running`, `Completed`.
- `packages/react/src/chat-messages.ts` — render projection mirrors the current tool states.
- `packages/voice-runtime/src/tool-bridge.ts` — realtime voice bridge has provider-normalized tool call/result envelope.

### Key Files

- `packages/protocol/src/event.ts` — event vocabulary changes.
- `packages/client/src/state.ts` — generic reducer state changes.
- `packages/react/src/chat-messages.ts` — headless UI state changes.
- `packages/agent-loop/src/run.ts` — local execution compatibility path.
- `lib/agents/providers/openai-provider.ts` and `lib/agents/providers/openai-codex-provider.ts` — provider adapter normalization later.

### System Dependencies

- `@yolk/protocol` schema compatibility.
- `@yolk/client` and `@yolk/react` projection compatibility.
- `@yolk/agent-loop` local tool execution semantics.
- Future append store PRD for durable persistence of lifecycle events.

### Data Model Changes

Expected protocol additions are generic event/state shapes, not app database schema.

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

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Protocol becomes provider-specific | Medium | High | Use generic names; keep OpenAI/MCP details in adapters. |
| Existing consumers break | Medium | High | Preserve existing events or provide compatibility reducers. |
| Approval policy leaks into packages | Medium | Medium | Protocol models decisions only; host owns policy/enforcement. |
| Too many states too early | Medium | Medium | Add only states needed by reference gaps; defer artifacts/output schemas. |
| Durable append store duplicates lifecycle concepts | Medium | High | Align PRDs before implementation. |

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
  | { readonly _tag: 'ToolExecutionStart'; readonly call: ToolCall }
  | { readonly _tag: 'ToolExecutionEnd'; readonly call: ToolCall; readonly result: ToolResult }
  | { readonly _tag: 'ToolExecutionError'; readonly call: ToolCall; readonly message: string }
  | { readonly _tag: 'ToolProviderResult'; readonly call: ToolCall; readonly result: ToolResult }
```

The final API may differ, but it must preserve these semantics.

---

## Documentation Requirements

- [ ] Update `packages/protocol/AGENTS.md` event guidance.
- [ ] Update `packages/client/AGENTS.md` tool reducer guidance.
- [ ] Update `packages/react/AGENTS.md` render-state guidance.
- [ ] Update `packages/agent-loop/AGENTS.md` local execution semantics.
- [ ] Update `packages/AGENTS.md` reference gap TODO after implementation.

---

## Open Questions

| Question | Owner | Due Date | Status |
| --- | --- | --- | --- |
| Should streamed tool input deltas be raw JSON string deltas or structured partial values? | Package owner | Before implementation | Open |
| Should approval events live in protocol or tool-registry package exports? | Package owner | Before implementation | Open |
| Should provider-executed tools create assistant `toolCalls`, `ToolResultMessage`, both, or separate transcript entries? | Package owner | Before implementation | Open |
| Should `ToolExecutionError` become a `ToolResult` with `isError`, or a distinct event only? | Package owner | Before implementation | Open |
| Which existing event names stay as compatibility aliases? | Package owner | Before implementation | Open |

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
