import * as Schema from 'effect/Schema'
import type { ToolDef } from '@yolk/agent/protocol'

export type OpenAiRealtimeVoice = 'marin' | 'cedar'
export type OpenAiRealtimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export const OpenAiRealtimeTranscriptionModelSchema = Schema.Literals([
  'gpt-realtime-whisper',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15'
])
export type OpenAiRealtimeTranscriptionModel = typeof OpenAiRealtimeTranscriptionModelSchema.Type

type PromptedOpenAiRealtimeTranscriptionModel = Exclude<
  OpenAiRealtimeTranscriptionModel,
  'gpt-realtime-whisper'
>

type OpenAiRealtimeRealtimeWhisperTranscription = {
  readonly model: 'gpt-realtime-whisper'
  readonly language: 'en'
}

type OpenAiRealtimePromptedTranscription = {
  readonly model: PromptedOpenAiRealtimeTranscriptionModel
  readonly language: 'en'
  readonly prompt: string
}

export type OpenAiRealtimeInputTranscription =
  | OpenAiRealtimeRealtimeWhisperTranscription
  | OpenAiRealtimePromptedTranscription

export type OpenAiRealtimeTranscriptionModelOption = {
  readonly model: OpenAiRealtimeTranscriptionModel
  readonly label: string
  readonly description: string
}

export type OpenAiRealtimeFunctionTool = {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export type OpenAiRealtimeSessionConfig = {
  readonly type: 'realtime'
  readonly model: string
  readonly output_modalities: ReadonlyArray<'audio'>
  readonly audio: {
    readonly input: {
      readonly transcription: OpenAiRealtimeInputTranscription
      readonly turn_detection: {
        readonly type: 'server_vad'
        readonly threshold: 0.5
        readonly prefix_padding_ms: 500
        readonly silence_duration_ms: 700
      }
    }
    readonly output: {
      readonly voice: OpenAiRealtimeVoice
    }
  }
  readonly instructions: string
  readonly tools: ReadonlyArray<OpenAiRealtimeFunctionTool>
  readonly tool_choice: 'auto'
  readonly reasoning: {
    readonly effort: OpenAiRealtimeReasoningEffort
  }
}

export type OpenAiRealtimeSessionConfigInput = {
  readonly instructions: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model?: string
  readonly voice?: OpenAiRealtimeVoice
  readonly reasoningEffort?: OpenAiRealtimeReasoningEffort
  readonly transcriptionModel?: OpenAiRealtimeTranscriptionModel
}

export const openAiRealtimeModel = 'gpt-realtime-2'
export const defaultOpenAiRealtimeVoice: OpenAiRealtimeVoice = 'marin'
export const defaultOpenAiRealtimeReasoningEffort: OpenAiRealtimeReasoningEffort = 'low'
export const defaultOpenAiRealtimeTranscriptionModel: OpenAiRealtimeTranscriptionModel =
  'gpt-realtime-whisper'
export const openAiRealtimeTranscriptionPrompt = 'Transcribe English speech. Preserve exact words.'
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

const makeOpenAiRealtimeInputTranscription = (
  model: OpenAiRealtimeTranscriptionModel
): OpenAiRealtimeInputTranscription => {
  switch (model) {
    case 'gpt-realtime-whisper':
      return { model, language: 'en' }
    case 'gpt-4o-transcribe':
    case 'gpt-4o-mini-transcribe':
    case 'gpt-4o-mini-transcribe-2025-12-15':
      return { model, language: 'en', prompt: openAiRealtimeTranscriptionPrompt }
  }
}

export const toOpenAiRealtimeTool = (tool: ToolDef): OpenAiRealtimeFunctionTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
})

export const makeOpenAiRealtimeSessionConfig = ({
  instructions,
  tools,
  model = openAiRealtimeModel,
  voice = defaultOpenAiRealtimeVoice,
  reasoningEffort = defaultOpenAiRealtimeReasoningEffort,
  transcriptionModel = defaultOpenAiRealtimeTranscriptionModel
}: OpenAiRealtimeSessionConfigInput): OpenAiRealtimeSessionConfig => ({
  type: 'realtime',
  model,
  output_modalities: ['audio'],
  audio: {
    input: {
      transcription: makeOpenAiRealtimeInputTranscription(transcriptionModel),
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 500,
        silence_duration_ms: 700
      }
    },
    output: {
      voice
    }
  },
  instructions,
  tools: tools.map(toOpenAiRealtimeTool),
  tool_choice: 'auto',
  reasoning: {
    effort: reasoningEffort
  }
})
