import { Duration, Effect, Exit, Ref, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from '@effect/vitest'
import type {
  StoredVoiceEvent} from '../../src/voice/index.ts';
import {
  makeVoiceEventOutbox,
  VoiceAssistantTranscriptDelta,
  VoiceSessionError,
  VoiceToolCall,
  VoiceToolCallsRequested,
  voiceToolEventId,
  VoiceUserTranscriptFinal
} from '../../src/voice/index.ts'

const delta = (text: string) =>
  VoiceAssistantTranscriptDelta.make({ itemId: 'item-1', responseId: 'resp-1', delta: text })

const collectingFlush = (batches: Ref.Ref<ReadonlyArray<ReadonlyArray<StoredVoiceEvent>>>) => {
  return (batch: ReadonlyArray<StoredVoiceEvent>) =>
    Ref.update(batches, current => [...current, batch])
}

describe('makeVoiceEventOutbox', () => {
  it.effect('flushes buffered events on the interval', () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<StoredVoiceEvent>>>([])
      const scope = yield* Scope.make()
      const outbox = yield* Scope.provide(
        makeVoiceEventOutbox({ streamId: 'session-1', flush: collectingFlush(batches) }),
        scope
      )

      yield* outbox.offer(delta('Hel'))
      yield* outbox.offer(delta('lo'))
      expect(yield* Ref.get(batches)).toHaveLength(0)

      yield* TestClock.adjust(Duration.millis(500))
      const flushed = yield* Ref.get(batches)

      expect(flushed).toHaveLength(1)
      expect(flushed[0]?.map(entry => entry.eventId)).toEqual(['session-1:0', 'session-1:1'])
      yield* Scope.close(scope, Exit.void)
    })
  )

  it.effect('flushes immediately on boundary events', () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<StoredVoiceEvent>>>([])
      const scope = yield* Scope.make()
      const outbox = yield* Scope.provide(
        makeVoiceEventOutbox({ streamId: 'session-1', flush: collectingFlush(batches) }),
        scope
      )

      yield* outbox.offer(delta('Hel'))
      yield* outbox.offer(VoiceUserTranscriptFinal.make({ itemId: 'item-2', text: 'Hi' }))
      yield* TestClock.adjust(Duration.millis(1))

      const flushed = yield* Ref.get(batches)

      expect(flushed).toHaveLength(1)
      expect(flushed[0]).toHaveLength(2)
      yield* Scope.close(scope, Exit.void)
    })
  )

  it.effect('assigns deterministic ids to tool lifecycle events', () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<StoredVoiceEvent>>>([])
      const scope = yield* Scope.make()
      const outbox = yield* Scope.provide(
        makeVoiceEventOutbox({ streamId: 'session-1', flush: collectingFlush(batches) }),
        scope
      )

      yield* outbox.offer(delta('a'))
      yield* outbox.offer(
        VoiceToolCallsRequested.make({
          calls: [VoiceToolCall.make({ callId: 'call-1', name: 'web_search', argumentsJson: '{}' })]
        })
      )
      yield* outbox.offer(delta('b'))
      yield* TestClock.adjust(Duration.millis(1))

      const flushed = yield* Ref.get(batches)

      // Tool events carry deterministic per-call ids; sequence numbers skip
      // them so sequenced events stay contiguous.
      expect(flushed[0]?.map(entry => entry.eventId)).toEqual([
        'session-1:0',
        voiceToolEventId('call-1', 'requested'),
        'session-1:1'
      ])
      yield* Scope.close(scope, Exit.void)
    })
  )

  it.effect('keeps the batch and retries after a failed flush', () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<StoredVoiceEvent>>>([])
      const failures = yield* Ref.make(1)
      const scope = yield* Scope.make()
      const outbox = yield* Scope.provide(
        makeVoiceEventOutbox({
          streamId: 'session-1',
          flush: batch =>
            Effect.gen(function* () {
              const remaining = yield* Ref.getAndUpdate(failures, count => count - 1)

              if (remaining > 0) {
                return yield* Effect.fail(
                  new VoiceSessionError({ code: 'transport_failed', message: 'offline' })
                )
              }

              yield* Ref.update(batches, current => [...current, batch])
            })
        }),
        scope
      )

      yield* outbox.offer(delta('Hel'))
      yield* TestClock.adjust(Duration.millis(500))
      expect(yield* Ref.get(batches)).toHaveLength(0)

      yield* outbox.offer(delta('lo'))
      yield* TestClock.adjust(Duration.millis(500))
      const flushed = yield* Ref.get(batches)

      expect(flushed).toHaveLength(1)
      expect(flushed[0]?.map(entry => entry.eventId)).toEqual(['session-1:0', 'session-1:1'])
      yield* Scope.close(scope, Exit.void)
    })
  )

  it.effect('drains pending events when the scope closes', () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<StoredVoiceEvent>>>([])
      const scope = yield* Scope.make()
      const outbox = yield* Scope.provide(
        makeVoiceEventOutbox({ streamId: 'session-1', flush: collectingFlush(batches) }),
        scope
      )

      yield* outbox.offer(delta('tail'))
      yield* Scope.close(scope, Exit.void)

      const flushed = yield* Ref.get(batches)

      expect(flushed).toHaveLength(1)
      expect(flushed[0]).toHaveLength(1)
    })
  )
})
