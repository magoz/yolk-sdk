import { Data, Effect, Match, Ref } from 'effect'

export type DrainWork = Effect.Effect<void>

export type DrainToken = {
  readonly id: number
}

export type DrainSlot =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Held'; readonly work: DrainWork; readonly token: DrainToken }

export const DrainSlot = Data.taggedEnum<DrainSlot>()

export const makeDrainOccupancy = (): Effect.Effect<{
  readonly occupy: (work: DrainWork, token: DrainToken) => Effect.Effect<boolean>
  readonly runHeld: Effect.Effect<void>
  readonly releaseIf: (token: DrainToken) => Effect.Effect<boolean>
  readonly isHeld: Effect.Effect<boolean>
}> =>
  Effect.gen(function* () {
    const drainSlot = yield* Ref.make<DrainSlot>(DrainSlot.Idle())

    return {
      occupy: (work: DrainWork, token: DrainToken) =>
        Ref.modify(drainSlot, current =>
          DrainSlot.$is('Idle')(current)
            ? [true, DrainSlot.Held({ work, token })]
            : [false, current]
        ),
      runHeld: Ref.get(drainSlot).pipe(
        Effect.flatMap(slot =>
          Match.value(slot).pipe(
            Match.tag('Idle', () => Effect.void),
            Match.tag('Held', held => held.work),
            Match.exhaustive
          )
        )
      ),
      releaseIf: (token: DrainToken) =>
        Ref.modify(drainSlot, current =>
          DrainSlot.$is('Held')(current) && current.token.id === token.id
            ? [true, DrainSlot.Idle()]
            : [false, current]
        ),
      isHeld: Ref.get(drainSlot).pipe(Effect.map(DrainSlot.$is('Held')))
    }
  })
