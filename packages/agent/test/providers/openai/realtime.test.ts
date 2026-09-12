import { describe, expect, it } from '@effect/vitest'
import { ToolDef } from '@yolk-sdk/agent/protocol'
import {
  VoiceAssistantTranscriptFinal,
  VoiceErrorEvent,
  VoiceInputTranscription,
  VoiceInterrupted,
  VoiceSessionConfig,
  VoiceSessionOpened,
  VoiceToolCall,
  VoiceToolCallsRequested,
  VoiceUserTranscriptDelta
} from '@yolk-sdk/agent/voice'
import {
  decodeOpenAiRealtimeServerEvent,
  makeOpenAiRealtimeFunctionCallOutputEvent,
  makeOpenAiRealtimeSessionConfig,
  OpenAiRealtimeError,
  OpenAiRealtimeIgnored,
  openAiRealtimeSessionConfigFromVoice,
  openAiRealtimeToolParameters,
  openAiRealtimeServerEventToVoiceEvents,
  openAiRealtimeTranscriptionPrompt
} from '../../../src/providers/openai/realtime/index.ts'

describe('decodeOpenAiRealtimeServerEvent', () => {
  it('keeps input transcript metadata', () => {
    const event = decodeOpenAiRealtimeServerEvent(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'Can you hear me?'
      })
    )

    expect(event._tag).toBe('InputAudioTranscriptionCompleted')
    expect(event).toMatchObject({ itemId: 'item_1', transcript: 'Can you hear me?' })
  })

  it('keeps output transcript metadata', () => {
    const event = decodeOpenAiRealtimeServerEvent(
      JSON.stringify({
        type: 'response.audio_transcript.done',
        item_id: 'item_2',
        response_id: 'resp_1',
        transcript: 'Yes, I can hear you.'
      })
    )

    expect(event._tag).toBe('OutputAudioTranscriptDone')
    expect(event).toMatchObject({
      itemId: 'item_2',
      responseId: 'resp_1',
      transcript: 'Yes, I can hear you.'
    })
  })

  it('keeps effective session transcription config', () => {
    const event = decodeOpenAiRealtimeServerEvent(
      JSON.stringify({
        type: 'session.updated',
        session: {
          model: 'gpt-realtime-2',
          audio: {
            input: {
              transcription: {
                model: 'gpt-4o-transcribe',
                language: 'en'
              }
            }
          }
        }
      })
    )

    expect(event._tag).toBe('SessionConfigured')
    expect(event).toMatchObject({
      eventType: 'session.updated',
      model: 'gpt-realtime-2',
      transcriptionModel: 'gpt-4o-transcribe',
      transcriptionLanguage: 'en'
    })
  })

  it('extracts function calls from response.done output', () => {
    const event = decodeOpenAiRealtimeServerEvent(
      JSON.stringify({
        type: 'response.done',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"q":1}' },
            { type: 'message', role: 'assistant', content: [] }
          ]
        }
      })
    )

    expect(event._tag).toBe('FunctionCalls')
    expect(event).toMatchObject({
      calls: [{ callId: 'call_1', name: 'web_search', argumentsJson: '{"q":1}' }]
    })
  })

  it('maps provider errors and ignores unknown payloads', () => {
    expect(
      decodeOpenAiRealtimeServerEvent(
        JSON.stringify({ type: 'error', error: { message: 'session expired' } })
      )
    ).toMatchObject(OpenAiRealtimeError.make({ message: 'session expired' }))
    expect(decodeOpenAiRealtimeServerEvent('not json')).toMatchObject(
      OpenAiRealtimeIgnored.make({})
    )
    expect(
      decodeOpenAiRealtimeServerEvent(JSON.stringify({ type: 'rate_limits.updated' }))
    ).toMatchObject(OpenAiRealtimeIgnored.make({}))
  })
})

describe('openAiRealtimeServerEventToVoiceEvents', () => {
  const decodeToVoice = (raw: string) =>
    openAiRealtimeServerEventToVoiceEvents(decodeOpenAiRealtimeServerEvent(raw))

  it('maps transcripts to voice transcript events', () => {
    expect(
      decodeToVoice(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: 'item_1',
          delta: 'Hel'
        })
      )
    ).toEqual([VoiceUserTranscriptDelta.make({ itemId: 'item_1', delta: 'Hel' })])

    expect(
      decodeToVoice(
        JSON.stringify({
          type: 'response.output_audio_transcript.done',
          item_id: 'item_2',
          response_id: 'resp_1',
          transcript: 'Hi there.'
        })
      )
    ).toEqual([
      VoiceAssistantTranscriptFinal.make({
        itemId: 'item_2',
        responseId: 'resp_1',
        text: 'Hi there.'
      })
    ])
  })

  it('maps same-turn function calls to one tool call batch', () => {
    expect(
      decodeToVoice(
        JSON.stringify({
          type: 'response.done',
          response: {
            output: [
              { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
              { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' }
            ]
          }
        })
      )
    ).toEqual([
      VoiceToolCallsRequested.make({
        calls: [
          VoiceToolCall.make({ callId: 'call_1', name: 'a', argumentsJson: '{}' }),
          VoiceToolCall.make({ callId: 'call_2', name: 'b', argumentsJson: '{}' })
        ]
      })
    ])
  })

  it('maps session config events to SessionOpened and cancelled responses to Interrupted', () => {
    expect(
      decodeToVoice(
        JSON.stringify({ type: 'session.created', session: { model: 'gpt-realtime-2' } })
      )
    ).toEqual([
      VoiceSessionOpened.make({
        model: 'gpt-realtime-2',
        transcriptionModel: null,
        transcriptionLanguage: null
      })
    ])

    expect(
      decodeToVoice(
        JSON.stringify({
          type: 'session.updated',
          session: {
            model: 'gpt-realtime-2',
            audio: { input: { transcription: { model: 'gpt-4o-transcribe', language: 'en' } } }
          }
        })
      )
    ).toEqual([
      VoiceSessionOpened.make({
        model: 'gpt-realtime-2',
        transcriptionModel: 'gpt-4o-transcribe',
        transcriptionLanguage: 'en'
      })
    ])

    expect(
      decodeToVoice(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'resp_1', status: 'cancelled', output: [] }
        })
      )
    ).toEqual([VoiceInterrupted.make({ responseId: 'resp_1' })])

    expect(
      decodeToVoice(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'resp_1', status: 'completed', output: [] }
        })
      )
    ).toEqual([])
  })

  it('maps provider errors to voice error events', () => {
    expect(decodeToVoice(JSON.stringify({ type: 'error', error: { message: 'boom' } }))).toEqual([
      VoiceErrorEvent.make({ code: 'provider_error', message: 'boom' })
    ])
  })
})

