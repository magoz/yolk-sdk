import type { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolCall } from './tool.ts'

/**
 * Tool change previews (ADR 0006): one tool-agnostic before → after description of what an
 * approval-gated tool call would change, rendered the same way for direct approvals, sibling
 * approvals, and staged plan reviews. Plain JSON: decode it with these Schemas across process or
 * network boundaries. A preview is display data computed before the person decides; the call's
 * arguments stay the source of truth for what runs, and the tool itself stays authoritative.
 */

/** A short scalar shown as-is: string, finite number, boolean, or `null` (empty/cleared). */
export const ToolChangeScalar = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null
])

export type ToolChangeScalar = typeof ToolChangeScalar.Type

/** One member of a `Set` or `List` change: a stable `id` and a display `label`. */
export const ToolChangeItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String
})

export type ToolChangeItem = typeof ToolChangeItem.Type

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Marks a value the bound cut (`truncated`): `originalSize` is the size before cutting, in
 * `unit`: `chars` (Unicode code points of a string), `items` (entries of an item array), or
 * `bytes` (UTF-8 bytes of the compact JSON of a `Structured` value, which is replaced by `null`:
 * check `truncated` before rendering a `Structured` `null`). Cut strings and arrays keep one
 * contiguous window starting `offset` units into the original (absent: 0); for a `before`/`after`
 * pair both windows start at the same offset, a little before their first difference, so the
 * change stays visible. Never silent: every cut value carries a marker.
 */
export const ToolChangeCut = Schema.Struct({
  unit: Schema.Literals(['chars', 'items', 'bytes']),
  originalSize: NonNegativeInt,
  offset: Schema.optionalKey(NonNegativeInt)
})

export type ToolChangeCut = typeof ToolChangeCut.Type

/** Cuts of a change's `before`/`after` values. */
export const ToolChangeSideCuts = Schema.Struct({
  before: Schema.optionalKey(ToolChangeCut),
  after: Schema.optionalKey(ToolChangeCut)
})

export type ToolChangeSideCuts = typeof ToolChangeSideCuts.Type

/** Cuts of a `Set` change's item arrays. */
export const ToolChangeSetCuts = Schema.Struct({
  added: Schema.optionalKey(ToolChangeCut),
  removed: Schema.optionalKey(ToolChangeCut),
  unchanged: Schema.optionalKey(ToolChangeCut)
})

export type ToolChangeSetCuts = typeof ToolChangeSetCuts.Type

const changeFields = {
  /** Stable machine name of the changed field (for example `status`, `body`, `tags`). */
  field: Schema.String,
  /** Display name of the field. */
  label: Schema.String
}

/** A short scalar field. `before` absent: unknown or new; `null`: known empty. */
export const ToolValueChange = Schema.TaggedStruct('Value', {
  ...changeFields,
  before: Schema.optionalKey(ToolChangeScalar),
  after: ToolChangeScalar,
  truncated: Schema.optionalKey(ToolChangeSideCuts)
})

export type ToolValueChange = typeof ToolValueChange.Type

/** Long or multiline text: hosts render a text diff. `before` absent: unknown or new. */
export const ToolTextChange = Schema.TaggedStruct('Text', {
  ...changeFields,
  before: Schema.optionalKey(Schema.String),
  after: Schema.String,
  truncated: Schema.optionalKey(ToolChangeSideCuts)
})

export type ToolTextChange = typeof ToolTextChange.Type

/** An unordered set of items: what is added and removed, and optionally what stays. */
export const ToolSetChange = Schema.TaggedStruct('Set', {
  ...changeFields,
  added: Schema.Array(ToolChangeItem),
  removed: Schema.Array(ToolChangeItem),
  /** Context only: never part of `toolChangeSignature`, and the first thing the bound drops. */
  unchanged: Schema.optionalKey(Schema.Array(ToolChangeItem)),
  truncated: Schema.optionalKey(ToolChangeSetCuts)
})

export type ToolSetChange = typeof ToolSetChange.Type

