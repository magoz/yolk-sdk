# PRD: Vercel Workflows Runtime Package

**Date:** 2026-05-14

---

## Problem Statement

### What problem are we solving?

The app now has a working Vercel Workflow-backed agent runtime, but the durable Workflow orchestration is embedded in app code. This makes the runtime hard to test independently, hard to reuse, and easy to couple to Yolk-specific auth, providers, routes, tools, and UI.

### Why now?

Workflow runtime behavior is stabilizing: step-split model/tool execution, plain serializable state, resume/cancel, bounded parallel tools, and optimistic stop UX now exist. Before adding more features or extracting API surfaces, tests should define the reusable contract.

### Who is affected?

- **Primary users:** Developers building Vercel Workflow-backed agent runtimes.
- **Secondary users:** Yolk maintainers who need durable streaming behavior without app-specific coupling.

---

## Proposed Solution

### Overview

Create a private workspace package at `packages/vercel-workflows-runtime` that owns Vercel Workflow-specific agent orchestration primitives. The package is runtime-only in v1: it defines durable workflow/step contracts, serializable continuation state, stream event writing, tool/model step coordination, and test fixtures. Apps keep Next routes, auth, provider selection, prompts, tool policy, telemetry, and UI.

---

## End State

When this PRD is complete:

- [ ] `packages/vercel-workflows-runtime` exists as a private workspace package.
- [ ] Package exposes runtime primitives for Workflow model/tool step orchestration.
- [ ] Package requires plain serializable workflow inputs and continuation state.
- [ ] Package has contract tests for serialization, model/tool continuation, errors, ordering, and stream lifecycle.
- [ ] Package includes a fixture/fake Workflow harness for cancel/resume/start behavior.
- [ ] Yolk app uses package primitives while keeping app-specific route/auth/provider/tool wiring local.
- [ ] Existing `/agent/workflow` behavior remains intact.
- [ ] Docs define package/app ownership boundaries.

---

## Success Metrics

### Quantitative

| Metric | Current | Target | Measurement Method |
| ------ | ------- | ------ | ------------------ |
| Package contract coverage | 0 | Covers core Workflow lifecycle | `pnpm --filter @yolk/vercel-workflows-runtime test:run` |
| App Workflow regressions | Manual smoke | Covered by fixture + app tests | `pnpm test:run` |
| Yolk-specific imports in package | N/A | 0 | package dependency graph / lint |

### Qualitative

- Workflow runtime can be reasoned about without reading app routes.
- Package API describes reusable Vercel-specific behavior, not Yolk product policy.
- Tests reduce reliance on Vercel logs for cancel/resume validation.

---

## Acceptance Criteria

### Package Boundary

- [ ] Package does not import `app/*`, `lib/services/*`, auth, telemetry, provider adapters, or app tool catalogs.
- [ ] Package may depend on `workflow`, Effect, `@yolk/protocol`, and `@yolk/agent-loop` only when needed.
- [ ] App supplies provider/tool/runtime layers or callbacks at step boundaries.
- [ ] App remains owner of Next route handlers and route paths.

### Runtime Contracts

- [ ] Workflow input and continuation state are plain serializable data.
- [ ] Model step returns either terminal completion or tool-call continuation.
- [ ] Tool batch step returns ordered tool-result messages, preserving original tool-call order.
- [ ] Workflow loop alternates durable model and tool steps until stop, error, or max-turn guard.
- [ ] Terminal errors are emitted in-band as protocol errors before stream close when possible.
- [ ] Effect runtime work remains outside `'use workflow'` orchestration and inside `'use step'` or app-supplied callbacks.

### Testing

- [ ] Contract tests cover successful no-tool model turn.
- [ ] Contract tests cover model → tool batch → model continuation.
- [ ] Contract tests cover parallel tool result ordering.
- [ ] Contract tests cover step failure → terminal error event.
- [ ] Contract tests cover max-turn guard.
- [ ] Fixture tests cover start/get/cancel behavior without log inspection.
- [ ] App smoke/e2e covers browser Stop → aborted state and cancel request.

---

## Technical Context

### Existing Patterns

- `lib/agents/workflow-runtime/run-agent-workflow.ts` — current app-owned Workflow orchestration and step functions.
- `packages/agent-loop/src/run.ts` — reusable `runModelTurn` / `runToolBatch` step APIs.
- `app/api/agent/workflow/route.ts` — starts Workflow and returns NDJSON stream with `x-workflow-run-id`.
- `app/api/agent/workflow/[runId]/route.ts` — GET resume and DELETE cancel route behavior.
- `packages/react/src/use-agent-chat.ts` — client abort/stop state behavior.

