---
'@yolk-sdk/vercel-workflows': minor
'@yolk-sdk/agent': minor
---

Retried and redelivered model steps no longer splice two answers in the client (#305).

- `@yolk-sdk/vercel-workflows`: `sequenceDurableAgentEvent`, `writeDurableAgentEvent` and `durableAgentEventId` take an optional `executionId`, appended as the id's last part (`${streamId}:${turn}:${eventSequence}:${executionId}`). Every execution of a step starts from the same `eventSequence`, so a retried model step (`modelStepRetry`, platform `fn.maxRetries`, queue redelivery) wrote a different answer under the first execution's ids and a client de-duping by `eventId` showed the first execution's early deltas plus the second's tail. Pass one unique per execution (for example `${stepId}:${attempt}` from `getStepMetadata()`) on a model step's live events; omit it on events every execution writes identically (the terminal event written after the commit, receipt replays). Without it ids are unchanged. The README no longer presents `eventId` de-dupe as making streamed retries safe.
- `@yolk-sdk/agent`: `LLMStreamStart` discards output still streaming from a superseded execution: `reduceAgentEvents` clears `text`, `reasoning` and `InputStreaming` tool runs, and the chat projection drops the tail assistant message's streaming text, reasoning and input-streaming tool parts. A model response ends with its `AssistantMessage`, so settled output is never touched.
