# PRD: Durable Runtime Append Store

**Date:** 2026-05-12

---

## Problem Statement

### What problem are we solving?

`@yolk/agent-runtime` now supports append-backed sessions, but durable coverage is not complete. The remaining risk is adapter-level confidence: Cloudflare Durable Objects need tests proving multiple turns append and replay correctly, reconnect cleanup records interruptions, and docs stay aligned with the package API. Host apps should not need whole-session snapshot overwrites or ad hoc lifecycle storage.

### Why now?

Reference repo review highlighted durable runtime/session state as the next foundational package gap. The package contract and Cloudflare adapter have moved to `SessionEventStore`; now the task is hardening tests and docs around that latest append-log pattern.

### Who is affected?

- **Primary users:** App/server adapters that run `@yolk/agent-runtime` for persistent agent sessions.
- **Secondary users:** UI clients that need reconnect/resume, history, and consistent run state.

---

## Proposed Solution

### Overview

Use a generic append-oriented runtime storage contract that records session inputs, run lifecycle events, protocol transcript additions, and numeric revisions without tying packages to a database, WebSocket, HTTP, auth, or product model. `Transcript` mode stays client-owned and stateless. `AppendInput` mode replays prior protocol `AgentMessage`s from the append log, appends input/start before loop execution, and appends completion/failure after the run.

---

## End State

When this PRD is complete, the following will be true:

- [x] Runtime persistence can append ordered session events with revision metadata.
- [x] Runtime can reconstruct protocol transcript state from append-store data.
- [x] Runtime can detect conflicting writes instead of silently overwriting sessions.
- [x] Runtime can represent started, completed, failed, and interrupted runs.
- [x] Existing transcript mode remains stateless; append persistence is opt-in via `AppendInput`.
- [x] Package tests cover append, replay, conflict, failure, and interrupted-run helpers.
- [x] Cloudflare tests cover multi-turn append logs and reconnect interruption.
- [x] Docs explain store boundaries, host responsibilities, and README/example status.

---

## Success Metrics

### Quantitative

| Metric                             | Current                   | Target                        | Measurement Method         |
| ---------------------------------- | ------------------------- | ----------------------------- | -------------------------- |
| Snapshot overwrites in append mode | 0 in package/adapter code | Remain 0                      | Runtime + Cloudflare tests |
| Durable replay coverage            | package covered           | Cloudflare multi-turn covered | Package + Cloudflare tests |
| Conflict handling coverage         | package covered           | stale revision rejected       | Package tests              |

### Qualitative

- Host adapters can implement durable sessions without reinterpreting loop internals.
- Runtime storage model is generic enough for Postgres, Durable Objects, KV-like stores, and in-memory tests.

---

## Acceptance Criteria

### Feature: Append Store Contract

- [x] A package-level storage interface supports append-only session events.
- [x] Appended events include session id, run id where applicable, event id/order, and revision information.
- [x] The interface does not depend on app auth, product tenancy, database clients, HTTP, or Cloudflare APIs.
- [x] The in-memory implementation supports deterministic tests.

### Feature: Runtime Replay

- [x] Runtime can load a session transcript by replaying persisted events.
- [x] Replay output is protocol `AgentMessage` values only, not UI render models.
- [x] Replay preserves ordered assistant parts because it stores/replays protocol `AgentMessage` values, including provider tool parts/results and `ToolResult.isError` metadata.
- [x] Unknown/future event variants fail at the Schema boundary unless explicitly versioned later.

### Feature: Run Lifecycle Durability

- [x] Runtime records run start and successful completion.
- [x] Runtime records failure/interruption without persisting fabricated assistant/tool messages.
- [x] Runtime can identify an incomplete active run for host-level cleanup/resume decisions.

### Feature: Conflict Semantics

- [x] Store writes can reject stale expected revisions.
- [x] Runtime maps conflict failures to existing runtime/protocol error paths.
- [x] Concurrent append input mode does not silently drop or overwrite protocol messages.

### Feature: Compatibility

- [x] Existing `runRuntime` transcript mode remains stateless by default.
- [x] Append persistence is opt-in through `AppendInput`; no snapshot store is required for transcript mode.
- [x] Cloudflare smoke adapter uses `SessionEventStore` over Durable Object storage.

---

## Technical Context

### Existing Patterns

- `packages/agent-runtime/src/run-runtime.ts` — coordinates stateless `Transcript` mode and append-backed `AppendInput` mode.
- `packages/agent-runtime/src/session-event-store.ts` — current append-only store contract, replay helpers, incomplete-run helper, and in-memory layer.
- `packages/agent-runtime/AGENTS.md` — documents append/run-event semantics.
- `cloudflare/agent/src/yolk-agent.ts` — thin adapter persists `SessionEventStore` logs in Durable Object storage.
- `packages/protocol/src/message.ts` and `packages/protocol/src/event.ts` — protocol transcript and stream event source of truth.

### Key Files

