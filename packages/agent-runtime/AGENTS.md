# Agent Runtime

`@yolk/agent-runtime` adds generic server lifecycle orchestration around `@yolk/agent-loop`. It is domain-free and storage-provider-neutral.

## Role

- Run the stateless loop from either a client-owned transcript or a server-owned session input.
- Load previous session transcript from `SessionStore` for durable input mode.
- Persist updated session state after successful loop completion when requested/required.
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
| `RuntimeRequest`    | Transcript or input mode request union          |
| `RuntimeTranscript` | Non-empty protocol transcript                   |
| `session-store`     | Storage interface for transcripts/session state |
| `error`             | Runtime-specific typed errors                   |
| `RuntimeSessionId`  | Opaque session id alias                         |

## Request modes

- `Transcript`: host/client provides a non-empty protocol transcript. Runtime runs exactly those messages. It does not load session state. It persists only when `persist: true`.
- `Input`: host/client provides latest input. Runtime loads the session transcript, appends input, runs loop, then saves the updated transcript.

## Persistence semantics

- Transcript mode defaults to stateless to match client-owned transcript flows.
- Transcript mode with `persist: true` saves `{ provided messages + created messages }` under `sessionId` after successful stream completion.
- Input mode persists `{ loaded messages + input + created messages }` after successful stream completion.
- Failed/interrupted streams do not save partial snapshots.
- Created messages come from `AgentEnd.messages`; runtime does not infer/fabricate assistant or tool messages from partial events.
- Current store API is snapshot-based. Add append/revision semantics before building concurrent durable sessions.

## Design rules

- Treat session ids as opaque strings.
- Keep loop behavior in `@yolk/agent-loop`; runtime only coordinates lifecycle.
- Map runtime/store errors to protocol `AgentError` via `runtimeErrorToAgentError`; do not duplicate mapping in adapters.
- Persist protocol transcript/state, not app render models.
- Do not encode HTTP, NDJSON, SSE, WebSockets, auth, provider choice, or tool policy here.
- Keep resume/fanout adapters outside this package until generic enough.
- Future durable behavior should prefer append/run-event semantics over whole-snapshot overwrite.

## Tests

- Test with fake stores and fake loop/provider layers.
- Cover transcript mode with and without persistence.
- Cover input mode load + append + save behavior.
- Cover config pass-through for reasoning/capabilities.
- Cover store/runtime error mapping when adding new runtime errors.
