import { Context, Effect, Layer, Ref } from 'effect'

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
  Layer.succeed(
    RunStore,
    RunStore.of({
      claim: runId =>
        options.load.pipe(
          Effect.flatMap(loaded => {
            const state = stateFromSnapshot(loaded ?? emptySnapshot)
            state.claimed.add(runId)
            return options.save(snapshotFromState(state.claimed, state.resumes))
          })
        ),
      release: runId =>
        options.load.pipe(
          Effect.flatMap(loaded => {
            const state = stateFromSnapshot(loaded ?? emptySnapshot)
            state.claimed.delete(runId)
            state.resumes.delete(runId)
            return options.save(snapshotFromState(state.claimed, state.resumes))
          })
        ),
      isClaimed: runId =>
        options.load.pipe(Effect.map(loaded => (loaded ?? emptySnapshot).claimed.includes(runId))),
      claimed: options.load.pipe(Effect.map(loaded => new Set((loaded ?? emptySnapshot).claimed))),
      incrementResumeCount: runId =>
        options.load.pipe(
          Effect.flatMap(loaded => {
            const state = stateFromSnapshot(loaded ?? emptySnapshot)
            const nextCount = (state.resumes.get(runId) ?? 0) + 1
            state.resumes.set(runId, nextCount)
            return options
              .save(snapshotFromState(state.claimed, state.resumes))
              .pipe(Effect.as(nextCount))
          })
        ),
      resumeCount: runId =>
        options.load.pipe(
          Effect.map(loaded => {
            const entry = (loaded ?? emptySnapshot).resumes.find(([key]) => key === runId)
            return entry === undefined ? 0 : entry[1]
          })
        )
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
