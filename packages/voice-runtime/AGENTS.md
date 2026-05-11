# Voice Runtime

`@yolk/voice-runtime` bridges provider-normalized realtime voice tool calls to the generic `ToolExecutor`. Provider/WebRTC details stay in app adapters.

## Role

- Accept normalized voice tool call requests.
- Decode string JSON arguments at the runtime boundary.
- Execute through `ToolExecutor`.
- Encode provider-safe JSON string outputs for realtime tool responses.
- Truncate long string outputs to keep realtime sessions responsive.

## Boundaries

- No OpenAI Realtime SDK, WebRTC, microphone, auth, or app route code.
- No app tool catalogs; execution is injected through `ToolExecutor`.
- No UI or browser lifecycle code.
- Provider adapters convert this package's result envelope to provider-specific events.

## Public model

| Export area   | Purpose                                              |
| ------------- | ---------------------------------------------------- |
| `tool-bridge` | Voice tool request/result types and execution bridge |

## Design rules

- Decode and encode JSON via Effect Schema boundaries.
- Return a string envelope: `{ result }` or `{ error }`.
- Preserve provider call ids exactly.
- Keep failures user-safe and typed; do not leak secrets through errors.

## Tests

- Cover successful tool execution, invalid arguments, executor failure, and truncation behavior.
- Use `TestToolExecutor`; no realtime provider dependencies.
