import { describe, expect, it } from '@effect/vitest'
import { makeErrorToolResult } from '../../src/protocol'

describe('tool protocol helpers', () => {
  it('creates handled error tool results', () => {
    const result = makeErrorToolResult({
      toolCallId: 'call_1',
      content: 'Missing resource',
      structuredContent: { code: 'missing_resource' }
    })

    expect(result).toMatchObject({
      toolCallId: 'call_1',
      content: 'Missing resource',
      isError: true,
      structuredContent: { code: 'missing_resource' }
    })
  })
})
