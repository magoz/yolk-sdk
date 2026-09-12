import { Context, Effect, Layer, Ref } from 'effect'
import type { Promotable } from './coordinator.ts'

export type InboxKind = 'input' | 'hitl'

export type InboxItem = {
  readonly id: string
  readonly runId: string
  readonly delivery: Promotable | 'queue'
  readonly kind: InboxKind
}

export type InboxApi = {
  readonly enqueue: (item: InboxItem) => Effect.Effect<void>
  readonly takePromotable: (
    runId: string,
    scope: Promotable
  ) => Effect.Effect<InboxItem | undefined>
  readonly pending: (runId: string) => Effect.Effect<ReadonlyArray<InboxItem>>
}

export class Inbox extends Context.Service<Inbox, InboxApi>()('@yolk-sdk/harness/Inbox') {
  /**
   * Canonical owning layer for the process-local inbox. Each call builds a fresh layer so
   * composed harnesses never share queued items across factory calls.
   */
  static layer = (): Layer.Layer<Inbox> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const items = yield* Ref.make<ReadonlyArray<InboxItem>>([])

        return Inbox.of({
          enqueue: item => Ref.update(items, current => [...current, item]),
          takePromotable: (runId, scope) =>
            Ref.modify(items, current => {
              const index = current.findIndex(
                item => item.runId === runId && isPromotableAt(item, scope)
              )

              if (index < 0) return [undefined, current] as const
              const taken = current[index]

              return [taken, current.filter((_, itemIndex) => itemIndex !== index)] as const
            }),
          pending: runId =>
            Ref.get(items).pipe(Effect.map(current => current.filter(item => item.runId === runId)))
        })
      })
    )
}

const isPromotableAt = (item: InboxItem, scope: Promotable) => {
  if (scope === 'steer') return item.delivery === 'steer'

  return item.delivery === 'steer' || item.delivery === 'input' || item.delivery === 'queue'
}

/** Backward-compatible delegation to {@link Inbox.layer}. */
export const makeInMemoryInboxLayer = (): Layer.Layer<Inbox> => Inbox.layer()
