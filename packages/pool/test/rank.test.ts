import { Chunk } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageWindow
} from '@yolk-sdk/agent/providers/subscription-usage'
import {
  defaultPoolMaxAgeMs,
  PoolAuthCooldown,
  type PoolCooldown,
  PoolDecision,
  PoolQuotaCooldown,
  poolReadingFromSnapshot,
  poolRoute,
  rankPool,
  staleQuotaCooldowns,
  type PoolCandidate,
  type PoolRankInput,
  type PoolReading,
  type PoolWindow
} from '@yolk-sdk/pool'

// Ported from magoz/cpa-expiring-first internal/router/{scheduler,quota,cooldown}_test.go. The Go
// scheduler's grace period, host inspector, and quota file are gone: the pool knows why an account
// is out, so those cases become the `unavailable` set.

const t0 = Date.parse('2026-10-09T12:00:00.000Z')

const minute = 60_000

const hour = 60 * minute

const day = 24 * hour

const week = 7 * 24 * 60

const primary: PoolCandidate = { id: 'primary', priority: 10 }

const backup: PoolCandidate = { id: 'backup', priority: 0 }

const weekly = (usedPercent: number, resetsAtMs?: number): PoolWindow =>
  resetsAtMs === undefined
    ? { durationMinutes: week, usedPercent, models: [] }
    : { durationMinutes: week, usedPercent, resetsAtMs, models: [] }

const session = (usedPercent: number, resetsAtMs?: number): PoolWindow =>
  resetsAtMs === undefined
    ? { durationMinutes: 300, usedPercent, models: [] }
    : { durationMinutes: 300, usedPercent, resetsAtMs, models: [] }

const reading = (...windows: ReadonlyArray<PoolWindow>): PoolReading => ({
  fetchedAtMs: t0,
  windows
})

const rank = (input: Partial<PoolRankInput>) =>
  rankPool({
    accounts: input.accounts ?? [primary, backup],
    unavailable: input.unavailable ?? new Set(),
    readings: input.readings ?? new Map(),
    pin: input.pin,
    route: input.route ?? 'm',
    nowMs: input.nowMs ?? t0,
    maxAgeMs: input.maxAgeMs ?? defaultPoolMaxAgeMs,
    reservePercent: input.reservePercent ?? 0
  })

const readings = (entries: Record<string, PoolReading>) => new Map(Object.entries(entries))

describe('rankPool without readings (sticky fill-first)', () => {
  it('first pick follows fill-first order', () => {
    expect(rank({ accounts: [backup, primary] })).toEqual(
      PoolDecision.FillFirst({ accountId: 'primary' })
    )
    expect(
      rank({
        accounts: [
          { id: 'b', priority: 1 },
          { id: 'a', priority: 1 }
        ]
      })
    ).toEqual(PoolDecision.FillFirst({ accountId: 'a' }))
  })

  it('stays on the failover account after the primary recovers', () => {
    // Primary ran out: the pin moved to backup.
    expect(rank({ unavailable: new Set(['primary']), pin: 'primary' })).toEqual(
      PoolDecision.FillFirst({ accountId: 'backup' })
    )
    // Primary's window resets; traffic stays on backup.
    expect(rank({ pin: 'backup' })).toEqual(PoolDecision.Sticky({ accountId: 'backup' }))
    // Backup runs out next; the pin moves back to primary.
    expect(rank({ unavailable: new Set(['backup']), pin: 'backup' })).toEqual(
      PoolDecision.FillFirst({ accountId: 'primary' })
    )
  })

  it('moves a pin to an account that is no longer configured', () => {
    expect(rank({ pin: 'retired' })).toEqual(PoolDecision.FillFirst({ accountId: 'primary' }))
  })

  it('returns nothing when every account is unavailable', () => {
    expect(rank({ unavailable: new Set(['primary', 'backup']), pin: 'primary' })).toBeUndefined()
  })
})

