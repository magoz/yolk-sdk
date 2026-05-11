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
