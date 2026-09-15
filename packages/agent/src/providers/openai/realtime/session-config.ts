import { Effect, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolDef } from '@yolk-sdk/agent/protocol'
import { VoiceToolBridgeError, type VoiceSessionConfig } from '@yolk-sdk/agent/voice'
import { backgroundVoiceUnsupportedMessage } from '../../../background-execution-internal.ts'

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
  readonly parameters: Schema.Json
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

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const jsonObjectField = (value: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined

type ObjectVariant = {
  readonly properties: Schema.JsonObject
  readonly required: ReadonlyArray<string>
}

const asObjectVariant = (value: Schema.Json): ObjectVariant | undefined => {
  if (!isJsonObject(value) || jsonObjectField(value, 'type') !== 'object') {
    return undefined
  }

  const properties = jsonObjectField(value, 'properties')

  if (!isJsonObject(properties)) {
    return undefined
  }

  const requiredValue = jsonObjectField(value, 'required')

  const required = Array.isArray(requiredValue)
    ? requiredValue.filter((key): key is string => Predicate.isString(key))
    : []

  return { properties, required }
}

const stringEnumValues = (schema: Schema.Json): ReadonlyArray<string> | undefined => {
  if (!isJsonObject(schema) || jsonObjectField(schema, 'type') !== 'string') {
    return undefined
  }

  const values = jsonObjectField(schema, 'enum')

  if (!Array.isArray(values) || !values.every(value => Predicate.isString(value))) {
    return undefined
  }

  return values
}

type MergedRealtimeStringEnumProperty = {
  readonly type: 'string'
  readonly enum: ReadonlyArray<string>
}

const mergeRealtimeStringEnumProperty = (
  existingValues: ReadonlyArray<string>,
  incomingValues: ReadonlyArray<string>
): MergedRealtimeStringEnumProperty => ({
  type: 'string',
  enum: [...new Set([...existingValues, ...incomingValues])]
})

// Same-named string enums union across variants so discriminator properties
// (for example `operation`) keep every variant's value; otherwise the first
// variant's schema wins.
const mergeVariantProperty = (existing: Schema.Json, incoming: Schema.Json): Schema.Json => {
  const existingValues = stringEnumValues(existing)
  const incomingValues = stringEnumValues(incoming)

  if (existingValues === undefined || incomingValues === undefined) {
    return existing
  }

  return mergeRealtimeStringEnumProperty(existingValues, incomingValues)
}

const openAiRealtimeLoweredObjectParameters = (
  properties: Schema.JsonObject,
  required: ReadonlyArray<string>
): Schema.JsonObject => {
  type OpenAiRealtimeLoweredParametersFields = {
    type: 'object'
    properties: Schema.JsonObject
    required?: ReadonlyArray<string>
  }

  const fields: OpenAiRealtimeLoweredParametersFields = {
    type: 'object',
    properties
  }

  if (required.length > 0) {
    fields.required = required
  }

  return { ...fields, additionalProperties: false }
}

/**
 * OpenAI Realtime hangs until a gateway timeout (504) on function tools whose
 * `parameters` root is a union (`anyOf`) instead of an object schema. Lower a
 * union of object variants into one object schema: variant properties merge
 * (same-named string enums union), and `required` keeps only keys required by
 * every variant. This widens what the model may produce; hosts still validate
 * real arguments against the original tool schema at execution time.
 *
 * Callers must admit `Schema.Json` before this helper; non-JSON documents fail
 * at the advertisement boundary rather than being lowered here.
 */
export const openAiRealtimeToolParameters = (parameters: Schema.Json): Schema.Json => {
  if (!isJsonObject(parameters)) {
    return parameters
  }

  const anyOf = jsonObjectField(parameters, 'anyOf')

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

  const properties = new Map<string, Schema.Json>()

  for (const variant of variants) {
    for (const [key, schema] of Object.entries(variant.properties)) {
      const existing = properties.get(key)
      properties.set(key, existing === undefined ? schema : mergeVariantProperty(existing, schema))
    }
  }

  const required = variants
    .map(variant => variant.required)
    .reduce((shared, keys) => shared.filter(key => keys.includes(key)))

  return openAiRealtimeLoweredObjectParameters(Object.fromEntries(properties), required)
}

const realtimeToolResult = (
  tool: ToolDef
): Result.Result<OpenAiRealtimeFunctionTool, VoiceToolBridgeError> => {
  if (tool.execution === 'background-v1') {
    return Result.fail(new VoiceToolBridgeError({ message: backgroundVoiceUnsupportedMessage }))
  }

  return Result.match(Schema.decodeUnknownResult(Schema.Json)(tool.parameters), {
    onFailure: error =>
      Result.fail(
        new VoiceToolBridgeError({
          message: `Invalid OpenAI Realtime tool parameters JSON: ${error.message}`
        })
      ),
    onSuccess: parameters =>
      Result.succeed({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: openAiRealtimeToolParameters(parameters)
      })
  })
}

/** Throws VoiceToolBridgeError for activated background definitions; prefer the Effect variant in Effect programs. */
export const toOpenAiRealtimeTool = (tool: ToolDef): OpenAiRealtimeFunctionTool =>
  Result.match(realtimeToolResult(tool), {
    onFailure: error => {
      throw error
    },
    onSuccess: mapped => mapped
  })

/** Typed advertisement validation; unexpected mapper defects remain defects. */
export const toOpenAiRealtimeToolEffect = (
  tool: ToolDef
): Effect.Effect<OpenAiRealtimeFunctionTool, VoiceToolBridgeError> =>
  Effect.suspend(() => Effect.fromResult(realtimeToolResult(tool)))

const sessionConfigFromTools = ({
  instructions,
  tools,
  model = openAiRealtimeModel,
  voice = defaultOpenAiRealtimeVoice,
  reasoningEffort = defaultOpenAiRealtimeReasoningEffort,
  transcriptionModel = defaultOpenAiRealtimeTranscriptionModel
}: Omit<OpenAiRealtimeSessionConfigInput, 'tools'> & {
  readonly tools: ReadonlyArray<OpenAiRealtimeFunctionTool>
}): OpenAiRealtimeSessionConfig => ({
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
  tools,
  tool_choice: 'auto',
  reasoning: {
    effort: reasoningEffort
  }
})

/** Synchronous compatibility builder; throws VoiceToolBridgeError for activated tools. */
export const makeOpenAiRealtimeSessionConfig = (
  input: OpenAiRealtimeSessionConfigInput
): OpenAiRealtimeSessionConfig =>
  sessionConfigFromTools({ ...input, tools: input.tools.map(toOpenAiRealtimeTool) })

/** Build before transport effects; catchTag('VoiceToolBridgeError') handles unsupported activation. */
export const makeOpenAiRealtimeSessionConfigEffect = (
  input: OpenAiRealtimeSessionConfigInput
): Effect.Effect<OpenAiRealtimeSessionConfig, VoiceToolBridgeError> =>
  Effect.forEach(input.tools, toOpenAiRealtimeToolEffect).pipe(
    Effect.map(tools => sessionConfigFromTools({ ...input, tools }))
  )

const isOpenAiRealtimeVoice = (value: string): value is OpenAiRealtimeVoice =>
  value === 'marin' || value === 'cedar'

const decodeTranscriptionModel = Schema.decodeUnknownOption(OpenAiRealtimeTranscriptionModelSchema)

/**
 * Lower a provider-neutral `VoiceSessionConfig` into the OpenAI Realtime
 * session payload. Unsupported values fall back to OpenAI defaults; tools are
 * passed separately because host toolset resolution owns them.
 */
const sessionConfigInputFromVoice = (
  config: VoiceSessionConfig,
  tools: ReadonlyArray<ToolDef>
): OpenAiRealtimeSessionConfigInput => {
  const transcriptionModel =
    config.inputTranscription === undefined
      ? Option.none<OpenAiRealtimeTranscriptionModel>()
      : decodeTranscriptionModel(config.inputTranscription.model)

  return {
    instructions: config.instructions,
    tools,
    model: config.model,
    voice:
      config.voice !== undefined && isOpenAiRealtimeVoice(config.voice) ? config.voice : undefined,
    transcriptionModel: Option.getOrUndefined(transcriptionModel)
  }
}

/** Synchronous compatibility lowering; throws VoiceToolBridgeError for activated tools. */
export const openAiRealtimeSessionConfigFromVoice = (
  config: VoiceSessionConfig,
  tools: ReadonlyArray<ToolDef>
): OpenAiRealtimeSessionConfig =>
  makeOpenAiRealtimeSessionConfig(sessionConfigInputFromVoice(config, tools))

/** Effect-native provider-neutral config lowering with typed advertisement failures. */
export const openAiRealtimeSessionConfigFromVoiceEffect = (
  config: VoiceSessionConfig,
  tools: ReadonlyArray<ToolDef>
): Effect.Effect<OpenAiRealtimeSessionConfig, VoiceToolBridgeError> =>
  Effect.suspend(() =>
    makeOpenAiRealtimeSessionConfigEffect(sessionConfigInputFromVoice(config, tools))
  )
