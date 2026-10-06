import { Effect, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolApprovalPolicy, ToolCall } from '@yolk-sdk/agent/protocol'
import {
  boundToolChangePreview,
  defaultToolChangePreviewMaxBytes,
  groupToolChangePreviews,
  isToolChangePreviewTruncated,
  makeTool,
  resolveTools,
  ToolChangePreview,
  toolChangeSignature,
  ToolListChange,
  ToolSetChange,
  ToolStructuredChange,
  ToolTextChange,
  ToolValueChange,
  type ToolChangePreviewOptions,
  type BackgroundToolHost,
  type ToolFieldChange
} from '../../src/tools/index.ts'

const preview = (
  changes: ReadonlyArray<ToolFieldChange>,
  label = 'Record 1'
): ToolChangePreview => ({
  target: { label, kind: 'record', id: label },
  changes
})

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

const bounded = (value: ToolChangePreview, maxBytes: number) => {
  const result = boundToolChangePreview(value, maxBytes)

  if (Result.isFailure(result)) throw new Error(result.failure.message)

  return result.success
}

const allChanges: ReadonlyArray<ToolFieldChange> = [
  ToolValueChange.make({ field: 'status', label: 'Status', before: 'draft', after: 'published' }),
  ToolValueChange.make({ field: 'owner', label: 'Owner', after: null }),
  ToolTextChange.make({ field: 'body', label: 'Body', before: 'Hello', after: 'Hello, world' }),
  ToolSetChange.make({
    field: 'tags',
    label: 'Tags',
    added: [{ id: 't2', label: 'Two' }],
    removed: [{ id: 't1', label: 'One' }],
    unchanged: [{ id: 't3', label: 'Three' }]
  }),
  ToolListChange.make({
    field: 'steps',
    label: 'Steps',
    before: [{ id: 's1', label: 'One' }],
    after: [
      { id: 's1', label: 'One' },
      { id: 's2', label: 'Two' }
    ]
  }),
  ToolStructuredChange.make({
    field: 'content',
    label: 'Content',
    before: { blocks: [] },
    after: { blocks: [{ type: 'paragraph', text: 'Hi' }] },
    summary: 'Adds a paragraph'
  })
]

describe('ToolChangePreview', () => {
  it.effect('round-trips every change variant through JSON', () =>
    Effect.gen(function* () {
      const value = preview(allChanges)

      const decoded = yield* Schema.decodeUnknownEffect(ToolChangePreview)(
        JSON.parse(JSON.stringify(value))
      )

      expect(decoded).toEqual(value)
    })
  )

  it.effect('rejects non-JSON values and unknown variants', () =>
    Effect.gen(function* () {
      const nonFinite = yield* Schema.decodeUnknownEffect(ToolChangePreview)(
        preview([{ _tag: 'Value', field: 'n', label: 'N', after: Number.NaN }])
      ).pipe(Effect.flip)

      const unknownTag = yield* Schema.decodeUnknownEffect(ToolChangePreview)({
        target: { label: 'x' },
        changes: [{ _tag: 'Diff', field: 'x', label: 'X' }]
      }).pipe(Effect.flip)

      expect(nonFinite._tag).toBe('SchemaError')
      expect(unknownTag._tag).toBe('SchemaError')
    })
  )
})

