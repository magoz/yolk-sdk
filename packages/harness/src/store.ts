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
