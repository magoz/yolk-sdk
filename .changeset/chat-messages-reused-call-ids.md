---
'@yolk-sdk/agent': patch
---

`buildAgentChatMessages` no longer gives one tool run to every card with its call id, across turns (#356). `toolRuns` can hold one run per turn for a reused id (`reduceAgentEvents`), and snapshot hosts pass runs of several turns (pending requests from `toolRunsFromHitlRequests`, accepted interaction receipts); the last run by id used to show on every card with the id, so an earlier turn's accepted interaction and a later turn's pending approval on `call_0` both showed the approval (or, in the other order, the actionable card was hidden).

- Each run goes to one card: the last card holding the same call the run holds (its own call, or its request's; id, name and arguments equal); a run holding no call (an input still streaming, an answer or denial without its request) goes to the last card with its id that no run took, as before for a single card. Later runs choose first and each card takes at most one run, so one run per turn of the same call lands on its own turn. A run holding a call no card holds (another turn's call, not in `messages` yet) shows nowhere; before, it showed on the last card with the id.
- A `ToolResult` message now belongs to the last card with its id before it: a later turn's call reusing the id no longer shows an earlier turn's result (or its background acceptance, which hid the later call's pending request), and an earlier call no longer shows a later turn's result.
