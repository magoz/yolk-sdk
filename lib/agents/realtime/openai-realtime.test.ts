import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { resolveAgentTools } from '@/lib/agents/tools/registry'
import {
  makeOpenAiRealtimeSessionConfig,
  openAiRealtimeTranscriptionPrompt
} from './openai-realtime'

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
        reasoning: { effort: 'low' },
        audio: {
          input: {
            transcription: {
              model: 'gpt-realtime-whisper',
              language: 'en'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 500,
              silence_duration_ms: 700
            }
          },
          output: { voice: 'marin' }
        }
      })
      expect(config.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
    })
  )

  it('uses the selected prompted transcription model', () => {
    const config = makeOpenAiRealtimeSessionConfig({
      instructions: 'Be brief.',
      tools: [],
      transcriptionModel: 'gpt-4o-mini-transcribe-2025-12-15'
    })

    expect(config.audio.input.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      language: 'en',
      prompt: openAiRealtimeTranscriptionPrompt
    })
  })

  it('omits prompt for realtime whisper', () => {
    const config = makeOpenAiRealtimeSessionConfig({
      instructions: 'Be brief.',
      tools: [],
      transcriptionModel: 'gpt-realtime-whisper'
    })

    expect(config.audio.input.transcription).toEqual({
      model: 'gpt-realtime-whisper',
      language: 'en'
    })
  })
})
