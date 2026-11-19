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

  /**
   * A store whose cooldowns live in a plain map that `putCooldown` overwrites with `merge` of the
   * current and the written cooldown, so the contract sees exactly that merge. Clearing follows the
   * contract (an observed quota cooldown only); pins and readings are the memory store's.
   */
  const merging =
    (merge: (current: PoolCooldown, next: PoolCooldown) => PoolCooldown) => (): PoolStoreApi => {
      const store = makeMemoryPoolStore()
      const cooldowns = new Map<string, PoolCooldown>()

      const pick = (accountIds: ReadonlyArray<string>) =>
        accountIds.flatMap(accountId => {
          const cooldown = cooldowns.get(accountId)

          return cooldown === undefined ? [] : [cooldown]
        })

      return {
        ...store,
        load: input =>
          store
            .load(input)
            .pipe(Effect.map(snapshot => ({ ...snapshot, cooldowns: pick(input.accountIds) }))),
        state: input =>
          store
            .state(input)
            .pipe(Effect.map(state => ({ ...state, cooldowns: pick(input.accountIds) }))),
        putCooldown: cooldown =>
          Effect.sync(() => {
            const current = cooldowns.get(cooldown.accountId)

            cooldowns.set(
              cooldown.accountId,
              current === undefined ? cooldown : merge(current, cooldown)
            )
          }),
        clearCooldown: input =>
          Effect.sync(() => {
            const current = cooldowns.get(input.accountId)

            return (
              Predicate.isTagged(current, 'PoolQuotaCooldown') &&
              current.startedAtMs === input.startedAtMs &&
              current.authUntilMs === input.authUntilMs &&
              cooldowns.delete(input.accountId)
            )
          })
      }
    }

  /** The later-ending cooldown as written (of two that end together, the later-started one). */
  const endsLater = (current: PoolCooldown, next: PoolCooldown) =>
    next.untilMs > current.untilMs ||
    (next.untilMs === current.untilMs && next.startedAtMs > current.startedAtMs)
      ? next
      : current

  it.effect('catches a store that overwrites a cooldown ending at the same time', () =>
    Effect.gen(function* () {
      const tieOverwrites = (current: PoolCooldown, next: PoolCooldown) =>
        next.untilMs >= current.untilMs ? next : current

      expect(yield* failures(merging(tieOverwrites))).toContain(
        'of two cooldowns that end together, the later-started one stays, whatever the write order'
      )
    })
  )

  it.effect('catches a store that lets an earlier cooldown win', () =>
    Effect.gen(function* () {
      expect(yield* failures(merging((_, next) => next))).toContain(
        'an earlier-ending cooldown does not replace a later one'
      )
    })
  )

  it.effect('catches a store that keeps a longer cooldown without the newer failure’s start', () =>
    Effect.gen(function* () {
      expect(yield* failures(merging(endsLater))).toEqual([
        'a longer quota cooldown absorbs a newer, shorter auth failure: its start and its end (forward)'
      ])
    })
  )

  it.effect('catches a store that forgets an absorbed auth failure', () =>
    Effect.gen(function* () {
      const newestStartOnly = (current: PoolCooldown, next: PoolCooldown) => {
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

      expect(yield* failures(merging(newestStartOnly))).toEqual([
        'a longer quota cooldown absorbs a newer, shorter auth failure: its start and its end (forward)'
      ])
    })
  )

  it.effect('catches a store that clears without comparing the absorbed auth failure', () =>
    Effect.gen(function* () {
      const broken = (): PoolStoreApi => {
        const store = makeMemoryPoolStore()

        return {
          ...store,
          clearCooldown: input =>
            store.load({ poolId: 'pool', route: 'model', accountIds: [input.accountId] }).pipe(
              Effect.flatMap(({ cooldowns }) => {
                const current = cooldowns[0]

                return store.clearCooldown({
                  ...input,
                  authUntilMs: Predicate.isTagged(current, 'PoolQuotaCooldown')
                    ? current.authUntilMs
                    : undefined
                })
              })
            )
        }
      }

      expect(yield* failures(broken)).toEqual([
        'clearing without the absorbed auth failure’s end is refused (forward)'
      ])
    })
  )

  it.effect('catches a store that lets an ended auth cooldown turn the next one into auth', () =>
    Effect.gen(function* () {
      const authDominates = (current: PoolCooldown, next: PoolCooldown) => {
        const kept = endsLater(current, next)

        const fields = {
          accountId: kept.accountId,
          startedAtMs: Math.max(current.startedAtMs, next.startedAtMs),
          untilMs: kept.untilMs
        }

        return Predicate.isTagged(current, 'PoolAuthCooldown') ||
          Predicate.isTagged(next, 'PoolAuthCooldown')
          ? PoolAuthCooldown.make(fields)
          : PoolQuotaCooldown.make(fields)
      }

      expect(yield* failures(merging(authDominates))).toEqual([
        'an auth cooldown that ended before a quota failure gives way to it (forward)'
      ])
    })
  )
})
