import { Effect, Match, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolError } from '@yolk-sdk/agent/loop'
import {
  ToolChangePreview,
  ToolChangePreviewError,
  type ToolChangeCut,
  type ToolChangeItem,
  type ToolFieldChange,
  type ToolListChange,
  type ToolSetChange,
  type ToolStructuredChange,
  type ToolTextChange,
  type ToolValueChange
} from '@yolk-sdk/agent/protocol'
import {
  compactToolArguments,
  truncateCodePoints,
  utf8ByteLength
} from '../protocol/bounded-text.ts'
import { toolChangePreviewMaxErrorChars } from '../protocol/change-preview.ts'
import { canonicalToolArguments } from './ledger.ts'
import { sha256HexSync } from './sha256.ts'

/** Default bound of one change preview: UTF-8 bytes of its compact JSON (16 KiB). */
export const defaultToolChangePreviewMaxBytes = 16 * 1024

/** Smallest accepted `changePreview.maxBytes`; smaller values are raised to it. */
export const minToolChangePreviewMaxBytes = 1024

/** Default time a tool's change preview hook may take before it reports `timeout` (5 s). */
export const defaultToolChangePreviewTimeoutMs = 5_000

/** `resolveTools` change preview options: the per-preview byte bound and the hook timeout. */
export type ToolChangePreviewOptions = {
  /** UTF-8 bytes of a preview's compact JSON; larger previews are truncated (see
   * `boundToolChangePreview`). Default 16 KiB, at least 1 KiB.
   */
  readonly maxBytes?: number
  /** Time a preview hook may take. Default 5 s. */
  readonly timeoutMs?: number
}

const jsonBytes = (value: unknown) => utf8ByteLength(compactToolArguments(value))

// Encoded size of one character inside a JSON string (escapes included, quotes excluded).
const encodedCharBytes = (character: string) => jsonBytes(character) - 2

// Truncation works on private mutable drafts of a preview; callers only ever see new values.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type SideCuts = { before?: ToolChangeCut; after?: ToolChangeCut }

type SetCuts = { added?: ToolChangeCut; removed?: ToolChangeCut; unchanged?: ToolChangeCut }

/** One cuttable value of a draft: its current JSON size, whether it can shrink, and the cut. */
type Slot = {
  readonly bytes: () => number
  readonly shrinkable: () => boolean
  /** Shrinks the value by about `bytes` (always by at least one unit) and marks it once. */
  readonly cut: (bytes: number) => void
}

// Units kept before the first difference of a `before`/`after` pair, so a cut shows the change.
const windowLeadChars = 64

const windowLeadItems = 2

/**
 * A string or item array cut to one window `[start, start + kept)` of its original units. The
 * first cut starts the window at `start`; every cut keeps strictly fewer units than before.
 */
const windowSlot = <Unit, Value>(input: {
  readonly units: ReadonlyArray<Unit>
  readonly unit: 'chars' | 'items'
  readonly start: number
  /** Encoded bytes one unit adds to the value's JSON (separators included). */
  readonly unitBytes: (unit: Unit) => number
  readonly render: (units: ReadonlyArray<Unit>) => Value
  readonly set: (value: Value) => void
  readonly mark: (cut: ToolChangeCut) => void
}): Slot => {
  const { units, start } = input
  let kept: number | undefined
  // Encoded size of every unit, measured once on the first cut.
  let sizes: ReadonlyArray<number> | undefined

  const current = () => (kept === undefined ? units : units.slice(start, start + kept))

  return {
    bytes: () => jsonBytes(input.render(current())),
    shrinkable: () => (kept === undefined ? units.length > 0 : kept > 0),
    cut: bytes => {
      sizes ??= units.map(input.unitBytes)

      const unitSizes = sizes
      const windowLength = units.length - start
      const from = kept === undefined ? 0 : start
      const to = kept === undefined ? units.length : start + kept
      // The most units the cut may keep: strictly fewer than now.
      const most = kept === undefined ? (start > 0 ? windowLength : windowLength - 1) : kept - 1
      let budget = -bytes

      for (let index = from; index < to; index += 1) budget += unitSizes[index] ?? 0

      let fitting = 0
      let used = 0

      while (fitting < most) {
        used += unitSizes[start + fitting] ?? 0

        if (used > budget) break

        fitting += 1
      }

      if (kept === undefined)
        input.mark(
          start > 0
            ? { unit: input.unit, originalSize: units.length, offset: start }
            : { unit: input.unit, originalSize: units.length }
        )

      kept = fitting
      input.set(input.render(current()))
    }
  }
}

