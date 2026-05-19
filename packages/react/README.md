# @yolk-sdk/react

Headless React primitives for building custom agent chat UIs.

## Install

```bash
pnpm add @yolk-sdk/react@canary @yolk-sdk/agent@canary effect react
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

```tsx
import { useAgentChat, buildAgentChatItems } from '@yolk-sdk/react'
import { Option } from 'effect'

export function Chat() {
  const chat = useAgentChat({ sessionId: 'demo' })
  const items = buildAgentChatItems({
    messages: chat.chatMessages,
    isRunning: chat.isRunning,
    activeToolLabel: Option.none()
  })

  return <MyChat items={items} onSubmit={chat.submitText} onStop={chat.stop} />
}
```

No UI components, styling, auth, or provider config are included. Host apps own all rendering and policy.

## Core API

```ts
const chat = useAgentChat({
  sessionId: 'thread_123',
  endpoint: '/api/agent'
})

chat.chatMessages // render source of truth
chat.messages // protocol replay derived from chatMessages
chat.submitText('Hello')
chat.stop()
```

Useful fields/actions:

| API | Purpose |
| --- | --- |
| `chat.chatMessages` | Render source of truth |
| `chat.messages` | Protocol transcript replay |
| `chat.submitText` / `submitMessage` | Append user message and start run |
| `chat.stop` | Interrupt active stream fiber |
| `chat.deleteTurn` | Remove a user/assistant turn locally |
| `chat.regenerateFrom` | Truncate and rerun from a message |
| `chat.editUserMessage` | Replace user content, truncate later turns, rerun |

## Custom transport

```ts
const chat = useAgentChat({
  sessionId: 'thread_123',
  transport: request => myAgentEventStream(request)
})
```

The transport must yield `AgentEvent`s and accept a protocol transcript in `request.messages`.

## Rendering model

- `AgentChatMessage` groups parts by role/turn.
- `AgentChatPart` covers text, reasoning, tool calls/results, and errors.
- `buildAgentChatItems` is optional convenience projection for simple flat UIs.
- Provider reasoning is displayed only from protocol reasoning events; never fabricate reasoning.

## Package layering

- Use `@yolk-sdk/agent/client` for framework-agnostic transport/state, including CLI clients.
- Use `@yolk-sdk/react` for React apps that need headless chat state.
- Keep host-specific UI, auth, providers, and tools in the app.

## Tests

Hook tests cover custom transport submission, streamed event application, ignored empty submits, and abort handling. Chat model tests cover protocol replay, tool anchoring, timing preservation, and render item projection.
