import { Context, Data, Effect, Layer, Predicate, Ref, Semaphore } from 'effect'
import type { CapturedRun, Promotable } from './coordinator.ts'

export type InboxKind = 'input' | 'hitl'

export type InboxItem = {
  readonly id: string
  readonly runId: string
  readonly delivery: Promotable | 'queue'
  readonly kind: InboxKind
}

export type ParkedResponse = {
  readonly itemId: string
  readonly requestId: string
}

export type ParkedState = {
  readonly generation: string
  readonly requestIds: ReadonlyArray<string>
  readonly responses: ReadonlyArray<ParkedResponse>
  readonly ready: boolean
}

export type HitlAdmission = {
  readonly itemId: string
  readonly requestId: string
  readonly generation: string
}

export type HitlDecision =
  | { readonly _tag: 'Accepted' }
  | { readonly _tag: 'Ready' }
  | { readonly _tag: 'Duplicate' }
  | { readonly _tag: 'Stale' }
  | { readonly _tag: 'UnknownRequest' }
  | { readonly _tag: 'NotParked' }

export type PauseDecision =
  | { readonly _tag: 'Parked'; readonly generation: string }
  | { readonly _tag: 'Stale' }

export type RecoveryAttempt =
  | { readonly _tag: 'Skip' }
  | { readonly _tag: 'Exhausted' }
  | { readonly _tag: 'Resume' }

export type RecoveryAdmission =
  | { readonly _tag: 'Skip' }
  | { readonly _tag: 'Exhausted' }
  | { readonly _tag: 'Resumed' }

export type DrainBegin =
  | { readonly _tag: 'Skip' }
  | {
      readonly _tag: 'Run'
      readonly drainToken: string
      readonly readyResponses: ReadonlyArray<ParkedResponse>
    }

export const HitlDecision = Data.taggedEnum<HitlDecision>()

export const PauseDecision = Data.taggedEnum<PauseDecision>()

export const RecoveryAttempt = Data.taggedEnum<RecoveryAttempt>()

export const RecoveryAdmission = Data.taggedEnum<RecoveryAdmission>()

export const DrainBegin = Data.taggedEnum<DrainBegin>()

export type InboxApi = {
  readonly enqueue: (item: InboxItem) => Effect.Effect<void>
  readonly takePromotable: (
    runId: string,
    scope: Promotable,
    drainToken: string
  ) => Effect.Effect<InboxItem | undefined>
  readonly pending: (runId: string) => Effect.Effect<ReadonlyArray<InboxItem>>
  readonly parked: (runId: string) => Effect.Effect<ParkedState | undefined>
  readonly park: (
    runId: string,
    requestIds: ReadonlyArray<string>,
    drainToken: string
  ) => Effect.Effect<PauseDecision>
  readonly acceptHitl: (
    runId: string,
    admission: HitlAdmission,
    onReady: Effect.Effect<void>
  ) => Effect.Effect<HitlDecision>
  readonly clearPark: (runId: string, generation: string) => Effect.Effect<boolean>
  readonly beginDrain: (runId: string, scope: Promotable) => Effect.Effect<DrainBegin>
  readonly endDrain: (
    runId: string,
    drainToken: string,
    acknowledged: boolean
  ) => Effect.Effect<void>
  readonly invalidate: (
    runId: string,
    interrupt: Effect.Effect<boolean>,
    releaseIdleClaim: Effect.Effect<void>
  ) => Effect.Effect<{ readonly hadPark: boolean; readonly interrupted: boolean }>
  readonly enqueueAndWake: (item: InboxItem, wake: Effect.Effect<void>) => Effect.Effect<void>
  readonly wakeIfUnblocked: (
    runId: string,
    scope: Promotable,
    wake: Effect.Effect<void>
  ) => Effect.Effect<boolean>
  readonly startIfUnblocked: <E, R>(
    runId: string,
    start: Effect.Effect<CapturedRun<E>, E, R>
  ) => Effect.Effect<CapturedRun<E> | undefined, E, R>
  readonly admitRecovery: <E, R>(
    runId: string,
    attempt: Effect.Effect<RecoveryAttempt, E, R>,
    wake: Effect.Effect<void>
  ) => Effect.Effect<RecoveryAdmission, E, R>
}

const isPromotableAt = (item: InboxItem, scope: Promotable) => {
  if (scope === 'steer') return item.delivery === 'steer'

  return item.delivery === 'steer' || item.delivery === 'input' || item.delivery === 'queue'
}

type Park = {
  readonly generation: string
  readonly requestIds: ReadonlyArray<string>
  readonly responses: ReadonlyArray<ParkedResponse>
  readonly readyWoken: boolean
}

type RunControl = {
  readonly pending: Promotable | undefined
  readonly liveToken: string | undefined
  readonly park: Park | undefined
  readonly leasedGeneration: string | undefined
}

