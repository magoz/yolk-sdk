import { Chunk, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ProviderSubscriptionUsageSnapshot } from '@yolk-sdk/agent/providers/subscription-usage'
import {
  PoolAccountId,
  PoolAuthCooldown,
  PoolPin,
  PoolQuotaCooldown,
  type PoolCooldown,
  type PoolStoreError
} from './model.ts'

export { PoolStoreError } from './model.ts'

/** The latest usage snapshot of one account. */
export class PoolStoredReading extends Schema.Class<PoolStoredReading>('PoolStoredReading')({
  accountId: PoolAccountId,
  snapshot: ProviderSubscriptionUsageSnapshot
}) {}

/** What one pick reads: the route's pin plus the cooldowns and readings of the pool's accounts. */
export type PoolStoreSnapshot = {
  readonly pin: PoolPin | undefined
  readonly cooldowns: ReadonlyArray<PoolCooldown>
  readonly readings: ReadonlyArray<PoolStoredReading>
}

/** Everything a store holds for one pool, for host UIs. */
export type PoolStoreState = {
  readonly pins: ReadonlyArray<PoolPin>
  readonly cooldowns: ReadonlyArray<PoolCooldown>
  readonly readings: ReadonlyArray<PoolStoredReading>
}

/**
 * Pool state shared by every instance of a host (ADR 0011). Hosts implement it on their database;
 * `makeMemoryPoolStore` serves tests and single-process hosts, and `poolStoreContract` pins the
 * semantics every implementation must meet.
 *
 * - Pins are keyed by `(poolId, route)`; cooldowns and readings by account id, so a cooldown or
 *   reading applies to every pool the account is in.
 * - Operations must be atomic per key: concurrent `movePin` calls with the same `expected` let
 *   exactly one through.
 */
export type PoolStoreApi = {
  /** The route's pin and the requested accounts' cooldowns (expired ones included) and readings. */
  readonly load: (input: {
    readonly poolId: string
    readonly route: string
    readonly accountIds: ReadonlyArray<string>
  }) => Effect.Effect<PoolStoreSnapshot, PoolStoreError>
  /**
   * Compare-and-set: writes `pin` when the route's current account is `expected` (`undefined`:
   * the route has no pin yet). Returns whether it wrote.
   */
  readonly movePin: (input: {
    readonly expected: string | undefined
    readonly pin: PoolPin
  }) => Effect.Effect<boolean, PoolStoreError>
  /**
   * Records a cooldown. When the account already has one:
   *
   * - one that ended before the other began is replaced by the other (an expired cooldown never
   *   shapes a later one);
   * - two that overlap merge into one: the later end and its kind (of two that end together, the
   *   later-started one's kind; of two that also start together, quota), with the later
   *   `startedAtMs` of the two, so the kept cooldown carries the newest failure's time and a
   *   reading taken before that failure never clears it;
   * - a kept quota cooldown records the latest end of any auth failure it absorbed as
   *   `authUntilMs` (omitted when that ended by the kept start), so no reading clears it before
   *   then.
   *
   * Concurrent writes for one account are the normal case, so merge atomically: one statement,
   * never a read followed by a write. For example an upsert that sets the start to the greatest
   * start, picks the end and kind with a `CASE` on which ends later (then which started later,
   * then quota), and sets `authUntilMs` to the greatest auth end of the two (an auth cooldown's
   * end, a quota cooldown's `authUntilMs`) when the kept one is quota and that end is after the
   * merged start, else null.
   */
  readonly putCooldown: (cooldown: PoolCooldown) => Effect.Effect<void, PoolStoreError>
  /**
   * Removes the account's quota cooldown only when it is the one observed (same `startedAtMs` and
   * `authUntilMs`). Never removes an auth cooldown. Two failures in the same millisecond share a
   * start, so the start alone cannot tell a quota cooldown from what it became after absorbing an
   * auth failure: that merge either made it an auth cooldown or set `authUntilMs`, and both make
   * a clear observed before it fail. Returns whether it removed one.
   */
  readonly clearCooldown: (input: {
    readonly accountId: string
    readonly startedAtMs: number
    /** The observed cooldown's `authUntilMs` (`undefined` when it had none). */
    readonly authUntilMs: number | undefined
  }) => Effect.Effect<boolean, PoolStoreError>
  /** Records a reading unless the stored one was fetched later. */
  readonly putReading: (reading: PoolStoredReading) => Effect.Effect<void, PoolStoreError>
  /** The pool's pins and the requested accounts' cooldowns and readings. */
  readonly state: (input: {
    readonly poolId: string
    readonly accountIds: ReadonlyArray<string>
  }) => Effect.Effect<PoolStoreState, PoolStoreError>
}

