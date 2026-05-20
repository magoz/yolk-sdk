import { describe, expect, it } from '@effect/vitest'
import { decodeOpenAiRealtimeServerEvent } from './openai-realtime-events'

describe('decodeOpenAiRealtimeServerEvent', () => {
  it('keeps input transcript metadata', () => {
    const event = decodeOpenAiRealtimeServerEvent(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'Can you hear me?'
      })
    )

    expect(event).toMatchObject({
      _tag: 'InputAudioTranscriptionCompleted',
      itemId: 'item_1',
      transcript: 'Can you hear me?'
    })
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

    expect(event).toMatchObject({
      _tag: 'OutputAudioTranscriptDone',
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

    expect(event).toMatchObject({
      _tag: 'SessionConfigured',
      eventType: 'session.updated',
      model: 'gpt-realtime-2',
      transcriptionModel: 'gpt-4o-transcribe',
      transcriptionLanguage: 'en'
    })
  })
})
