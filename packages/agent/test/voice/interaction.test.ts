import { Effect, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { InteractionDescriptor, ToolDef } from '@yolk-sdk/agent/protocol'
import { ToolError, ToolExecutor } from '@yolk-sdk/agent/loop'
import { VoiceToolCall } from '../../src/voice/index.ts'
import {
  decideVoiceToolCall,
  handleVoiceToolCall,
  voiceInteractionUnsupportedMessage,
  type VoiceToolCallDecision
} from '../../src/voice/tool-server.ts'
import { toOpenAiRealtimeToolEffect } from '../../src/providers/openai/realtime/session-config.ts'

const interactionDef = ToolDef.make({
  name: 'document',
  description: 'Let the user review and file a document.',
  parameters: {},
  interaction: InteractionDescriptor.make({
    kind: 'document-editor',
    actions: [{ id: 'publish', label: 'Publish' }]
  })
})

const call = VoiceToolCall.make({
  callId: 'call_doc',
  name: 'document',
  argumentsJson: '{"title":"Edited title"}'
})

describe('interaction voice denial', () => {
  it('denies interaction tools before approval matching', () => {
    const decision: VoiceToolCallDecision = decideVoiceToolCall([interactionDef], call)

    expect(Predicate.isTagged(decision, 'Deny')).toBe(true)

    if (Predicate.isTagged(decision, 'Deny')) {
      expect(decision.reason).toBe(voiceInteractionUnsupportedMessage)
    }
  })

  it.effect('returns a model-visible denial without executing', () =>
    Effect.gen(function* () {
      let executed = false

      const outcome = yield* handleVoiceToolCall({
        call,
        tools: [interactionDef]
      }).pipe(
        Effect.provideService(
          ToolExecutor,
          ToolExecutor.of({
            execute: current =>
              Effect.sync(() => {
                executed = true

                return current
              }).pipe(
                Effect.flatMap(current =>
                  Effect.fail(
                    new ToolError({
                      tool: current.name,
                      cause: 'execution',
                      message: 'must not execute'
                    })
                  )
                )
              )
          })
        )
      )

      expect(Predicate.isTagged(outcome, 'Denied')).toBe(true)

      expect(executed).toBe(false)
    })
  )

  it.effect('rejects interaction tools in realtime session config', () =>
    Effect.gen(function* () {
      const error = yield* toOpenAiRealtimeToolEffect(interactionDef).pipe(Effect.flip)

      expect(error.message).toContain('not supported in voice sessions')
    })
  )
})
