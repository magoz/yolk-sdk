// @vitest-environment node
import { describe, expect, it } from '@effect/vitest'
import { AgentRuntimeInfo } from './agent-runtime-info'

describe('shared runtime information', () => {
  it('constructs plain serializable props without importing a client component', () => {
    const values = [
      AgentRuntimeInfo.Next({ label: 'Next', detail: 'Next detail' }),
      AgentRuntimeInfo.Cloudflare({
        label: 'Cloudflare',
        detail: 'Cloudflare detail',
        webSocketUrl: 'wss://agent.example.test/connect/session'
      }),
      AgentRuntimeInfo.Workflow({ label: 'Workflow', detail: 'Workflow detail' })
    ]

    expect(values).toEqual([
      { _tag: 'Next', label: 'Next', detail: 'Next detail' },
      {
        _tag: 'Cloudflare',
        label: 'Cloudflare',
        detail: 'Cloudflare detail',
        webSocketUrl: 'wss://agent.example.test/connect/session'
      },
      { _tag: 'Workflow', label: 'Workflow', detail: 'Workflow detail' }
    ])

    for (const value of values) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
      expect(structuredClone(value)).toEqual(value)
    }
  })
})