const stringSlot = (
  text: string,
  start: number,
  set: (value: string) => void,
  mark: (cut: ToolChangeCut) => void
): Slot =>
  windowSlot({
    units: Array.from(text),
    unit: 'chars',
    start,
    unitBytes: encodedCharBytes,
    render: characters => characters.join(''),
    set,
    mark
  })

const itemsSlot = (
  items: ReadonlyArray<ToolChangeItem>,
  start: number,
  set: (value: ReadonlyArray<ToolChangeItem>) => void,
  mark: (cut: ToolChangeCut) => void
): Slot =>
  windowSlot({
    units: items,
    unit: 'items',
    start,
    unitBytes: item => jsonBytes(item) + 1,
    render: kept => kept,
    set,
    mark
  })

const structuredSlot = (
  value: Schema.Json,
  set: (value: null) => void,
  mark: (cut: ToolChangeCut) => void
): Slot => {
  let cut = false

  return {
    bytes: () => (cut ? 4 : jsonBytes(value)),
    shrinkable: () => !cut && value !== null,
    cut: () => {
      mark({ unit: 'bytes', originalSize: jsonBytes(value) })
      set(null)
      cut = true
    }
  }
}

// A value the hook already cut keeps its own original size, and the offsets add up. A hook marker
// in another unit cannot be composed and is kept as the hook wrote it.
const composeCut = (existing: ToolChangeCut | undefined, cut: ToolChangeCut): ToolChangeCut => {
  if (existing === undefined) return cut

  if (existing.unit !== cut.unit) return existing

  const offset = (existing.offset ?? 0) + (cut.offset ?? 0)

  return offset > 0
    ? { unit: existing.unit, originalSize: existing.originalSize, offset }
    : { unit: existing.unit, originalSize: existing.originalSize }
}

const commonPrefix = <Unit>(
  left: ReadonlyArray<Unit>,
  right: ReadonlyArray<Unit>,
  same: (left: Unit, right: Unit) => boolean
) => {
  let index = 0

  while (index < left.length && index < right.length) {
    const a = left[index]
    const b = right[index]

    if (a === undefined || b === undefined || !same(a, b)) break

    index += 1
  }

  return index
}

// Where both windows of a `before`/`after` pair start: a little before their first difference.
const pairStart = <Unit>(
  before: ReadonlyArray<Unit> | undefined,
  after: ReadonlyArray<Unit>,
  lead: number,
  same: (left: Unit, right: Unit) => boolean
) => (before === undefined ? 0 : Math.max(0, commonPrefix(before, after, same) - lead))

const sameItem = (left: ToolChangeItem, right: ToolChangeItem) =>
  left.id === right.id && left.label === right.label

const charsStart = (before: string | undefined, after: string) =>
  pairStart(
    before === undefined ? undefined : Array.from(before),
    Array.from(after),
    windowLeadChars,
    (left, right) => left === right
  )

type ChangeDraft = {
  readonly change: () => ToolFieldChange
  readonly slots: ReadonlyArray<Slot>
  /** Drops `Set.unchanged` (context only), marking it. */
  readonly dropUnchanged: () => void
}

const withSideCuts = <
  Change extends ToolValueChange | ToolTextChange | ToolListChange | ToolStructuredChange
>(
  draft: Change,
  cuts: SideCuts
): Change => (Object.keys(cuts).length === 0 ? draft : { ...draft, truncated: cuts })

const withSetCuts = (draft: ToolSetChange, cuts: SetCuts): ToolSetChange =>
  Object.keys(cuts).length === 0 ? draft : { ...draft, truncated: cuts }

const valueDraft = (change: ToolValueChange): ChangeDraft => {
  const draft: Mutable<typeof change> = { ...change }
  const cuts: SideCuts = { ...change.truncated }
  const before = Predicate.isString(change.before) ? change.before : undefined
  const after = Predicate.isString(change.after) ? change.after : undefined
  const start = after === undefined ? 0 : charsStart(before, after)

  return {
    change: () => withSideCuts(draft, cuts),
    dropUnchanged: () => undefined,
    slots: [
      ...(before === undefined
        ? []
        : [
            stringSlot(
              before,
              start,
              value => {
                draft.before = value
              },
              cut => {
                cuts.before = composeCut(cuts.before, cut)
              }
            )
          ]),
      ...(after !== undefined
        ? [
            stringSlot(
              after,
              start,
              value => {
                draft.after = value
              },
              cut => {
                cuts.after = composeCut(cuts.after, cut)
              }
            )
          ]
        : [])
    ]
  }
}