describe('boundToolChangePreview', () => {
  it('keeps a preview that fits unchanged', () => {
    const value = preview(allChanges)

    expect(bounded(value, defaultToolChangePreviewMaxBytes)).toBe(value)
  })

  it('drops Set.unchanged first, with a marker', () => {
    const unchanged = Array.from({ length: 200 }, (_, index) => ({
      id: `u${index}`,
      label: `Unchanged ${index}`
    }))

    const value = preview([
      ToolSetChange.make({
        field: 'tags',
        label: 'Tags',
        added: [{ id: 'a', label: 'A' }],
        removed: [],
        unchanged
      })
    ])

    const result = bounded(value, 1024)

    expect(result.changes).toEqual([
      ToolSetChange.make({
        field: 'tags',
        label: 'Tags',
        added: [{ id: 'a', label: 'A' }],
        removed: [],
        unchanged: [],
        truncated: { unchanged: { unit: 'items', originalSize: 200 } }
      })
    ])
    expect(isToolChangePreviewTruncated(result)).toBe(false)
  })

  it('cuts long text around the first difference so a tail edit stays visible', () => {
    const shared = 'a'.repeat(5000)

    const value = preview([
      ToolTextChange.make({
        field: 'body',
        label: 'Body',
        before: `${shared} old ending`,
        after: `${shared} new ending`
      })
    ])

    const result = bounded(value, 1024)
    const change = result.changes[0]

    expect(bytes(result)).toBeLessThanOrEqual(1024)
    expect(change?._tag).toBe('Text')

    if (change?._tag !== 'Text') return

    expect(change.before).toContain('old ending')
    expect(change.after).toContain('new ending')
    expect(change.truncated).toEqual({
      before: { unit: 'chars', originalSize: 5011, offset: 4937 },
      after: { unit: 'chars', originalSize: 5011, offset: 4937 }
    })
    expect(isToolChangePreviewTruncated(result)).toBe(true)
  })

  it('replaces oversized structured values by null with a byte marker, largest first', () => {
    const blocks = Array.from({ length: 300 }, (_, index) => ({
      type: 'paragraph',
      text: `Block ${index}`
    }))

    const value = preview([
      ToolValueChange.make({
        field: 'status',
        label: 'Status',
        before: 'draft',
        after: 'published'
      }),
      ToolStructuredChange.make({
        field: 'content',
        label: 'Content',
        before: { blocks: [] },
        after: { blocks }
      })
    ])

    const result = bounded(value, 1024)

    expect(result.changes).toEqual([
      ToolValueChange.make({
        field: 'status',
        label: 'Status',
        before: 'draft',
        after: 'published'
      }),
      ToolStructuredChange.make({
        field: 'content',
        label: 'Content',
        before: { blocks: [] },
        after: null,
        truncated: { after: { unit: 'bytes', originalSize: bytes({ blocks }) } }
      })
    ])
  })

  it('keeps item prefixes and is deterministic', () => {
    const items = Array.from({ length: 400 }, (_, index) => ({
      id: `i${index}`,
      label: `Item ${index}`
    }))

    const value = preview([
      ToolSetChange.make({
        field: 'tags',
        label: 'Tags',
        added: items,
        removed: items.slice(0, 10)
      }),
      ToolListChange.make({ field: 'order', label: 'Order', after: items })
    ])

    const first = bounded(value, 4096)
    const second = bounded(value, 4096)

    expect(first).toEqual(second)
    expect(bytes(first)).toBeLessThanOrEqual(4096)

    const [set, list] = first.changes

    expect(set?._tag === 'Set' && set.added.every((item, index) => item.id === `i${index}`)).toBe(
      true
    )
    expect(set?._tag === 'Set' ? set.truncated?.added : undefined).toEqual({
      unit: 'items',
      originalSize: 400
    })
    expect(list?._tag === 'List' ? list.truncated?.after : undefined).toEqual({
      unit: 'items',
      originalSize: 400
    })
  })

  it('keeps the original size and offset of a value that was already cut', () => {
    const shared = 'a'.repeat(5000)

    const value = preview([
      ToolTextChange.make({
        field: 'body',
        label: 'Body',
        before: `${shared} old ending`,
        after: `${shared} new ending`
      })
    ])

    const once = bounded(value, 4096)
    const twice = bounded(once, 1024)
    const change = twice.changes[0]

    expect(change?.truncated).toEqual({
      before: { unit: 'chars', originalSize: 5011, offset: 4937 },
      after: { unit: 'chars', originalSize: 5011, offset: 4937 }
    })
    expect(change?._tag === 'Text' && change.after.endsWith('new ending')).toBe(true)
  })

  it('fails too_large when the parts it never cuts do not fit', () => {
    const value: ToolChangePreview = {
      ...preview([]),
      warnings: Array.from({ length: 100 }, () => 'w'.repeat(100))
    }

    const result = boundToolChangePreview(value, 1024)

    expect(Result.isFailure(result) && result.failure.cause).toBe('too_large')
  })
})

