---
'@yolk-sdk/agent': minor
---

Add `stepAgentChatProjection` and `AgentChatProjectionStep` (`@yolk-sdk/agent/react`) for hosts that fold a run's status beside the chat projection (#351). It applies an event as `applyAgentEventToChatProjection` does and returns `{ projection, statusEvent }`: `statusEvent` is the event the `useAgentChat` reducer's status follows, so a host folding it with `nextAgentStatus` or `agentStatusFromEvents` gets the same status. A replayed `AgentAwaitingInput` whose every request names a call already answered, cancelled, denied or finished gives `undefined` (the status stays instead of showing `Blocked` with no card to answer), and a pause naming some such calls comes back with only its pending requests, read in the turn the event acted in; an event seen before, an event of a superseded, settled or stale model step, and a replayed start of a finished call also give `undefined`. The `useAgentChat` reducer now folds its status from the same step.
