import { Effect, Ref } from 'effect'

export type DrainWork = Effect.Effect<void>

export type DrainSlot =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Held'; readonly work: DrainWork }

export const makeDrainOccupancy = (): Effect.Effect<{
  readonly occupy: (work: DrainWork) => Effect.Effect<boolean>
  readonly drain: Effect.Effect<void>
}> =>
  Effect.gen(function* () {
    const drainSlot = yield* Ref.make<DrainSlot>({ _tag: 'Idle' })

    return {
      occupy: (work: DrainWork) =>
        Ref.modify(drainSlot, current => {
          if (current._tag !== 'Idle') {
            return [false, current]
          }
          const held: DrainSlot = { _tag: 'Held', work }
          return [true, held]
        }),
      drain: Ref.get(drainSlot).pipe(
        Effect.flatMap(slot => {
          if (slot._tag === 'Idle') {
            return Effect.void
          }
          const idle: DrainSlot = { _tag: 'Idle' }
          return slot.work.pipe(Effect.ensuring(Ref.set(drainSlot, idle)))
        })
      )
    }
  })
