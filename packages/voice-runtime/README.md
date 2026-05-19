# @yolk-sdk/voice-runtime

Provider-neutral bridge from realtime voice tool calls to Yolk tool execution.

## What it provides

- Normalized voice tool call request/result types.
- `executeVoiceToolCall` for running calls through `ToolExecutor`.
- JSON string result envelope for realtime provider adapters.
- Typed voice bridge errors.

## Use it when

- A realtime provider adapter receives a tool call and needs to execute it through Yolk tools.

## Boundaries

- No WebRTC or microphone code.
- No OpenAI Realtime SDK imports.
- No app tool catalogs.
