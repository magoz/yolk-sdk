import { describe, expect, it } from '@effect/vitest'
import { calculatorTools } from '@/lib/agents/tools/calculator-tool'
import { makeOpenAiRealtimeSessionConfig } from './openai-realtime'

describe('makeOpenAiRealtimeSessionConfig', () => {
  it('configures gpt-realtime-2 with app tools', () => {
    const config = makeOpenAiRealtimeSessionConfig({
      instructions: 'Be brief.',
      tools: calculatorTools
    })

    expect(config).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2',
      output_modalities: ['audio'],
      tool_choice: 'auto',
      reasoning: { effort: 'low' },
      audio: {
        input: { turn_detection: { type: 'semantic_vad' } },
        output: { voice: 'marin' }
      }
    })
    expect(config.tools.map(tool => tool.name)).toEqual(['calculate'])
  })
})
