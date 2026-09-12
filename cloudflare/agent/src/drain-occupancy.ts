import { Effect, Ref } from 'effect'

export type DrainWork = Effect.Effect<void>

export type DrainToken = {
  readonly id: number
}

export type DrainSlot =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Held'; readonly work: DrainWork; readonly token: DrainToken }

export const makeDrainOccupancy = (): Effect.Effect<{
  readonly occupy: (work: DrainWork, token: DrainToken) => Effect.Effect<boolean>
  readonly runHeld: Effect.Effect<void>
  readonly releaseIf: (token: DrainToken) => Effect.Effect<boolean>
  readonly isHeld: Effect.Effect<boolean>
}> =>
  Effect.gen(function* () {
    const drainSlot = yield* Ref.make<DrainSlot>({ _tag: 'Idle' })

    return {
      occupy: (work: DrainWork, token: DrainToken) =>
        Ref.modify(drainSlot, current => {
          if (current._tag !== 'Idle') {
            return [false, current]
          }
          const held: DrainSlot = { _tag: 'Held', work, token }
          return [true, held]
        }),
      runHeld: Ref.get(drainSlot).pipe(
        Effect.flatMap(slot => (slot._tag === 'Idle' ? Effect.void : slot.work))
      ),
      releaseIf: (token: DrainToken) =>
        Ref.modify(drainSlot, current => {
          if (current._tag !== 'Held' || current.token.id !== token.id) {
            return [false, current]
          }
          return [true, { _tag: 'Idle' as const }]
        }),
      isHeld: Ref.get(drainSlot).pipe(Effect.map(slot => slot._tag === 'Held'))
    }
  })
