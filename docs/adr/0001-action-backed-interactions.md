# Action-backed interactions

Status: accepted.

Terminology: [Agent interactions](../../CONTEXT.md). This decision records the behavioral
contract; package release status is tracked separately.

A person should be able to review an agent-proposed operation, edit its values, and execute it
with one explicit action such as **Send**. Introduce a distinct `makeInteractionTool` rather
than granting permissions through `makeInputTool`: ordinary inputs remain data-only, while an
interaction authorizes one server-defined action on one immutable submission.

## Scope

The first consumer is an email composer, but SDK APIs remain domain-independent. The
reference integration and tests stay generic (a document publisher with Publish/Archive
actions); no email delivery, credentials, provider effects, or product-specific SDK
components are included. Hosts own
renderers, credentials, authentication, account access, business rules, persistence, external
providers, and reconciliation. Yolk owns schema-backed registration, the interaction protocol,
execution ordering, and headless state.

No arbitrary model-generated UI, persistent permission grants, generic form builder, provider
integration, or voice/background support is included in this first slice.

## Registration contract

The following is a host-integration sketch, not a standalone runnable program. Registration
infers response and proposal types; bind a typed host context through `ToolModule<Context>`
or explicit registration generics. The generic document reference tests use fake effects.

```ts
const emailEditor = makeInteractionTool({
  name: 'email_editor',
  description: 'Let the user review and finish an email',
  access: 'write',
  callParameters: EmailDraft,
  response: EmailDraft,
  renderer: 'email-editor',
  title: 'Review email',
  actions: {
    send: {
      label: 'Send',
      validate: ({ data, context }) => context.email.validateSend(data),
      execute: ({ data, context, submissionId }) =>
        context.email.send(data, { idempotencyKey: submissionId })
    },
    saveDraft: {
      label: 'Save draft',
      execute: ({ data, context, submissionId }) =>
        context.email.saveDraft(data, { idempotencyKey: submissionId })
    }
  }
})
```

- `callParameters` describes the model's proposal/context; `response` describes the editable
  values submitted by the person. Infer their types and the action IDs from registration.
- The host explicitly declares tool access and availability. An action click does not bypass
  account access or other host policy. Action handlers receive fresh host-owned context.
- Action IDs, labels, validators, and handlers are server-defined. Serializable descriptors
  contain display information only; never credentials, callbacks, or executable permissions.
- Original Effect schemas validate both call parameters and submitted values. Provider-facing
  JSON Schema is guidance, not the execution validator.
- V1 admits JSON-preserving schemas. Decoding cannot silently replace the values the person
  authorized; normalization that changes their meaning needs another presentation.
- Optional action-specific `validate` runs before acceptance, without business effects. A
  validation rejection can keep the interaction editable. Do not run it as an irreversible
  operation or rely on its result as permanent authorization.
- `execute` runs the chosen server handler, not another model turn. Its result distinguishes
  `completed`, `failed`, and `unknown`. Only report `failed` when the host can establish the
  intended action did not take effect.
- No tool revision or contract-version field in v1. Keep registration focused on the form and
  its actions; deployment compatibility remains host-owned.
- Cancellation is built-in, needs no completed form, and executes no business handler. Closing
  a drawer is a host UI operation, not cancellation. Custom cleanup actions are out of scope.
- Input/interaction overlap, approval policy, and background activation are invalid
  combinations. No additional approval is requested after the selected action is accepted.

## Submission and wire contract

Add distinct `InteractionRequest` and `InteractionResponse` variants within the existing HITL
unions and transports. Do not overload `InputResponse` with an optional action field.

A request carries its opaque request ID, tool-call ID, original call, renderer metadata,
response-schema hint, and server-defined action descriptions. Execution scope and
pending-generation identity come from the host, never from the model.

A response has two explicit shapes:

```ts
type InteractionResponsePayload =
  | {
      outcome: 'submitted'
      requestId: string
      toolCallId: string
      actionId: string
      data: Json
    }
  | {
      outcome: 'cancelled'
      requestId: string
      toolCallId: string
      reason?: string
    }
```

