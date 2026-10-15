import { Data, Predicate } from 'effect'
import type { ProviderSubscriptionUsageSnapshot } from '@yolk-sdk/agent/providers/subscription-usage'
import type { PoolCooldown } from './model.ts'

/** One usage window of a reading, as the ranking reads it. */
export type PoolWindow = {
  /** Window length; absent when the provider's window has no fixed length (a billing month). */
  readonly durationMinutes?: number
  readonly usedPercent: number
  /** When the window resets; absent when it has not started. */
  readonly resetsAtMs?: number
  /** Lowercase model substrings the window limits; empty for every model. */
  readonly models: ReadonlyArray<string>
}

type MutablePoolWindow = { -readonly [Key in keyof PoolWindow]: PoolWindow[Key] }

/** The latest quota reading of one account. */
export type PoolReading = {
  readonly fetchedAtMs: number
  readonly windows: ReadonlyArray<PoolWindow>
}

/** A configured account as the ranking sees it. */
export type PoolCandidate = {
  readonly id: string
  readonly priority: number
}

/**
 * The route a request pins: its model id, trimmed and lowercased. Reasoning effort is a separate
 * request field and never part of the route.
 */
export const poolRoute = (model: string) => model.trim().toLowerCase()

/**
 * A usage snapshot as the ranking reads it; an unreadable `fetchedAt` yields no reading. Windows
 * without a length still block a used-up account but never rank it. A window that reports only
 * `resetsAfterSeconds` resets that long after the reading.
 */
export const poolReadingFromSnapshot = (
  snapshot: ProviderSubscriptionUsageSnapshot
): PoolReading | undefined => {
  const fetchedAtMs = Date.parse(snapshot.fetchedAt)

  if (!Number.isFinite(fetchedAtMs)) {
    return undefined
  }

  const windows = Array.from(snapshot.windows).map((window): PoolWindow => {
    const resetsAtMs =
      window.resetsAt !== undefined
        ? Date.parse(window.resetsAt)
        : window.resetsAfterSeconds !== undefined
          ? fetchedAtMs + window.resetsAfterSeconds * 1000
          : Number.NaN

    const models = (window.models ?? []).flatMap(model => {
      const normalized = model.trim().toLowerCase()

      return normalized === '' ? [] : [normalized]
    })

    const fields: MutablePoolWindow = { usedPercent: window.usedPercent, models }

    if (window.windowDurationMinutes !== undefined) {
      fields.durationMinutes = window.windowDurationMinutes
    }

    if (Number.isFinite(resetsAtMs)) {
      fields.resetsAtMs = resetsAtMs
    }

    return fields
  })

  return { fetchedAtMs, windows }
}

/** Why the ranking chose an account. */
export type PoolDecision = Data.TaggedEnum<{
  /** Fresh readings ranked it first; `resetsAtMs` is its longest window's reset, if started. */
  Quota: { readonly accountId: string; readonly resetsAtMs: number | undefined }
  /** No candidate is usable by a fresh reading; the route's pin is still available. */
  Sticky: { readonly accountId: string }
  /** No candidate is usable by a fresh reading and no pin is: highest priority, then lowest id. */
  FillFirst: { readonly accountId: string }
}>

export const PoolDecision = Data.taggedEnum<PoolDecision>()

export type PoolRankInput = {
  /** Configured accounts. */
  readonly accounts: ReadonlyArray<PoolCandidate>
  /** Accounts that cannot serve now: an active cooldown, or already tried by this request. */
  readonly unavailable: ReadonlySet<string>
  readonly readings: ReadonlyMap<string, PoolReading>
  /** The account the route is pinned to, if any. */
  readonly pin: string | undefined
  readonly route: string
  readonly nowMs: number
  readonly maxAgeMs: number
  readonly reservePercent: number
}

const appliesTo = (window: PoolWindow, route: string) =>
  window.models.length === 0 || window.models.some(model => route.includes(model))

const hasStarted = (window: PoolWindow, nowMs: number) =>
  window.resetsAtMs !== undefined && window.resetsAtMs > nowMs

type AccountRank =
  /** No window of the reading applies to the route: the reading says nothing. */
  | { readonly kind: 'unknown' }
  /** An applicable started window is used up to the reserve. */
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'usable'; readonly resetsAtMs: number | undefined }

/**
 * The reset of the account's longest window with a length that applies to the route (undefined
 * when it has not started, or no applicable window has a length). Unusable when no window applies
 * or an applicable started window is used up to the reserve; a window whose reset has passed counts
 * as fresh, whatever the reading said.
 */
const accountRank = (
  reading: PoolReading,
  route: string,
  nowMs: number,
  reservePercent: number
): AccountRank => {
  let usable = false
  let longest = 0
  let resetsAtMs: number | undefined

  for (const window of reading.windows) {
    if (!appliesTo(window, route)) {
      continue
    }

    const started = hasStarted(window, nowMs)

    if (started && window.usedPercent >= 100 - reservePercent) {
      return { kind: 'exhausted' }
    }

    usable = true

    if (window.durationMinutes === undefined) {
      continue
    }

    if (window.durationMinutes > longest) {
      longest = window.durationMinutes
      resetsAtMs = started ? window.resetsAtMs : undefined
    } else if (
      window.durationMinutes === longest &&
      started &&
      window.resetsAtMs !== undefined &&
      (resetsAtMs === undefined || window.resetsAtMs < resetsAtMs)
    ) {
      resetsAtMs = window.resetsAtMs
    }
  }

  return usable ? { kind: 'usable', resetsAtMs } : { kind: 'unknown' }
}

