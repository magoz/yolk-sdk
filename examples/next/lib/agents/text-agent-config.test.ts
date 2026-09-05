import { describe, expect, it } from '@effect/vitest'
import {
  agentTextModel,
  agentTextModelMaxOutputTokens,
  agentTextModelOptions,
  agentTextModelProvider,
  isAgentTextModel
} from './text-agent-config'

describe('text agent models', () => {
  it.each([
    {
      model: 'astra',
      label: 'OpenAI Astra',
      provider: 'openai-codex',
      maxOutputTokens: 128_000
    },
    {
      model: 'claude-fable-5-1',
      label: 'Claude Fable 5.1',
      provider: 'anthropic-claude',
      maxOutputTokens: 64_000
    }
  ] as const)('exposes and routes $model', option => {
    expect(agentTextModelOptions).toContainEqual(option)
    expect(isAgentTextModel(option.model)).toBe(true)
    expect(agentTextModelProvider(option.model)).toBe(option.provider)
    expect(agentTextModelMaxOutputTokens(option.model)).toBe(option.maxOutputTokens)
  })

  it('preserves the default and existing models', () => {
    expect(agentTextModel).toBe('gpt-5.5')
    expect(isAgentTextModel('gpt-5.5')).toBe(true)
    expect(isAgentTextModel('claude-sonnet-4-6')).toBe(true)
    expect(isAgentTextModel('unknown-model')).toBe(false)
  })
})
