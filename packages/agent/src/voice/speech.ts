import { Context, Encoding, type Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { AudioPart, inlineBase64AttachmentSource } from '@yolk-sdk/agent/protocol'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export const VoiceSpeechErrorCode = Schema.Literals([
  'invalid_request',
  'provider_error',
  'unknown'
])
export type VoiceSpeechErrorCode = typeof VoiceSpeechErrorCode.Type

/** Safe speech/transcription failure; never carries raw provider bodies. */
export class VoiceSpeechError extends Schema.TaggedErrorClass<VoiceSpeechError>()(
  'VoiceSpeechError',
  {
    code: VoiceSpeechErrorCode,
    message: Schema.String
  }
) {}

/** Provider-neutral one-shot text-to-speech request. */
export class VoiceSpeechRequest extends Schema.Class<VoiceSpeechRequest>('VoiceSpeechRequest')({
  text: NonEmptyTrimmedString,
  model: Schema.optional(Schema.String),
  voice: Schema.optional(Schema.String),
  /** Provider output format hint, e.g. `mp3`, `wav`, `opus`. */
  outputFormat: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String)
}) {}

export type VoiceSpeechResult = {
  readonly audio: Uint8Array
  readonly mimeType: string
}

/** One-shot text-to-speech service; providers supply layers. */
export class VoiceSpeechSynthesizer extends Context.Service<
  VoiceSpeechSynthesizer,
  {
    readonly synthesize: (
      request: VoiceSpeechRequest
    ) => Effect.Effect<VoiceSpeechResult, VoiceSpeechError>
  }
>()('@yolk-sdk/agent/voice/VoiceSpeechSynthesizer') {}

/** Provider-neutral one-shot transcription request. */
export type VoiceTranscriptionRequest = {
  readonly audio: Uint8Array
  readonly mimeType: string
  readonly model?: string
  readonly language?: string
  readonly prompt?: string
}

export class VoiceTranscriptionSegment extends Schema.Class<VoiceTranscriptionSegment>(
  'VoiceTranscriptionSegment'
)({
  text: Schema.String,
  startSeconds: Schema.optional(Schema.Number),
  endSeconds: Schema.optional(Schema.Number)
}) {}

export class VoiceTranscriptionResult extends Schema.Class<VoiceTranscriptionResult>(
  'VoiceTranscriptionResult'
)({
  text: Schema.String,
  language: Schema.optional(Schema.String),
  durationSeconds: Schema.optional(Schema.Number),
  segments: Schema.optional(Schema.Array(VoiceTranscriptionSegment))
}) {}

/** One-shot speech-to-text service; providers supply layers. */
export class VoiceTranscriber extends Context.Service<
  VoiceTranscriber,
  {
    readonly transcribe: (
      request: VoiceTranscriptionRequest
    ) => Effect.Effect<VoiceTranscriptionResult, VoiceSpeechError>
  }
>()('@yolk-sdk/agent/voice/VoiceTranscriber') {}

/** Convert a synthesized speech result into a protocol `AudioPart`. */
export const speechResultToAudioPart = (
  result: VoiceSpeechResult,
  options?: { readonly filename?: string; readonly durationMs?: number }
): AudioPart =>
  AudioPart.make({
    source: inlineBase64AttachmentSource(Encoding.encodeBase64(result.audio)),
    mimeType: result.mimeType,
    filename: options?.filename,
    durationMs: options?.durationMs
  })
