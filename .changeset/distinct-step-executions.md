---
'@yolk-sdk/vercel-workflows': minor
'@yolk-sdk/agent': minor
---

Retried and redelivered model steps no longer splice two answers in the client, and a final turn that ran more than once shows the committed answer, when the host tags its model events with `executionId` and clients are on this release (#305). One case stays open (below).

- `@yolk-sdk/vercel-workflows`: `sequenceDurableAgentEvent`, `writeDurableAgentEvent` and `durableAgentEventId` take an optional `executionId`. It is appended to the id (`${streamId}:${turn}:${eventSequence}:${executionId}`) and set as the event's `executionId` field, with the `streamId` beside it; without it both fields are removed from the event and ids are unchanged. A blank or padded `executionId` throws (a defect in `writeDurableAgentEvent`). Every execution of a step starts from the same `eventSequence`, so before, a retried model step (`modelStepRetry`, platform `fn.maxRetries`, queue redelivery) wrote a different answer under the first execution's ids and `eventId` de-dupe showed parts of both.
- `@yolk-sdk/agent`: events have optional `executionId` and `streamId`. `reduceAgentEvents`, `applyAgentEventToChatProjection` and the `useAgentChat` reducer keep the executions they saw (`executions` on their state, typed `AgentExecution`), per run (`streamId`) and turn (`LLMStreamStart.turn`):
  - a newer execution's `LLMStreamStart` removes the older one's provisional output (streaming text, its `AssistantMessage`, tool calls nothing acknowledged, restoring a call whose id it reused) and drops its later events;
  - a start for a turn older than one its run already started, or after the run's terminal event, is dropped with its later events;
  - a later turn, another run, a terminal event, a user message or `AgentStart` settles executions (output kept, later events dropped);
  - at `AgentEnd` and `AgentAwaitingInput`, a final turn that ran more than once shows the committed answer from the event's messages, keeping its tool calls' state;
  - events without `executionId` only discard output still streaming at the next `LLMStreamStart`.
- Hosts must: pass `executionId` unique per execution (for example `${stepId}:${attempt}` from `getStepMetadata()`) on every event the model call produces, `LLMStreamStart` included; leave it off host events (promoted user messages, the terminal event written after the commit; a receipt replay rewrites only that terminal event); upgrade clients and servers together; keep a projection's `executions` with its `seenEventIds` (and reset it per run if events carry no `streamId`).
- Caveats: an older client ignores the fields and shows both executions back to back. Open: a non-final turn whose older execution committed while a newer one streamed keeps the newer answer and its tool calls until reload, though the tool batch ran the older execution's calls ([README, One step, several executions](https://github.com/magoz/yolk-sdk/blob/main/packages/vercel-workflows/README.md#one-step-several-executions)). Tool-batch steps are out of scope: read calls are not ledgered and can rerun with different results under the same ids.
