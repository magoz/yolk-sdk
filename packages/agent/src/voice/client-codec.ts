import type { Effect } from 'effect'
import type { VoiceSessionError } from './protocol.ts'

/**
 * Provider client codec: encodes client-side intents into raw provider wire
 * strings for the transport. Each encoder returns strings in send order.
 * Provider subpaths implement this; voice core stays provider-neutral.
 */
export type VoiceClientCodec = {
  /** Encode one tool output submission. Does not request a response turn. */
  readonly encodeToolOutput: (
    callId: string,
    output: string
  ) => Effect.Effect<ReadonlyArray<string>, VoiceSessionError>
  /** Request the provider to produce the next response turn. */
  readonly encodeResponseTurn: () => Effect.Effect<ReadonlyArray<string>, VoiceSessionError>
  /** Encode a user text message as conversation context. */
  readonly encodeUserText: (
    text: string
  ) => Effect.Effect<ReadonlyArray<string>, VoiceSessionError>
  /** Encode an assistant text message as conversation context (replay seed). */
  readonly encodeAssistantText: (
    text: string
  ) => Effect.Effect<ReadonlyArray<string>, VoiceSessionError>
}
