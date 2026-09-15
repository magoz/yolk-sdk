import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import {
  QuestionOption,
  QuestionPrompt,
  QuestionRequest,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall
} from '@yolk-sdk/agent/protocol'
import {
  VoiceAwaitingInput,
  VoiceCommand,
  VoiceConnect,
  VoiceEvent,
  VoiceSendText,
  VoiceSessionConfig,
  VoiceSubmitHitlResponse,
  VoiceToolCall,
  VoiceToolCallsRequested,
  VoiceUserTranscriptFinal
} from '../../src/voice/index.ts'

const decodeEvent = Schema.decodeUnknownEffect(VoiceEvent)

const encodeEvent = Schema.encodeEffect(VoiceEvent)

const decodeCommand = Schema.decodeUnknownEffect(VoiceCommand)

const encodeCommand = Schema.encodeEffect(VoiceCommand)

const decodeSessionConfig = Schema.decodeUnknownEffect(VoiceSessionConfig)

const roundTripEvent = (event: VoiceEvent) =>
  Effect.gen(function* () {
    const encoded = yield* encodeEvent(event)
    const wire: unknown = JSON.parse(JSON.stringify(encoded))

    return yield* decodeEvent(wire)
  })

describe('voice protocol', () => {
  it.effect('round-trips voice events through plain JSON', () =>
    Effect.gen(function* () {
      const events: ReadonlyArray<VoiceEvent> = [
        VoiceUserTranscriptFinal.make({ itemId: 'item_1', text: 'Hello' }),
        VoiceToolCallsRequested.make({
          calls: [
            VoiceToolCall.make({
              callId: 'call_1',
              name: 'web_search',
              argumentsJson: '{"query":"weather"}'
            })
          ]
        })
      ]

      for (const event of events) {
        expect(yield* roundTripEvent(event)).toEqual(event)
      }
    })
  )

  it.effect('round-trips awaiting-input events with protocol HITL requests', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'call_1', name: 'sandbox', params: { command: 'ls' } })

      const event = VoiceAwaitingInput.make({
        requests: [
          ToolApprovalRequest.make({
            requestId: 'req_1',
            toolCallId: 'call_1',
            call
          }),
          QuestionRequest.make({
            requestId: 'req_2',
            toolCallId: 'call_2',
            call: ToolCall.make({ id: 'call_2', name: 'question', params: {} }),
            questions: [
              QuestionPrompt.make({
                id: 'q1',
                prompt: 'Which account?',
                options: [QuestionOption.make({ id: 'work', label: 'Work' })]
              })
            ]
          })
        ]
      })

      const decoded = yield* roundTripEvent(event)

      expect(decoded._tag).toBe('AwaitingInput')
      expect(decoded).toEqual(event)
    })
  )

  it.effect('decodes voice commands by tag', () =>
    Effect.gen(function* () {
      const connectEncoded: unknown = JSON.parse(
        JSON.stringify(yield* encodeCommand(VoiceConnect.make({})))
      )

      const sendTextEncoded: unknown = JSON.parse(
        JSON.stringify(yield* encodeCommand(VoiceSendText.make({ text: 'hi' })))
      )

      const hitlEncoded: unknown = JSON.parse(
        JSON.stringify(
          yield* encodeCommand(
            VoiceSubmitHitlResponse.make({
              response: ToolApprovalResponse.make({
                requestId: 'req_1',
                toolCallId: 'call_1',
                decision: 'approved',
                source: 'user'
              })
            })
          )
        )
      )

      const connect = yield* decodeCommand(connectEncoded)
      const sendText = yield* decodeCommand(sendTextEncoded)
      const hitl = yield* decodeCommand(hitlEncoded)

      expect(connect._tag).toBe('Connect')
      expect(sendText).toEqual(VoiceSendText.make({ text: 'hi' }))
      expect(hitl).toBeInstanceOf(VoiceSubmitHitlResponse)
    })
  )

  it.effect('rejects blank session config models and empty command text', () =>
    Effect.gen(function* () {
      const configError = yield* decodeSessionConfig({
        model: '  ',
        instructions: 'Be brief.'
      }).pipe(Effect.flip)

      const commandError = yield* decodeCommand({ _tag: 'SendText', text: '  ' }).pipe(Effect.flip)

      expect(configError._tag).toBe('SchemaError')
      expect(commandError._tag).toBe('SchemaError')
    })
  )
})