describe('rankPool with fresh readings (expiring-first)', () => {
  it('picks the soonest weekly reset over priority and stickiness', () => {
    expect(
      rank({
        pin: 'primary',
        readings: readings({
          primary: reading(weekly(30, t0 + 4 * day)),
          backup: reading(weekly(80, t0 + day))
        })
      })
    ).toEqual(PoolDecision.Quota({ accountId: 'backup', resetsAtMs: t0 + day }))
  })

  it('prefers started windows over windows that have not started', () => {
    expect(
      rank({
        readings: readings({
          primary: reading(weekly(0)),
          backup: reading(weekly(10, t0 + 6 * day))
        })
      })
    ).toEqual(PoolDecision.Quota({ accountId: 'backup', resetsAtMs: t0 + 6 * day }))
  })

  it('breaks ties by priority, then id', () => {
    expect(
      rank({
        accounts: [backup, primary],
        readings: readings({ primary: reading(weekly(0)), backup: reading(weekly(0)) })
      })
    ).toEqual(PoolDecision.Quota({ accountId: 'primary', resetsAtMs: undefined }))
    expect(
      rank({
        accounts: [
          { id: 'c', priority: 1 },
          { id: 'b', priority: 1 }
        ],
        readings: readings({ b: reading(weekly(0)), c: reading(weekly(0)) })
      })
    ).toEqual(PoolDecision.Quota({ accountId: 'b', resetsAtMs: undefined }))
  })

  it.each([
    [
      'weekly used up',
      { backup: reading(weekly(100, t0 + day)), primary: reading(weekly(10, t0 + day + hour)) }
    ],
    [
      'session used up',
      {
        backup: reading(weekly(10, t0 + day), session(100, t0 + hour)),
        primary: reading(weekly(10, t0 + day + hour))
      }
    ]
  ])('skips exhausted windows: %s', (_name, entries) => {
    expect(rank({ readings: readings(entries) })?.accountId).toBe('primary')
  })

  it('treats a passed reset as fresh', () => {
    // backup's weekly reading is from before its reset, which has now passed.
    expect(
      rank({
        readings: readings({
          backup: reading(weekly(100, t0 - minute)),
          primary: reading(weekly(50, t0 + 2 * day))
        })
      })?.accountId
    ).toBe('primary')
    expect(
      rank({
        accounts: [backup],
        readings: readings({ backup: reading(weekly(100, t0 - minute)) })
      })
    ).toEqual(PoolDecision.Quota({ accountId: 'backup', resetsAtMs: undefined }))
  })

  it('keeps the reserve untouched', () => {
    expect(
      rank({
        reservePercent: 5,
        readings: readings({
          backup: reading(weekly(96, t0 + day)),
          primary: reading(weekly(10, t0 + 2 * day))
        })
      })?.accountId
    ).toBe('primary')
  })

  it('applies model-scoped windows only to their models', () => {
    const scopedOut: PoolWindow = {
      durationMinutes: week,
      usedPercent: 100,
      resetsAtMs: t0 + day,
      models: ['fable']
    }

    const entries = readings({
      backup: reading(weekly(10, t0 + day), scopedOut),
      primary: reading(weekly(10, t0 + 2 * day))
    })

    expect(rank({ route: 'claude-fable-5', readings: entries })?.accountId).toBe('primary')
    expect(rank({ route: 'claude-opus-5-5', readings: entries })?.accountId).toBe('backup')
  })

  it('ranks by the longest window, using the soonest reset among equally long ones', () => {
    expect(
      rank({
        readings: readings({
          // backup's five-hour window resets sooner, but its weekly one later.
          backup: reading(session(10, t0 + hour), weekly(10, t0 + 3 * day)),
          primary: reading(session(10, t0 + 4 * hour), weekly(10, t0 + 2 * day))
        })
      })?.accountId
    ).toBe('primary')
  })

  it.each([
    ['no readings', new Map<string, PoolReading>()],
    [
      'stale reading',
      readings({
        backup: { fetchedAtMs: t0 - defaultPoolMaxAgeMs - 1000, windows: [weekly(0, t0 + hour)] }
      })
    ],
    ['unknown accounts', readings({ other: reading(weekly(0, t0 + hour)) })],
    [
      'all exhausted',
      readings({
        backup: reading(weekly(100, t0 + hour)),
        primary: reading(weekly(100, t0 + hour))
      })
    ],
    [
      'no window applies',
      readings({
        backup: reading({
          durationMinutes: week,
          usedPercent: 0,
          resetsAtMs: t0 + hour,
          models: ['fable']
        })
      })
    ]
  ])('falls back to sticky fill-first: %s', (_name, entries) => {
    expect(rank({ readings: entries })).toEqual(PoolDecision.FillFirst({ accountId: 'primary' }))
    expect(rank({ readings: entries, pin: 'backup' })).toEqual(
      PoolDecision.Sticky({ accountId: 'backup' })
    )
  })

  it('ignores readings of unavailable accounts', () => {
    expect(
      rank({
        unavailable: new Set(['backup']),
        readings: readings({
          backup: reading(weekly(10, t0 + day)),
          primary: reading(weekly(10, t0 + 2 * day))
        })
      })
    ).toEqual(PoolDecision.Quota({ accountId: 'primary', resetsAtMs: t0 + 2 * day }))
  })
})

describe('poolRoute', () => {
  it('lowercases and trims model ids, keeping models distinct', () => {
    expect(poolRoute(' Claude-Opus-5-5 ')).toBe('claude-opus-5-5')
    expect(poolRoute('opus')).not.toBe(poolRoute('haiku'))
  })
})