const pinKey = (poolId: string, route: string) => JSON.stringify([poolId, route])

const fetchedAtMs = (reading: PoolStoredReading) => Date.parse(reading.snapshot.fetchedAt)

/** Until when a cooldown stands for a rejected credential, if it does. */
const authUntilOf = (cooldown: PoolCooldown) =>
  Predicate.isTagged(cooldown, 'PoolAuthCooldown') ? cooldown.untilMs : cooldown.authUntilMs

/**
 * The account's cooldown after `next` is written over `current` (`putCooldown`): a cooldown that
 * ended before the other began gives way to it; overlapping ones keep the later end and its kind,
 * dated to the newer failure, and a kept quota cooldown keeps the end of an auth failure it
 * absorbed.
 */
const mergeCooldowns = (current: PoolCooldown, next: PoolCooldown): PoolCooldown => {
  if (current.untilMs <= next.startedAtMs) {
    return next
  }

  if (next.untilMs <= current.startedAtMs) {
    return current
  }

  // The later end, then the later start, then quota: "auth" means rejected credentials only.
  const nextWins =
    next.untilMs !== current.untilMs
      ? next.untilMs > current.untilMs
      : next.startedAtMs !== current.startedAtMs
        ? next.startedAtMs > current.startedAtMs
        : Predicate.isTagged(next, 'PoolQuotaCooldown')

  const kept = nextWins ? next : current

  const fields = {
    accountId: kept.accountId,
    startedAtMs: Math.max(current.startedAtMs, next.startedAtMs),
    untilMs: kept.untilMs
  }

  if (Predicate.isTagged(kept, 'PoolAuthCooldown')) {
    return PoolAuthCooldown.make(fields)
  }

  const authEnds = [current, next].flatMap(cooldown => {
    const until = authUntilOf(cooldown)

    return until === undefined ? [] : [until]
  })

  const authUntilMs = authEnds.length === 0 ? undefined : Math.max(...authEnds)

  return PoolQuotaCooldown.make(
    authUntilMs !== undefined && authUntilMs > fields.startedAtMs
      ? { ...fields, authUntilMs }
      : fields
  )
}

/**
 * An in-memory `PoolStoreApi`: state lives in this process only, so it suits tests and hosts that
 * run one long-lived process. Serverless hosts implement the port on their database.
 */
export const makeMemoryPoolStore = (): PoolStoreApi => {
  const pins = new Map<string, PoolPin>()
  const cooldowns = new Map<string, PoolCooldown>()
  const readings = new Map<string, PoolStoredReading>()

  const pick = <A>(source: Map<string, A>, accountIds: ReadonlyArray<string>) =>
    accountIds.flatMap(accountId => {
      const value = source.get(accountId)

      return value === undefined ? [] : [value]
    })

  return {
    load: input =>
      Effect.sync(() => ({
        pin: pins.get(pinKey(input.poolId, input.route)),
        cooldowns: pick(cooldowns, input.accountIds),
        readings: pick(readings, input.accountIds)
      })),
    movePin: input =>
      Effect.sync(() => {
        const key = pinKey(input.pin.poolId, input.pin.route)

        if (pins.get(key)?.accountId !== input.expected) {
          return false
        }

        pins.set(key, input.pin)

        return true
      }),
    putCooldown: cooldown =>
      Effect.sync(() => {
        const current = cooldowns.get(cooldown.accountId)

        cooldowns.set(
          cooldown.accountId,
          current === undefined ? cooldown : mergeCooldowns(current, cooldown)
        )
      }),
    clearCooldown: input =>
      Effect.sync(() => {
        const current = cooldowns.get(input.accountId)

        if (
          !Predicate.isTagged(current, 'PoolQuotaCooldown') ||
          current.startedAtMs !== input.startedAtMs ||
          current.authUntilMs !== input.authUntilMs
        ) {
          return false
        }

        cooldowns.delete(input.accountId)

        return true
      }),
    putReading: reading =>
      Effect.sync(() => {
        const current = readings.get(reading.accountId)

        if (current === undefined || fetchedAtMs(reading) >= fetchedAtMs(current)) {
          readings.set(reading.accountId, reading)
        }
      }),
    state: input =>
      Effect.sync(() => ({
        pins: Array.from(pins.values())
          .filter(pin => pin.poolId === input.poolId)
          .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)),
        cooldowns: pick(cooldowns, input.accountIds),
        readings: pick(readings, input.accountIds)
      }))
  }
}

