# Agent HITL

Repo-wide contract for human-in-the-loop agent pauses. Package owns protocol semantics; apps own storage, transport wiring, and UI.

## Ownership

| Layer                      | Owns                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/agent/protocol` | `HitlRequest`, `HitlResponse`, approval/question/input events, `AgentAwaitingInput`                  |
| `@yolk-sdk/agent/loop`     | Pauses before gated tool execution; resumes from `hitlResponses` and the pause's `awaitingRequests`  |
| `@yolk-sdk/agent/runtime`  | Transcript replay and append-log pending/resume events                                               |
| `@yolk-sdk/agent/client`   | HTTP/WS response submission helpers                                                                  |
| `@yolk-sdk/agent/tools`    | Domain-free `question` and generalized typed input (`makeInputTool`) contracts                       |
| `@yolk-sdk/agent/react`    | Headless waiting/tool/question render state                                                          |
| `@yolk-sdk/agent/voice`    | Voice approval gating (`handleVoiceToolCall`), controller pause/resume, `AwaitingInput` voice events |
| `@yolk-sdk/harness`        | Payload-free park generation, sibling readiness, pause/resume/stop admission                         |
| App adapters               | Typed HITL payload persistence, auth, concrete routes, hooks, buttons/forms                          |

## Semantics

- Tool approval policy lives on `ToolDef.approval` and can be sourced from `ToolRegistration.approval`.
- Manual approval emits `ToolApprovalRequested`, ends the run with `AgentAwaitingInput`, and never dispatches the tool until approved.
- Denied approval becomes a model-visible `ToolResultMessage` with `isError = true`.
- Approval binds the call on resume, not the tool's current policy (hosts re-read policy at execution). A resume batch (the transcript resume of `run`, or a `runToolBatch`/`prepareToolBatch` batch given `awaitingRequests` or any `hitlResponses`; all three take an explicit `resume` that overrides this detection) settles a call with an exact-match recorded response (denied: the denied result, never executed; approved: executed). A denial under another approval id of the same call (`approval:<id>` or `approval:<id>:…`, after an execution-mode change) also denies. Otherwise an unanswered `ToolApprovalRequest` from the resumed pause stays pending: the same request (its original policy, its preview recomputed and dropped when the tool has no previewer) while it still names the call (name, canonical params, request id), else a fresh request. Requests naming calls outside the batch are ignored. A fresh batch (a new model turn) never settles an approval from recorded answers: the current policy decides and a gated call asks again, because providers may reuse call ids. Answers consumed by a resumed batch never reach a later model turn of the same run (question and input answers reach only a run's first turn, the fresh-replay contract). A call is settled only by a result in its result window (the consecutive `ToolResult` messages right after its assistant message), so a provider-reused call id stays pending. The loop sees only what the host passes. Append-backed `runRuntime` forwards the pause automatically, with only the responses of the paused batch (logged after the event that recorded the batch's assistant message, sibling answers included); the Vercel Workflow loop forwards each pause's requests. Transcript-mode and stateless hosts (`run`, `runToolBatch`, `prepareToolBatch` called directly) must pass the pause being resumed as `awaitingRequests` (`AgentAwaitingInput.requests`) and only the responses of the batch being resumed, or set `resume` explicitly. Without the pause record, an unanswered request of a tool that no longer requires approval runs.
- Change previews ([ADR 0006](../docs/adr/0006-tool-change-previews.md)): pending `ToolApprovalRequest`s carry the tool's `preview` (`ToolChangePreview`) or `previewError` when hosts pass `ResolvedToolSet.approvalPreviews` as `approvalPreviews`. Display only: approval binds to the call, never the preview; a preview failure never blocks the approval (show `call.params`). Render the latest request event per call: resumed sibling rounds recompute previews.
- `question` is a package-owned tool name. The loop intercepts it, emits `QuestionRequested`, and resumes with structured answers in `ToolResult.structuredContent`.
- Generalized typed input tools (`makeInputTool`) share the same HITL lifecycle under their own interception branch. `ToolDef.input` carries display metadata only (`kind` stable renderer key, `title?`, `description?`, display-only JSON Schema hint); the registration's original Effect Schema owns server validation. Payloads and results are JSON-only (`Schema.Json`).
- Input correlation is `input:<name>:<callId>` (distinct from `question:<callId>` / `approval:<callId>`); outcomes are `submitted | cancelled`. Hosts echo `requestId`/`toolCallId` opaquely and never rebuild ids.
- Resolved input validators live in `ResolvedToolSet.inputs` and must be passed explicitly to `prepareToolBatch`/`runToolBatch`/`run`/`runRuntime` configs. Without them, input tools fail closed as model-visible `unavailable` errors (no prompt, no dispatch, no executor call). Input tools never take approval/background policy and never execute through direct dispatch.
- Validate input call parameters against their original schema before prompting; malformed calls produce model-visible errors. Validate user data against its original response schema (excess fields rejected by `makeInputTool`), not the display hint.
- Invalid input payloads re-pend the same `InputRequest` (no result message or execution). The first valid submission or cancellation settles the request; earlier invalid attempts allow correction, later stale/duplicate responses cannot overwrite it. Durable hosts admit only currently pending request/call/type matches. Workflow filters responses at its durable hook boundary before adding them to batch history.
- Question resume `ToolResult.content` must include selected answer values/labels and continuation guidance, not only `answered`; providers reliably see text output.
- Input resume `ToolResult.content` is the registration's `formatContent` projection with `structuredContent` `{ type: 'input_response', ... }`, so replay stays provider-neutral through normal tool result messages.
- Full `run` streams publish canonical synthetic `ToolExecutionCompleted` results for preflight rejection and resolved HITL, including while other siblings remain pending. These events do not dispatch executors. Response markers and terminal transcript snapshots alone cannot preserve server formatting or settle every call in an already-streamed React turn.
- Question `structuredContent` must be plain JSON-serializable; use `questionResponseStructuredContent`/`plainHitlResponse` at persistence and workflow boundaries.
- Preserve unchosen options in `ToolCall.params`/UI input; model-visible question results should emphasize chosen answers.
- HITL responses are control inputs (`ToolApprovalResponseInput`, `QuestionResponseInput`, `InputResponseInput`, `hitlResponses`), not user/assistant text.
- Submitted approval/question responses can be mapped to optimistic UI/protocol events with `hitlResponseEvent`. Typed input acceptance must come from the server; never project unvalidated input as an accepted result.
- Replay stays provider-neutral through normal assistant tool calls and tool result messages.
- Same-turn sibling tools may yield multiple pending requests; submit responses one at a time unless a runtime adds batching later.
- Voice sessions support tool approvals only in v1; the `question` tool and generalized input tools are deferred for voice and voice `submitHitlResponse` ignores both response kinds.
- Voice approvals never execute server-side without a matching approved response (`requestId` = `approval:<callId>`, matching `toolCallId`); denials return model-visible denial output.
- Background-activated tool calls (`ToolDef.execution === 'background-v1'`) bind approval identity to the exact name, execution mode, and canonical arguments (`approval:<callId>:background-v1:<canonical JSON>`); a changed payload or mode needs a fresh approval, malformed envelopes are rejected before any prompt, and non-activated tools keep `approval:<callId>`. Hosts echo `requestId` opaquely and never rebuild it. IDs intentionally retain the full canonical payload for lossless exact binding; hosts must accommodate potentially long opaque IDs or enforce input bounds before admission (no truncation/hashing).

## Runtime adapters

| Runtime         | Resume contract                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateless Next  | Client sends full transcript plus `hitlResponses` to `/api/agent`; route passes `toolSet.inputs` through so input tools can resume                                                                               |
| Cloudflare DO   | WebSocket accepts typed HITL response input; append log persists `RunAwaitingInput` and `HitlResponseAppended`                                                                                                   |
| Vercel Workflow | Tool step writes `AgentAwaitingInput`, waits on `createHook`, route resumes with `resumeHook`; each resumed tool step gets the pause's `awaitingRequests` and forwards them to `prepareToolBatch`/`runToolBatch` |
| Voice session   | Server tool endpoint returns `ApprovalRequired`; controller emits voice `AwaitingInput` and resumes by re-posting the call with the approval response; session death keeps the approval pending host-side        |

## UI rules

- Disable normal submit/edit/regenerate/delete while `status === 'waiting'`.
- Render approve/deny, question, and typed input controls from headless tool states; keep UI app-owned.
- Render typed inputs by `InputRequest.input.kind` through an app-owned renderer registry; unknown kinds fall back to an explicit unsupported notice with cancel (never a silent drop). Show server re-pends by keeping the form open; invalid payloads carry no validation detail in events.
- Keep custom input forms pending during submission; only server acceptance may produce a replayable input result. A transport failure must not turn unvalidated user data into a tool result. `AgentAwaitingInput.requests` restores headless pending state on replay.
- Show denial/cancel reason when available.
- Use accessible controls: labels, keyboard operation, and polite status updates.

## Tests

- Protocol wire round-trips: approval/question/input request + response.
- Plain serialization helpers: no Schema/Class instances in durable HITL payloads.
- Loop: pause, approve, deny, question answer/cancel, input call validation/submit/cancel/invalid-repend/first-valid-wins, parallel pending, no duplicate execution, approval binding across a policy change (resume vs fresh turn, outstanding reuse, execution-mode flip).
- Runtime: append pending state, replay responses, durable resume.
- React: waiting status, submit helpers, projection/replay.
- App adapters: route/WS/Workflow resume and toolset inclusion.

## Action-backed interactions: authenticated host wiring

`makeInteractionTool` is distinct from data-only inputs. Registration callbacks infer the original
response/proposal schema types; v1 rejects normalization, defaults or transforms that change exact
JSON consent. A side-effect-free action validator may fail with `InteractionValidationError`.

1. Resolve tools with a fresh host context and an `InteractionHost` scoped to the active
   session/run/pending generation. Never implement the port as global lookup by a model call ID.
2. Authenticate the browser caller; load the authoritative pending request and check ownership,
   active scope and policy. Call `validateInteractionSubmission({ request, response,
...toolSet.interactions[name] })` before acceptance. The resolved `validateAction` runs bound
   policy here; validation itself is not authentication. Invalid attempts consume nothing.
3. In the host transaction, accept the first valid submission/cancellation in ONE slot across
   all actions. Allocate an opaque unique submission ID and store the exact original call,
   selected action/data (or cancellation) immutably. Identical retries reuse it; changed bindings
   conflict. Cancellation rejects action/data and needs no current valid form/proposal. Store a
   settled cancellation result with `interaction_outcome` identity and `outcome: 'cancelled'`.
4. Only then append/resume. Pass `interactions` **and** `interactionHost` into `run`,
   `runToolBatch`, or `RuntimeConfig`. Raw `hitlResponses`, `source: 'user'`, client transcripts,
   and nominal types grant no authority. `AppendHitlResponse` is transport/logging, not acceptance.
5. Durable hosts call `loadInteractionReceipts(calls, host)` before each `prepareToolBatch` and
   pass the map as `interactionReceipts`. Preparation only validates/plans. All pending siblings
   fence every executor call. Forward `{ interaction: ref }` through every executor decorator.
6. `claim(ref)` atomically advances an already accepted record to started and returns a fencing
   token with the same immutable receipt. It never manufactures acceptance. Concurrent losers
   observe the existing record. Abandoned started records cannot be taken over or resent.
7. `settle(token, outcome)` validates identity, is idempotent and never overwrites a settled
   observation. Settlement acknowledgement loss seals uncertainty; a retry can replay a stored
   completed outcome, but never executes again. Host callbacks must cooperate with interruption;
   SDK finalization bounds its settlement attempt to five seconds.

Historical settled observations replay before current schemas/actions (including removed or
disabled tools); no current handler means no NEW dispatch. Only explicit returned `failed` means
known no effect. Escaped typed errors, including timeouts/`ModelVisibleToolError`, are unknown.
Defects/interruption preserve their Cause while attempting durable uncertainty. Unknown results
carry identity, `isError: true` and a no-auto-retry warning in string or rich content. Reconciliation,
external-provider idempotency, and warning/blocking separately consented duplicates remain host-owned.

`InteractionSubmitted` means accepted, not completed: keep it active until a server tool result.
Never optimistically emit it from local submit or reconstruct a result from transcript acceptance.
Voice/realtime, background activation, and hosts without authenticated receipt storage remain
unsupported.

Staged tool plans ([ADR 0005](../docs/adr/0005-staged-tool-plans.md)) reuse this flow: the
`review_plan` interaction (`makePlanReviewTool`) accepts `{ selectedKeys }` for a code mode plan,
and its action applies only those staged calls after re-reading the started receipt. Hosts add a
conversation-scoped `ToolPlanStore` (`resolveTools(..., { plans })`) next to the receipt port and
wire their per-call write authorizer as `beforeCall` (applied calls bypass `beforeNestedCall` and
executor decorators). With a tool ledger, a redelivered review (receipt `started`) waits behind the
apply's ledger entry for the real outcome; listings never call a call `not_run` while an earlier
execution may still reach it.

Call validators and `validateAction` may read host storage (`InteractionCallValidator`); an
unavailable store fails with `InteractionHostError`, never a verdict: `prepareToolBatch` fails the
batch with `ToolError` `unavailable` (retry the step), admission answers `InteractionAdmissionError`
`unavailable` (nothing consumed), and execution fails closed. When an accepted receipt's call no
longer validates, preflight still dispatches it and the executor re-reads the receipt, reporting a
delivery that already started or settled it instead of an invalid-arguments error. Generic fake-effect reference and adversarial tests: `packages/agent/test/tools/interaction-host.ts`,
`interaction.test.ts`, and `test/loop/interaction-tools.test.ts`. No live app opt-in is included.
