# Staged tool plans

Status: accepted.

Code mode ([ADR 0002](0002-code-mode.md)) keeps approval-gated tools fail-closed: scripts never
call them, and each direct call needs its own approval. Bulk gated work therefore costs one
approval per item. Speldosa must set curriculum links on 124 published resources through an
approval-gated `cms_manage_published` tool: 124 model turns and 124 clicks for one decision a
person wants to make once, with the option to leave a few items out.

Let a script **stage** approval-gated calls into a plan instead of running them. A person reviews
the plan once through an action-backed interaction and selects the calls to apply; Yolk then runs
exactly those recorded calls.

## Terms

- **Stageable tool**: an approval-gated tool the host marks `staging` (`ToolDef.staging: true`).
- **Staged call**: `{ key, toolName, params, argsDigest }` a script recorded with
  `stage(name, args)`. `key` is `<planId>/s<n>`.
- **Tool plan**: the ordered staged calls of one successful script, with `id` (the host's
  `plans.planId({ call })` for the code mode call, default its call id), the plan store `scope`,
  and `digest` (SHA-256 over the ordered `[toolName, argsDigest]`).
- **Plan review**: the `review_plan` interaction tool (`makePlanReviewTool`) whose accepted
  submission selects which staged calls to apply.

## Decision summary

| Area         | Decision                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| Script phase | Explicit `stage(name, args)` global; the script completes normally. Nothing executes or is ledgered.         |
| Review phase | A separate model tool call (`review_plan({ planId, planDigest })`) built on `makeInteractionTool` mechanics. |
| Selection    | `{ selectedKeys: NonEmptyArray<string> }`: untick only, never argument edits.                                |
| Execution    | A privileged plan executor inside the accepted review action, through the normal registry execute path.      |
| Storage      | Host `ToolPlanStore` (`put` idempotent by id and digest, `get`, single-use `claim`).                         |
| Availability | Only with `plans`, an `interactionHost`, and exactly one plan review tool in the resolution.                 |
| Fail-closed  | Unchanged for direct calls: `tools.<name>()` on approval tools still fails; `stage` is the only path.        |
| Atomicity    | None in v1: calls apply in staged order; a crash leaves a partial apply reported as `unknown`.               |

## Why a separate review call

HITL requests only arise **before** a tool batch runs: `prepareToolBatch` preflights every call and
pending requests fence all execution. A tool's `execute` returns a result or a `ToolError`, never a
pause. A script cannot stop half-way for a person and continue later without replaying it (the
rejected post-execution pause below). So the script completes, the plan is saved, and the review is
an ordinary interaction tool call the model makes next. Interaction tools already give what review
needs: validation at admission with a fresh host context, an exact receipt-bound submission,
claim/settle fencing, `unknown` on crash, and no re-run.

## Script phase

`makeCodeModeTool` adds `stage(name, args)` when the resolution offers staging
(`NestedToolExecutor.staging`). `stage`:

1. Accepts only stageable tools (approval-gated, `staging`, not `callableBy: 'model'`, no input,
   interaction, background, or nested access; never `question`/`subagent`).
2. Validates the JSON arguments with the tool's side-effect-free decoder (`ToolRegistration.validate`,
   after the registry's argument normalization).
3. Records the staged call; executes nothing, ledgers nothing, and resolves to
   `{ staged: true, key, index }`.

Guardrails:

- Once a script stages, later non-`read` nested calls are rejected; `stage` is rejected once a
  non-`read` call was admitted. Reads run anywhere. A plan never mixes with direct writes of the
  same script, so a review never approves work whose premise a write already changed.
- A duplicate (same tool and `argsDigest`) is rejected.
- `maxCalls` (default 500) and `maxArgsBytes` (default 1 MiB of canonical JSON) are checked at
  `stage`; a call past them is rejected, never truncated. Code mode's `staging.maxCalls` may only
  lower the cap.

