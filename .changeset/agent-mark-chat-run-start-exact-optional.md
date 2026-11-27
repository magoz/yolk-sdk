---
'@yolk-sdk/agent': patch
---

`markChatRunStart` (`@yolk-sdk/agent/chat`, `@yolk-sdk/agent/react`) takes an `AgentChatEventProjectionState` or an `AgentChatState` under `exactOptionalPropertyTypes`. Its input type now allows `turnStart?: AgentChatTurnStart | undefined`, which the chat Schemas give, so hosts no longer copy the start over from a call on the messages alone.