describe('toolChangeSignature and groupToolChangePreviews', () => {
  const setChange = (
    added: ReadonlyArray<string>,
    unchanged: ReadonlyArray<string>
  ): ToolFieldChange =>
    ToolSetChange.make({
      field: 'tags',
      label: 'Tags',
      added: added.map(id => ({ id, label: id.toUpperCase() })),
      removed: [],
      unchanged: unchanged.map(id => ({ id, label: id }))
    })

  it('ignores the target, summary, warnings, blocked, Set order, and Set.unchanged', () => {
    const a = preview([setChange(['x', 'y'], ['k'])], 'Record 1')

    const b: ToolChangePreview = {
      ...preview([setChange(['y', 'x'], ['m', 'n'])], 'Record 2'),
      summary: 'other',
      warnings: ['stale'],
      blocked: 'locked'
    }

    const c = preview([setChange(['x'], [])])

    expect(toolChangeSignature(a)).toBe(toolChangeSignature(b))
    expect(toolChangeSignature(a)).not.toBe(toolChangeSignature(c))
    expect(toolChangeSignature(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it.effect('is independent of object key order', () =>
    Effect.gen(function* () {
      const reordered = yield* Schema.decodeUnknownEffect(ToolChangePreview)(
        JSON.parse(
          '{"target":{"label":"r"},"changes":[{"after":"b","label":"L","field":"f","_tag":"Value","before":"a"}]}'
        )
      )

      expect(toolChangeSignature(reordered)).toBe(
        toolChangeSignature(
          preview([ToolValueChange.make({ field: 'f', label: 'L', before: 'a', after: 'b' })])
        )
      )
    })
  )

  it('groups by tool and signature in first-appearance order, never truncated previews', () => {
    const tagX = preview([setChange(['x'], [])])
    const tagY = preview([setChange(['y'], [])])
    const long = 'z'.repeat(3000)

    const truncated = bounded(
      preview([ToolTextChange.make({ field: 'body', label: 'Body', after: long })]),
      1024
    )

    const groups = groupToolChangePreviews([
      { key: 'k1', toolName: 'tag', preview: tagX },
      { key: 'k2', toolName: 'tag', preview: tagY },
      { key: 'k3', toolName: 'tag', preview: tagX },
      { key: 'k4', toolName: 'label', preview: tagX },
      { key: 'k5', toolName: 'text', preview: truncated },
      { key: 'k6', toolName: 'text', preview: truncated }
    ])

    expect(groups.map(group => [group.toolName, group.entries.map(entry => entry.key)])).toEqual([
      ['tag', ['k1', 'k3']],
      ['tag', ['k2']],
      ['label', ['k4']],
      ['text', ['k5']],
      ['text', ['k6']]
    ])
    expect(groups[0]?.changes).toEqual(tagX.changes)
  })
})

type Ctx = { readonly tenant: string }

const Params = Schema.Struct({ id: Schema.String })

const gated = (
  changePreview: (params: typeof Params.Type) => Effect.Effect<ToolChangePreview, ToolError>,
  options: { readonly approval?: boolean; readonly background?: boolean } = {}
) => {
  const base = {
    name: 'update_record',
    description: 'Update a record',
    parameters: Params,
    access: 'write' as const,
    changePreview: ({ params }: { readonly params: typeof Params.Type }) => changePreview(params),
    execute: () => Effect.die('never runs')
  }

  if (options.approval === false) return makeTool<Ctx, typeof Params>(base)

  return makeTool<Ctx, typeof Params>({
    ...base,
    approval: ToolApprovalPolicy.make({ mode: 'manual' }),
    background: options.background === true
  })
}

const backgroundHost: BackgroundToolHost<Ctx> = {
  accept: () => Effect.die('never accepts')
}

type ResolveFields = {
  changePreview?: ToolChangePreviewOptions
  backgroundHost?: BackgroundToolHost<Ctx>
}

const resolve = (
  tool: ReturnType<typeof gated>,
  options: {
    readonly changePreview?: ToolChangePreviewOptions | undefined
    readonly background?: boolean
  } = {}
) => {
  const fields: ResolveFields = {}

  if (options.changePreview !== undefined) fields.changePreview = options.changePreview

  if (options.background === true) fields.backgroundHost = backgroundHost

  return resolveTools([{ id: 'records', tools: [tool] }], { tenant: 't' }, fields)
}

const call = (params: unknown) => ToolCall.make({ id: 'call_1', name: 'update_record', params })

describe('resolved approval previews', () => {
  it.effect('requires an approval policy', () =>
    Effect.gen(function* () {
      const error = yield* resolve(
        gated(() => Effect.succeed(preview([])), { approval: false })
      ).pipe(Effect.flip)

      expect(error.cause).toBe('change_preview_unsupported_policy')
    })
  )

  it.effect('previews decoded arguments and reports invalid ones without running the hook', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []

      const toolSet = yield* resolve(
        gated(params =>
          Effect.sync(() => {
            seen.push(params.id)

            return preview([ToolValueChange.make({ field: 'id', label: 'Id', after: params.id })])
          })
        )
      )

      const previewer = toolSet.approvalPreviews.update_record

      if (previewer === undefined) throw new Error('missing previewer')

      const ok = yield* previewer(call({ id: 'r1' }))
      const invalid = yield* previewer(call({ id: 1 })).pipe(Effect.flip)

      expect(ok.changes).toEqual([ToolValueChange.make({ field: 'id', label: 'Id', after: 'r1' })])
      expect(invalid.cause).toBe('failed')
      expect(invalid.message).toContain('Invalid update_record arguments')
      expect(seen).toEqual(['r1'])
    })
  )

  it.effect('maps failures, defects, invalid previews, and the byte bound', () =>
    Effect.gen(function* () {
      const run = (
        hook: (params: typeof Params.Type) => Effect.Effect<ToolChangePreview, ToolError>,
        options?: ToolChangePreviewOptions
      ) =>
        Effect.gen(function* () {
          const toolSet = yield* resolve(gated(hook), { changePreview: options })

          const previewer = toolSet.approvalPreviews.update_record

          if (previewer === undefined) throw new Error('missing previewer')

          return yield* previewer(call({ id: 'r1' })).pipe(Effect.flip)
        })

      const failed = yield* run(() =>
        Effect.fail(new ToolError({ tool: 'update_record', cause: 'unavailable', message: 'down' }))
      )

      const defect = yield* run(() => Effect.die(new Error('boom')))

      const invalid = yield* run(() =>
        Effect.succeed(
          preview([{ _tag: 'Value', field: 'n', label: 'N', after: Number.POSITIVE_INFINITY }])
        )
      )

      const tooLarge = yield* run(
        () => Effect.succeed({ ...preview([]), warnings: ['w'.repeat(2000)] }),
        { maxBytes: 1024 }
      )

      expect([failed.cause, failed.message]).toEqual(['failed', 'down'])
      expect(defect.cause).toBe('failed')
      expect(invalid.cause).toBe('invalid')
      expect(tooLarge.cause).toBe('too_large')
    })
  )

  it.effect('previews the business arguments of an activated background call', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolve(
        gated(
          params =>
            Effect.succeed(
              preview([ToolValueChange.make({ field: 'id', label: 'Id', after: params.id })])
            ),
          {
            background: true
          }
        ),
        { background: true }
      )

      const previewer = toolSet.approvalPreviews.update_record

      if (previewer === undefined) throw new Error('missing previewer')

      const ok = yield* previewer(call({ execution: 'background', arguments: { id: 'r9' } }))
      const malformed = yield* previewer(call({ id: 'r9' })).pipe(Effect.flip)

      expect(ok.changes).toEqual([ToolValueChange.make({ field: 'id', label: 'Id', after: 'r9' })])
      expect(malformed.cause).toBe('failed')
    })
  )

  it.effect('times out a slow preview', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolve(
        gated(() => Effect.never),
        { changePreview: { timeoutMs: 1000 } }
      )

      const previewer = toolSet.approvalPreviews.update_record

      if (previewer === undefined) throw new Error('missing previewer')

      const fiber = yield* previewer(call({ id: 'r1' })).pipe(Effect.flip, Effect.forkChild)

      yield* TestClock.adjust(1000)

      const error = yield* Fiber.join(fiber)

      expect(error.cause).toBe('timeout')
    })
  )
})
