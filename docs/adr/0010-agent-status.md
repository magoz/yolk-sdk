# Agent status

Status: accepted.

Hosts derived "what is this run doing" from loose columns and string flags: an active-run lease
for "running", a stored list of awaiting HITL requests for "waiting", a last outcome for done or
failed. Session lists showed only Running/Idle, so a run that needed a person looked like it was
running or idle. Push notifications mapped `awaiting_input`/`run_finished`/`run_failed` by hand.
Task boards kept one `in_progress` status for both "working" and "waiting on a person", and a
lease that outlived its run left a task "In progress" forever. The SDK's own `AgentRunStatus`
(`idle | running | waiting | done | error | aborted`) existed only in the live browser stream and
said neither what a waiting run needs nor what a running run is doing.

The [OSC 7501 Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)
solves the same problem for terminals: the program reports `idle`, `working`, `done`, `blocked`
(with `kind` `permission`, `question`, or `auth`), or `error`; records nest by id; working and
blocked records only live as long as the process; and presentation belongs to the terminal. Yolk
adopts that vocabulary and its rules for agent runs. It does not adopt the wire format: Yolk has no
terminal surface, and hosts that ship one can encode a status themselves.

## Decision summary

| Area         | Decision                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract     | `AgentStatus` Effect Schemas in protocol: `Idle`, `Working{activity}`, `Blocked{kind, requests}`, `Done`, `Failed{message, error?}`                |
| Activity     | `Busy`, `Generating`, `Tools{calls}`, `Compacting{strategy}`, `Retrying{retry}`                                                                    |
| Kinds        | Exactly OSC 7501's `permission`, `question`, `auth`; approvals and interactions are `permission`, questions and inputs `question`, `auth` reserved |
| Mixed batch  | One kind per pause: `auth` over `permission` over `question`; each request keeps its own kind                                                      |
| Cancel       | A person's cancel is `Idle` (OSC 7501); `system` and `max_turns` aborts are `Failed`                                                               |
| Live         | `nextAgentStatus(status, event)`, the single event → status mapping                                                                                |
| Stored       | Hosts persist the encoded status; `reconcileAgentStatus(stored, { runActive })` drops live statuses of dead runs                                   |
| Subagents    | `AgentStatusTree` = root + one entry per subagent; background entries are host-owned                                                               |
| Client/React | `status: AgentStatus` and `subagents` replace `AgentRunStatus`, `error`, `errorInfo`, `retryInfo`                                                  |
| Host-owned   | Seen/unread, labels, notifications and their rate limits, run liveness, terminal output                                                            |

## Mapping

| Event                                                      | Status                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AgentStart`, `TurnStart`                                  | `Working(Busy)`                                                        |
| `LLMStreamStart` / `LLMStreamEnd`                          | `Working(Generating)` / `Busy`                                         |
| `ToolExecutionStarted` / `Completed`, `Accepted`, `Error`  | add / remove a running call in `Tools`                                 |
| `CompactionStart` / `CompactionEnd`                        | `Working(Compacting)` / `Busy`                                         |
| `AgentRetry`                                               | `Working(Retrying)` until text, reasoning, tool input, or a new stream |
| `AgentAwaitingInput`                                       | `Blocked`                                                              |
| `AgentEnd`                                                 | `Done`                                                                 |
| `AgentError` `aborted` with `abortReason` `user` or absent | `Idle`                                                                 |
| other `AgentError`                                         | `Failed`                                                               |

Every other event leaves the status as it was. Work events (start, turn, stream start, tool start,
compaction start, retry) mean the run is working whatever the previous status was, so a resumed
durable stream leaves `Blocked` even without `AgentStart`; after a terminal status nothing else
changes it. Callers dedupe replayed events by `eventId` first.

`AgentError` gains an optional `abortReason` (`AgentAbortReason`, also the loop's `AbortError`
reason) because the reason only existed inside the message text, and status must never parse
messages. Events recorded before it are treated as a person's cancel, the common case.

## Lifetime

OSC 7501 drops `working` and `blocked` records when the process exits and keeps `done` and `error`
until the terminal clears them; there is no heartbeat. For a run, "the process" is the host's
authoritative run record (a lease, a platform run status), never the last event seen.
`reconcileAgentStatus` applies the rule: `Working` and `Blocked` become `Idle` when the host says
the run is not active; `Done` and `Failed` stay. "Unseen" is the host's: the SDK models no people.

## Subagents

`SubagentStarted` adds a `Working` entry and `SubagentCompleted` settles it. A subagent call the
host accepts as background work (`ToolExecutionAccepted`) is marked `background`; it never receives
`SubagentCompleted` from the parent stream, so its status comes from the host
(`withSubagentStatus`). When the run stops (`AgentEnd`, `AgentError`, a local abort or transport
failure), live inline subagents become `Idle`, since they cannot outlive it. `AgentStart` drops
entries settled in earlier runs.

## Client and React

`AgentClientState` and `AgentChatState` replace `status: AgentRunStatus` and the `error`,
`errorInfo`, and `retryInfo` fields with `status: AgentStatus` and `subagents`, so "done with an
error" cannot be represented. Both reducers apply `nextAgentStatusTree`; local actions use
`startAgentStatusTree` (submit, HITL response, regenerate, edit) and `settleAgentStatusTree`
(transport failure, abort). Chat actions that change the transcript without starting a run
(hydrate, append, delete a turn) clear a `Failed` status to `Idle`, as they cleared the error
before. `useAgentChat` returns `status` and `subagents` and keeps `isRunning`/`isWaiting`.

## Rejected

- **Keep `AgentRunStatus` next to the new type.** Two status vocabularies for one run.
- **A snapshot builder over awaiting requests, an active flag, and a terminal event.** More API
  than storing the status itself, and each host would still choose the precedence.
- **One child record per HITL request.** Faithful to OSC 7501 ids, but mixed batches are rare and
  per-request kinds already let a UI list them.
- **A `cancelled` flag on `Idle`.** OSC 7501 reports a cancel as plain `idle`; hosts that react to a
  stop have `onAbort`.
- **Emit OSC 7501 sequences.** No Yolk host owns a terminal.
