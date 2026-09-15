import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { subagentMetadata } from './subagent-metadata'

const call = (params: unknown) => ToolCall.make({ id: 'subagent-1', name: 'subagent', params })

describe('subagent display metadata', () => {
  it('retains a valid input label beside an invalid sibling', () => {
    expect(
      subagentMetadata(call({ description: 'Inspect files', subagent_type: 7 }), undefined)
    ).toMatchObject({ description: 'Inspect files', subagentType: undefined })
  })

  it('retains valid result fields and independently falls back to input fields', () => {
    expect(
      subagentMetadata(call({ description: 'Input label', subagent_type: 'explore' }), {
        description: 'Result label',
        subagent_type: false,
        subagent_run_id: 'run-1',
        started_at_ms: 0,
        ended_at_ms: 25,
        duration_ms: 'invalid',
        status: 'completed',
        model: 'test-model'
      })
    ).toEqual({
      description: 'Result label',
      subagentType: 'explore',
      subagentRunId: 'run-1',
      startedAtMs: 0,
      endedAtMs: 25,
      durationMs: undefined,
      status: 'completed',
      model: 'test-model'
    })
  })

  it('ignores inherited and accessor fields without invoking getters', () => {
    let reads = 0

    const structured = Object.defineProperties(
      {},
      {
        description: {
          get: () => {
            reads += 1

            return 'getter label'
          }
        },
        status: { value: 'completed', enumerable: false }
      }
    )

    Object.setPrototypeOf(structured, { model: 'inherited model' })

    const params = Object.defineProperty({ description: 'Own label' }, 'subagent_type', {
      get: () => {
        reads += 1

        return 'getter type'
      }
    })

    expect(subagentMetadata(call(params), structured)).toMatchObject({
      description: 'Own label',
      subagentType: undefined,
      status: 'completed',
      model: undefined
    })
    expect(reads).toBe(0)
  })

  it('omits empty text and nonfinite numbers while retaining zero and finite timing', () => {
    expect(
      subagentMetadata(call({ description: 'Fallback' }), {
        description: '',
        subagent_type: '',
        started_at_ms: Number.NaN,
        ended_at_ms: Number.POSITIVE_INFINITY,
        duration_ms: 0
      })
    ).toMatchObject({
      description: 'Fallback',
      subagentType: undefined,
      startedAtMs: undefined,
      endedAtMs: undefined,
      durationMs: 0
    })
  })

  it('handles missing and scalar metadata without inventing values', () => {
    expect(subagentMetadata(call(null), 7)).toEqual({
      description: undefined,
      subagentType: undefined,
      subagentRunId: undefined,
      startedAtMs: undefined,
      endedAtMs: undefined,
      durationMs: undefined,
      status: undefined,
      model: undefined
    })
  })

  it('does not project metadata for other tools', () => {
    expect(
      subagentMetadata(ToolCall.make({ id: 'other-1', name: 'other', params: {} }), {
        description: 'Not a subagent'
      })
    ).toBeUndefined()
  })
})