/** A `PoolStoreApi` implementation broke the store contract. */
export class PoolStoreContractViolation extends Schema.TaggedError<PoolStoreContractViolation>()(
  'PoolStoreContractViolation',
  {
    case: Schema.String,
    message: Schema.String
  }
) {}

/** One semantic every `PoolStoreApi` must meet. Run each case against a fresh, empty store. */
export type PoolStoreContractCase = {
  readonly name: string
  readonly run: (
    store: PoolStoreApi
  ) => Effect.Effect<void, PoolStoreContractViolation | PoolStoreError>
}

const contractCase = (
  name: string,
  run: (
    store: PoolStoreApi,
    expect: (condition: boolean, message: string) => Effect.Effect<void, PoolStoreContractViolation>
  ) => Effect.Effect<void, PoolStoreContractViolation | PoolStoreError>
): PoolStoreContractCase => ({
  name,
  run: store =>
    run(store, (condition, message) =>
      condition ? Effect.void : Effect.fail(new PoolStoreContractViolation({ case: name, message }))
    )
})

const contractPin = (route: string, accountId: string, pinnedAtMs: number, poolId = 'pool') =>
  PoolPin.make({ poolId, route, accountId, pinnedAtMs })

const contractReading = (accountId: string, fetchedAt: string) =>
  PoolStoredReading.make({
    accountId,
    snapshot: ProviderSubscriptionUsageSnapshot.make({
      provider: 'contract',
      fetchedAt,
      windows: Chunk.empty()
    })
  })

type ContractCooldown = {
  readonly kind: 'quota' | 'auth'
  readonly startedAtMs: number
  readonly untilMs: number
  readonly authUntilMs?: number
}

const contractCooldown = (accountId: string, cooldown: ContractCooldown): PoolCooldown => {
  const fields = { accountId, startedAtMs: cooldown.startedAtMs, untilMs: cooldown.untilMs }

  if (cooldown.kind === 'auth') {
    return PoolAuthCooldown.make(fields)
  }

  return PoolQuotaCooldown.make(
    cooldown.authUntilMs === undefined ? fields : { ...fields, authUntilMs: cooldown.authUntilMs }
  )
}