const textDraft = (change: ToolTextChange): ChangeDraft => {
  const draft: Mutable<typeof change> = { ...change }
  const cuts: SideCuts = { ...change.truncated }
  const start = charsStart(change.before, change.after)

  return {
    change: () => withSideCuts(draft, cuts),
    dropUnchanged: () => undefined,
    slots: [
      ...(change.before === undefined
        ? []
        : [
            stringSlot(
              change.before,
              start,
              value => {
                draft.before = value
              },
              cut => {
                cuts.before = composeCut(cuts.before, cut)
              }
            )
          ]),
      stringSlot(
        change.after,
        start,
        value => {
          draft.after = value
        },
        cut => {
          cuts.after = composeCut(cuts.after, cut)
        }
      )
    ]
  }
}

const setDraft = (change: ToolSetChange): ChangeDraft => {
  const draft: Mutable<typeof change> = { ...change }
  const cuts: SetCuts = { ...change.truncated }

  return {
    change: () => withSetCuts(draft, cuts),
    dropUnchanged: () => {
      const unchanged = draft.unchanged

      if (unchanged === undefined || unchanged.length === 0) return

      cuts.unchanged = composeCut(cuts.unchanged, {
        unit: 'items',
        originalSize: unchanged.length
      })
      draft.unchanged = []
    },
    slots: [
      itemsSlot(
        change.added,
        0,
        value => {
          draft.added = value
        },
        cut => {
          cuts.added = composeCut(cuts.added, cut)
        }
      ),
      itemsSlot(
        change.removed,
        0,
        value => {
          draft.removed = value
        },
        cut => {
          cuts.removed = composeCut(cuts.removed, cut)
        }
      )
    ]
  }
}

const listDraft = (change: ToolListChange): ChangeDraft => {
  const draft: Mutable<typeof change> = { ...change }
  const cuts: SideCuts = { ...change.truncated }
  const start = pairStart(change.before, change.after, windowLeadItems, sameItem)

  return {
    change: () => withSideCuts(draft, cuts),
    dropUnchanged: () => undefined,
    slots: [
      ...(change.before === undefined
        ? []
        : [
            itemsSlot(
              change.before,
              start,
              value => {
                draft.before = value
              },
              cut => {
                cuts.before = composeCut(cuts.before, cut)
              }
            )
          ]),
      itemsSlot(
        change.after,
        start,
        value => {
          draft.after = value
        },
        cut => {
          cuts.after = composeCut(cuts.after, cut)
        }
      )
    ]
  }
}

const structuredDraft = (change: ToolStructuredChange): ChangeDraft => {
  const draft: Mutable<typeof change> = { ...change }
  const cuts: SideCuts = { ...change.truncated }

  return {
    change: () => withSideCuts(draft, cuts),
    dropUnchanged: () => undefined,
    slots: [
      ...(change.before === undefined
        ? []
        : [
            structuredSlot(
              change.before,
              value => {
                draft.before = value
              },
              cut => {
                cuts.before = composeCut(cuts.before, cut)
              }
            )
          ]),
      structuredSlot(
        change.after,
        value => {
          draft.after = value
        },
        cut => {
          cuts.after = composeCut(cuts.after, cut)
        }
      )
    ]
  }
}

const draftOf = (change: ToolFieldChange): ChangeDraft =>
  Match.value(change).pipe(
    Match.tagsExhaustive({
      Value: valueDraft,
      Text: textDraft,
      Set: setDraft,
      List: listDraft,
      Structured: structuredDraft
    })
  )

// Room left for the marker each cut adds, so a round usually fits.
const markerReserveBytes = 64

/**
 * The largest per-value size `cap` such that capping every value at it keeps their total within
 * `budget`: values below the cap stay whole, larger ones share what is left equally.
 */
const waterLevel = (sizes: ReadonlyArray<number>, budget: number) => {
  const sorted = [...sizes].sort((left, right) => left - right)
  let remaining = Math.max(0, budget)

  for (const [index, size] of sorted.entries()) {
    const left = sorted.length - index

    if (size * left >= remaining) return Math.floor(remaining / left)

    remaining -= size
  }

  return sorted[sorted.length - 1] ?? 0
}

