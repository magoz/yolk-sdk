# @yolk-sdk/agent/client

Framework-agnostic client transport and state helpers for Yolk agents.

## What it provides

- Effect stream and async generator helpers for streamed `AgentEvent`s.
- Durable run resume helpers that follow continuation chunks until terminal events.
- Generic client state reducer helpers.
- Non-empty `AgentTranscript` type.
- Tool run lifecycle state.
- HITL response submission helpers for approvals and questions.
- Existing-run HITL resume helpers that POST only `hitlResponses`.
- Typed transport errors; `BlobTextReadError` from the text file/blob helpers.
- Terminal events (`AgentEnd`, `AgentError`, `AgentAwaitingInput`) end consumers while HTTP bodies drain to EOF.
- Durable continuation helpers fail with `AgentTransportError` if a terminal event is not reached.
- HITL resume tail headers describe the stream tail before the returned body.
- `continuationLimit: 0` makes non-terminal responses fail without follow-up requests.
- Durable helpers do not own route auth, run ownership, Workflow hook tokens, or HITL request matching.
- A request id alone does not say which pause an answer is for: pass the pause as `pause` to the
  HITL resume helpers (the `eventId` of the latest `AgentAwaitingInput` that asked). They send it
  as `?pause=<eventId>` on the POST only; continuation reads use `endpoint` as given. Track it with
  `rememberHitlPause` (fold every event of every stream that reads the run: start, HITL resume,
  replay) and read it with `hitlPauseFor` (below). A blank `pause` fails before the POST.

## Name the pause an answer is for

`HitlPauses` (an Effect Schema: request id -> pause id) is pure, immutable state. `useAgentChat`
keeps one for you (`state.hitlPauses`, passed to your transport as `request.pause`); without React:

```ts
import { Effect, Stream } from 'effect'
import {
  emptyHitlPauses,
  hitlPauseFor,
  rememberHitlPause,
  streamAgentRunHitlResponseEventStreamUntilTerminal
} from '@yolk-sdk/agent/client'
import type { AgentEvent, HitlResponse } from '@yolk-sdk/agent/protocol'

let pauses = emptyHitlPauses

// Every event you read from the run (start, HITL resume, replay), in stream order.
const remember = (event: AgentEvent) =>
  Effect.sync(() => {
    pauses = rememberHitlPause(pauses, event)
  })

const answer = (runId: string, response: HitlResponse) =>
  streamAgentRunHitlResponseEventStreamUntilTerminal({
    endpoint: `/api/agent/workflow/${encodeURIComponent(runId)}`,
    hitlResponses: [response],
    pause: hitlPauseFor(pauses, response)
  }).pipe(Stream.tap(remember))
```

The latest pause wins per request: a request that pends again (after an invalid answer, or a
provider reusing a call id in a later turn) moves to its new pause. A replay from an earlier index
applies the later pauses again, so it still ends at the latest. A pause without an `eventId` names
nothing: its requests forget the earlier pause, and their answers name none (the route refuses
them rather than taking them for a stale pause). Start from `emptyHitlPauses` for each new run.

## Use it when

- A browser, CLI, or other client needs to consume agent events from an app endpoint.
- You need protocol state without React hooks or UI components.

## Boundaries

- No React.
- No UI components.
- No auth chrome, provider defaults, or app routes.
- HTTP helpers are runtime-portable when the host provides an Effect `HttpClient` layer.
- `documentPartFromTextFile`/`textFromBlob` require `File`/`Blob`; the fallback reader requires
  `FileReader`.
- Cloudflare WebSocket transport requires the global `WebSocket` constructor when its stream runs.
- Browser globals are not read at module import time.
- Pre-terminal cancellation aborts active response body readers; terminal draining does not.
