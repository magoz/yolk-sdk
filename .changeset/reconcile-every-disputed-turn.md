---
'@yolk-sdk/agent': minor
---

Clients show the committed answer for every turn of a run that ran more than once, not only the final one (#322). When a non-final turn's older execution committed while a newer one streamed, `reduceAgentEvents`, `applyAgentEventToChatProjection` and the `useAgentChat` reducer kept the newer answer and its tool calls until reload, beside the calls the tool batch actually ran. At `AgentEnd` and `AgentAwaitingInput` they now replace it with the committed assistant message from the event's `messages` (the one an execution of that turn streamed, found by value), at the turn's place in the chat, keeping each committed call's state; the uncommitted execution's calls no host event acted on are removed (from `toolRuns` too). A turn already showing the committed answer is unchanged. Until that event, the newer answer stays shown.

- `AgentExecution` has an optional `answer` (its `AssistantMessage`); the shown execution of a turn that ran more than once keeps `calls`, `output` and `answer` after it settles, and a superseded one keeps `answer`, until its run's terminal event.
- `AgentChatExecutionOutput` has a new `After` variant (where an execution's turn starts in the chat); exhaustive matches on it need a case.
- An `AssistantMessage` no longer deletes a tool part a host event acted on (running, completed, pending approval or question) that it does not name: a tool batch that ran another execution's call while this one streamed placed it in its message.
