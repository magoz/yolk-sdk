import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  emptyNestedToolCallRecorder,
  makeNestedToolCallRecorder,
  nestedToolCallMaxArgsBytes,
  nestedToolCallMaxCalls,
  nestedToolCallMaxErrorChars,
  nestedToolCallMaxTotalArgsBytes,
  nestedToolCallResultFields,
  recordNestedToolCall,
  ToolResult,
  toolResultMessageFromResult,
  type NestedToolCallInput,
  type NestedToolCallRecorder
} from '@yolk-sdk/agent/protocol'

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

const usage = (input: number, output: number) =>
  AgentUsage.make({
    input: AgentInputUsage.make({ total: input }),
    output: AgentOutputUsage.make({ total: output })
  })

const record = (inputs: ReadonlyArray<NestedToolCallInput>): NestedToolCallRecorder =>
  inputs.reduce(recordNestedToolCall, emptyNestedToolCallRecorder)

const nestedCall = (seq: number, args: unknown = { seq }): NestedToolCallInput => ({
  id: `call_parent/${seq}`,
  name: 'lookup',
  args,
  status: 'ok'
})

describe('nested tool call record', () => {
  it('exports the documented bounds', () => {
    expect(nestedToolCallMaxCalls).toBe(256)
    expect(nestedToolCallMaxArgsBytes).toBe(8 * 1024)
    expect(nestedToolCallMaxTotalArgsBytes).toBe(32 * 1024)
    expect(nestedToolCallMaxErrorChars).toBe(500)
  })

  it('records compact arguments, statuses, durations, errors, and summed usage', () => {
    const recorder = record([
      { ...nestedCall(1, { query: 'a', page: 2 }), durationMs: 12, usage: usage(10, 2) },
      { ...nestedCall(2), status: 'error', error: 'upstream down' },
      { ...nestedCall(3), status: 'cancelled', usage: usage(5, 1) }
    ])

    const fields = nestedToolCallResultFields(recorder)

    expect(fields.nestedCalls.complete).toBe(true)
    expect(fields.nestedCalls.calls.map(call => [call.id, call.status, call.args])).toEqual([
      ['call_parent/1', 'ok', '{"query":"a","page":2}'],
      ['call_parent/2', 'error', '{"seq":2}'],
      ['call_parent/3', 'cancelled', '{"seq":3}']
    ])
    expect(fields.nestedCalls.calls[0]?.durationMs).toBe(12)
    expect(fields.nestedCalls.calls[1]?.error).toBe('upstream down')
    expect(fields.usage).toMatchObject({ input: { total: 15 }, output: { total: 3 } })
    expect(Object.hasOwn(fields.nestedCalls.calls[1] ?? {}, 'durationMs')).toBe(false)
    expect(Object.hasOwn(nestedToolCallResultFields(record([nestedCall(1)])), 'usage')).toBe(false)
  })

  it('drops calls past the call bound but keeps their usage', () => {
    const inputs = Array.from({ length: nestedToolCallMaxCalls + 4 }, (_, index) => ({
      ...nestedCall(index + 1),
      usage: usage(1, 1)
    }))

    const fields = nestedToolCallResultFields(record(inputs))

    expect(fields.nestedCalls.calls).toHaveLength(nestedToolCallMaxCalls)
    expect(fields.nestedCalls.calls.at(-1)?.id).toBe(`call_parent/${nestedToolCallMaxCalls}`)
    expect(fields.nestedCalls.complete).toBe(false)
    expect(fields.usage?.input.total).toBe(nestedToolCallMaxCalls + 4)
  })

  it('keeps per-status counts of every call, dropped calls included', () => {
    const statuses = ['ok', 'error', 'cancelled', 'ok', 'ok'] as const

    const recorder = statuses
      .map((status, index) => ({ ...nestedCall(index + 1), status }))
      .reduce(recordNestedToolCall, makeNestedToolCallRecorder({ maxCalls: 2 }))

    const fields = nestedToolCallResultFields(recorder)

    expect(fields.nestedCalls.calls.map(call => call.id)).toEqual([
      'call_parent/1',
      'call_parent/2'
    ])
    expect(fields.nestedCalls.complete).toBe(false)
    expect(fields.nestedCalls.counts).toEqual({ ok: 3, error: 1, cancelled: 1 })
  })

  it('sizes the record from maxCalls while keeping the byte budgets', () => {
    const inputs = Array.from({ length: 768 }, (_, index) => nestedCall(index + 1))

    const fields = nestedToolCallResultFields(
      inputs.reduce(recordNestedToolCall, makeNestedToolCallRecorder({ maxCalls: 768 }))
    )

    const total = fields.nestedCalls.calls.reduce((sum, call) => sum + utf8Bytes(call.args), 0)

    expect(fields.nestedCalls.calls).toHaveLength(768)
    expect(fields.nestedCalls.counts?.ok).toBe(768)
    expect(total).toBeLessThanOrEqual(nestedToolCallMaxTotalArgsBytes)
  })

  it('cuts arguments to the per-call byte bound on character boundaries', () => {
    const big = { text: '😀é'.repeat(4_000) }
    const fields = nestedToolCallResultFields(record([nestedCall(1, big)]))
    const args = fields.nestedCalls.calls[0]?.args ?? ''

    expect(utf8Bytes(args)).toBeLessThanOrEqual(nestedToolCallMaxArgsBytes)
    expect(args.endsWith('…')).toBe(true)
    expect(args.startsWith('{"text":"😀é')).toBe(true)
    // No lone surrogate halves survive the cut.
    expect(args.slice(0, -1)).toBe(Array.from(args.slice(0, -1)).join(''))
    expect(/[\uD800-\uDFFF]$/u.test(args.slice(0, -1))).toBe(false)
    expect(fields.nestedCalls.complete).toBe(false)
  })

  it('cuts arguments to the total byte budget across calls', () => {
    const inputs = Array.from({ length: 6 }, (_, index) =>
      nestedCall(index + 1, 'x'.repeat(7 * 1024))
    )

    const fields = nestedToolCallResultFields(record(inputs))
    const total = fields.nestedCalls.calls.reduce((sum, call) => sum + utf8Bytes(call.args), 0)

    expect(fields.nestedCalls.calls).toHaveLength(6)
    expect(total).toBeLessThanOrEqual(nestedToolCallMaxTotalArgsBytes)
    expect(fields.nestedCalls.calls.at(-1)?.args).toBe('')
    expect(fields.nestedCalls.complete).toBe(false)
  })

  it('cuts errors without marking the record incomplete', () => {
    const fields = nestedToolCallResultFields(
      record([{ ...nestedCall(1), status: 'error', error: 'é'.repeat(2_000) }])
    )

    const error = fields.nestedCalls.calls[0]?.error ?? ''

    expect(Array.from(error)).toHaveLength(nestedToolCallMaxErrorChars)
    expect(error.endsWith('…')).toBe(true)
    expect(fields.nestedCalls.complete).toBe(true)
  })

  it('records unserializable and undefined arguments without throwing', () => {
    const cyclic = { self: {} }
    cyclic.self = cyclic

    const fields = nestedToolCallResultFields(
      record([
        nestedCall(1, cyclic),
        nestedCall(2, BigInt(1)),
        { ...nestedCall(3), args: undefined }
      ])
    )

    expect(fields.nestedCalls.calls.map(call => call.args)).toEqual([
      '[unserializable arguments]',
      '[unserializable arguments]',
      'null'
    ])
  })

  it.effect('round-trips through plain JSON on ToolResult and stays out of transcripts', () =>
    Effect.gen(function* () {
      const result = ToolResult.make({
        toolCallId: 'call_parent',
        content: 'Script completed',
        structuredContent: { value: 1 },
        ...nestedToolCallResultFields(
          record([
            { ...nestedCall(1), durationMs: 3, usage: usage(4, 2) },
            { ...nestedCall(2), status: 'error', error: 'nope' }
          ])
        )
      })

      const encoded = yield* Schema.encodeEffect(ToolResult)(result)
      const plain: unknown = JSON.parse(JSON.stringify(encoded))
      const decoded = yield* Schema.decodeUnknownEffect(ToolResult)(plain)

      expect(decoded).toEqual(result)
      expect(decoded.nestedCalls?.calls[1]?.error).toBe('nope')
      expect(decoded.usage?.input.total).toBe(4)

      const message = toolResultMessageFromResult(decoded)

      expect(Object.hasOwn(message, 'nestedCalls')).toBe(false)
      expect(Object.hasOwn(message, 'usage')).toBe(false)
      expect(JSON.stringify(message)).not.toContain('call_parent/1')
    })
  )
})