At script end a successful script's calls are saved once (`ToolPlanStore.put`, idempotent by id;
the same id with another digest is a conflict, so a re-executed step stages the same plan or
fails). Provider call ids can repeat across turns, so hosts whose plan store outlives one turn pass
`plans.planId` (for example run, turn, and call id): it must be unique within the store scope and
stable across re-executions of the same call. An empty, untrimmed, or throwing id disables `stage`
for that call. A failed script's staged calls are discarded: a partial plan is never offered. The result
text tells the model `review_plan({ planId, planDigest })`; hosts get
`structuredContent.codemode.plan: { id, digest, count, reviewToolName }`.

## Review phase

`makePlanReviewTool` (default name `review_plan`, renderer `tool_plan_review`, one action `apply`):

- **Call validation** loads the plan: present, in the store's scope, every staged digest and the
  plan digest matching, `planDigest` equal, not yet claimed. It runs at preflight and again before
  execution.
- **Admission** (`validateAction`, the resolution's fresh context) checks the selection: a
  non-empty, duplicate-free subset of the plan's keys whose tools are still stageable, then each
  tool's optional `staging.precheck` (at most 8 at a time). Hosts use prechecks for preconditions
  that may have changed since staging; a tool's own compare-and-set in `execute` stays the
  authority (a precheck cannot close the gap between check and write).
- **Apply** runs the privileged plan executor (`ToolPlanRuntime.apply`):
  1. Re-reads the review receipt and refuses unless it is started, submitted with action `apply`,
     for the resolved review tool, and for this exact call, plan id, digest, and selection.
  2. Re-checks plan integrity, then `claim(planId, submissionId)`: `claimed` proceeds, `taken`
     refuses (`failed`, nothing applied), `same` reports the earlier apply as `unknown`.
  3. Runs the selected calls in staged order through `executeRegistration` (decoding, registration
     wrappers, the tool ledger) with ids `<reviewCallId>/<n>` (staged position) and the review call
     as ledger parent, calling the host `beforeCall` first (same shape as `beforeNestedCall`).
  4. `onFailure: 'stop'` (default) marks later selected calls `not_run`; `'continue'` runs them.
     Unselected calls are `skipped`. A partial apply is a `completed` outcome listing every call as
     `applied`, `failed`, `skipped`, or `not_run`.
- **Per-call authority**: applied calls run inside the review action, so code mode's
  `beforeNestedCall` and decorators around the `ToolExecutor` never see them. `beforeCall` is the
  only per-call host authority hook: hosts must wire their run-authority (nested-write) authorizer
  there. Registration wrappers and the ledger still apply.
- **Apply fence**: with a tool ledger, each apply runs behind one ledger entry keyed by the review
  call id (whatever the ledger policy), claimed before the plan claim and before any call, heartbeated
  while the calls run, and completed with the apply's result. Another execution of the same review
  (a redelivered step, which Vercel queues do while the first is still running) finds the receipt
  `started` and claims the same entry, so it:
  - replays the recorded result when the apply completed;
  - waits while the apply is in flight (polls, up to the ledger's `maxWaitMs` or `deadline`, as for
    duplicate ledgered calls) and then returns the apply's real outcome (or the receipt's
    settlement, when recorded meanwhile);
  - holds the fence itself when no apply passed it, and the durable plan claim agrees (the plan is
    not claimed by this review, the ledger lists no call of it, the plan and selection are known):
    nothing ran and nothing will (an apply that
    arrives later replays that result instead of running), so it reports every selected call
    `not_run` with outcome `failed` (known no effect; the plan stays unclaimed and reviewable);
  - otherwise (the wait ends while the apply still runs, or its lease expired) falls back to the
    listing below.
- **Fence scope**: the fence assumes every execution of a review call resolves with the same
  ledger scope (for example run + turn of the review step) and that the host keeps the fence entry
  at least as long as the receipt. A fresh fence in another scope, or after the entry was deleted,
  is not taken as proof on its own: the plan claim must agree, else the listing stays uncertain.
