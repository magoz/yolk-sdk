# PRD: Subagent Task Tool v1

**Date:** 2026-05-14  

---

## Problem Statement

### What problem are we solving?

Yolk's main agent currently has to perform all exploration, synthesis, and tool work in one linear context. Complex requests often need independent investigation across multiple files, systems, or sources. Without subagents, the main agent spends context and wall-clock time doing serial discovery that could be delegated to focused workers.

### Why now?

The agent package stack was consolidated around `@yolk/agent` with explicit protocol, loop, runtime, client, and tools subpaths. The loop already supports parallel tool execution, which creates a natural foundation for a Claude Code/opencode-style `task` tool that lets the model launch parallel subagents when useful.

### Who is affected?

- **Primary users:** Users asking Yolk to handle complex codebase, research, or debugging tasks.
- **Secondary users:** Engineers maintaining Yolk agent runtime/tool packages and app adapters.

---

## Proposed Solution

### Overview

Add a package-owned subagent task primitive that exposes an LLM-callable `task` tool. The main agent can call `task` one or more times in a turn to delegate focused work to specialized subagents. Each subagent receives an explicit prompt, a selected subagent type, scoped tools, and its own run budget. Subagents may use normal tools, but v1 does not allow subagents to call `task` recursively. The main agent receives each subagent's final answer as a normal tool result and remains responsible for synthesizing the user-facing response.

### User Experience

Users do not need to explicitly invoke subagents. The main agent sees the `task` tool and decides when parallel delegation is useful. When it launches tasks, the UI can show normal tool lifecycle states for `task` calls. In v1, nested subagent traces are not required; the result appears as the completed task tool output.

#### User Flow: Parallel Code Exploration

1. User asks Yolk to understand a large feature or debug a cross-cutting issue.
2. Main agent emits several `task` tool calls in one turn, such as an auth explorer, route explorer, and test explorer.
3. Runtime executes those task tool calls concurrently under the existing tool concurrency limit.
4. Each subagent uses allowed normal tools such as search, read, web fetch, or MCP tools.
5. Each subagent returns a concise final answer.
6. Main agent receives task tool results and synthesizes the final answer for the user.

### Design Considerations

- Tool name is `task` to align with Claude Code and opencode model priors.
- Spawned worker term is `subagent`.
- v1 forbids recursive `task` calls from subagents by omitting the task tool from subagent toolsets.
- Subagents can call normal tools according to their definition and host policy.
- Task prompts must be explicit because subagents do not implicitly share full parent context.
- Multiple top-level task calls should run in parallel through existing `toolConcurrency` behavior.

---

## End State

When this PRD is complete, the following will be true:

- [ ] Main text agents can receive a `task` tool in their resolved toolset.
- [ ] The `task` tool accepts a description, prompt, and subagent type.
- [ ] The main agent can launch multiple task calls in one turn and they execute concurrently.
- [ ] Subagents run with scoped system prompt, model, capabilities, tools, and loop budget.
- [ ] Subagents can use normal tools, but cannot use `task` recursively in v1.
- [ ] Task results return model-visible content as normal `ToolResult` values.
- [ ] Package-level contracts remain domain-free; app adapters own model/provider/session/user policy.
- [ ] Tests cover tool schema, registry behavior, parallel task execution, no-recursion policy, errors, and app wiring.
- [ ] Documentation explains task tool semantics, subagent definitions, and v1 limits.

---

## Success Metrics

### Quantitative

| Metric | Current | Target | Measurement Method |
|--------|---------|--------|-------------------|
| Parallel task support | 0 subagent tasks | 2+ task calls can execute concurrently | Package/app tests with delayed fake subagents |
| Recursive task exposure | Not applicable | 0 task tools exposed inside v1 subagents | Tests inspect subagent resolved toolset |
| Package boundary violations | 0 expected | 0 | `pnpm packages:check` |

### Qualitative

- Main agent can explain and synthesize delegated findings without user instructions.
- Subagent definitions are easy to add without touching core loop code.
- The feature feels familiar to users and models that know Claude Code/opencode Task.

---

## Acceptance Criteria

### Feature: Task tool contract

- [ ] `@yolk/agent` exposes domain-free subagent/task types through explicit subpaths.
- [ ] Task input schema includes `description`, `prompt`, and `subagent_type` using opencode/Claude Code-compatible snake_case.
- [ ] Unknown subagent type returns a typed tool error.
- [ ] Task result includes a model-visible task result and enough metadata for host/UI correlation.

### Feature: Subagent execution

- [ ] A subagent run can execute through existing `runRuntime`/`run` primitives with injected provider/tool/runtime layers.
- [ ] Subagent execution has an explicit max-turn or budget limit independent from the parent run.
- [ ] Subagent failures return safe, typed tool errors and do not crash sibling tasks.
- [ ] Parent cancellation interrupts active subagent runs.

### Feature: Parallel delegation

