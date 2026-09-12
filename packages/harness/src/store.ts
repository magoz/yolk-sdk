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

type MemorySnapshot = {
  readonly claimed: ReadonlySet<string>
  readonly resumes: ReadonlyMap<string, number>
}

const emptySnapshot: DurableRunStoreSnapshot = {
  claimed: [],
  resumes: []
}

const snapshotFromMemory = (memory: MemorySnapshot): DurableRunStoreSnapshot => ({
  claimed: [...memory.claimed],
  resumes: [...memory.resumes.entries()]
})

const memoryFromSnapshot = (snapshot: DurableRunStoreSnapshot): MemorySnapshot => ({
  claimed: new Set(snapshot.claimed),
  resumes: new Map(snapshot.resumes)
})

const makeSnapshotRunStore = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
}): Effect.Effect<RunStore['Service']> =>
  Effect.gen(function* () {
    const loaded = yield* options.load
    const memory = yield* Ref.make(memoryFromSnapshot(loaded ?? emptySnapshot))
    const lock = yield* Semaphore.make(1)
    const mutate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask(restore =>
        restore(lock.take(1)).pipe(
          Effect.flatMap(() => effect.pipe(Effect.ensuring(lock.release(1))))
        )
      )
    const commit = (next: MemorySnapshot) =>
      options.save(snapshotFromMemory(next)).pipe(Effect.flatMap(() => Ref.set(memory, next)))

    return RunStore.of({
      claim: runId =>
        mutate(
          Effect.gen(function* () {
            const current = yield* Ref.get(memory)
            yield* commit({
              claimed: new Set(current.claimed).add(runId),
              resumes: current.resumes
            })
          })
        ),
      release: runId =>
        mutate(
          Effect.gen(function* () {
            const current = yield* Ref.get(memory)
            const claimed = new Set(current.claimed)
            claimed.delete(runId)
            const resumes = new Map(current.resumes)
            resumes.delete(runId)
            yield* commit({ claimed, resumes })
          })
        ),
      isClaimed: runId => Ref.get(memory).pipe(Effect.map(current => current.claimed.has(runId))),
      claimed: Ref.get(memory).pipe(Effect.map(current => new Set(current.claimed))),
      incrementResumeCount: runId =>
        mutate(
          Effect.gen(function* () {
            const current = yield* Ref.get(memory)
            const nextCount = (current.resumes.get(runId) ?? 0) + 1
            const resumes = new Map(current.resumes)
            resumes.set(runId, nextCount)
            yield* commit({ claimed: current.claimed, resumes })
            return nextCount
          })
        ),
      resumeCount: runId =>
        Ref.get(memory).pipe(Effect.map(current => current.resumes.get(runId) ?? 0))
    })
  })

export const makeSnapshotRunStoreLayer = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
}): Layer.Layer<RunStore> => Layer.effect(RunStore, makeSnapshotRunStore(options))

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
