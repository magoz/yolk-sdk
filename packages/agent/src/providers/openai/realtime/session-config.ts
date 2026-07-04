import { Option } from 'effect'
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

type JsonSchemaRecord = Record<string, unknown>

const isJsonSchemaRecord = (value: unknown): value is JsonSchemaRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type ObjectVariant = {
  readonly properties: JsonSchemaRecord
  readonly required: ReadonlyArray<string>
}

const asObjectVariant = (value: unknown): ObjectVariant | undefined => {
  if (!isJsonSchemaRecord(value) || value['type'] !== 'object') {
    return undefined
  }

  const properties = value['properties']

  if (!isJsonSchemaRecord(properties)) {
    return undefined
  }

  const required = Array.isArray(value['required'])
    ? value['required'].filter((key): key is string => typeof key === 'string')
    : []

  return { properties, required }
}

const stringEnumValues = (schema: unknown): ReadonlyArray<string> | undefined => {
  if (!isJsonSchemaRecord(schema) || schema['type'] !== 'string') {
    return undefined
  }

  const values = schema['enum']

  if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
    return undefined
  }

  return values
}

// Same-named string enums union across variants so discriminator properties
// (for example `operation`) keep every variant's value; otherwise the first
// variant's schema wins.
const mergeVariantProperty = (existing: unknown, incoming: unknown): unknown => {
  const existingValues = stringEnumValues(existing)
  const incomingValues = stringEnumValues(incoming)

  if (existingValues === undefined || incomingValues === undefined) {
    return existing
  }

  return { type: 'string', enum: [...new Set([...existingValues, ...incomingValues])] }
}

/**
 * OpenAI Realtime hangs until a gateway timeout (504) on function tools whose
 * `parameters` root is a union (`anyOf`) instead of an object schema. Lower a
 * union of object variants into one object schema: variant properties merge
 * (same-named string enums union), and `required` keeps only keys required by
 * every variant. This widens what the model may produce; hosts still validate
 * real arguments against the original tool schema at execution time.
 */
export const openAiRealtimeToolParameters = (parameters: unknown): unknown => {
  if (!isJsonSchemaRecord(parameters)) {
    return parameters
  }

  const anyOf = parameters['anyOf']

  if (!Array.isArray(anyOf) || anyOf.length === 0) {
    return parameters
  }

  const variants = anyOf.flatMap(value => {
    const variant = asObjectVariant(value)

    return variant === undefined ? [] : [variant]
  })

  if (variants.length !== anyOf.length) {
    return parameters
  }

  const properties: JsonSchemaRecord = {}

  for (const variant of variants) {
    for (const [key, schema] of Object.entries(variant.properties)) {
      properties[key] = key in properties ? mergeVariantProperty(properties[key], schema) : schema
    }
  }

  const required = variants
    .map(variant => variant.required)
    .reduce((shared, keys) => shared.filter(key => keys.includes(key)))

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  }
}

export const toOpenAiRealtimeTool = (tool: ToolDef): OpenAiRealtimeFunctionTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: openAiRealtimeToolParameters(tool.parameters)
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
      ? Option.none<OpenAiRealtimeTranscriptionModel>()
      : decodeTranscriptionModel(config.inputTranscription.model)

  return makeOpenAiRealtimeSessionConfig({
    instructions: config.instructions,
    tools,
    model: config.model,
    voice:
      config.voice !== undefined && isOpenAiRealtimeVoice(config.voice) ? config.voice : undefined,
    transcriptionModel: Option.getOrUndefined(transcriptionModel)
  })
}
