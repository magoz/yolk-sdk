import type { OpenAiRealtimeTranscriptionModel } from '@yolk-sdk/agent/providers/openai/realtime'

export {
  defaultOpenAiRealtimeReasoningEffort,
  defaultOpenAiRealtimeTranscriptionModel,
  defaultOpenAiRealtimeVoice,
  makeOpenAiRealtimeSessionConfig,
  openAiRealtimeModel,
  openAiRealtimeTranscriptionPrompt,
  OpenAiRealtimeTranscriptionModelSchema,
  toOpenAiRealtimeTool,
  type OpenAiRealtimeFunctionTool,
  type OpenAiRealtimeInputTranscription,
  type OpenAiRealtimeReasoningEffort,
  type OpenAiRealtimeSessionConfig,
  type OpenAiRealtimeSessionConfigInput,
  type OpenAiRealtimeTranscriptionModel,
  type OpenAiRealtimeVoice
} from '@yolk-sdk/agent/providers/openai/realtime'

// App-owned UI labels for transcription model selection.
export type OpenAiRealtimeTranscriptionModelOption = {
  readonly model: OpenAiRealtimeTranscriptionModel
  readonly label: string
  readonly description: string
}

export const openAiRealtimeTranscriptionModelOptions: ReadonlyArray<OpenAiRealtimeTranscriptionModelOption> =
  [
    {
      model: 'gpt-realtime-whisper',
      label: 'realtime whisper',
      description: 'Lowest latency streaming transcription.'
    },
    {
      model: 'gpt-4o-transcribe',
      label: '4o transcribe',
      description: 'Higher accuracy English transcription with prompt steering.'
    },
    {
      model: 'gpt-4o-mini-transcribe',
      label: '4o mini',
      description: 'Lower cost transcription.'
    },
    {
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      label: '4o mini 2025-12-15',
      description: 'Latest dated mini transcription snapshot.'
    }
  ]