This is a wire-shape sketch; implementation uses Effect Schema constructors and follows existing
protocol tagging conventions. Cancellation must reject action/data fields rather than secretly
selecting an action. Hosts echo opaque IDs instead of reconstructing them.

Export a side-effect-free `validateInteractionSubmission` helper for server admission. It checks
the authoritative pending request, exact correlation, original schemas, and selected server
action. Its output is a validated candidate, **not authenticated consent**.

The host authenticates the caller, checks pending ownership and action-specific policy, then
atomically accepts the first valid submission or cancellation. Reject malformed, stale, or
conflicting submissions before appending/resuming. Missing data differs from valid `null`,
`false`, and `0`. An invalid attempt must not consume the pending interaction.

## Durable authority and execution

One pending interaction has one acceptance slot, scoped by the host's session/run/generation.
Do not key competing admissions by action: **Send** and **Save draft** must compete for the same
slot. Store the exact original call, selected action, and submitted values beside the
accepted submission identity. Identical retries reuse that acceptance; changed values or actions
conflict after acceptance.

Action-backed registration requires an explicit host adapter, following the existing background
host precedent. No adapter means unavailable, not an unsafe in-memory fallback.

The server-only port is:

```ts
type InteractionRef = {
  readonly slot: string
  readonly submissionId: string
}

type InteractionHost = {
  readonly read: (slot: string) => Effect<InteractionReceipt | undefined, InteractionHostError>
  readonly claim: (ref: InteractionRef) => Effect<InteractionClaim, InteractionHostError>
  readonly settle: (
    token: string,
    outcome: InteractionOutcome
  ) => Effect<InteractionOutcome, InteractionHostError>
}
```

These are callbacks over host storage, not a new SDK storage engine:

- `read` returns an authoritative accepted/started/settled receipt, including its immutable
  binding, or no accepted submission. A cancellation has its own settled receipt shape.
- `claim` verifies the reference against an already accepted record and atomically returns
  either ownership with a fencing token and the accepted data, or an existing observation.
  It must not create acceptance from arbitrary loop input. A missing, foreign, stale, or
  conflicting record cannot grant ownership.
- A second claimant joins the existing owner or receives its recorded observation. Timeout,
  crash, or an abandoned `started` receipt never authorizes ownership takeover and resending.
- `settle` is token-fenced and idempotent. A stale worker cannot overwrite another authoritative
  outcome. Persistence uncertainty cannot license a new execution attempt.

Resolve action handlers with the host context into a server-only `ResolvedToolSet.interactions`
map. Carry references, not executable closures, across durable step boundaries.

Extend the existing executor seam additively:

```ts
execute(call, options?: { interaction: InteractionRef })
```

An interaction call without its explicit reference fails closed. Existing executor decorators
must forward the option or validate an authoritative stored receipt before returning a replayed
result. Ordinary dispatch, raw `hitlResponses`, `source: 'user'`, client transcripts, and nominal
TypeScript brands are not execution authority.

`resolveTools` returns `interactions` (schema validators, action IDs and a fresh-context-bound
`validateAction`) plus the supplied `interactionHost`. Pass both into `run`, `runToolBatch`, or
`RuntimeConfig`. Those boundaries call `loadInteractionReceipts(calls, interactionHost)` before
preparation. Durable hosts invoking `prepareToolBatch` directly must call this helper first and
supply its result as `interactionReceipts`; do not put storage reads inside preparation.

Load authoritative receipt snapshots before preflight. `prepareToolBatch` only validates and
plans; it does not claim, settle, or invoke an action. All pending sibling requests continue to
fence execution. Once the batch is ready, the selected handler runs behind `ToolExecutor` and
before the next model turn. This preserves existing host admission/replay decorators.

Historical settled receipt lookup precedes current schema/handler validation: replay its actual
result rather than executing again. Even an absent or disabled current tool can replay an authentic
stored outcome through the explicit-reference executor seam. Missing handlers never authorize new
dispatch. Accepted (not started) work with no current handler is unavailable; a started receipt is
observed as unknown without takeover. Hosts own deployment behavior
for pending work when changing an action's meaning; v1 does not attempt to detect arbitrary
handler changes. Never mutate an accepted submission.

