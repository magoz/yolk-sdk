# @yolk/react

Headless React primitives for building custom agent chat UIs.

```tsx
import { useAgentChat, buildAgentChatItems } from '@yolk/react'
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

## Custom transport

```ts
const chat = useAgentChat({
  sessionId: 'thread_123',
  transport: request => myAgentEventStream(request)
})
```

The transport must yield `AgentEvent`s and accept a protocol transcript in `request.messages`.

## Package layering

- Use `@yolk/client` for framework-agnostic transport/state, including CLI clients.
- Use `@yolk/react` for React apps that need headless chat state.
- Keep host-specific UI, auth, providers, and tools in the app.