describe('poolReadingFromSnapshot', () => {
  it('keeps windows with a duration and normalizes models', () => {
    const snapshot = ProviderSubscriptionUsageSnapshot.make({
      provider: 'anthropic-claude',
      fetchedAt: '2026-10-09T12:00:00.000Z',
      windows: Chunk.make(
        ProviderSubscriptionUsageWindow.make({
          id: 'five-hour',
          usedPercent: 4,
          resetsAt: '2026-10-09T13:00:00.000Z',
          windowDurationMinutes: 300
        }),
        ProviderSubscriptionUsageWindow.make({ id: 'monthly', usedPercent: 30 }),
        ProviderSubscriptionUsageWindow.make({
          id: 'seven-day-opus',
          usedPercent: 100,
          windowDurationMinutes: week,
          models: ['Opus']
        })
      )
    })

    expect(poolReadingFromSnapshot(snapshot)).toEqual({
      fetchedAtMs: t0,
      windows: [
        { durationMinutes: 300, usedPercent: 4, resetsAtMs: t0 + hour, models: [] },
        { durationMinutes: week, usedPercent: 100, models: ['opus'] }
      ]
    })
  })
})

describe('staleQuotaCooldowns', () => {
  const until = t0 + 3 * day

  const quotaCooldown = PoolQuotaCooldown.make({
    accountId: 'backup',
    startedAtMs: t0,
    untilMs: until
  })

  const stale = (
    entries: Record<string, PoolReading>,
    nowMs: number,
    cooldown: PoolCooldown = quotaCooldown
  ) =>
    staleQuotaCooldowns({
      cooldowns: [cooldown],
      readings: readings(entries),
      nowMs,
      maxAgeMs: defaultPoolMaxAgeMs
    })

  it('needs a reading taken after the cooldown began that shows quota left', () => {
    // The reading predates the 429: it still shows quota, but cannot prove the limit was reset.
    expect(
      stale({ backup: { fetchedAtMs: t0 - minute, windows: [weekly(90, until)] } }, t0 + minute)
    ).toEqual([])
    // A later reading still shows the weekly window used up: the cooldown is real.
    expect(
      stale(
        { backup: { fetchedAtMs: t0 + 5 * minute, windows: [weekly(100, until)] } },
        t0 + 6 * minute
      )
    ).toEqual([])
    // A limit reset was spent: the next reading shows quota again.
    expect(
      stale(
        { backup: { fetchedAtMs: t0 + 15 * minute, windows: [weekly(0, until), session(0)] } },
        t0 + 16 * minute
      )
    ).toEqual([quotaCooldown])
  })

  it('starts over with each new cooldown', () => {
    const entries = { backup: { fetchedAtMs: t0 + 10 * minute, windows: [weekly(0, until)] } }

    expect(stale(entries, t0 + 11 * minute)).toEqual([quotaCooldown])

    // Cleared, the account ran out again: the new cooldown needs a reading newer than itself.
    const again = PoolQuotaCooldown.make({
      accountId: 'backup',
      startedAtMs: t0 + 12 * minute,
      untilMs: until + hour
    })

    expect(stale(entries, t0 + 12 * minute, again)).toEqual([])
  })

  const fresh = (windows: ReadonlyArray<PoolWindow>): PoolReading => ({
    fetchedAtMs: t0 + minute,
    windows
  })

  it.each([
    ['no reading', {}, quotaCooldown],
    [
      'reading too old',
      {
        backup: {
          fetchedAtMs: t0 + minute - defaultPoolMaxAgeMs - 2 * minute,
          windows: [weekly(0, until)]
        }
      },
      PoolQuotaCooldown.make({ accountId: 'backup', startedAtMs: t0 - day, untilMs: until })
    ],
    ['reading empty', { backup: fresh([]) }, quotaCooldown],
    [
      'session used up',
      { backup: fresh([weekly(0, until), session(100, t0 + 4 * hour)]) },
      quotaCooldown
    ],
    [
      'scoped window out',
      {
        backup: fresh([
          weekly(0, until),
          { durationMinutes: week, usedPercent: 100, resetsAtMs: until, models: ['fable'] }
        ])
      },
      quotaCooldown
    ],
    [
      'auth cooldown',
      { backup: fresh([weekly(0, until)]) },
      PoolAuthCooldown.make({ accountId: 'backup', startedAtMs: t0, untilMs: until })
    ],
    [
      'expired cooldown',
      { backup: fresh([weekly(0, until)]) },
      PoolQuotaCooldown.make({ accountId: 'backup', startedAtMs: t0, untilMs: t0 + minute })
    ]
  ])('ignores: %s', (_name, entries, cooldown) => {
    expect(stale(entries, t0 + 2 * minute, cooldown)).toEqual([])
  })
})