/** Two failures of one account and the cooldown `putCooldown` keeps, in either write order. */
const contractMerges: ReadonlyArray<{
  readonly id: string
  readonly name: string
  readonly first: ContractCooldown
  readonly second: ContractCooldown
  readonly kept: ContractCooldown
}> = [
  {
    id: 'ended',
    name: 'an auth cooldown that ended before a quota failure gives way to it',
    first: { kind: 'auth', startedAtMs: 1, untilMs: 10 },
    second: { kind: 'quota', startedAtMs: 20, untilMs: 100 },
    kept: { kind: 'quota', startedAtMs: 20, untilMs: 100 }
  },
  {
    id: 'quota-auth',
    name: 'a longer quota cooldown absorbs a newer, shorter auth failure: its start and its end',
    first: { kind: 'quota', startedAtMs: 1, untilMs: 100 },
    second: { kind: 'auth', startedAtMs: 5, untilMs: 50 },
    kept: { kind: 'quota', startedAtMs: 5, untilMs: 100, authUntilMs: 50 }
  },
  {
    id: 'same-ms',
    name: 'a quota cooldown absorbs an auth failure of the same millisecond and keeps its end',
    first: { kind: 'quota', startedAtMs: 5, untilMs: 100 },
    second: { kind: 'auth', startedAtMs: 5, untilMs: 50 },
    kept: { kind: 'quota', startedAtMs: 5, untilMs: 100, authUntilMs: 50 }
  },
  {
    id: 'full-tie',
    name: 'of a quota and an auth cooldown that start and end together, quota stays with the auth end',
    first: { kind: 'quota', startedAtMs: 5, untilMs: 100 },
    second: { kind: 'auth', startedAtMs: 5, untilMs: 100 },
    kept: { kind: 'quota', startedAtMs: 5, untilMs: 100, authUntilMs: 100 }
  },
  {
    id: 'auth-quota',
    name: 'a longer auth cooldown absorbs a newer, shorter quota failure and stays auth',
    first: { kind: 'auth', startedAtMs: 1, untilMs: 100 },
    second: { kind: 'quota', startedAtMs: 5, untilMs: 50 },
    kept: { kind: 'auth', startedAtMs: 5, untilMs: 100 }
  },
  {
    id: 'quota-quota',
    name: 'a longer quota cooldown absorbs a newer, shorter quota failure and takes its start',
    first: { kind: 'quota', startedAtMs: 1, untilMs: 100 },
    second: { kind: 'quota', startedAtMs: 5, untilMs: 50 },
    kept: { kind: 'quota', startedAtMs: 5, untilMs: 100 }
  },
  {
    id: 'absorbed-ended',
    name: 'an absorbed auth failure that ended by the newest failure is dropped',
    first: { kind: 'quota', startedAtMs: 1, untilMs: 100, authUntilMs: 10 },
    second: { kind: 'quota', startedAtMs: 20, untilMs: 50 },
    kept: { kind: 'quota', startedAtMs: 20, untilMs: 100 }
  },
  {
    id: 'absorbed-carried',
    name: 'an absorbed auth failure still active is carried into a later-ending cooldown',
    first: { kind: 'quota', startedAtMs: 1, untilMs: 100, authUntilMs: 50 },
    second: { kind: 'quota', startedAtMs: 20, untilMs: 200 },
    kept: { kind: 'quota', startedAtMs: 20, untilMs: 200, authUntilMs: 50 }
  }
]

