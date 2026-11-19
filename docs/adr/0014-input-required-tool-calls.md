# Input-required tool calls

Status: accepted.

Builds on [ADR 0001](0001-action-backed-interactions.md) (interactions) and
[ADR 0005](0005-staged-tool-plans.md) (staged plans); extends the MCP client's durable form
elicitation (multi round-trip requests, protocol `2026-07-28`) to agent sessions and to Yolk's MCP
server.

A remote tool may need a person's input after it was called: an MCP server answers a `tools/call`
with an `InputRequiredResult` holding a form (a confirmation before a delete) and a `requestState`,
and finishes only when the client sends the call again with the answer. Yolk's agent loop asks
people only **before** a tool batch runs: a tool's `execute` returns a result or a `ToolError`,
never a pause (ADR 0005, "Why a separate review call"). Hosts that never declared form elicitation
got `CLIENT_CAPABILITY_REQUIRED` and could not run such tools at all.

## Decision summary

| Area        | Decision                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paused call | The tool stores the pause host-side and returns `makeInputRequiredToolResult`: an error result with `{ code: 'input_required', inputRequired }`. |
| Marker      | `inputRequired = { reviewToolName, pauseIds }` (`ToolInputRequiredRef`). The call is over: the ledger records it and it never runs again.        |
| Finishing   | A separate input review interaction (`makeInputReviewTool`, default `review_input({ pauseIds })`) shows the stored forms and resumes each pause. |
| Code mode   | The nested call rejects with `error.code === 'input_required'`; `structuredContent.codemode.inputRequired` lists every pause, caught or not.     |
| Plan apply  | New per-call status `input_required` (with its ref); it never stops the apply under `onFailure: 'stop'`.                                         |
| Storage     | Host port `InputReviewHost` (`load`, `validateAnswer`, `resume`, `recorded`); the SDK stores nothing.                                            |
| Once-only   | The host claims each pause before resuming it; a claimed pause is never sent again (a crash leaves it `unknown`).                                |
| MCP server  | `McpServerForwardingTool` forwards a remote pause to the server's own client under a signed, stateless forward state.                            |

## Why a marker on an error result

Every consumer of error results already treats one as "did not complete": output checks skip it
(`decodeOutput` is never applied to `isError`), the tool ledger records and replays it, code mode
rejects the nested call with the structured `code`, and plan apply counts it. A new `ToolResult`
field would have to be threaded through the protocol class, the ledger's stored copy, durable
bounding, transcripts and React. The marker needs two small changes (plan status and code mode
reporting) and stays plain JSON.

Every replay (a redelivered step, an interrupted plan apply's listing, code mode's abandoned-script
listing) reads the ledger's stored copy, so the ledger's bounding (`toolLedgerResult`) keeps the
pause refs of two kinds of results through every reduction, the way it keeps `files`. Over
`maxResultBytes`, other `structuredContent` fields are dropped and the text is cut before the review
text, never the review text itself (rebuilt from the kept refs when the text does not end with it):

- An input-required error result keeps its marker `{ code, inputRequired }` and its review call
  (`inputRequiredInstruction`).
- A code mode result keeps `{ codemode: { ok, inputRequired } }` and its notice
  (`inputRequiredNotice`).

Other results' pause refs are not kept. A plan apply's stored outcome (its fence entry) is reduced
like any result; over the bound its replay lists the applied calls' own ledger entries instead,
which keep their markers (a call the ledger policy skips has no entry and is listed `unknown`).
The kept refs and review text are never cut, so a result naming many pauses can be stored over
`maxResultBytes`.

Because the marker is plain JSON, a remote system must not be able to forge it: Yolk's MCP client
keeps a remote error result's structured content that decodes as the marker under
`remoteStructuredContent` (`toolCallResultToToolResult`), so a server's own failure never reads as
a paused call (which plan apply would not stop on). Hosts adapting other remote error results do
the same.

## Input review

`makeInputReviewTool` is an interaction registration (renderer `input_review`, one action
`submit`, params `{ pauseIds }` (at most `maxInputReviewPauses`, no repeats), response
`{ answers: Record<pauseId, Json> }`):

