# Agent Client

`@yolk/client` is the UI/runtime-agnostic client package for consuming streamed agent events and maintaining generic client state. React-specific hooks live in `@yolk/react`.

## Role

- Stream `AgentEvent`s from an app endpoint via Effect `HttpClient`.
- Parse NDJSON/event payloads through protocol schemas.
- Maintain generic client-owned transcript and live run state.
- Expose async-generator compatibility helpers for browser UI code.

## Boundaries

- No React, JSX, CSS, or UI components.
- No app auth chrome, model defaults, Codex/OpenAI specifics, or product permissions.
- No server-side loop execution.
- Transport endpoint shape is generic; app owns concrete route and auth.

## Public model

| Export area | Purpose                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `transport` | Effect stream + async helpers for event transport                      |
| `state`     | Generic transcript, live messages, tool run lifecycle, reducer helpers |

## Design rules

- `AgentTranscript` is client-owned and non-empty when sent to the server.
- Keep `AgentToolRun` as the single source for called/running/completed state.
- Use Effect `HttpClient`; tests inject fake clients instead of raw fetch mocks.
- Keep transport/parse failures typed as `AgentTransportError`.
- `streamAgentEventStream` is the native Effect API; `streamAgentEvents` is async-generator compatibility.
- `StreamAgentEventsRequest.signal` interrupts request/body streams.
- Use protocol messages for replay; app/UI packages may project richer render parts.

## Tests

- Cover NDJSON streaming, abort behavior, parse errors, non-2xx responses, and state transitions.
- Do not depend on a real browser, real network, or app routes.
