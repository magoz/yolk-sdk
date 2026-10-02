import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { ToolExecutor } from '@yolk-sdk/agent/loop'
import {
  decideVoiceToolCall,
  handleVoiceToolCall,
  VoiceSessionConfig,
  VoiceToolCall
} from '../../src/voice/index.ts'
import {
  makeOpenAiRealtimeSessionConfig,
  makeOpenAiRealtimeSessionConfigEffect,
  openAiRealtimeSessionConfigFromVoice,
  openAiRealtimeSessionConfigFromVoiceEffect
} from '../../src/providers/openai/realtime/index.ts'

const visible = ToolDef.make({
  name: 'web_search',
  description: 'Search the web',
  parameters: { type: 'object', properties: {} }
})

const scriptOnly = ToolDef.make({
  name: 'docs_search',
  description: 'Script-only search',
  parameters: { type: 'object', properties: {} },
  callableBy: 'codemode'
})

const tools = [visible, scriptOnly]

const call = VoiceToolCall.make({ callId: 'call_1', name: 'docs_search', argumentsJson: '{}' })

describe('voice code mode exposure', () => {
  it.effect('never advertises codemode-only tools in realtime session configs', () =>
    Effect.gen(function* () {
      const names = (config: { readonly tools: ReadonlyArray<{ readonly name: string }> }) =>
        config.tools.map(tool => tool.name)

      const voiceConfig = VoiceSessionConfig.make({ model: 'gpt-realtime-2', instructions: 'Hi' })

      expect(names(makeOpenAiRealtimeSessionConfig({ instructions: 'Hi', tools }))).toEqual([
        'web_search'
      ])
      expect(
        names(yield* makeOpenAiRealtimeSessionConfigEffect({ instructions: 'Hi', tools }))
      ).toEqual(['web_search'])
      expect(names(openAiRealtimeSessionConfigFromVoice(voiceConfig, tools))).toEqual([
        'web_search'
      ])
      expect(names(yield* openAiRealtimeSessionConfigFromVoiceEffect(voiceConfig, tools))).toEqual([
        'web_search'
      ])
    })
  )

  it.effect('denies provider-issued codemode-only calls without executing', () =>
    Effect.gen(function* () {
      const executed: Array<string> = []

      const executorLayer = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: toolCall => {
            executed.push(toolCall.name)

            return Effect.succeed(ToolResult.make({ toolCallId: toolCall.id, content: 'ran' }))
          }
        })
      )

      expect(decideVoiceToolCall(tools, call)).toMatchObject({
        _tag: 'Deny',
        reason: 'Tool is not configured: docs_search'
      })

      const outcome = yield* handleVoiceToolCall({ call, tools }).pipe(
        Effect.provide(executorLayer)
      )

      expect(outcome._tag).toBe('Denied')
      expect(executed).toEqual([])
    })
  )
})
