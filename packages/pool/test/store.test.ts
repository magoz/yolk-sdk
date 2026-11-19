import { Effect, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { PoolAuthCooldown, PoolQuotaCooldown, type PoolCooldown } from '@yolk-sdk/pool'
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

  it.effect('catches a store that overwrites a cooldown ending at the same time', () =>
    Effect.gen(function* () {
      const broken = (): PoolStoreApi => {
        const store = makeMemoryPoolStore()

        return {
          ...store,
          putCooldown: cooldown =>
            store.load({ poolId: 'pool', route: 'model', accountIds: [cooldown.accountId] }).pipe(
              Effect.flatMap(({ cooldowns }) => {
                const current = cooldowns[0]

                return current !== undefined && current.untilMs === cooldown.untilMs
                  ? store
                      .clearCooldown({
                        accountId: current.accountId,
                        startedAtMs: current.startedAtMs
                      })
                      .pipe(Effect.andThen(store.putCooldown(cooldown)))
                  : store.putCooldown(cooldown)
              })
            )
        }
      }

      expect(yield* failures(broken)).toContain(
        'of two cooldowns that end together, the later-started one stays, whatever the write order'
      )
    })
  )

  /** The memory store, with `putCooldown` writing `merge` of the current and the new cooldown. */
  const merging =
    (merge: (current: PoolCooldown, next: PoolCooldown) => PoolCooldown) => (): PoolStoreApi => {
      const store = makeMemoryPoolStore()

      return {
        ...store,
        putCooldown: cooldown =>
          store.load({ poolId: 'pool', route: 'model', accountIds: [cooldown.accountId] }).pipe(
            Effect.flatMap(({ cooldowns }) => {
              const current = cooldowns[0]

              return current === undefined
                ? store.putCooldown(cooldown)
                : store
                    .clearCooldown(current)
                    .pipe(Effect.andThen(store.putCooldown(merge(current, cooldown))))
            })
          )
      }
    }

  const endsLater = (current: PoolCooldown, next: PoolCooldown) =>
    next.untilMs > current.untilMs ||
    (next.untilMs === current.untilMs && next.startedAtMs > current.startedAtMs)
      ? next
      : current

  it.effect('catches a store that keeps a longer cooldown without the newer failure’s start', () =>
    Effect.gen(function* () {
      expect(yield* failures(merging(endsLater))).toEqual([
        'a later-ending cooldown kept over a newer failure takes that failure’s start'
      ])
    })
  )

  it.effect('catches a store that absorbs an auth failure into a quota cooldown', () =>
    Effect.gen(function* () {
      const newestStart = (current: PoolCooldown, next: PoolCooldown) => {
        const kept = endsLater(current, next)

        const fields = {
          accountId: kept.accountId,
          startedAtMs: Math.max(current.startedAtMs, next.startedAtMs),
          untilMs: kept.untilMs
        }

        return Predicate.isTagged(kept, 'PoolAuthCooldown')
          ? PoolAuthCooldown.make(fields)
          : PoolQuotaCooldown.make(fields)
      }

      expect(yield* failures(merging(newestStart))).toEqual([
        'a cooldown kept for two failures is an auth cooldown when either was auth'
      ])
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