## Outcomes and headless state

```text
requested → accepted → executing → completed
                                → failed
                                → unknown
requested → cancelled
```

The UI may show local **submitting** state, but acceptance and outcomes come from the server.
`InteractionSubmitted` is not terminal success and must never synthesize a tool result during
transcript reconstruction. Only an actual server result settles the tool call.

A result includes interaction identity, selected action, receipt reference, and explicit business
outcome. An `unknown` result is a truthful terminal tool observation, with `isError: true`; it is
not a claim that the business action failed. Its model-visible text must state that the action
may have happened and must not be retried automatically. Headless projection preserves this
classification rather than presenting a definite success or failure.

Do not reuse `AgentAwaitingInput` to ask the person to submit the same uncertain action again.
Host reconciliation may update its own receipt/status without rewriting historical consent or
silently executing again. A newly proposed operation requires new consent, and hosts should warn
or block potentially duplicative operations while an earlier outcome is uncertain.

Receipt fencing prevents rerunning one accepted slot. It does not promise exactly-once external
effects or deduplicate separately consented requests. External provider idempotency and recovery
remain host responsibilities.

## Compatibility and rejected alternatives

Keep `makeInputTool`, approvals, and questions behaviorally unchanged. New HITL variants require
updates in exhaustive consumers; this is an intentional opt-in public API migration. Old clients
need not decode new interactions, but must never downgrade one to data-only completion or ordinary
execution. Hosts advertise interaction tools only on supported surfaces.

Reusing `InputResponse` was considered because it inherits existing input guards. It was rejected:
`react/chat-messages.ts` reconstructs a tool result from `InputSubmitted`, so an old projection can
silently treat acceptance as completed work. Optional action fields can also be stripped by old
copy helpers. Distinct variants make these migrations explicit and fail closed.

Executing handlers directly from preflight was rejected because durable hosts run preflight more
than once. Bypassing `ToolExecutor` was rejected because existing host admission and replay wrappers
surround that seam. Fiber-local authorization was rejected because it is implicit and does not
survive durable step serialization.

Audit every input/interactive guard in registry, loop, voice/realtime, background activation,
client transport, runtime, React projection, and example adapters. Voice, background activation,
and hosts without authenticated receipt storage remain unsupported in v1.

## Implementation and acceptance plan

1. Protocol and registration: distinct descriptors/requests/responses, plain serialization,
   request/submission binding, original validators, host-declared access, and direct-dispatch guards.
2. Admission and execution: candidate validator, mandatory host port, explicit executor reference,
   side-effect-free batch preparation, sibling fences, and authoritative result reuse.
3. Runtime and client: safe append/resume integration, transport round trips, non-optimistic
   acceptance, and headless requested/accepted/executing/outcome state.
4. Reference integration: a fake-effect host with observable durable-style receipts; no real email
   delivery, credentials, provider effects, or product-specific SDK components.
5. Documentation, changeset, and package verification before the implementation PR. Publishing is
   a separate reviewed release action, not part of this proposal.

Tests must demonstrate:

- Legacy input/approval/question behavior remains intact.
- Invalid/extra/missing values, false-like JSON, and invalid actions are handled correctly.
- Invalid submissions can be corrected/cancelled without accepting or executing them.
- Forged responses, references, transcripts, stale scopes, and changed accepted payloads cannot
  dispatch actions.
- Acceptance never becomes a synthetic completed result in client/transcript replay.
- Preflight, repeated preflight, pending siblings, and ordinary dispatch execute no actions.
- Duplicate/concurrent claims, lost acknowledgements, workflow replay, and post-dispatch failures
  do not rerun the same accepted operation.
- Stored settled receipts replay without the current validator/handler.
- Failed and unknown outcomes remain distinct; uncertain execution is never automatically retried.
- Voice/background/unsupported surfaces fail closed, and wrappers dropping references fail closed.

Full root `pnpm test:run` resets the example database and requires separately approved operation
against a verified disposable lease. Database-free package suites and static/package checks do
not replace that evidence. No database operation is authorized by this proposal.