describe('makeOpenAiRealtimeSessionConfig', () => {
  const webSearchTool = ToolDef.make({
    name: 'web_search',
    description: 'Search the web',
    parameters: { type: 'object', properties: {} }
  })

  it('configures defaults with function tools', () => {
    const config = makeOpenAiRealtimeSessionConfig({
      instructions: 'Be brief.',
      tools: [webSearchTool]
    })

    expect(config).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2',
      output_modalities: ['audio'],
      tool_choice: 'auto',
      reasoning: { effort: 'low' },
      audio: {
        input: {
          transcription: { model: 'gpt-realtime-whisper', language: 'en' },
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
    expect(config.tools).toEqual([
      {
        type: 'function',
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} }
      }
    ])
  })

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

describe('openAiRealtimeToolParameters', () => {
  // OpenAI Realtime 504s on union-root tool parameters; see the helper's doc.
  it('lowers a union of object variants into one object schema', () => {
    const parameters = {
      anyOf: [
        {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['upsert'] },
            slug: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['operation', 'slug', 'content'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['delete'] },
            slug: { type: 'string' }
          },
          required: ['operation', 'slug'],
          additionalProperties: false
        }
      ]
    }

    expect(openAiRealtimeToolParameters(parameters)).toEqual({
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['upsert', 'delete'] },
        slug: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['operation', 'slug'],
      additionalProperties: false
    })
  })

  it('keeps object-root parameters unchanged', () => {
    const parameters = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    }

    expect(openAiRealtimeToolParameters(parameters)).toBe(parameters)
  })

  it('keeps unions with non-object variants unchanged', () => {
    const parameters = {
      anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }]
    }

    expect(openAiRealtimeToolParameters(parameters)).toBe(parameters)
  })

  it('omits required when no key is shared by every variant', () => {
    const parameters = {
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }
      ]
    }

    expect(openAiRealtimeToolParameters(parameters)).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false
    })
  })

  it('applies the lowering to session config tools', () => {
    const unionTool = ToolDef.make({
      name: 'knowledge_manage',
      description: 'Manage knowledge',
      parameters: {
        anyOf: [
          {
            type: 'object',
            properties: { operation: { type: 'string', enum: ['upsert'] } },
            required: ['operation']
          }
        ]
      }
    })

    const config = makeOpenAiRealtimeSessionConfig({
      instructions: 'Be brief.',
      tools: [unionTool]
    })

    expect(config.tools[0]?.parameters).toEqual({
      type: 'object',
      properties: { operation: { type: 'string', enum: ['upsert'] } },
      required: ['operation'],
      additionalProperties: false
    })
  })
})

describe('openAiRealtimeSessionConfigFromVoice', () => {
  it('lowers provider-neutral config with supported values', () => {
    const config = openAiRealtimeSessionConfigFromVoice(
      VoiceSessionConfig.make({
        model: 'gpt-realtime-2',
        instructions: 'Be brief.',
        voice: 'cedar',
        inputTranscription: VoiceInputTranscription.make({ model: 'gpt-4o-transcribe' })
      }),
      []
    )

    expect(config.model).toBe('gpt-realtime-2')
    expect(config.audio.output.voice).toBe('cedar')
    expect(config.audio.input.transcription.model).toBe('gpt-4o-transcribe')
  })

  it('falls back to defaults for unsupported voice/transcription values', () => {
    const config = openAiRealtimeSessionConfigFromVoice(
      VoiceSessionConfig.make({
        model: 'gpt-realtime-2',
        instructions: 'Be brief.',
        voice: 'alloy',
        inputTranscription: VoiceInputTranscription.make({ model: 'whisper-x' })
      }),
      []
    )

    expect(config.audio.output.voice).toBe('marin')
    expect(config.audio.input.transcription.model).toBe('gpt-realtime-whisper')
  })
})

describe('makeOpenAiRealtimeFunctionCallOutputEvent', () => {
  it('wraps tool output as conversation item create', () => {
    const event = makeOpenAiRealtimeFunctionCallOutputEvent('call_1', '{"result":"ok"}')

    expect(event).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: '{"result":"ok"}' }
    })
  })
})