type Ranked = { readonly candidate: PoolCandidate; readonly resetsAtMs: number | undefined }

/** Code-unit id order, so ties never depend on locale. */
const idBefore = (a: string, b: string) => a < b

/**
 * Started windows by soonest reset, then windows that have not started; ties by higher priority,
 * then lower id.
 */
const ranksBefore = (a: Ranked, b: Ranked) => {
  if (a.resetsAtMs !== undefined && b.resetsAtMs !== undefined) {
    if (a.resetsAtMs !== b.resetsAtMs) {
      return a.resetsAtMs < b.resetsAtMs
    }
  } else if (a.resetsAtMs !== undefined || b.resetsAtMs !== undefined) {
    return a.resetsAtMs !== undefined
  }

  if (a.candidate.priority !== b.candidate.priority) {
    return a.candidate.priority > b.candidate.priority
  }

  return idBefore(a.candidate.id, b.candidate.id)
}

/** Highest priority, then lowest id. */
const fillFirst = (candidates: ReadonlyArray<PoolCandidate>): PoolCandidate | undefined => {
  let best: PoolCandidate | undefined

  for (const candidate of candidates) {
    if (
      best === undefined ||
      candidate.priority > best.priority ||
      (candidate.priority === best.priority && idBefore(candidate.id, best.id))
    ) {
      best = candidate
    }
  }

  return best
}

/**
 * Expiring-first: the available account whose longest applicable window resets soonest and still
 * has quota. When no available account is usable by a fresh reading (within `maxAgeMs`), it routes
 * stickily: the pin while it is available, else fill-first, preferring accounts that no fresh
 * reading shows used up; those serve only when nothing else is left, so the provider's own answer
 * decides. Undefined when no account is available.
 */
export const rankPool = (input: PoolRankInput): PoolDecision | undefined => {
  const candidates = input.accounts.filter(account => !input.unavailable.has(account.id))
  const exhausted = new Set<string>()

  let best: Ranked | undefined

  for (const candidate of candidates) {
    const reading = input.readings.get(candidate.id)

    if (reading === undefined || input.nowMs - reading.fetchedAtMs > input.maxAgeMs) {
      continue
    }

    const rank = accountRank(reading, input.route, input.nowMs, input.reservePercent)

    if (rank.kind === 'exhausted') {
      exhausted.add(candidate.id)
    }

    if (rank.kind !== 'usable') {
      continue
    }

    const next: Ranked = { candidate, resetsAtMs: rank.resetsAtMs }

    if (best === undefined || ranksBefore(next, best)) {
      best = next
    }
  }

  if (best !== undefined) {
    return PoolDecision.Quota({ accountId: best.candidate.id, resetsAtMs: best.resetsAtMs })
  }

  const unexhausted = candidates.filter(candidate => !exhausted.has(candidate.id))
  const fallback = unexhausted.length > 0 ? unexhausted : candidates

  if (input.pin !== undefined && fallback.some(candidate => candidate.id === input.pin)) {
    return PoolDecision.Sticky({ accountId: input.pin })
  }

  const first = fillFirst(fallback)

  return first === undefined ? undefined : PoolDecision.FillFirst({ accountId: first.id })
}

/** Whether a cooldown still keeps its account out at `nowMs`. */
export const isCooldownActive = (cooldown: PoolCooldown, nowMs: number) => cooldown.untilMs > nowMs

/**
 * Every account-wide window of the reading has quota left or has reset; model-scoped windows block
 * only their models through ranking, never the whole account. A reading without account-wide
 * windows proves nothing.
 */
const hasQuotaLeft = (reading: PoolReading, nowMs: number) => {
  const accountWide = reading.windows.filter(window => window.models.length === 0)

  return (
    accountWide.length > 0 &&
    accountWide.every(window => !hasStarted(window, nowMs) || window.usedPercent < 100)
  )
}

/**
 * Active quota cooldowns that a fresh reading taken after they began shows to be over (a limit
 * reset was spent, or the provider reset early). A reading from before the lockout never clears
 * one, and auth cooldowns are never cleared by readings.
 */
export const staleQuotaCooldowns = (input: {
  readonly cooldowns: ReadonlyArray<PoolCooldown>
  readonly readings: ReadonlyMap<string, PoolReading>
  readonly nowMs: number
  readonly maxAgeMs: number
}): ReadonlyArray<PoolCooldown> =>
  input.cooldowns.filter(cooldown => {
    if (
      !Predicate.isTagged(cooldown, 'PoolQuotaCooldown') ||
      !isCooldownActive(cooldown, input.nowMs)
    ) {
      return false
    }

    const reading = input.readings.get(cooldown.accountId)

    return (
      reading !== undefined &&
      input.nowMs - reading.fetchedAtMs <= input.maxAgeMs &&
      reading.fetchedAtMs > cooldown.startedAtMs &&
      hasQuotaLeft(reading, input.nowMs)
    )
  })
