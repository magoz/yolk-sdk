# Tool change previews

Status: accepted.

An approval asks a person to consent to a call they cannot read: `ToolApprovalRequest` carried
only the call and its policy, so hosts showed raw arguments and Approve/Deny. Staged plan reviews
([ADR 0005](0005-staged-tool-plans.md)) had a `staging.preview` hook returning arbitrary JSON, so
every host and tool invented its own preview shape: a real diff for one field, raw "proposed
value" dumps without a before for the others, raw JSON for rich content, no grouping of hundreds of
identical changes, and settled reviews that still showed pending diffs.

Give every approval-gated call one tool-agnostic, reviewable before → after preview: one contract,
one tool hook, three consumers (direct approvals, sibling approvals in one turn, staged plan
reviews), and one host component that renders any tool's change (record edits, CRM writes,
mailbox changes, ...).

## Decision summary

| Area          | Decision                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Contract      | `ToolChangePreview` Effect Schemas in protocol (re-exported from tools): target, changes, warnings, blocked |
| Change shapes | `Value`, `Text`, `Set`, `List`, `Structured` (`_tag` union); items are `{ id, label }`                      |
| Hook          | `changePreview` on approval-gated registrations (`makeTool` decodes the arguments first)                    |
| Approvals     | `prepareToolBatch` attaches `preview` or `previewError` to pending `ToolApprovalRequest`s                   |
| Plans         | `previewToolPlan`/`previewStoredToolPlan` run the same hook per staged call                                 |
| Bound         | Deterministic truncation with markers, default 16 KiB per preview, host-configurable                        |
| Authority     | Display only: approvals bind to the call, `staging.precheck` and the tool's own write stay authoritative    |
| Grouping      | `toolChangeSignature` + `groupToolChangePreviews`, per tool                                                 |

## Contract

```ts
ToolChangePreview = {
  target: { label; kind?; status?; href?; id? }
  summary?: string
  changes: ToolFieldChange[]   // every field the call changes; empty: no-op
  warnings?: string[]          // shown; the call stays selectable
  blocked?: string             // cannot apply as requested or staged; not selectable
}
ToolFieldChange =
  | Value      { field, label, before?: scalar | null, after: scalar | null }
  | Text       { field, label, before?: string, after: string }
  | Set        { field, label, added: Item[], removed: Item[], unchanged?: Item[] }
  | List       { field, label, before?: Item[], after: Item[] }
  | Structured { field, label, before?: Json, after: Json, summary? }
```

An absent `before` means unknown or new; `null` means known empty. Scalars are strings, finite
numbers, booleans, or `null`. The Schemas are plain JSON and decode across process boundaries;
`ToolChangePreviewError` (`failed`, `invalid`, `too_large`, `timeout`) says why a preview is
missing, and its wire form `ToolChangePreviewFailure` (`{ cause, message }`) is the `previewError`
of approval requests and plan previews. Plan preview entries are separate Schema members with
`preview`, with `previewError`, or with neither (the absent field is declared `Never`), so an
entry with both fails to decode; producers of
approval requests set at most one (the request class keeps two optional fields so earlier requests
still decode). Defects of host hooks are logged as warnings.

## One hook

`ToolRegistration.changePreview({ call, context })` (and `makeTool({ changePreview: ({ params,
call, context }) })`, which decodes the arguments first and never calls the hook with invalid
ones) is side-effect free and allowed only with `def.approval` (`resolveTools` fails with
`change_preview_unsupported_policy` otherwise). `resolveTools` runs every preview through one path:
null-optional argument normalization, the resolution's fresh context, `timeoutMs` (default 5 s),
Schema decoding (excess keys dropped), and the byte bound. `staging.preview` is removed; `staging`
keeps only `precheck`.

## Direct and sibling approvals

`ResolvedToolSet.approvalPreviews` holds a previewer per approval-gated tool with a hook. Hosts pass
it like `inputs` and `interactions` (`run`, `runToolBatch`, `prepareToolBatch`, `RuntimeConfig`).
After preparing the batch, `prepareToolBatch` previews every still-pending approval request (at most
8 at a time) and rebuilds the request and its `ToolApprovalRequested` event with `preview` or
`previewError`. A call that already has a response is never previewed. Failures, defects, timeouts,
and oversized previews become `previewError`; interruption propagates. Activated background calls
preview the business arguments of their envelope. Voice approvals do not compute previews.