- `packages/agent-runtime/src/run-runtime.ts` — runtime integration point.
- `packages/agent-runtime/src/session-event-store.ts` — append store contract and helpers.
- `packages/agent-runtime/test/session-event-store.test.ts` — append/replay/conflict/incomplete-run tests.
- `packages/agent-runtime/test/run-runtime.test.ts` — current persistence semantics tests.
- `cloudflare/agent/src/yolk-agent.ts` — downstream smoke adapter to validate portability later.

### System Dependencies

- Effect services/layers for injected storage.
- `@yolk/protocol` message/event schemas for persisted payloads.
- No direct DB, Cloudflare, HTTP, WebSocket, or auth dependency in package code.

### Data Model Changes

The package should define generic data shapes only. Host apps own physical tables/storage.

Expected logical entities:

- **RuntimeSessionEventLog:** session id, current numeric revision, ordered stored events.
- **StoredRuntimeSessionEvent:** event id/order, session id, revision, and runtime event payload.
- **RuntimeSessionEvent:** `InputAppended`, `RunStarted`, `RunCompleted`, `RunFailed`, or `RunInterrupted`.
- **IncompleteRuntimeRun:** latest started run without terminal completion/failure/interruption.

---

## Risks & Mitigations

| Risk                                               | Likelihood | Impact | Mitigation                                                                                         |
| -------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Store contract becomes database-specific           | Medium     | High   | Keep package interface logical; adapters own physical persistence.                                 |
| Event model duplicates protocol events incorrectly | Medium     | High   | Persist protocol messages/events where possible; separate runtime metadata from protocol payload.  |
| Resume semantics become too broad                  | High       | Medium | Define resumability as storage/read model first; transport reconnect/fanout can remain host-owned. |
| Backcompat breaks transcript callers               | Low        | Medium | Keep `Transcript` mode stateless and make append persistence opt-in.                               |
| Partial runs expose fabricated protocol messages   | Medium     | High   | Only persist created protocol messages from loop `AgentEnd`; record partial lifecycle separately.  |

---

## Alternatives Considered

### Alternative 1: Keep snapshot-only store

- **Description:** Continue loading/saving whole protocol transcripts as a single blob.
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

Current package API exposes:

```ts
type SessionRevision = number

type RuntimeSessionEvent =
  | { readonly _tag: 'InputAppended'; readonly message: AgentMessage }
  | { readonly _tag: 'RunStarted'; readonly runId: string }
  | {
      readonly _tag: 'RunCompleted'
      readonly runId: string
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | { readonly _tag: 'RunFailed'; readonly runId: string; readonly error: RuntimeError }
  | { readonly _tag: 'RunInterrupted'; readonly runId: string }
```

These semantics must remain product-free. Physical storage belongs to host adapters.

---

## Documentation Requirements

- [x] Update `packages/agent-runtime/AGENTS.md` persistence semantics.
- [x] Update `packages/AGENTS.md` runtime section if package boundaries shift.
- [x] Add README examples for transcript vs append usage once API stabilizes, or document why README examples remain deferred.
- [x] Document host-owned storage responsibilities and conflict behavior.

---

## Open Questions

| Question                                                                      | Owner         | Due Date   | Status                                                                                                  |
| ----------------------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| Keep `SessionStore` and add `SessionEventStore`, or replace contract?         | Package owner | 2026-05-12 | Resolved: use `SessionEventStore`; no snapshot store in current runtime package.                        |
| Revision type: numeric sequence, opaque token, or both?                       | Package owner | 2026-05-12 | Resolved: numeric `SessionRevision`.                                                                    |
| Should runtime persist `AgentEvent` traces separately from transcript events? | Package owner | 2026-05-12 | Deferred: append store persists lifecycle + protocol messages; traces can be future optional telemetry. |
| Should active run cleanup be runtime-owned or host-owned?                     | Package owner | 2026-05-12 | Resolved: package exposes `latestIncompleteRuntimeRun`; host appends `RunInterrupted`.                  |
| How should append-store replay handle provider-executed assistant tool parts? | Package owner | 2026-05-12 | Resolved direction: replay protocol transcript parts, not UI-local state.                               |

---

## Appendix

### Glossary

- **Transcript mode:** Stateless runtime mode where the caller supplies a complete client-owned protocol transcript.
- **AppendInput mode:** Durable runtime mode where the runtime appends input/run lifecycle events and replays prior protocol messages.
- **Append store:** Ordered event storage model with numeric revision/conflict semantics.
- **Revision:** Numeric store sequence used to detect stale writes.
- **Run:** One runtime invocation over a transcript/input.

### References

- `.repos/opencode/packages/opencode/src/session/processor.ts`
- `.repos/opencode/packages/opencode/src/session/run-state.ts`
- `.repos/pi/packages/coding-agent/src/core/session-manager.ts`
- `.repos/pi/packages/agent/src/harness/agent-harness.ts`
- `cloudflare/agent/AGENTS.md`
