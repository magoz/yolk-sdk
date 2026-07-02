import { Context, type Effect, type Stream } from 'effect'
import type { VoiceEvent, VoiceSessionError } from './protocol.ts'

/**
 * Live voice transport instance. `send` moves raw provider wire strings
 * (provider codecs own the shapes); `events` is the provider-neutral decoded
 * event stream. The stream ends when the session closes and fails only on
 * unrecoverable transport defects.
 */
export type VoiceTransportApi = {
  readonly send: (data: string) => Effect.Effect<void, VoiceSessionError>
  readonly events: Stream.Stream<VoiceEvent, VoiceSessionError>
}

export class VoiceTransport extends Context.Service<VoiceTransport, VoiceTransportApi>()(
  '@yolk-sdk/agent/voice/VoiceTransport'
) {}