- [ ] If the model emits multiple task tool calls in one turn, they run through existing bounded parallel tool execution.
- [ ] Results are returned to the parent transcript in deterministic call order, matching existing tool-result behavior.
- [ ] Tests prove wall-clock overlap or equivalent concurrent scheduling semantics with fake subagents.

### Feature: No recursion v1

- [ ] Main agents can receive the `task` tool.
- [ ] Subagent toolsets exclude the `task` tool by default.
- [ ] A subagent cannot call another subagent unless a future explicit capability enables it.
- [ ] Docs state recursion is intentionally deferred.

### Feature: App integration

- [ ] Next text runtime can register built-in subagent definitions.
- [ ] Cloudflare text runtime either supports the same task tool or explicitly omits it with documented rationale.
- [ ] Voice runtime does not expose `task` in v1 unless explicitly enabled later.
- [ ] UI can render `task` as a normal tool run without nested trace support.

---

## Technical Context

### Existing Patterns

- `packages/agent/src/loop/run.ts` — bounded parallel tool execution already exists via `parallelToolExecutionStream` and `toolConcurrency`.
- `packages/agent/src/tools/registry.ts` — generic `ToolModule<Context>` and `ToolRegistration<Context>` pattern for host-resolved tools.
- `packages/agent/src/runtime/run-runtime.ts` — generic transcript and append-input runtime over the stateless loop.
- `lib/agents/tools/registry.ts` — app composes runtime-portable text tool modules explicitly.
- `lib/agents/runtime-layer.ts` — app builds runtime layers from provider + tool executor dependencies.
- `.repos/opencode/packages/opencode/src/tool/task.ts` — reference Task tool with `description`, `prompt`, `subagent_type`, optional resume id, and subagent session execution.
- `.repos/opencode/packages/opencode/src/tool/task.txt` — reference model-facing Task tool guidance including parallel usage.
- `.repos/opencode/packages/opencode/src/agent/subagent-permissions.ts` — reference permission derivation and task recursion gating.
- `.repos/clanka/src/AgentTools.ts` — reference `delegate` tool via injected `SubagentExecutor`.
- `.repos/clanka/src/Agent.ts` and `.repos/clanka/src/AgentOutput.ts` — reference nested subagent execution/events, deferred for Yolk v1.

### Key Files

- `packages/agent/src/tools/registry.ts` — likely home for `makeTaskToolModule` or generic tool integration helpers.
- `packages/agent/src/runtime/index.ts` — likely export surface for subagent contracts if runtime owns execution semantics.
- `packages/agent/src/runtime/run-runtime.ts` — existing runtime entrypoint subagents should reuse, not duplicate.
- `packages/agent/src/loop/services/loop-config.ts` — contains `toolConcurrency` and loop budget defaults relevant to parent/subagent execution.
- `lib/agents/tools/registry.ts` — app text runtime tool composition point for enabling `task`.
- `lib/agents/tools/tool-context.ts` — app-owned context that may need parent session/user/surface metadata for task execution.
- `lib/agents/text-agent-config.ts` — app model/capabilities source for subagent definitions.
- `app/api/agent/route.ts` and `lib/agents/route-handler.ts` — Next text runtime integration boundary.
- `cloudflare/agent/src/tool-modules.ts` and `cloudflare/agent/src/yolk-agent.ts` — Cloudflare parity boundary.
- `packages/agent/test/tools` and `packages/agent/test/runtime` — package-level tests for task contracts and subagent execution.

### System Dependencies

- Existing LLM provider layers and `ToolExecutor` layers.
- Existing Effect Stream/Layer runtime composition.
- No new external services are required for v1.

### Data Model Changes

- No database migration required for v1 recommended defaults.
- v1 can be transcript-only/ephemeral from the parent perspective.
- Durable subagent sessions, `task_id` resume, and nested trace persistence are deferred.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Runaway fanout | Med | High | No recursive task in v1; bounded `toolConcurrency`; subagent max-turn budget |
| Context leakage | Med | Med | Subagents only receive explicit prompt/context; docs require complete task prompts |
| Tool policy bypass | Med | High | App owns subagent definitions and toolsets; tests assert task omitted from subagent tools |
| Poor synthesis | Med | Med | Task tool description instructs main agent to summarize results for user |
| Opaque UI | Med | Low | v1 renders as normal tool calls; nested events deferred until needed |
| Runtime mismatch between Next and Cloudflare | Med | Med | Document supported surfaces; add parity tests where enabled |

---

## Alternatives Considered

### Alternative 1: App-only task tool

- **Description:** Implement `task` purely under `lib/agents/tools` as an app-specific tool module.
- **Pros:** Fastest implementation and app policy can be hardcoded.
- **Cons:** Loses reusable package contract; subagent semantics spread through app glue; harder to test independently.
- **Decision:** Rejected. Use package-owned primitives with app-provided definitions/policy.

### Alternative 2: New protocol-level subagent events in v1

