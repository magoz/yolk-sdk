---
'@yolk-sdk/vercel-workflows': patch
---

The "Awaiting input" docs now say that an answer names the pause it is for (#334). A request id alone is ambiguous: a request pends again under the same id after an invalid answer, and approval request ids (`approval:${call.id}`) repeat when a provider reuses a call id, so a late retry could fill a later pause or a new answer be taken for an old one. Give each pause an id the client sees, the `eventId` its `AgentAwaitingInput` gets (`durableAgentEventId`), stored with the pause before the event is written; the client sends it with the answer (for example `?pause=<eventId>` on the endpoint it passes to `streamAgentRunHitlResponseEventStreamUntilTerminal`), and the resume route matches strictly by it. Keep a bounded history of delivered pauses so an identical retry is reported as delivered; refuse an answer naming no pause, or an unknown or evicted one, and never record it for the current pause.