- **Listing without an outcome**: it combines the receipt's selection, the plan claim, and the
  ledger. Ledger entries give `applied`, `failed`, or `unknown`; unselected calls are `skipped`. A
  selected call without an entry is `not_run` only when that is provable: another review owns the
  plan, this execution holds the fence that no apply passed, or the apply itself ended (its own
  seal, for a tool the ledger records). While an apply may still be running it is `unknown`: a lease
  expiry or a timed-out wait does not prove the apply stopped, and it may still reach that call.
  Without a ledger there is no fence and selected calls without proof are `unknown`, with
  `ledgerUnavailable` (never an empty listing). A defect or interruption seals the receipt with the
  apply's own listing (`unknownOutcome` phase `seal`): the description has its own 3 s bound
  (falling back to the generic notice) and settlement keeps its full 5 s. Interactions gain an
  optional `unknownOutcome({ call, submissionId, phase })` hook for this; in phase `replay` it may
  return an `outcome` the registration proves from its own durable record (here, the fence).
- **Storage outages are never verdicts**: plan store errors in call validation and admission are
  `InteractionHostError`s (protocol `InteractionCallValidator`). Loop preflight fails the batch
  closed (`prepareToolBatch` fails with `ToolError` `unavailable`, like `loadInteractionReceipts`),
  so the step can be retried with the review intact; admission answers `InteractionAdmissionError`
  `unavailable` (nothing is consumed). During execution, before the receipt claim, an outage fails
  closed as a model-visible `unavailable` `ToolError`, as ledger claim failures do; nothing runs
  and the review stays accepted. After the receipt claim the review attempt cannot be retried (a
  started receipt is never taken over): an outage reading the receipt or plan, or claiming the
  fence, settles it `failed` with nothing applied and tells the model the plan is unchanged and can
  be reviewed again; an outage claiming the plan settles it `failed` noting the plan may now be
  locked. No call runs in either case.
- **Concurrent deliveries**: when an accepted review's call or selection no longer validates,
  preflight still dispatches it, and the executor re-reads the receipt before reporting a
  validation error: a receipt another delivery started or settled meanwhile yields that outcome
  (`unknown` or the settled result), never "invalid arguments".
- **Integrity**: staged keys are positional (`<planId>/s<n>`), so a key moved to another call in
  storage fails the integrity check. Stage snapshots the arguments once (canonical JSON, parsed) and
  validates, digests, and stores that snapshot.
- **Known limitations** (at most once always holds; the plan claim decides):
  - An outage that starts between preflight and execution of the same step reaches the executor,
    which fails closed with a model-visible `unavailable` result while the receipt stays accepted;
    the model must open a fresh review. Making it a step failure would need a retryable error
    channel on `ToolExecutor.execute` (all `ToolError`s are tool results today); deferred.
  - Staged calls apply sequentially in one tool step: size plans (`staging.maxCalls`) so the
    selected calls fit the host's step budget, and give the ledger's wait (`maxWaitMs`,
    `deadline`) room for the apply, so a redelivery returns the real outcome instead of the
    `unknown` listing.
  - A redelivery that waits for an apply returns the apply's outcome, but the receipt keeps the
    settlement of the execution that ran it; if that execution dies after the fence completed and
    before settling, the receipt stays `started` and later replays return the fence's result.
  - A `ToolError` from an applied call is reported `failed`, as in code mode listings, even though
    a timeout does not prove no effect; the review outcome stays `completed`, never `failed`.
  - The review tool stays advertised when the resolution has no plans (it answers unavailable),
    consistent with interaction tools resolved without a host.
- **Trust**: `planReview` handlers and `beforeCall` are trusted host code. The executor re-checks
  the receipt to stop the model and the browser, not host code (which can call any tool directly).
  Submission ids must be unique within the plan store's scope: a reused id would make `claim`
  answer `same` for an unrelated review.
- **Bounded text**: results count applied and skipped calls and list at most 50 other calls;
  `structuredContent.result.calls` keeps every call.
- **Cancel** applies nothing. Deny-all is cancel; an empty selection is invalid.

