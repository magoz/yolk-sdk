import { Duration, Effect, Queue, Ref, type Scope } from 'effect'
import type {
  StoredVoiceEvent} from './projection.ts';
import {
  initialVoiceEventSequencerState,
  sequenceVoiceEvent,
  type VoiceEventSequencerState
} from './projection.ts'
import type { VoiceEvent, VoiceSessionError } from './protocol.ts'
import { storedVoiceToolEvents } from './session-log.ts'

/**
 * Client-side voice event outbox options. `flush` posts one batch to the
 * host's authenticated session-log endpoint; hosts should use
 * keepalive-capable transport (for example `fetch` with `keepalive: true`)
 * so the final batch survives page unload.
 */
export type VoiceEventOutboxOptions = {
  /** Host voice session id; namespaces sequence-based event ids. */
  readonly streamId: string
  readonly flush: (batch: ReadonlyArray<StoredVoiceEvent>) => Effect.Effect<void, VoiceSessionError>
  /** Interval between periodic flushes. Defaults to 500ms. */
  readonly flushIntervalMs?: number
  /** Flush immediately once this many events are pending. Defaults to 100. */
  readonly maxBatchSize?: number
}

export type VoiceEventOutboxApi = {
  /** Enqueue one event; boundary events schedule an immediate flush. */
  readonly offer: (event: VoiceEvent) => Effect.Effect<void>
  /** Wake the flusher now (best-effort; delivery is at-least-once). */
  readonly flushNow: Effect.Effect<void>
}

const defaultFlushIntervalMs = 500
const defaultMaxBatchSize = 100

/**
 * Events that mark a durable boundary: flush immediately instead of waiting
 * for the next interval so finals/tool activity land server-side with
 * minimal loss window.
 */
const isBoundaryEvent = (event: VoiceEvent) => {
  switch (event._tag) {
    case 'UserTranscriptFinal':
    case 'AssistantTranscriptFinal':
    case 'Interrupted':
    case 'SessionClosed':
    case 'ToolCallsRequested':
    case 'ToolCallCompleted':
    case 'ToolCallFailed':
    case 'Error':
      return true
    default:
      return false
  }
}

const isToolLifecycleEvent = (
  event: VoiceEvent
): event is Extract<
  VoiceEvent,
  { _tag: 'ToolCallsRequested' | 'ToolCallCompleted' | 'ToolCallFailed' }
> =>
  event._tag === 'ToolCallsRequested' ||
  event._tag === 'ToolCallCompleted' ||
  event._tag === 'ToolCallFailed'

type OutboxBuffer = {
  readonly pending: ReadonlyArray<StoredVoiceEvent>
  readonly sequencer: VoiceEventSequencerState
}

/**
 * Buffer voice events as replay-safe `StoredVoiceEvent`s and flush them in
 * batches: on an interval, when the buffer grows past `maxBatchSize`, on
 * boundary events, and once more when the owning scope closes.
 *
 * Delivery is at-least-once: a failed flush keeps the batch and retries on
 * the next wake; the server fold dedupes by `eventId`. Tool lifecycle events
 * use deterministic per-call ids (`voiceToolEventId`) so server-witnessed
 * tool logs and this client replay dedupe against each other; everything
 * else is sequenced as `streamId:sequence`.
 */
export const makeVoiceEventOutbox = (
  options: VoiceEventOutboxOptions
): Effect.Effect<VoiceEventOutboxApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const buffer = yield* Ref.make<OutboxBuffer>({
      pending: [],
      sequencer: initialVoiceEventSequencerState
    })
    const wake = yield* Queue.unbounded<void>()
    const maxBatchSize = options.maxBatchSize ?? defaultMaxBatchSize
    const flushInterval = Duration.millis(options.flushIntervalMs ?? defaultFlushIntervalMs)

    const takePending = Ref.modify(buffer, current => [
      current.pending,
      { pending: [], sequencer: current.sequencer } satisfies OutboxBuffer
    ])

    const restorePending = (batch: ReadonlyArray<StoredVoiceEvent>) =>
      Ref.update(buffer, current => ({
        pending: [...batch, ...current.pending],
        sequencer: current.sequencer
      }))

    // Single flusher: only this effect sends batches, so flushes never
    // interleave and order is preserved.
    const flushPending = Effect.gen(function* () {
      const batch = yield* takePending

      if (batch.length === 0) {
        return
      }

      yield* options.flush(batch).pipe(Effect.catch(() => restorePending(batch)))
    })

    const offer = (event: VoiceEvent) =>
      Effect.gen(function* () {
        const pendingSize = yield* Ref.modify(buffer, current => {
          const stored = isToolLifecycleEvent(event)
            ? storedVoiceToolEvents(event)
            : [sequenceVoiceEvent(options.streamId, current.sequencer, event).stored]
          const sequencer = isToolLifecycleEvent(event)
            ? current.sequencer
            : { nextSequence: current.sequencer.nextSequence + 1 }
          const pending = [...current.pending, ...stored]

          return [pending.length, { pending, sequencer } satisfies OutboxBuffer]
        })

        if (isBoundaryEvent(event) || pendingSize >= maxBatchSize) {
          yield* Queue.offer(wake, undefined).pipe(Effect.asVoid)
        }
      })

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.raceFirst(Queue.take(wake), Effect.sleep(flushInterval)).pipe(
          Effect.andThen(flushPending)
        )
      )
    )

    // Final drain when the session scope closes; errors are swallowed — the
    // server fold tolerates the missing tail and dedupes any later replay.
    yield* Effect.addFinalizer(() => flushPending.pipe(Effect.catch(() => Effect.void)))

    return {
      offer,
      flushNow: Queue.offer(wake, undefined).pipe(Effect.asVoid)
    }
  })
