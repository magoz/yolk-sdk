import * as Schema from 'effect/Schema'
import type { ToolDef } from '@yolk-sdk/agent/protocol'
import type { VoiceSessionConfig } from '@yolk-sdk/agent/voice'

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

const isOpenAiRealtimeVoice = (value: string): value is OpenAiRealtimeVoice =>
  value === 'marin' || value === 'cedar'

const decodeTranscriptionModel = Schema.decodeUnknownOption(OpenAiRealtimeTranscriptionModelSchema)

/**
 * Lower a provider-neutral `VoiceSessionConfig` into the OpenAI Realtime
 * session payload. Unsupported values fall back to OpenAI defaults; tools are
 * passed separately because host toolset resolution owns them.
 */
export const openAiRealtimeSessionConfigFromVoice = (
  config: VoiceSessionConfig,
  tools: ReadonlyArray<ToolDef>
): OpenAiRealtimeSessionConfig => {
  const transcriptionModel =
    config.inputTranscription === undefined
      ? undefined
      : decodeTranscriptionModel(config.inputTranscription.model)

  return makeOpenAiRealtimeSessionConfig({
    instructions: config.instructions,
    tools,
    model: config.model,
    voice:
      config.voice !== undefined && isOpenAiRealtimeVoice(config.voice) ? config.voice : undefined,
    transcriptionModel:
      transcriptionModel !== undefined && transcriptionModel._tag === 'Some'
        ? transcriptionModel.value
        : undefined
  })
}
