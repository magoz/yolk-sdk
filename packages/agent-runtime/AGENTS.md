# Agent Runtime

`@yolk/agent-runtime` adds generic server lifecycle orchestration around `@yolk/agent-loop`. It is domain-free and storage-provider-neutral.

## Role

- Run the stateless loop from a client-owned transcript or append-backed session input.
- Replay previous transcript from `SessionEventStore` for append-backed input mode.
- Persist run lifecycle via append-only events.
- Thread runtime config through to `@yolk/agent-loop` (`model`, `systemPrompt`, `tools`, `reasoningEffort`, `capabilities`).
- Expose runtime errors separately from loop/provider errors and map them to protocol `AgentError` at adapter boundaries.

## Boundaries

- No concrete database, auth, HTTP, WebSocket, or app route code.
- No provider SDKs or app tool catalogs.
- No product assumptions about users, orgs, projects, billing, or permissions.
- Persistence is an injected interface; app/services own implementation and tenancy.

## Public model

| Export area         | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `run-runtime`       | Server orchestration entrypoint                 |
| `RuntimeConfig`     | Loop config passed through by host apps         |
| `RuntimeRequest`    | `Transcript` or `AppendInput` request union     |
| `RuntimeTranscript` | Non-empty protocol transcript                   |
| `session-event-store` | Append-only event storage contract, replay/append/incomplete-run helpers, in-memory tests |
| `error`             | Runtime-specific typed errors                   |
| `RuntimeSessionId`  | Opaque session id alias                         |

## Request modes

- `Transcript`: host/client provides a non-empty protocol transcript. Runtime runs exactly those messages. It does not load or persist session state.
- `AppendInput`: host/client provides latest input + run id. Runtime replays `SessionEventStore`, appends input/start, runs loop, then appends completion/failure.

## Persistence semantics

- Transcript mode is stateless to match client-owned transcript flows.
- AppendInput persists `InputAppended` + `RunStarted` before loop execution.
- AppendInput appends `RunCompleted` after success and `RunFailed` after loop failure.
- Created messages come from `AgentEnd.messages`; runtime does not infer/fabricate assistant or tool messages from partial events.
- Append replay derives protocol transcript from `InputAppended` and `RunCompleted` only.
- Failed/interrupted runs are durable lifecycle metadata; they do not add transcript messages.
- Append mode uses `expectedRevision` for conflict detection; omit only when host accepts latest loaded revision.
- Use `appendRuntimeSessionEventsToLog` in host stores to keep revision/id generation consistent.
- Use `latestIncompleteRuntimeRun` for reconnect/cleanup; append `RunInterrupted` instead of fabricating transcript messages.
- Runtime events (`InputAppended`, `RunStarted`, `RunCompleted`, `RunFailed`, `RunInterrupted`) are durable server append-log events, distinct from `@yolk/react` UI edit events.

## Design rules

- Treat session ids as opaque strings.
- Keep loop behavior in `@yolk/agent-loop`; runtime only coordinates lifecycle.
- Map runtime/store errors to protocol `AgentError` via `runtimeErrorToAgentError`; do not duplicate mapping in adapters.
- Persist protocol transcript/state, not app render models.
- Use Effect `Ref` for stream-owned completion state; avoid mutable arrays/objects in runtime streams.
- Use Effect nullish helpers at boundaries instead of manual `undefined` branching.
- Do not encode HTTP, NDJSON, SSE, WebSockets, auth, provider choice, or tool policy here.
- There is no current Effect Platform dependency; add platform services only when runtime owns generic IO.
- Keep resume/fanout adapters outside this package until generic enough.
- Durable behavior uses append/run-event semantics, not whole-snapshot overwrite.
- Append store revisions are numeric and conflict on stale `expectedRevision`.
- Incomplete-run detection scans event logs only; host adapters decide when to cleanup/resume.

## Tests

- Test with fake stores and fake loop/provider layers.
- Cover stateless transcript mode.
- Cover append input replay, completion, failure, and conflict behavior.
- Cover config pass-through for reasoning/capabilities.
- Cover store/runtime error mapping when adding new runtime errors.
- Cover append replay, revision conflicts, failed runs, and interrupted runs when changing `session-event-store.ts`.
