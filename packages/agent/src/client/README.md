# @yolk-sdk/agent/client

Framework-agnostic client transport and state helpers for Yolk agents.

## What it provides

- Effect stream and async generator helpers for streamed `AgentEvent`s.
- Durable run resume helpers that follow continuation chunks until terminal events.
- Generic client state reducer helpers.
- Non-empty `AgentTranscript` type.
- Tool run lifecycle state.
- HITL response submission helpers for approvals and questions.
- Existing-run HITL resume helpers that POST only `hitlResponses`.
- Typed transport errors.
- Terminal events (`AgentEnd`, `AgentError`, `AgentAwaitingInput`) end consumers while HTTP bodies drain to EOF.
- Durable continuation helpers fail with `AgentTransportError` if a terminal event is not reached.
- HITL resume tail headers describe the stream tail before the returned body.
- `continuationLimit: 0` makes non-terminal responses fail without follow-up requests.
- Durable helpers do not own route auth, run ownership, Workflow hook tokens, or HITL request matching.

## Use it when

- A browser, CLI, or other client needs to consume agent events from an app endpoint.
- You need protocol state without React hooks or UI components.

## Boundaries

- No React.
- No UI components.
- No auth chrome, provider defaults, or app routes.
- HTTP helpers are runtime-portable when the host provides an Effect `HttpClient` layer.
- `documentPartFromTextFile`/`textFromBlob` require `File`/`Blob`; the fallback reader requires
  `FileReader`.
- Cloudflare WebSocket transport requires the global `WebSocket` constructor when its stream runs.
- Browser globals are not read at module import time.
- Pre-terminal cancellation aborts active response body readers; terminal draining does not.
