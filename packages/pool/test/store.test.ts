import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeMemoryPoolStore, poolStoreContract, type PoolStoreApi } from '@yolk-sdk/pool/store'

describe('makeMemoryPoolStore', () => {
  for (const contractCase of poolStoreContract) {
    it.effect(`meets the store contract: ${contractCase.name}`, () =>
      contractCase.run(makeMemoryPoolStore())
    )
  }
})

describe('poolStoreContract', () => {
  const failures = (store: () => PoolStoreApi) =>
    Effect.forEach(poolStoreContract, contractCase =>
      contractCase.run(store()).pipe(
        Effect.flip,
        Effect.map(error => error.message),
        Effect.orElseSucceed(() => undefined)
      )
    ).pipe(Effect.map(results => results.filter(result => result !== undefined)))

  it.effect('catches a store that overwrites pins without comparing', () =>
    Effect.gen(function* () {
      const broken = (): PoolStoreApi => {
        const store = makeMemoryPoolStore()

        return {
          ...store,
          movePin: input => store.movePin(input).pipe(Effect.as(true))
        }
      }

      expect(yield* failures(broken)).toContain('creating a pin that already exists is refused')
    })
  )

  it.effect('catches a store that lets an earlier cooldown win', () =>
    Effect.gen(function* () {
      const broken = (): PoolStoreApi => {
        const store = makeMemoryPoolStore()

        return {
          ...store,
          putCooldown: cooldown =>
            store
              .clearCooldown({ accountId: cooldown.accountId, startedAtMs: 1 })
              .pipe(Effect.andThen(store.putCooldown(cooldown)))
        }
      }

      expect(yield* failures(broken)).toContain(
        'an earlier-ending cooldown does not replace a later one'
      )
    })
  )
})
