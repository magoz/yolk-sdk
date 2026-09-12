import { Context, Effect, Layer, Ref, Semaphore } from 'effect'
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

export type DrainBegin =
  | { readonly _tag: 'Skip' }
  | {
      readonly _tag: 'Run'
      readonly drainToken: string
      readonly readyResponses: ReadonlyArray<ParkedResponse>
    }

export type InboxShape = {
  readonly enqueue: (item: InboxItem) => Effect.Effect<void>
  readonly takePromotable: (
    runId: string,
    scope: Promotable
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
  readonly beginDrain: (runId: string) => Effect.Effect<DrainBegin>
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
  readonly wakeIfUnblocked: (runId: string, wake: Effect.Effect<void>) => Effect.Effect<boolean>
  readonly startIfUnblocked: <E, R>(
    runId: string,
    start: Effect.Effect<CapturedRun<E>, E, R>
  ) => Effect.Effect<CapturedRun<E> | undefined, E, R>
}

export class Inbox extends Context.Service<Inbox, InboxShape>()('@yolk-sdk/harness/Inbox') {}

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
  readonly allowed: boolean
  readonly liveToken: string | undefined
  readonly park: Park | undefined
  readonly leasedGeneration: string | undefined
}

const emptyControl: RunControl = {
  allowed: false,
  liveToken: undefined,
  park: undefined,
  leasedGeneration: undefined
}

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
  !control.allowed &&
  control.liveToken === undefined &&
  control.park === undefined &&
  control.leasedGeneration === undefined

export const makeInMemoryInboxLayer = (): Layer.Layer<Inbox> =>
  Layer.effect(
    Inbox,
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
        if (park === undefined) return { _tag: 'NotParked' }
        if (park.generation !== admission.generation) return { _tag: 'Stale' }
        if (!park.requestIds.includes(admission.requestId)) return { _tag: 'UnknownRequest' }
        if (
          park.responses.some(
            response =>
              response.itemId === admission.itemId || response.requestId === admission.requestId
          )
        ) {
          return { _tag: 'Duplicate' }
        }
        if (park.readyWoken) return { _tag: 'Duplicate' }
        const responses = [
          ...park.responses,
          { itemId: admission.itemId, requestId: admission.requestId }
        ]
        return parkComplete({ ...park, responses }) ? { _tag: 'Ready' } : { _tag: 'Accepted' }
      }

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
          Ref.get(items).pipe(Effect.map(current => current.filter(item => item.runId === runId))),
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
                if (control.liveToken !== drainToken) return { _tag: 'Stale' } as const
                generationSeq += 1
                const generation = String(generationSeq)
                yield* writeControl(runId, {
                  allowed: control.allowed,
                  liveToken: control.liveToken,
                  leasedGeneration: control.leasedGeneration,
                  park: {
                    generation,
                    requestIds: [...requestIds],
                    responses: [],
                    readyWoken: false
                  }
                })
                return { _tag: 'Parked', generation } as const
              })
            )
          ),
        acceptHitl: (runId, admission, onReady) =>
          withGate(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const control = yield* getControl(runId)
                const decision = acceptHitlPure(control, admission)
                if (decision._tag !== 'Accepted' && decision._tag !== 'Ready') {
                  return decision
                }
                const park = control.park
                if (park === undefined) return { _tag: 'NotParked' } as const
                const nextPark: Park = {
                  ...park,
                  responses: [
                    ...park.responses,
                    { itemId: admission.itemId, requestId: admission.requestId }
                  ],
                  readyWoken: decision._tag === 'Ready'
                }
                yield* writeControl(runId, {
                  allowed: decision._tag === 'Ready' ? true : control.allowed,
                  liveToken: control.liveToken,
                  leasedGeneration: control.leasedGeneration,
                  park: nextPark
                })
                if (decision._tag === 'Ready') yield* onReady
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
                  allowed: control.allowed,
                  liveToken: control.liveToken,
                  leasedGeneration: control.leasedGeneration,
                  park: undefined
                })
                return true
              })
            )
          ),
        beginDrain: runId =>
          withGate(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const control = yield* getControl(runId)
                if (parkBlocked(control.park) || !control.allowed) return { _tag: 'Skip' } as const
                drainSeq += 1
                const drainToken = `d${drainSeq}`
                const park = control.park
                const ready = park !== undefined && parkComplete(park) ? park : undefined
                yield* writeControl(runId, {
                  allowed: false,
                  liveToken: drainToken,
                  park,
                  leasedGeneration: ready?.generation
                })
                return {
                  _tag: 'Run',
                  drainToken,
                  readyResponses: ready === undefined ? [] : ready.responses
                } as const
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
                  allowed: control.allowed,
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
                  allowed: true,
                  liveToken: control.liveToken,
                  leasedGeneration: control.leasedGeneration,
                  park: control.park
                })
                yield* wake
              })
            )
          ),
        wakeIfUnblocked: (runId, wake) =>
          withGate(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const control = yield* getControl(runId)
                if (parkBlocked(control.park)) return false
                yield* writeControl(runId, {
                  allowed: true,
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
                if (ticket._tag === 'Started') {
                  yield* writeControl(runId, {
                    allowed: true,
                    liveToken: control.liveToken,
                    leasedGeneration: control.leasedGeneration,
                    park: control.park
                  })
                }
                return ticket
              })
            )
          )
      })
    })
  )
