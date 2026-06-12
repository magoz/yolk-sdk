# @yolk-sdk/agent/client

Framework-agnostic client transport and state helpers for Yolk agents.

## What it provides

- Effect stream and async generator helpers for streamed `AgentEvent`s.
- Generic client state reducer helpers.
- Non-empty `AgentTranscript` type.
- Tool run lifecycle state.
- HITL response submission helpers for approvals and questions.
- Typed transport errors.
- Terminal events (`AgentEnd`, `AgentError`, `AgentAwaitingInput`) end consumers while HTTP bodies drain to EOF.

## Use it when

- A browser, CLI, or other client needs to consume agent events from an app endpoint.
- You need protocol state without React hooks or UI components.

## Boundaries

- No React.
- No UI components.
- No auth chrome, provider defaults, or app routes.
- Pre-terminal cancellation aborts active response body readers; terminal draining does not.