### Key Constraints

- `'use workflow'` functions are bundler/runtime sensitive.
- Workflow arguments must be plain serializable wire data, not Effect Schema class instances.
- Effect runtime calls must not run inside `'use workflow'` orchestration.
- Vercel cancellation may not preempt already-running model steps immediately.
- Product transcript remains app/client-owned for v1.

### System Dependencies

- Vercel `workflow` package.
- Effect runtime for step internals and tests.
- `@yolk/protocol` event/message schemas.
- `@yolk/agent-loop` model/tool step APIs.

### Data Model Changes

- None required for v1.
- Persisted run lifecycle may be added later by app-owned storage, not package v1.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Package leaks app concerns | Medium | High | Enforce dependency boundaries; app supplies callbacks/layers. |
| Workflow bundler rejects abstractions | Low | High | Keep `@workflow/vitest` package directive tests; isolate exported workflow fixtures carefully. |
| Tests mock away real Vercel behavior | Medium | Medium | Pair contract tests with tiny fixture/e2e smoke. |
| API freezes too early | Medium | Medium | Keep package private; document unstable exports. |
| Cancel semantics misunderstood | High | Medium | Test observable behavior; document preemption limits. |

---

## Alternatives Considered

### Keep Workflow runtime app-only

- **Pros:** Lowest extraction risk; app can move quickly.
- **Cons:** Harder to reuse and independently test; durable runtime logic stays mixed with auth/provider/tool policy.
- **Decision:** Rejected for v1 package goal.

### Batteries-included Next adapter

- **Pros:** Fastest setup for Next apps.
- **Cons:** Bakes route/auth/UI assumptions into first package API.
- **Decision:** Deferred. Start runtime-only.

### Generic durable agent runtime package

- **Pros:** Could support Cloudflare, local stores, and Vercel under one abstraction.
- **Cons:** Too broad; current need is Vercel Workflow-specific step orchestration.
- **Decision:** Rejected for this PRD.

---

## Non-Goals (v1)

- Next route builders — app keeps routes.
- React/UI helpers — existing `@yolk/react` owns headless UI state.
- Auth/session/provider/token refresh — app-owned.
- Tool catalog/policy — app-owned.
- Product transcript persistence — app/client-owned.
- Database-backed run lifecycle — future app integration.
- Public npm release — package remains private until API stabilizes.

---

## Interface Specifications

### Package

```txt
@yolk/vercel-workflows-runtime
```

Expected v1 surface shape, names TBD:

```ts
type WorkflowRuntimeInput = {
  readonly request: unknown
  readonly context: unknown
}

type WorkflowContinuationState = {
  readonly request: unknown
  readonly messages?: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly usage?: unknown
  readonly turn: number
}
```

Package exports should be explicit and minimal. No broad barrels.

---

## Documentation Requirements

- [ ] Add `packages/vercel-workflows-runtime/AGENTS.md` with ownership boundaries.
- [ ] Update root `AGENTS.md` package map.
- [ ] Update `lib/agents/AGENTS.md` with app/package Workflow split.
- [ ] Document Vercel cancel semantics after fixture/e2e validation.

---

## Open Questions

| Question | Owner | Due Date | Status |
| -------- | ----- | -------- | ------ |
| Exact public API names? | Engineering | Before implementation | Open |
| Should package own `getWritable()` event writing helpers? | Engineering | Before implementation | Open |
| Can fixture test real Vercel Workflow locally without deployment? | Engineering | 2026-05-14 | Resolved: `@workflow/vitest` starts package-owned workflow directives in-process. |
| How much retry behavior belongs in package vs app? | Engineering | During implementation | Open |

---

## Appendix

### Glossary

- **Workflow:** Vercel durable workflow function using `'use workflow'`.
- **Step:** Vercel durable step function using `'use step'`.
- **Continuation state:** Plain serializable state passed between durable steps.
- **Runtime-only:** Package owns orchestration primitives, not routes/auth/UI.

### References

- `lib/agents/workflow-runtime/run-agent-workflow.ts`
- `packages/agent-loop/src/run.ts`
- `app/api/agent/workflow/route.ts`
- `app/api/agent/workflow/[runId]/route.ts`