- **Call validation** loads the pauses through the host: present in its scope (a session), still
  waiting. The model passes only ids; it can never open a review of a pause it made up, and the
  host renders forms only from stored pauses. A storage outage is an `InteractionHostError`, never
  a verdict.
- **Admission** requires exactly one answer per listed pause and checks each with
  `validateAnswer` (for MCP, the form's restricted JSON Schema), so an invalid answer is never
  accepted and consumes nothing.
- **The action** resumes the pauses in review order. `resume` claims the pause for the submission
  before sending and records the resolution: `Completed` (the remote result, even an error result),
  `InputRequired` (asked again: the new pauses), `NotSent` (refused before sending, for example the
  target changed), or `Unknown` (it may have run). The result lists every pause with its status and
  each completed call's own result content (files included), then the review call for new pauses.
  The interaction outcome is `unknown` when any pause is unknown, `failed` when none was sent, else
  `completed`.
- **Interrupted reviews** (a crash after the claim, or a redelivered step finding the receipt
  started) list what the host recorded (`recorded`); only a replay where every pause has a
  recorded resolution reports a proven outcome. Nothing is sent again.
- **Cancel** sends nothing; the pauses stay reviewable.

The original call stays input-required in the transcript; the review result is its completion.
A script that needed the value continues in a new script from the review result, never by calling
the remote tool again.

## MCP server forwarding

A tool of `makeMcpToolServer` that proxies a remote tool (`forward: true`, optional `approval`)
runs one round per request:

- `Initial`: call the remote tool. `clientElicitation` is true only on a `2026-07-28` request that
  declares form elicitation, with approvals configured; the host opts the remote call into
  elicitation only then, so a remote server that needs input refuses to run instead of pausing a
  call nobody can answer.
- A remote pause is forwarded as this server's own `InputRequiredResult` (the remote forms under
  their keys) with a `requestState` signed by the approvals key under its own binding (server name,
  principal, method, forward purpose) that holds the tool, the arguments digest, the remote pause's
  `roundId` and expiry (`ttlSeconds` after it was first forwarded), the approval id (when the tool
  asked its own approval first) and the remote pause. It is bounded (`mcpForwardMaxStateBytes`). It
  is signed, not encrypted: the client can read the remote forms and the remote `requestState`.
- `Resume`: only a round whose verified, unexpired state matches the call and answers every
  forwarded form (checked against the forms) resumes the remote call. A round that misses an answer
  is asked the same forms again in the same round (same `roundId` and expiry), so asking again
  never opens a second resume of one remote pause nor keeps it alive. A state that does not verify
  answers `forwardStaleMessage`, sending nothing; on a tool with `approval` it is no approval answer
  either, so the approval is asked again (and an accept starts a new remote call, as a fresh call
  would). Once-only is the host's: key it on `roundId`.
- The header-less JSON path and 2025-era requests run only the first round.

## Rejected alternatives

- **Native loop suspension** (a tool's `execute` returns a suspension that becomes an interaction
  request on the same call): nicer for direct calls, but a deep loop change, and scripts and plan
  apply still could not pause (ADR 0005's rejected post-execution pause).
- **A new `ToolResult` field**: see "Why a marker".
- **Signed pause tokens in the result instead of host storage**: pauses can be large (the MCP client
  bounds them at 256 KiB) and would enter the model's context, and single-use would still need a
  claim table.
- **Answering a remote form automatically after the host's own approval**: the remote form is the
  remote server's consent request; answering it unseen defeats it.

## Tests

`packages/agent/test/tools/input-review.test.ts` (marker helpers, call validation against stored
pauses and outages, admission, resume and new pauses, a refused review, crash listing),
`packages/agent/test/tools/plan.test.ts` (`input_required` status, apply continuing past it,
interrupted listing, older outcomes decoding, an apply outcome over the ledger bound),
`packages/agent/test/tools/ledger.test.ts` (a stored copy over the bound keeps the marker and the
review call), `packages/codemode/test/ledger.test.ts` (a replayed script over the bound keeps its
pauses and notice), `packages/codemode/test/pi-executor.test.ts` (caught pauses still reported),
`packages/mcp/test/server/forward.test.ts` (forward and resume through the real resumable client,
cancel, clients without form elicitation, no approvals, approval first, stale state, the JSON
path).
