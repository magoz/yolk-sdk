# PRD: Durable Runtime Append Store

**Date:** 2026-05-12

---

## Problem Statement

### What problem are we solving?

`@yolk/agent-runtime` currently persists whole session snapshots only after a successful run. This is simple, but it cannot safely support durable multi-client sessions, reconnect/resume, concurrent writes, partial run inspection, interrupted cleanup, or event fanout. Host apps that need durable agents must either overwrite full transcripts or build ad hoc storage outside the package.

### Why now?

Reference repo review highlighted durable runtime/session state as the next foundational package gap. Cloudflare Durable Object smoke storage already proves package portability, but its `messages` snapshot model will not scale to real durable sessions.

### Who is affected?

- **Primary users:** App/server adapters that run `@yolk/agent-runtime` for persistent agent sessions.
- **Secondary users:** UI clients that need reconnect/resume, history, and consistent run state.

---

## Proposed Solution

### Overview

Add a generic append-oriented runtime storage contract that records session inputs, created messages, run lifecycle events, and revisions without tying packages to a database, WebSocket, HTTP, auth, or product model. The runtime should retain existing transcript/input behavior while enabling hosts to implement durable sessions from an ordered event log rather than whole-snapshot overwrite.

---

## End State

When this PRD is complete, the following will be true:

- [ ] Runtime persistence can append ordered session events with revision metadata.
- [ ] Runtime can reconstruct protocol transcript state from append-store data.
- [ ] Runtime can detect conflicting writes instead of silently overwriting sessions.
- [ ] Runtime can represent started, completed, failed, and interrupted runs.
- [ ] Existing snapshot semantics remain compatible or have a documented migration path.
- [ ] Tests cover append, replay, conflict, failure, and interrupted-run behavior.
- [ ] Package docs explain store boundaries and host responsibilities.

---

## Success Metrics

### Quantitative

| Metric | Current | Target | Measurement Method |
| --- | --- | --- | --- |
| Snapshot overwrites in runtime persistence | 100% | 0 for append-store mode | Runtime tests |
| Durable replay coverage | none | session replay tested | Package tests |
| Conflict handling coverage | none | stale revision rejected | Package tests |

### Qualitative

- Host adapters can implement durable sessions without reinterpreting loop internals.
- Runtime storage model is generic enough for Postgres, Durable Objects, KV-like stores, and in-memory tests.

---

## Acceptance Criteria

### Feature: Append Store Contract

- [ ] A package-level storage interface supports append-only session events.
- [ ] Appended events include session id, run id, event id/order, and revision information.
- [ ] The interface does not depend on app auth, product tenancy, database clients, HTTP, or Cloudflare APIs.
- [ ] The in-memory implementation supports deterministic tests.

### Feature: Runtime Replay

- [ ] Runtime can load a session transcript by replaying persisted events.
- [ ] Replay output is protocol messages only, not UI render models.
- [ ] Unknown/future event variants fail safely or are ignored only when explicitly versioned.

### Feature: Run Lifecycle Durability

- [ ] Runtime records run start and successful completion.
- [ ] Runtime records failure/interruption without persisting fabricated assistant/tool messages.
- [ ] Runtime can identify an incomplete active run for host-level cleanup/resume decisions.

### Feature: Conflict Semantics

- [ ] Store writes can reject stale expected revisions.
- [ ] Runtime maps conflict failures to existing runtime/protocol error paths.
- [ ] Concurrent input mode does not silently drop or overwrite messages.

### Feature: Compatibility

- [ ] Existing `runRuntime` transcript mode remains stateless by default.
- [ ] Existing input mode behavior is preserved for callers using snapshot stores, or migration docs explicitly describe the replacement.
- [ ] Cloudflare smoke adapter has a clear path from snapshot storage to append storage.

---

## Technical Context

### Existing Patterns

- `packages/agent-runtime/src/run-runtime.ts` — coordinates transcript/input mode and saves after success.
- `packages/agent-runtime/src/session-store.ts` — current snapshot store contract and in-memory layer.
- `packages/agent-runtime/AGENTS.md` — already states future durable behavior should prefer append/run-event semantics.
- `cloudflare/agent/src/yolk-agent.ts` — thin adapter currently persists `messages` in Durable Object storage.
- `packages/protocol/src/message.ts` and `packages/protocol/src/event.ts` — protocol transcript and stream event source of truth.

### Key Files

- `packages/agent-runtime/src/run-runtime.ts` — runtime integration point.
- `packages/agent-runtime/src/session-store.ts` — likely store contract evolution point.
- `packages/agent-runtime/test/run-runtime.test.ts` — current persistence semantics tests.
- `cloudflare/agent/src/yolk-agent.ts` — downstream smoke adapter to validate portability later.