/**
 * A preview within `maxBytes` UTF-8 bytes of compact JSON, deterministically: an unchanged
 * preview when it fits; otherwise every `Set.unchanged` is dropped first (context only), then the
 * values are cut in rounds until the preview fits: each round caps every cuttable value at one
 * shared size (smaller values stay whole, larger ones get an equal share). Strings and item
 * arrays keep one window (`chars`, `items`) that, for a `before`/`after` pair, starts shortly
 * before their first difference (`offset`), and `Structured` values over the cap are replaced by
 * `null` (`bytes`). Every cut value gets a `truncated` marker
 * with its original size; nothing is cut silently. Labels, the target, `summary`, `warnings`, and
 * `blocked` are never cut: when the preview still does not fit with every value at its minimum,
 * it fails with `too_large` (hosts show the raw arguments).
 */
export const boundToolChangePreview = (
  preview: ToolChangePreview,
  maxBytes: number
): Result.Result<ToolChangePreview, ToolChangePreviewError> => {
  if (jsonBytes(preview) <= maxBytes) return Result.succeed(preview)

  const drafts = preview.changes.map(draftOf)
  const current = (): ToolChangePreview => ({ ...preview, changes: drafts.map(d => d.change()) })

  for (const draft of drafts) draft.dropUnchanged()

  const slots = drafts.flatMap(draft => draft.slots)
  let size = jsonBytes(current())

  while (size > maxBytes) {
    const shrinkable = slots.filter(slot => slot.shrinkable())

    if (shrinkable.length === 0)
      return Result.fail(
        new ToolChangePreviewError({
          cause: 'too_large',
          message: `The change preview exceeds ${maxBytes} bytes even with every value truncated.`
        })
      )

    const sizes = shrinkable.map(slot => slot.bytes())
    const need = size - maxBytes + markerReserveBytes * shrinkable.length
    const cap = waterLevel(sizes, sizes.reduce((total, bytes) => total + bytes, 0) - need)
    let cut = false

    shrinkable.forEach((slot, index) => {
      const bytes = sizes[index] ?? 0

      if (bytes > cap) {
        slot.cut(bytes - cap)
        cut = true
      }
    })

    // Every round shrinks at least one value, so the loop ends.
    if (!cut) shrinkable[sizes.indexOf(Math.max(...sizes))]?.cut(need)

    size = jsonBytes(current())
  }

  return Result.succeed(current())
}

const byItemId = (left: ToolChangeItem, right: ToolChangeItem) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : left.label < right.label ? -1 : 1

// `Set.unchanged` is per-target context, so it never splits otherwise identical changes; set
// members are unordered, so they are hashed sorted by id.
const signatureChange = (change: ToolFieldChange) => {
  if (!Predicate.isTagged(change, 'Set')) return change

  const { unchanged: _unchanged, truncated, ...rest } = change

  const sorted = {
    ...rest,
    added: [...rest.added].sort(byItemId),
    removed: [...rest.removed].sort(byItemId)
  }

  if (truncated === undefined) return sorted

  const { unchanged: _unchangedCut, ...cuts } = truncated

  return Object.keys(cuts).length === 0 ? sorted : { ...sorted, truncated: cuts }
}

/**
 * Stable digest of what a preview changes, ignoring its target, summary, warnings, `blocked`, and
 * `Set.unchanged`: lower-case hex SHA-256 of the canonical JSON (sorted keys) of `changes`, with
 * `Set` members sorted by id. Previews of one tool with the same signature make the same change
 * on different targets. A grouping key, not a security boundary. A truncated preview's signature
 * covers only what was kept, so `groupToolChangePreviews` never groups truncated previews.
 */
export const toolChangeSignature = (preview: ToolChangePreview): string =>
  sha256HexSync(canonicalToolArguments(preview.changes.map(signatureChange)))

/** Whether the bound cut any value of the preview (a dropped `Set.unchanged` does not count). */
export const isToolChangePreviewTruncated = (preview: ToolChangePreview): boolean =>
  preview.changes.some(change =>
    Predicate.isTagged(change, 'Set')
      ? change.truncated?.added !== undefined || change.truncated?.removed !== undefined
      : change.truncated !== undefined &&
        (change.truncated.before !== undefined || change.truncated.after !== undefined)
  )

