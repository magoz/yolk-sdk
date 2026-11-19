---
'@yolk-sdk/agent': patch
---

Chat projections no longer let a later turn's tool call overwrite an earlier turn's call when a provider reuses the call id across turns (#335). `applyAgentEventToChatProjection` and the `useAgentChat` reducer matched a tool event's call by id in the last message holding it, even an earlier turn's, so (for example) turn 1's completed `call_0` became turn 3's `Called` call, with or without `executionId`.

- Both chat states record where the latest model turn starts (`turnStart`, new `AgentChatTurnStart` type), at each `LLMStreamStart`, tagged or not (an untagged retry of the latest turn keeps its start; `AgentStart` and the chat reducer's local submit, HITL answer, regenerate and edit clear it). A turn's tool events (input, its `AssistantMessage`'s calls, provider results, the tool batch, approvals, questions and answers) match and place a call only after it: an execution's own turn start for its events, the latest turn's for host events, which keep finding the call they act on across a pause and resume. Carry `turnStart` with `seenEventIds` when you keep projection state yourself.
- A later turn's call no longer joins an earlier turn's message, and a later turn's `AssistantMessage` no longer replaces it; question, input, interaction and approval-denied answers update the one call they answer, not every part with its id.
- Before a start is seen, after `AgentStart`, and always in `applyAgentEventToChatMessages`, tool events match the last message holding the call, as before.
- Reconciling a turn that ran more than once: without its anchor, the turn starts after the user message before its first message (a steer after the turn no longer keeps both answers); without `Until`, a later turn's start the chat saw without `executionId` ends it; restoring a message the discarded execution replaced keeps the parts the tool batch updated since.
- `reduceAgentEvents` is unchanged: it keeps one tool run per call id (the latest turn's) and takes a later call reusing the id of an accepted call for a replay of it.
