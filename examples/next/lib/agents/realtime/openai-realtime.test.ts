import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { resolveAgentTools } from '@/lib/agents/tools/registry'
import { makeOpenAiRealtimeSessionConfig } from './openai-realtime'

describe('makeOpenAiRealtimeSessionConfig', () => {
  it.effect('configures gpt-realtime-2 with resolved app tools', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentTools({
        surface: 'voice',
        route: '/agent',
        userId: 'user_1'
      })
      const config = makeOpenAiRealtimeSessionConfig({
        instructions: 'Be brief.',
        tools: toolSet.tools
      })

      expect(config).toMatchObject({
        type: 'realtime',
        model: 'gpt-realtime-2',
        output_modalities: ['audio'],
        tool_choice: 'auto',
        reasoning: { effort: 'low' }
      })
      expect(config.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
    })
  )
})