/** The `PoolStoreApi` contract. Hosts run every case against a fresh store of their implementation. */
export const poolStoreContract: ReadonlyArray<PoolStoreContractCase> = [
  contractCase('pins are created once and moved by compare-and-set', (store, expect) =>
    Effect.gen(function* () {
      const load = store.load({ poolId: 'pool', route: 'model', accountIds: [] })

      yield* expect((yield* load).pin === undefined, 'a new route has no pin')
      yield* expect(
        yield* store.movePin({ expected: undefined, pin: contractPin('model', 'a', 1) }),
        'the first pin is written'
      )
      yield* expect(
        !(yield* store.movePin({ expected: undefined, pin: contractPin('model', 'b', 2) })),
        'creating a pin that already exists is refused'
      )
      yield* expect(
        !(yield* store.movePin({ expected: 'b', pin: contractPin('model', 'c', 3) })),
        'a move expecting another account is refused'
      )
      yield* expect(
        yield* store.movePin({ expected: 'a', pin: contractPin('model', 'b', 4) }),
        'a move expecting the current account is written'
      )

      const pin = (yield* load).pin

      yield* expect(
        pin?.accountId === 'b' && pin.pinnedAtMs === 4,
        'load returns the latest pin with its time'
      )
    })
  ),
  contractCase('pins are keyed by pool and route', (store, expect) =>
    Effect.gen(function* () {
      yield* store.movePin({ expected: undefined, pin: contractPin('one', 'a', 1) })
      yield* store.movePin({ expected: undefined, pin: contractPin('two', 'b', 1) })
      yield* store.movePin({ expected: undefined, pin: contractPin('one', 'c', 1, 'other') })

      const one = yield* store.load({ poolId: 'pool', route: 'one', accountIds: [] })
      const two = yield* store.load({ poolId: 'pool', route: 'two', accountIds: [] })
      const other = yield* store.load({ poolId: 'other', route: 'one', accountIds: [] })

      yield* expect(
        one.pin?.accountId === 'a' && two.pin?.accountId === 'b' && other.pin?.accountId === 'c',
        'each (pool, route) keeps its own pin'
      )

      const state = yield* store.state({ poolId: 'pool', accountIds: [] })

      yield* expect(
        state.pins.map(pin => pin.route).join() === 'one,two',
        'state lists the pool’s pins only, ordered by route'
      )
    })
  ),
  contractCase('concurrent moves from the same pin let exactly one through', (store, expect) =>
    Effect.gen(function* () {
      yield* store.movePin({ expected: undefined, pin: contractPin('model', 'a', 1) })

      const results = yield* Effect.all(
        ['b', 'c', 'd', 'e'].map(accountId =>
          store.movePin({ expected: 'a', pin: contractPin('model', accountId, 2) })
        ),
        { concurrency: 'unbounded' }
      )

      yield* expect(results.filter(Boolean).length === 1, 'exactly one move is written')
    })
  ),
  contractCase('cooldowns keep the later end and clear only when observed', (store, expect) =>
    Effect.gen(function* () {
      const load = store.load({ poolId: 'pool', route: 'model', accountIds: ['a', 'b'] })

      yield* store.putCooldown(
        PoolQuotaCooldown.make({ accountId: 'a', startedAtMs: 1, untilMs: 100 })
      )
      yield* store.putCooldown(
        PoolAuthCooldown.make({ accountId: 'a', startedAtMs: 2, untilMs: 50 })
      )

      const kept = (yield* load).cooldowns

      yield* expect(
        kept.length === 1 && kept[0]?.untilMs === 100,
        'an earlier-ending cooldown does not replace a later one'
      )

      yield* store.putCooldown(
        PoolAuthCooldown.make({ accountId: 'a', startedAtMs: 3, untilMs: 200 })
      )

      const replaced = (yield* load).cooldowns

      yield* expect(
        replaced.length === 1 &&
          Predicate.isTagged(replaced[0], 'PoolAuthCooldown') &&
          replaced[0].startedAtMs === 3,
        'a later-ending cooldown replaces the current one'
      )
      yield* expect(
        !(yield* store.clearCooldown({ accountId: 'a', startedAtMs: 3, authUntilMs: undefined })),
        'an auth cooldown is never cleared, even with its start'
      )

      const quotaOfB = (startedAtMs: number) =>
        store.putCooldown(PoolQuotaCooldown.make({ accountId: 'b', startedAtMs, untilMs: 200 }))

      yield* quotaOfB(3)
      yield* quotaOfB(4)
      yield* quotaOfB(2)

      const renewed = (yield* load).cooldowns.filter(cooldown => cooldown.accountId === 'b')

      yield* expect(
        renewed.length === 1 && renewed[0]?.startedAtMs === 4,
        'of two cooldowns that end together, the later-started one stays, whatever the write order'
      )
      yield* expect(
        !(yield* store.clearCooldown({ accountId: 'b', startedAtMs: 3, authUntilMs: undefined })),
        'clearing a cooldown that is no longer current is refused'
      )
      yield* expect(
        yield* store.clearCooldown({ accountId: 'b', startedAtMs: 4, authUntilMs: undefined }),
        'clearing the observed cooldown succeeds'
      )
      yield* expect(
        (yield* load).cooldowns.every(cooldown => cooldown.accountId !== 'b'),
        'a cleared cooldown is gone'
      )
      yield* expect(
        !(yield* store.clearCooldown({ accountId: 'c', startedAtMs: 3, authUntilMs: undefined })),
        'clearing an account without a cooldown is refused'
      )
    })
  ),
  contractCase(
    'a cooldown that ended gives way; overlapping ones keep the later end with the newest start',
    (store, expect) =>
      Effect.gen(function* () {
        for (const merge of contractMerges) {
          for (const [order, writes] of [
            ['forward', [merge.first, merge.second]],
            ['reversed', [merge.second, merge.first]]
          ] as const) {
            const accountId = `${merge.id}-${order}`

            for (const write of writes) {
              yield* store.putCooldown(contractCooldown(accountId, write))
            }

            const kept = (yield* store.load({
              poolId: 'pool',
              route: 'model',
              accountIds: [accountId]
            })).cooldowns

            const cooldown = kept[0]

            yield* expect(
              kept.length === 1 &&
                cooldown !== undefined &&
                cooldown._tag ===
                  (merge.kept.kind === 'quota' ? 'PoolQuotaCooldown' : 'PoolAuthCooldown') &&
                cooldown.startedAtMs === merge.kept.startedAtMs &&
                cooldown.untilMs === merge.kept.untilMs &&
                (Predicate.isTagged(cooldown, 'PoolQuotaCooldown')
                  ? cooldown.authUntilMs
                  : undefined) === merge.kept.authUntilMs,
              `${merge.name} (${order})`
            )

            const clear = (startedAtMs: number, authUntilMs: number | undefined) =>
              store.clearCooldown({ accountId, startedAtMs, authUntilMs })

            yield* expect(
              !(yield* clear(
                Math.min(merge.first.startedAtMs, merge.second.startedAtMs),
                merge.first.authUntilMs
              )),
              `clearing with the older failure’s start is refused (${order})`
            )

            if (merge.kept.authUntilMs !== undefined) {
              yield* expect(
                !(yield* clear(merge.kept.startedAtMs, undefined)),
                `clearing without the absorbed auth failure’s end is refused (${order})`
              )
            }

            yield* expect(
              (yield* clear(merge.kept.startedAtMs, merge.kept.authUntilMs)) ===
                (merge.kept.kind === 'quota'),
              merge.kept.kind === 'quota'
                ? `a kept quota cooldown clears when observed as it is (${order})`
                : `a kept auth cooldown is never cleared (${order})`
            )
          }
        }
      })
  ),
  contractCase(
    'cooldowns and readings are returned for the requested accounts only',
    (store, expect) =>
      Effect.gen(function* () {
        yield* store.putCooldown(
          PoolQuotaCooldown.make({ accountId: 'a', startedAtMs: 1, untilMs: 9 })
        )
        yield* store.putCooldown(
          PoolQuotaCooldown.make({ accountId: 'b', startedAtMs: 1, untilMs: 9 })
        )
        yield* store.putReading(contractReading('a', '2026-10-15T12:00:00.000Z'))
        yield* store.putReading(contractReading('b', '2026-10-15T12:00:00.000Z'))

        const snapshot = yield* store.load({ poolId: 'pool', route: 'model', accountIds: ['b'] })
        const state = yield* store.state({ poolId: 'pool', accountIds: ['a'] })

        yield* expect(
          snapshot.cooldowns.every(cooldown => cooldown.accountId === 'b') &&
            snapshot.cooldowns.length === 1 &&
            snapshot.readings.every(reading => reading.accountId === 'b') &&
            snapshot.readings.length === 1,
          'load filters by account'
        )
        yield* expect(
          state.cooldowns.length === 1 &&
            state.cooldowns[0]?.accountId === 'a' &&
            state.readings.length === 1 &&
            state.readings[0]?.accountId === 'a',
          'state filters by account'
        )
      })
  ),
  contractCase('readings keep the latest fetch', (store, expect) =>
    Effect.gen(function* () {
      const load = store.load({ poolId: 'pool', route: 'model', accountIds: ['a'] })

      yield* store.putReading(contractReading('a', '2026-10-15T12:00:00.000Z'))
      yield* store.putReading(contractReading('a', '2026-10-15T11:00:00.000Z'))

      yield* expect(
        (yield* load).readings[0]?.snapshot.fetchedAt === '2026-10-15T12:00:00.000Z',
        'an older reading does not replace a newer one'
      )

      yield* store.putReading(contractReading('a', '2026-10-15T13:00:00.000Z'))

      yield* expect(
        (yield* load).readings[0]?.snapshot.fetchedAt === '2026-10-15T13:00:00.000Z',
        'a newer reading replaces the stored one'
      )
    })
  )
]