The approval keeps binding to the call (`approval:<callId>` or the activated envelope id). The
preview is a display snapshot of the state when the request was raised, never part of the consent
binding: the arguments decide what runs and the tool's own write stays authoritative.

Siblings are previewed against the state before any of them runs, so two calls touching one record
both show its current state. Durable hosts that resume one response per round re-run the batch and
re-raise the remaining siblings with recomputed previews; hosts render the latest request event per
call. A redelivered step may emit an equal event with another preview; either is display only.

## Staged plans

`previewToolPlan` and `previewStoredToolPlan` run the same hook per staged call. An `ok` entry
carries the staged `params` and `preview` or `previewError` (a failing preview no longer makes the
entry an error, so the person still sees the arguments); `status: 'error'` remains for keys outside
the plan and tools no longer stageable. `blocked` should express the condition `staging.precheck`
enforces, so a person sees why a selection would be rejected; the precheck stays authoritative at
admission and the tool's write at apply.

A settled direct approval renders its result, not the pending diff: an approved call that ran
shows the after state, a denied call "not applied". Settled reviews render from
`ToolPlanOutcome.calls`, not from previews: `applied` shows the after
state; `skipped`, `not_run`, and `failed` show "not applied" without a pending diff; `unknown` says
the call may have been applied.

## Bound

Previews are bounded to `maxBytes` UTF-8 bytes of compact JSON (`resolveTools(..., { changePreview:
{ maxBytes } })`, default 16 KiB, at least 1 KiB), deterministically and never silently:

1. A preview that fits is unchanged.
2. Every `Set.unchanged` is dropped (it is context), with a marker.
3. In rounds, every cuttable value (strings of `Value`/`Text`, item arrays of `Set`/`List`,
   `Structured` values) is capped at one shared size: smaller values stay whole, larger ones get
   an equal share. Strings and arrays keep one window; for a `before`/`after` pair both windows
   start a little before their first difference, so a change at the end of a long text stays
   visible. A `Structured` value over the cap becomes `null`.
4. Each cut value has a `truncated` marker with `unit` (`chars`, `items`, or `bytes`),
   `originalSize`, and an optional `offset`. Hosts check it before rendering a `Structured`
   `null`. A value the hook already cut keeps its marker's original size, and the offsets add up.
5. Labels, the target, `summary`, `warnings`, and `blocked` are never cut. When they alone exceed
   the bound, the preview fails `too_large` and hosts show the arguments.

Previews are display; the staged or requested arguments remain the source of truth. Each preview
is stored with its request (`ToolApprovalRequested` and `AgentAwaitingInput.requests`), so durable
event stores must allow `maxBytes` per pending approval.

## Grouping

`toolChangeSignature(preview)` is the lower-case hex SHA-256 of the canonical JSON (sorted keys) of
`changes`, with `Set.unchanged` removed and `Set` members sorted by id; the target, summary,
warnings, and `blocked` are ignored. `groupToolChangePreviews` groups `{ toolName, preview }`
entries by tool and signature in first-appearance order, so hosts render "add X on 120 records"
once. A truncated preview's signature covers only what was kept, so truncated previews are never
grouped. Hosts group across all pages of a paged plan.

## Rejected alternatives

- **Preview on `ToolExecutor`**: every decorator and fake would have to forward a second method,
  and decorators that wrap only `execute` would drop previews silently; applied plan calls bypass
  decorators anyway.
- **Preview in the approval id**: binding consent to a display snapshot would make every
  recomputed preview a new request; the call is what runs.
- **Signature over the truncated preview, grouping regardless**: two diffs that differ only past
  the cut would be grouped as identical.
- **Prefix-only truncation**: an edit at the end of a long text would show identical before and
  after.
- **Dropping trailing changes past the bound**: a partial change list reads as the whole change;
  the arguments fallback is truthful.
- **Per-tool preview JSON**: the problem this replaces.

## Tests

`packages/agent/test/tools/change-preview.test.ts` (Schema round trips, truncation policy and
determinism, signature and grouping stability, the resolved previewer: approval required, decoded
arguments, failures, defects, invalid previews, the byte bound, timeouts, activated envelopes),
`packages/agent/test/loop/approval-preview.test.ts` (sibling requests each with their own preview,
preview errors, no preview once answered, interruption, wire round trip, legacy requests),
`packages/agent/test/property/change-preview.property.test.ts` (bound, determinism, markers), and
`packages/agent/test/tools/plan.test.ts` (staged plan previews from the same hook, preview errors
keeping the arguments, grouping a stored plan's pages).
