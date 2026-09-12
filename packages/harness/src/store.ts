import { Context, Effect, Layer, Ref, Semaphore } from 'effect'

export type RunStoreShape = {
  readonly claim: (runId: string) => Effect.Effect<void>
  readonly release: (runId: string) => Effect.Effect<void>
  readonly isClaimed: (runId: string) => Effect.Effect<boolean>
  readonly claimed: Effect.Effect<ReadonlySet<string>>
  readonly incrementResumeCount: (runId: string) => Effect.Effect<number>
  readonly resumeCount: (runId: string) => Effect.Effect<number>
}

export class RunStore extends Context.Service<RunStore, RunStoreShape>()(
  '@yolk-sdk/harness/RunStore'
) {}

export type DurableRunStoreSnapshot = {
  readonly claimed: ReadonlyArray<string>
  readonly resumes: ReadonlyArray<readonly [string, number]>
}

const emptySnapshot: DurableRunStoreSnapshot = {
  claimed: [],
  resumes: []
}

const snapshotFromState = (
  claimed: ReadonlySet<string>,
  resumes: ReadonlyMap<string, number>
): DurableRunStoreSnapshot => ({
  claimed: [...claimed],
  resumes: [...resumes.entries()]
})

const stateFromSnapshot = (snapshot: DurableRunStoreSnapshot) => ({
  claimed: new Set(snapshot.claimed),
  resumes: new Map(snapshot.resumes)
})

export const makeSnapshotRunStoreLayer = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
}): Layer.Layer<RunStore> =>
  Layer.effect(
    RunStore,
    Effect.gen(function* () {
      const loaded = yield* options.load
      const initial = stateFromSnapshot(loaded ?? emptySnapshot)
      const claimed = yield* Ref.make(initial.claimed)
      const resumes = yield* Ref.make(initial.resumes)
      const lock = yield* Semaphore.make(1)
      const persist = () =>
        Effect.gen(function* () {
          const nextClaimed = yield* Ref.get(claimed)
          const nextResumes = yield* Ref.get(resumes)
          yield* options.save(snapshotFromState(nextClaimed, nextResumes))
        })
      const mutate = <A>(effect: Effect.Effect<A>) => lock.withPermits(1)(effect)

      return RunStore.of({
        claim: runId =>
          mutate(
            Ref.update(claimed, current => new Set(current).add(runId)).pipe(
              Effect.andThen(persist)
            )
          ),
        release: runId =>
          mutate(
            Effect.zip(
              Ref.update(claimed, current => {
                const next = new Set(current)
                next.delete(runId)
                return next
              }),
              Ref.update(resumes, current => {
                const next = new Map(current)
                next.delete(runId)
                return next
              })
            ).pipe(Effect.andThen(persist), Effect.asVoid)
          ),
        isClaimed: runId => Ref.get(claimed).pipe(Effect.map(current => current.has(runId))),
        claimed: Ref.get(claimed).pipe(Effect.map(current => new Set(current))),
        incrementResumeCount: runId =>
          mutate(
            Ref.modify(resumes, current => {
              const nextCount = (current.get(runId) ?? 0) + 1
              const next = new Map(current)
              next.set(runId, nextCount)
              return [nextCount, next] as const
            }).pipe(Effect.tap(persist))
          ),
        resumeCount: runId => Ref.get(resumes).pipe(Effect.map(current => current.get(runId) ?? 0))
      })
    })
  )

export const makeInMemoryRunStoreLayer = (): Layer.Layer<RunStore> =>
  Layer.effect(
    RunStore,
    Effect.gen(function* () {
      const claimed = yield* Ref.make(new Set<string>())
      const resumes = yield* Ref.make(new Map<string, number>())

      return RunStore.of({
        claim: runId => Ref.update(claimed, current => new Set(current).add(runId)),
        release: runId =>
          Effect.zip(
            Ref.update(claimed, current => {
              const next = new Set(current)
              next.delete(runId)
              return next
            }),
            Ref.update(resumes, current => {
              const next = new Map(current)
              next.delete(runId)
              return next
            })
          ).pipe(Effect.asVoid),
        isClaimed: runId => Ref.get(claimed).pipe(Effect.map(current => current.has(runId))),
        claimed: Ref.get(claimed).pipe(Effect.map(current => new Set(current))),
        incrementResumeCount: runId =>
          Ref.modify(resumes, current => {
            const nextCount = (current.get(runId) ?? 0) + 1
            const next = new Map(current)
            next.set(runId, nextCount)
            return [nextCount, next] as const
          }),
        resumeCount: runId => Ref.get(resumes).pipe(Effect.map(current => current.get(runId) ?? 0))
      })
    })
  )