const emptyControl: RunControl = {
  pending: undefined,
  liveToken: undefined,
  park: undefined,
  leasedGeneration: undefined
}

const widerPending = (current: Promotable | undefined, next: Promotable): Promotable =>
  current === 'input' || next === 'input' ? 'input' : 'steer'

const remainingPending = (pending: Promotable, scope: Promotable): Promotable | undefined =>
  scope === 'steer' && pending === 'input' ? 'input' : undefined

const itemScope = (item: InboxItem): Promotable => (item.delivery === 'steer' ? 'steer' : 'input')

const parkComplete = (park: Park) =>
  park.requestIds.every(requestId =>
    park.responses.some(response => response.requestId === requestId)
  )

const parkBlocked = (park: Park | undefined) => park !== undefined && !parkComplete(park)

const parkedState = (park: Park): ParkedState => ({
  generation: park.generation,
  requestIds: park.requestIds,
  responses: park.responses,
  ready: parkComplete(park)
})

const isPrunable = (control: RunControl) =>
  control.pending === undefined &&
  control.liveToken === undefined &&
  control.park === undefined &&
  control.leasedGeneration === undefined

export class Inbox extends Context.Service<Inbox, InboxApi>()('@yolk-sdk/harness/Inbox') {
  /** Fresh queue, admission gate and HITL generations per layer acquisition. */
  static layer = (): Layer.Layer<Inbox> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const items = yield* Ref.make<ReadonlyArray<InboxItem>>([])
        const controls = yield* Ref.make<ReadonlyMap<string, RunControl>>(new Map())
        const gate = yield* Semaphore.make(1)
        let generationSeq = 0
        let drainSeq = 0

        const withGate = <A, E, R>(body: Effect.Effect<A, E, R>) => gate.withPermits(1)(body)

        const getControl = (runId: string) =>
          Ref.get(controls).pipe(Effect.map(current => current.get(runId) ?? emptyControl))

        const writeControl = (runId: string, next: RunControl) =>
          Ref.update(controls, current => {
            const copy = new Map(current)

            if (isPrunable(next)) copy.delete(runId)
            else copy.set(runId, next)

            return copy
          })

        const dropQueued = (runId: string) =>
          Ref.update(items, current => current.filter(item => item.runId !== runId))

        const acceptHitlPure = (control: RunControl, admission: HitlAdmission): HitlDecision => {
          const park = control.park

          if (park === undefined) return HitlDecision.NotParked()

          if (park.generation !== admission.generation) return HitlDecision.Stale()

          if (!park.requestIds.includes(admission.requestId)) return HitlDecision.UnknownRequest()

          if (
            park.responses.some(
              response =>
                response.itemId === admission.itemId || response.requestId === admission.requestId
            )
          ) {
            return HitlDecision.Duplicate()
          }

          if (park.readyWoken) return HitlDecision.Duplicate()

          const responses = [
            ...park.responses,
            { itemId: admission.itemId, requestId: admission.requestId }
          ]

          return parkComplete({ ...park, responses })
            ? HitlDecision.Ready()
            : HitlDecision.Accepted()
        }

