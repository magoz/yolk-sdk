# @yolk-sdk/voice-runtime

Provider-neutral bridge from realtime voice tool calls to Yolk tool execution.

## Install

```bash
pnpm add @yolk-sdk/voice-runtime@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## What it provides

- Normalized voice tool call request/result types.
- `executeVoiceToolCall` for running calls through `ToolExecutor`.
- JSON string result envelope for realtime provider adapters.
- Typed voice bridge errors.

## Example

```ts
import { Effect } from 'effect'
import { executeVoiceToolCall } from '@yolk-sdk/voice-runtime'

const result = executeVoiceToolCall({
  callId: 'call_1',
  name: 'search',
  arguments: '{"query":"hello"}'
})

// Host provides ToolExecutor.
Effect.runPromise(result)
```

Output is a provider-safe JSON string envelope:

```json
{ "result": { "content": [{ "type": "text", "text": "..." }] } }
```

Failures use:

```json
{ "error": "..." }
```

## Use it when

- A realtime provider adapter receives a tool call and needs to execute it through Yolk tools.

## Host responsibilities

- Normalize provider tool-call events into this package's request shape.
- Provide `ToolExecutor` and app tool policy.
- Convert the JSON string envelope into provider-specific realtime responses.

## Boundaries

- No WebRTC or microphone code.
- No OpenAI Realtime SDK imports.
- No app tool catalogs.
- Provider adapters convert this package's result into provider-specific realtime events.