### System Dependencies

- Effect services/layers for injected storage.
- `@yolk/protocol` message/event schemas for persisted payloads.
- No direct DB, Cloudflare, HTTP, WebSocket, or auth dependency in package code.

### Data Model Changes

The package should define generic data shapes only. Host apps own physical tables/storage.

Expected logical entities:

- **Session metadata:** session id, current revision, optional active run marker.
- **Session event:** event id/order, session id, run id, kind, payload, revision.
- **Run record:** run id, status, timestamps/order markers, failure/interruption details.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Store contract becomes database-specific | Medium | High | Keep package interface logical; adapters own physical persistence. |
| Event model duplicates protocol events incorrectly | Medium | High | Persist protocol messages/events where possible; separate runtime metadata from protocol payload. |
| Resume semantics become too broad | High | Medium | Define resumability as storage/read model first; transport reconnect/fanout can remain host-owned. |
| Backcompat breaks current app/Cloudflare smoke | Medium | Medium | Keep snapshot store until migration path exists. |
| Partial runs expose fabricated messages | Medium | High | Only persist created protocol messages from `AgentEnd`; record partial lifecycle separately. |

---

## Alternatives Considered

### Alternative 1: Keep snapshot-only store

- **Description:** Continue loading/saving whole transcripts.
- **Pros:** Simple and already implemented.
- **Cons:** Silent overwrites, no run lifecycle, weak resume/fanout story.
- **Decision:** Rejected for durable sessions.

### Alternative 2: Persist every `AgentEvent` as the session log

- **Description:** Store all streamed events verbatim and replay from them.
- **Pros:** Maximum fidelity for observability and resume.
- **Cons:** Protocol stream events include transient deltas; transcript reconstruction and compaction become fragile.
- **Decision:** Rejected as the only model. May be useful as optional trace data.

### Alternative 3: App-owned append model only

- **Description:** Leave runtime package unchanged; each host builds append semantics.
- **Pros:** Avoids package API churn.
- **Cons:** Duplicates lifecycle logic and weakens reusable runtime value.
- **Decision:** Rejected. Package should own generic lifecycle semantics.

---

## Non-Goals (v1)

- WebSocket/SSE reconnect protocol — host/client transport concern.
- UI thread list, drafts, model picker, or command palette — app/product layer.
- Database migrations or concrete Drizzle schema — app/service layer.
- Cross-device auth/tenancy policy — app boundary.
- Tool approval policy — separate lifecycle/tool PRD.
- Durable compaction strategy — future runtime extension after append semantics exist.

---

## Interface Specifications

### Package API

Exact names are not specified by this PRD, but the public interface must expose:

```ts
type SessionRevision = string | number

type RuntimeSessionEvent =
  | { readonly _tag: 'InputAppended'; readonly message: AgentMessage }
  | { readonly _tag: 'RunStarted'; readonly runId: string }
  | { readonly _tag: 'RunCompleted'; readonly runId: string; readonly messages: ReadonlyArray<AgentMessage> }
  | { readonly _tag: 'RunFailed'; readonly runId: string; readonly error: RuntimeError }
  | { readonly _tag: 'RunInterrupted'; readonly runId: string }
```

The final API may differ, but it must represent these semantics without product-specific fields.

---

## Documentation Requirements

- [ ] Update `packages/agent-runtime/AGENTS.md` persistence semantics.
- [ ] Update `packages/AGENTS.md` runtime section if package boundaries shift.
- [ ] Add README examples for snapshot vs append usage once API stabilizes.
- [ ] Document host-owned storage responsibilities and conflict behavior.

---

## Open Questions

| Question | Owner | Due Date | Status |
| --- | --- | --- | --- |
| Keep `SessionStore` and add `SessionEventStore`, or replace contract? | Package owner | Before implementation | Open |
| Revision type: numeric sequence, opaque token, or both? | Package owner | Before implementation | Open |
| Should runtime persist `AgentEvent` traces separately from transcript events? | Package owner | Before implementation | Open |
| Should active run cleanup be runtime-owned or host-owned? | Package owner | Before implementation | Open |

---

## Appendix

### Glossary

- **Snapshot store:** Current whole-transcript load/save model.
- **Append store:** Ordered event storage model with revision/conflict semantics.
- **Revision:** Store token used to detect stale writes.
- **Run:** One runtime invocation over a transcript/input.

### References

- `.repos/opencode/packages/opencode/src/session/processor.ts`
- `.repos/opencode/packages/opencode/src/session/run-state.ts`
- `.repos/pi/packages/coding-agent/src/core/session-manager.ts`
- `.repos/pi/packages/agent/src/harness/agent-harness.ts`
- `cloudflare/agent/AGENTS.md`