/** Entries of one tool that make the same change (`toolChangeSignature`). */
export type ToolChangeGroup<Entry> = {
  readonly toolName: string
  readonly signature: string
  /** The changes of the group's first entry (`Set.unchanged` may differ per entry). */
  readonly changes: ReadonlyArray<ToolFieldChange>
  readonly entries: ReadonlyArray<Entry>
}

/**
 * Groups entries (for example `ToolPlanPreview`s that have a `preview`, or pending approval
 * requests mapped to `{ toolName, preview }`) by tool name and `toolChangeSignature`, in order of
 * first appearance, keeping input order within a group. Truncated previews
 * (`isToolChangePreviewTruncated`) always get their own group: their cut parts could differ.
 * `warnings` and `blocked` stay per entry, so a group can mix selectable and blocked rows. Pure;
 * group across every page of a paged plan, not per page.
 */
export const groupToolChangePreviews = <
  Entry extends { readonly toolName: string; readonly preview: ToolChangePreview }
>(
  entries: ReadonlyArray<Entry>
): ReadonlyArray<ToolChangeGroup<Entry>> => {
  const groups: Array<ToolChangeGroup<Entry> & { readonly entries: Array<Entry> }> = []
  const byKey = new Map<string, ToolChangeGroup<Entry> & { readonly entries: Array<Entry> }>()

  for (const entry of entries) {
    const signature = toolChangeSignature(entry.preview)
    const key = JSON.stringify([entry.toolName, signature])
    const existing = isToolChangePreviewTruncated(entry.preview) ? undefined : byKey.get(key)

    if (existing !== undefined) {
      existing.entries.push(entry)
      continue
    }

    const group = {
      toolName: entry.toolName,
      signature,
      changes: entry.preview.changes,
      entries: [entry]
    }

    groups.push(group)

    if (!isToolChangePreviewTruncated(entry.preview)) byKey.set(key, group)
  }

  return groups
}

const decodePreview = Schema.decodeUnknownEffect(ToolChangePreview)

const previewError = (cause: ToolChangePreviewError['cause'], message: string) =>
  new ToolChangePreviewError({
    cause,
    message: truncateCodePoints(message, toolChangePreviewMaxErrorChars)
  })

/**
 * Runs one tool's change preview hook for approvals and plan reviews: bounded by `timeoutMs`,
 * failures and defects become `failed`, the result is decoded as a `ToolChangePreview`
 * (`invalid`; excess keys are dropped), then bounded to `maxBytes` (`too_large`). Interruption is
 * preserved. Internal to `tools`.
 */
export const runToolChangePreview = (input: {
  readonly tool: string
  readonly preview: Effect.Effect<ToolChangePreview, ToolError>
  readonly maxBytes: number
  readonly timeoutMs: number
}): Effect.Effect<ToolChangePreview, ToolChangePreviewError> =>
  Effect.suspend(() => input.preview).pipe(
    Effect.mapError(error => previewError('failed', error.message)),
    Effect.tapDefect(defect =>
      Effect.logWarning(`The change preview of ${input.tool} failed`, defect)
    ),
    Effect.catchDefect(() =>
      Effect.fail(previewError('failed', `The change preview of ${input.tool} failed.`))
    ),
    Effect.timeoutOption(input.timeoutMs),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            previewError(
              'timeout',
              `The change preview of ${input.tool} took longer than ${input.timeoutMs} ms.`
            )
          ),
        onSome: preview =>
          decodePreview(preview).pipe(
            Effect.mapError(error =>
              previewError('invalid', `Invalid change preview of ${input.tool}: ${error.message}`)
            )
          )
      })
    ),
    Effect.flatMap(preview => Effect.fromResult(boundToolChangePreview(preview, input.maxBytes)))
  )

/** `ToolChangePreviewOptions` with defaults applied. Internal to `tools`. */
export type ResolvedToolChangePreviewOptions = {
  readonly maxBytes: number
  readonly timeoutMs: number
}

/** Resolved `ToolChangePreviewOptions`. Internal to `tools`. */
export const resolveToolChangePreviewOptions = (
  options: ToolChangePreviewOptions | undefined
): ResolvedToolChangePreviewOptions => {
  const maxBytes = options?.maxBytes
  const timeoutMs = options?.timeoutMs

  return {
    maxBytes:
      maxBytes !== undefined && Number.isFinite(maxBytes)
        ? Math.max(minToolChangePreviewMaxBytes, Math.floor(maxBytes))
        : defaultToolChangePreviewMaxBytes,
    timeoutMs:
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : defaultToolChangePreviewTimeoutMs
  }
}
