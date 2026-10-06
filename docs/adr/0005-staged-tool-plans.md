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
  tool's optional `staging.precheck`. Hosts use prechecks for preconditions that may have changed
  since staging (for example an expected current value).
- **Apply** runs the privileged plan executor (`ToolPlanRuntime.apply`):
  1. Re-reads the review receipt and refuses unless it is accepted, started, submitted for this
     exact call, plan id, digest, and selection.
  2. Re-checks plan integrity, then `claim(planId, submissionId)`: `claimed` proceeds, `taken`
     refuses (`failed`, nothing applied), `same` reports the earlier apply as `unknown`.
  3. Runs the selected calls in staged order through `executeRegistration` (decoding, registration
     wrappers, the tool ledger) with ids `<reviewCallId>/<n>` (staged position) and the review call
     as ledger parent, calling the host `beforeCall` first (same shape as `beforeNestedCall`).
  4. `onFailure: 'stop'` (default) marks later selected calls `not_run`; `'continue'` runs them.
     Unselected calls are `skipped`. A partial apply is a `completed` outcome listing every call as
     `applied`, `failed`, `skipped`, or `not_run`.
- **Crash**: the receipt stays `started`; re-execution never runs again and returns `unknown`
  with the ledger's per-key states (`applied`, `failed`, `unknown`), or `ledgerUnavailable` when
  there is no ledger (never an empty listing). A defect or interruption seals the receipt with the
  same listing (bounded to 5 s, else the generic notice). Interactions gain an optional
  `unknownOutcome` hook for this.
- **Integrity**: staged keys are positional (`<planId>/s<n>`), so a key moved to another call in
  storage fails the integrity check; the executor also requires the receipt to name the resolved
  review tool.
- **Known limitations** (at most once always holds; the plan claim decides):
  - Two concurrent executions of one accepted review (a redelivered step) both re-validate before
    the receipt claim; the loser can see "already applied" as a validation error instead of the
    winner's outcome. The same happens earlier at loop preflight (`prepareToolBatch` re-runs call
    validation for an `accepted` receipt), where the loser gets a synthetic invalid-arguments result.
  - A plan store outage during call validation is reported as a validation error, so a preflight
    of an accepted review turns into an invalid-arguments result and the plan needs a fresh
    review. Keep the plan store beside the receipt storage. A follow-up may surface store errors
    as retryable step failures instead.
  - Staged calls apply sequentially in one tool step: size plans (`staging.maxCalls`) so the
    selected calls fit the host's step budget.
  - A `ToolError` from an applied call is reported `failed`, as in code mode listings, even though
    a timeout does not prove no effect; the review outcome stays `completed`, never `failed`.
- **Trust**: `planReview` handlers and `beforeCall` are trusted host code. The executor re-checks
  the receipt to stop the model and the browser, not host code (which can call any tool directly).
- **Bounded text**: results count applied and skipped calls and list at most 50 other calls;
  `structuredContent.result.calls` keeps every call.
- **Cancel** applies nothing. Deny-all is cancel; an empty selection is invalid.

`previewToolPlan({ toolSet, plan, keys })` returns bounded per-key previews for host review screens
(each tool's optional `staging.preview`, at most 50 keys per page, 16 KiB per preview), refusing
plans of another scope or with mismatched digests.

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
single-use claims (`taken`, `same`), the plan executor refusing without a started receipt or with
mismatched digests, `onFailure`, `beforeCall`, crash mid-apply (`unknown` with per-key ledger
states), nested ledger keys, cancel, previews, and the pi executor end to end.