- **Description:** Add `SubagentStarted`, `SubagentEvent`, and `SubagentCompleted` to protocol immediately.
- **Pros:** Rich UI traces and nested observability from first release.
- **Cons:** Larger protocol/client/react surface, more persistence questions, more UI work before validating core utility.
- **Decision:** Deferred. v1 uses normal tool lifecycle; nested events can be v2.

### Alternative 3: Allow recursive tasks in v1

- **Description:** Let subagents receive the `task` tool and delegate further.
- **Pros:** More autonomous planning for complex tasks; matches some opencode configurations.
- **Cons:** Runaway fanout, budget/cancellation complexity, harder result synthesis, more policy risk.
- **Decision:** Rejected for v1. Add explicit capability later if needed.

### Alternative 4: Name the tool `delegate` or `subtask`

- **Description:** Use a more semantically precise tool name.
- **Pros:** `delegate` is clear; `subtask` implies no recursion.
- **Cons:** Claude Code/opencode use `task`; LLM priors likely favor `task`.
- **Decision:** Rejected. Use `task` for ecosystem/model familiarity.

---

## Non-Goals (v1)

Explicitly out of scope for this PRD:

- Recursive subagents — deferred until budget/cancellation/policy semantics are explicit.
- Nested subagent protocol events — deferred until UI/observability needs justify the protocol surface.
- `task_id` resume — deferred; v1 task runs can be ephemeral tool executions.
- Durable subagent sessions — deferred; host persistence design can follow after v1 behavior is validated.
- New UI pane for subagent traces — normal tool rendering is sufficient for v1.
- Voice task tool — text-first; voice can opt in later after UX review.
- Product permission system — app definitions/policy are enough for v1.

---

## Interface Specifications

### Package API

Exact names may change during implementation, but the completed API must preserve these semantics:

```ts
type SubagentDefinition = {
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly model?: string
  readonly tools: ReadonlyArray<ToolModule<SubagentToolContext>>
  readonly maxTurns?: number
  readonly allowTaskTool?: false
}

type TaskToolInput = {
  readonly description: string
  readonly prompt: string
  // Keep snake_case for model/tool compatibility with opencode and Claude Code.
  readonly subagent_type: string
}

type SubagentExecutor = {
  readonly run: (input: {
    readonly parentSessionId: string
    readonly callId: string
    readonly subagentType: string
    readonly prompt: string
    readonly description: string
  }) => Effect.Effect<ToolResult, ToolError>
}
```

### Tool Schema

```ts
{
  name: 'task',
  description: 'Launch a new agent to handle complex, multi-step tasks autonomously...',
  input: {
    description: 'short 3-5 word task label',
    prompt: 'complete task instructions and required context',
    subagent_type: 'specialized subagent type'
  }
}
```

### Task Result Shape

Task results should be model-visible and easy to synthesize:

```text
<task_result>
<subagent final answer>
</task_result>
```

If v1 includes metadata, it must not require UI changes to render correctly as a normal tool result.

---

## Documentation Requirements

- [ ] Update `packages/agent/AGENTS.md` with task/subagent boundaries.
- [ ] Update `packages/AGENTS.md` with subagent runtime/tool semantics.
- [ ] Update `lib/agents/AGENTS.md` and `lib/agents/tools/AGENTS.md` with app wiring and no-recursion policy.
- [ ] Update package README/import examples if new public exports are added.
- [ ] Document reference behavior from opencode/Claude Code naming and clanka delegate design.

---

## Open Questions

| Question | Owner | Due Date | Status |
|----------|-------|----------|--------|
| Should the canonical schema field be `subagent_type` for opencode compatibility or `subagentType` for Yolk style? | Engineering | 2026-05-14 | Resolved: use `subagent_type`; future resume field should be `task_id` if added. |
| Which subagent types ship first: `general`, `explore`, or app-specific definitions only? | Product/Engineering | Before implementation | Open |
| Should Cloudflare text runtime expose `task` in v1 or defer to Next runtime only? | Engineering | Before implementation | Open |
| Should task results include a generated task id even without resume support? | Engineering | Before implementation | Open |

---

## Appendix

### Glossary

- **Task tool:** LLM-callable tool named `task` that launches a subagent.
- **Subagent:** A focused agent run spawned by the parent/main agent.
- **Parent agent:** The agent run that calls the `task` tool.
- **Recursive task:** A subagent calling the `task` tool to spawn another subagent. Not allowed in v1.

### References

- `.repos/opencode/packages/opencode/src/tool/task.ts`
- `.repos/opencode/packages/opencode/src/tool/task.txt`
- `.repos/opencode/packages/opencode/src/agent/agent.ts`
- `.repos/opencode/packages/opencode/src/agent/subagent-permissions.ts`
- `.repos/clanka/src/AgentTools.ts`
- `.repos/clanka/src/Agent.ts`
- `.repos/clanka/src/AgentOutput.ts`
- `packages/agent/src/loop/run.ts`
- `packages/agent/src/tools/registry.ts`
- `packages/agent/src/runtime/run-runtime.ts`