        return Inbox.of({
          enqueue: item => Ref.update(items, current => [...current, item]),
          takePromotable: (runId, scope, drainToken) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)

                  if (control.liveToken === undefined || control.liveToken !== drainToken) {
                    return undefined
                  }

                  return yield* Ref.modify(items, current => {
                    const index = current.findIndex(
                      item => item.runId === runId && isPromotableAt(item, scope)
                    )

                    if (index < 0) return [undefined, current] as const
                    const taken = current[index]

                    return [taken, current.filter((_, itemIndex) => itemIndex !== index)] as const
                  })
                })
              )
            ),
          pending: runId =>
            Ref.get(items).pipe(
              Effect.map(current => current.filter(item => item.runId === runId))
            ),
          parked: runId =>
            getControl(runId).pipe(
              Effect.map(control =>
                control.park === undefined ? undefined : parkedState(control.park)
              )
            ),
          park: (runId, requestIds, drainToken) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)

                  if (control.liveToken !== drainToken) return PauseDecision.Stale()
                  generationSeq += 1
                  const generation = String(generationSeq)
                  yield* writeControl(runId, {
                    pending: control.pending,
                    liveToken: control.liveToken,
                    leasedGeneration: control.leasedGeneration,
                    park: {
                      generation,
                      requestIds: [...requestIds],
                      responses: [],
                      readyWoken: false
                    }
                  })

                  return PauseDecision.Parked({ generation })
                })
              )
            ),
          acceptHitl: (runId, admission, onReady) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)
                  const decision = acceptHitlPure(control, admission)

                  if (
                    !Predicate.isTagged(decision, 'Accepted') &&
                    !Predicate.isTagged(decision, 'Ready')
                  ) {
                    return decision
                  }

                  const park = control.park

                  if (park === undefined) return HitlDecision.NotParked()

                  const nextPark: Park = {
                    ...park,
                    responses: [
                      ...park.responses,
                      { itemId: admission.itemId, requestId: admission.requestId }
                    ],
                    readyWoken: Predicate.isTagged(decision, 'Ready')
                  }

                  yield* writeControl(runId, {
                    pending: Predicate.isTagged(decision, 'Ready')
                      ? widerPending(control.pending, 'input')
                      : control.pending,
                    liveToken: control.liveToken,
                    leasedGeneration: control.leasedGeneration,
                    park: nextPark
                  })

                  if (Predicate.isTagged(decision, 'Ready')) yield* onReady

                  return decision
                })
              )
            ),
          clearPark: (runId, generation) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)

                  if (control.park === undefined || control.park.generation !== generation) {
                    return false
                  }

                  yield* writeControl(runId, {
                    pending: control.pending,
                    liveToken: control.liveToken,
                    leasedGeneration: control.leasedGeneration,
                    park: undefined
                  })

                  return true
                })
              )
            ),
          beginDrain: (runId, scope) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)
                  const pending = control.pending

                  if (parkBlocked(control.park) || pending === undefined) {
                    return DrainBegin.Skip()
                  }

                  drainSeq += 1
                  const drainToken = `d${drainSeq}`
                  const park = control.park
                  const ready = park !== undefined && parkComplete(park) ? park : undefined
                  yield* writeControl(runId, {
                    pending: remainingPending(pending, scope),
                    liveToken: drainToken,
                    park,
                    leasedGeneration: ready?.generation
                  })

                  return DrainBegin.Run({
                    drainToken,
                    readyResponses: ready === undefined ? [] : ready.responses
                  })
                })
              )
            ),
          endDrain: (runId, drainToken, acknowledged) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)

                  if (control.liveToken !== drainToken) return
                  const leased = control.leasedGeneration
                  const park = control.park

                  const clearPark =
                    acknowledged &&
                    leased !== undefined &&
                    park !== undefined &&
                    park.generation === leased

                  yield* writeControl(runId, {
                    pending: control.pending,
                    liveToken: undefined,
                    leasedGeneration: undefined,
                    park: clearPark ? undefined : park
                  })
                })
              )
            ),
          invalidate: (runId, interrupt, releaseIdleClaim) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)
                  const hadPark = control.park !== undefined
                  yield* dropQueued(runId)
                  yield* writeControl(runId, emptyControl)
                  const interrupted = yield* interrupt

                  if (!interrupted) yield* releaseIdleClaim

                  return { hadPark, interrupted }
                })
              )
            ),
          enqueueAndWake: (item, wake) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* Ref.update(items, current => [...current, item])
                  const control = yield* getControl(item.runId)

                  if (parkBlocked(control.park)) return
                  yield* writeControl(item.runId, {
                    pending: widerPending(control.pending, itemScope(item)),
                    liveToken: control.liveToken,
                    leasedGeneration: control.leasedGeneration,
                    park: control.park
                  })
                  yield* wake
                })
              )
            ),
          wakeIfUnblocked: (runId, scope, wake) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)

                  if (parkBlocked(control.park)) return false
                  yield* writeControl(runId, {
                    pending: widerPending(control.pending, scope),
                    liveToken: control.liveToken,
                    leasedGeneration: control.leasedGeneration,
                    park: control.park
                  })
                  yield* wake

                  return true
                })
              )
            ),
          startIfUnblocked: (runId, start) =>
            withGate(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const control = yield* getControl(runId)

                  if (parkBlocked(control.park)) return undefined
                  const ticket = yield* start

                  if (Predicate.isTagged(ticket, 'Started')) {
                    yield* writeControl(runId, {
                      pending: widerPending(control.pending, 'input'),
                      liveToken: control.liveToken,
                      leasedGeneration: control.leasedGeneration,
                      park: control.park
                    })
                  }

                  return ticket
                })
              )
            ),
          admitRecovery: (runId, attempt, wake) =>
            Effect.uninterruptibleMask(restore =>
              restore(gate.take(1)).pipe(
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    const control = yield* getControl(runId)

                    if (parkBlocked(control.park)) return RecoveryAdmission.Skip()
                    const decision = yield* attempt

                    if (!RecoveryAttempt.$is('Resume')(decision)) return decision
                    yield* writeControl(runId, {
                      pending: widerPending(control.pending, 'input'),
                      liveToken: control.liveToken,
                      leasedGeneration: control.leasedGeneration,
                      park: control.park
                    })
                    yield* wake

                    return RecoveryAdmission.Resumed()
                  }).pipe(Effect.ensuring(gate.release(1)))
                )
              )
            )
        })
      })
    )
}

/** Backward-compatible delegation to the owning inbox layer. */
export const makeInMemoryInboxLayer = (): Layer.Layer<Inbox> => Inbox.layer()