Host review screens use `previewStoredToolPlan({ toolSet, planId, planDigest, offset?, limit? })`
(loads through the plan store with the same scope, integrity, and digest checks; pages of at most
50 calls with `nextOffset` and the claim state) or `previewToolPlan({ toolSet, plan, keys })` for a
plan already in hand (`toolPlanKeyPages` pages its keys). Previews carry each tool's optional
`staging.preview`, bounded to 16 KiB. `ToolPlanOutcome`, `ToolPlanPreview`, and
`ToolPlanPreviewPage` are Effect Schemas so hosts can decode them across process boundaries.

The plan store contract: `put` is atomic insert-or-compare (one statement or transaction), `claim`
a single conditional update, JSON(B) storage is safe (digests use canonical JSON with sorted
keys), and retention is host policy (unreviewed plans are inert; expire them after the review
window, keep claimed ones as long as the ledger entries they explain).

Approval binds to the transcript call (`approval:<callId>`); the plan review binds the person's
consent to the receipt of one review call, one plan digest, and one selection. The plan executor
is reachable only from that action: the runtime that holds it is bound by `resolveTools` into plan
review registrations and re-verifies the receipt itself. `argsDigest` and the plan digest are
conflict and tamper fingerprints over host-stored data (the ledger format), not signatures.

## Availability

`resolveTools(modules, context, { plans: { store }, interactionHost })` with exactly one plan review
registration enables staging. Without plans or an interaction host, scripts get no `stage`, the
code mode description does not mention it, and the review tool is unavailable. Voice (no
interaction host, interactions denied), subagent, and other child resolutions therefore never get
it unless a host deliberately resolves them with both.

## Rejected alternatives

- **Post-execution pause of `codemode`**: the loop cannot pause after a tool returned, and a
  paused script would need abort-and-replay to continue.
- **Implicit placeholders from `tools.x()`**: returning fake results for gated calls lets scripts
  branch on values that do not exist and hides which calls are staged. `stage` is explicit.
- **A new HITL kind**: interactions already provide admission, receipts, fencing, and truthful
  unknown outcomes; a new kind would duplicate them across protocol, loop, client, and React.
- **Approval with selection**: approvals bind one call and carry a decision, not data; extending
  them to N calls changes every approval host and the voice path.
- **Scoped grants** ("allow `cms_manage_published` for 10 minutes"): authorizes future calls a
  person never saw, against the per-call approval rule.
- **App-specific change sets**: each app would rebuild staging, review, and the at-most-once apply.
- **Atomic `executeBatch`**: tools have no transaction contract today. Future work: an optional
  per-tool batch executor for tools that can apply a selection atomically.

## Relation to ADR 0002

This supersedes ADR 0002's Phase 2 (abort-and-replay approvals inside scripts) for gated writes.
Abort-and-replay stays deferred until a script needs a gated call's **result** mid-run; staged
plans cover the common case where the script computes the writes and a person approves them.

## Tests

`packages/agent/test/tools/plan.test.ts` and `packages/codemode/test/plan.test.ts`: fail-closed
direct calls, staging availability (no `stage` without plans, host, or review tool), stage
validation and guardrails (write-then-stage, stage-then-write, duplicates, caps), plan put
idempotency and conflicts, review validation (digest, scope, subset, duplicates, prechecks),
single-use claims (`taken`, `same`), the plan executor refusing without a started receipt, for a
started receipt of another selection, digest, or tool, or with mismatched or moved keys,
`onFailure`, `beforeCall`, crash mid-apply (`unknown` with per-key listings, ledgered and
unledgered tools), plan store outages at preflight, admission, and execution, concurrent
deliveries reporting the winner's outcome, redeliveries during an in-flight apply (waiting for its
real outcome, the wait-deadline fallback listing unknown calls, the no-ledger listing, and a fence
held first proving nothing ran), argument snapshots, bounded precheck concurrency, host
plan ids, nested ledger keys, cancel, paged stored previews with Schema decoding, and the pi
executor end to end.
