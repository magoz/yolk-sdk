import { Arbitrary } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  defaultPoolMaxAgeMs,
  rankPool,
  type PoolCandidate,
  type PoolRankInput,
  type PoolReading,
  type PoolWindow
} from '@yolk-sdk/pool'

const runs = Number(process.env.PROPERTY_RUNS ?? 200)

const propertyOptions = { arbitrary: { runs: Number.isInteger(runs) && runs > 0 ? runs : 200 } }

const nowMs = Date.parse('2026-10-09T12:00:00.000Z')

const hour = 3_600_000

const ids = ['a', 'b', 'c', 'd'] as const

const small = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))

const WindowCase = Schema.Struct({
  long: Schema.Boolean,
  used: small(100),
  /** Hours from now; negative resets have passed, `null` has not started. */
  resetHours: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 200 }))),
  scoped: Schema.Boolean
})

const AccountCase = Schema.Struct({
  id: Schema.Literals(ids),
  priority: small(3),
  available: Schema.Boolean,
  reading: Schema.NullOr(
    Schema.Struct({ ageMinutes: small(60), windows: Schema.Array(WindowCase) })
  )
})

const Scenario = Schema.Struct({
  accounts: Schema.Array(AccountCase),
  pin: Schema.NullOr(Schema.Literals(ids)),
  route: Schema.Literals(['claude-opus-5-5', 'claude-fable-5']),
  reserve: small(10)
})

type Scenario = typeof Scenario.Type

const window = (current: typeof WindowCase.Type): PoolWindow => {
  const base = {
    durationMinutes: current.long ? 10_080 : 300,
    usedPercent: current.used,
    models: current.scoped ? ['fable'] : []
  }

  return current.resetHours === null
    ? base
    : { ...base, resetsAtMs: nowMs + current.resetHours * hour }
}

const toInput = (scenario: Scenario): PoolRankInput => {
  const seen = new Set<string>()
  const accounts: Array<PoolCandidate> = []
  const unavailable = new Set<string>()
  const readings = new Map<string, PoolReading>()

  for (const account of scenario.accounts) {
    if (seen.has(account.id)) {
      continue
    }

    seen.add(account.id)
    accounts.push({ id: account.id, priority: account.priority })

    if (!account.available) {
      unavailable.add(account.id)
    }

    if (account.reading !== null) {
      readings.set(account.id, {
        fetchedAtMs: nowMs - account.reading.ageMinutes * 60_000,
        windows: account.reading.windows.map(window)
      })
    }
  }

  return {
    accounts,
    unavailable,
    readings,
    pin: scenario.pin ?? undefined,
    route: scenario.route,
    nowMs,
    maxAgeMs: defaultPoolMaxAgeMs,
    reservePercent: scenario.reserve
  }
}

/** An independent statement of "this account may serve the route on quota". */
const usableOnQuota = (input: PoolRankInput, accountId: string) => {
  const reading = input.readings.get(accountId)

  if (reading === undefined || input.nowMs - reading.fetchedAtMs > input.maxAgeMs) {
    return false
  }

  const applicable = reading.windows.filter(
    current =>
      current.models.length === 0 || current.models.some(model => input.route.includes(model))
  )

  return (
    applicable.length > 0 &&
    applicable.every(
      current =>
        current.resetsAtMs === undefined ||
        current.resetsAtMs <= input.nowMs ||
        current.usedPercent < 100 - input.reservePercent
    )
  )
}

describe('rankPool properties', () => {
  it.prop(
    'serves an available account whenever one exists, and only then',
    [Arbitrary.schema(Scenario)],
    ([scenario]) => {
      const input = toInput(scenario)
      const decision = rankPool(input)
      const available = input.accounts.filter(account => !input.unavailable.has(account.id))

      if (available.length === 0) {
        expect(decision).toBeUndefined()

        return
      }

      expect(decision).toBeDefined()
      expect(input.unavailable.has(decision?.accountId ?? '')).toBe(false)
      expect(available.map(account => account.id)).toContain(decision?.accountId)
    },
    propertyOptions
  )

  it.prop(
    'never serves a used-up account while a fresh reading makes another one usable',
    [Arbitrary.schema(Scenario)],
    ([scenario]) => {
      const input = toInput(scenario)
      const decision = rankPool(input)

      const usable = input.accounts.filter(
        account => !input.unavailable.has(account.id) && usableOnQuota(input, account.id)
      )

      if (usable.length === 0) {
        expect(decision?._tag).not.toBe('Quota')

        return
      }

      expect(decision?._tag).toBe('Quota')
      expect(usable.map(account => account.id)).toContain(decision?.accountId)
    },
    propertyOptions
  )

  it.prop(
    'does not depend on account order',
    [Arbitrary.schema(Scenario)],
    ([scenario]) => {
      const input = toInput(scenario)

      expect(rankPool({ ...input, accounts: [...input.accounts].reverse() })).toEqual(
        rankPool(input)
      )
    },
    propertyOptions
  )

  it.prop(
    'keeps an available pin when no fresh reading decides',
    [Arbitrary.schema(Scenario)],
    ([scenario]) => {
      const input = toInput(scenario)
      const decision = rankPool(input)

      if (
        decision?._tag === 'Quota' ||
        input.pin === undefined ||
        input.unavailable.has(input.pin) ||
        !input.accounts.some(account => account.id === input.pin)
      ) {
        return
      }

      expect(decision?._tag).toBe('Sticky')
      expect(decision?.accountId).toBe(input.pin)
    },
    propertyOptions
  )
})