/** An ordered list of items, when order matters. `before` absent: unknown or new. */
export const ToolListChange = Schema.TaggedStruct('List', {
  ...changeFields,
  before: Schema.optionalKey(Schema.Array(ToolChangeItem)),
  after: Schema.Array(ToolChangeItem),
  truncated: Schema.optionalKey(ToolChangeSideCuts)
})

export type ToolListChange = typeof ToolListChange.Type

/**
 * Rich structured content (for example editor blocks): hosts may render it structurally, or fall
 * back to `summary`. `before` absent: unknown or new.
 */
export const ToolStructuredChange = Schema.TaggedStruct('Structured', {
  ...changeFields,
  before: Schema.optionalKey(Schema.Json),
  after: Schema.Json,
  summary: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(ToolChangeSideCuts)
})

export type ToolStructuredChange = typeof ToolStructuredChange.Type

/** One changed field of a tool change preview. */
export const ToolFieldChange = Schema.Union([
  ToolValueChange,
  ToolTextChange,
  ToolSetChange,
  ToolListChange,
  ToolStructuredChange
])

export type ToolFieldChange = typeof ToolFieldChange.Type

/** What a call changes: the record, document, message, or other object it targets. */
export const ToolChangeTarget = Schema.Struct({
  /** Display name, for example the record title. */
  label: Schema.String,
  /** Display kind, for example `article` or `contact`. */
  kind: Schema.optionalKey(Schema.String),
  /** Display state of the target, for example `published`. */
  status: Schema.optionalKey(Schema.String),
  /** Link to the target in the host app. */
  href: Schema.optionalKey(Schema.String),
  /** Stable host id of the target. */
  id: Schema.optionalKey(Schema.String)
})

export type ToolChangeTarget = typeof ToolChangeTarget.Type

/**
 * A tool call's reviewable change: its `target`, an optional one-line `summary`, every field it
 * changes (`changes`; empty means the call changes nothing), `warnings` to show (the call stays
 * selectable), and `blocked` when it cannot apply as staged or requested (for example stale or in
 * the wrong state; hosts make the row unselectable or recommend denying). `warnings` and
 * `blocked` are display: a staged plan's `staging.precheck` stays authoritative at admission, and
 * the tool's own execution at apply.
 */
export const ToolChangePreview = Schema.Struct({
  target: ToolChangeTarget,
  summary: Schema.optionalKey(Schema.String),
  changes: Schema.Array(ToolFieldChange),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  blocked: Schema.optionalKey(Schema.String)
})

export type ToolChangePreview = typeof ToolChangePreview.Type

/**
 * Why a change preview is unavailable: the tool's hook failed (`failed`), returned something that
 * is not a `ToolChangePreview` (`invalid`), stayed too large after truncation (`too_large`), or
 * did not finish in time (`timeout`).
 */
export const ToolChangePreviewErrorCause = Schema.Literals([
  'failed',
  'invalid',
  'too_large',
  'timeout'
])

export type ToolChangePreviewErrorCause = typeof ToolChangePreviewErrorCause.Type

/** A change preview that could not be computed. Never blocks an approval or a review. */
export class ToolChangePreviewError extends Schema.TaggedError<ToolChangePreviewError>()(
  'ToolChangePreviewError',
  { message: Schema.String, cause: ToolChangePreviewErrorCause }
) {}

/**
 * Wire form of a missing preview (`ToolApprovalRequest.previewError`, `ToolPlanPreview`
 * `previewError`): hosts show the raw arguments instead, and may say why (`cause`).
 */
export const ToolChangePreviewFailure = Schema.Struct({
  cause: ToolChangePreviewErrorCause,
  message: Schema.String
})

export type ToolChangePreviewFailure = typeof ToolChangePreviewFailure.Type

/** Most characters of a preview failure message. */
export const toolChangePreviewMaxErrorChars = 500

/**
 * Loop seam computing the preview of one approval-gated call before its approval request is
 * raised (`ResolvedToolSet.approvalPreviews`, by tool name; hosts pass them to
 * `run`/`runToolBatch`/`prepareToolBatch`/runtime configs). Side-effect free.
 */
export type ToolApprovalPreviewer = (
  call: ToolCall
) => Effect.Effect<ToolChangePreview, ToolChangePreviewError>
