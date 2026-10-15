import { Clock, Effect, Match, Predicate, Ref, Stream } from 'effect'
import {
  LLMError,
  type LLMEvent,
  type LLMProvider,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { ProviderErrorInfo } from '@yolk-sdk/agent/protocol'
import type { ProviderSubscriptionUsageSnapshot } from '@yolk-sdk/agent/providers/subscription-usage'
import {
  PoolAuthCooldown,
  PoolConfigError,
  type PoolCooldown,
  PoolPin,
  PoolQuotaCooldown,
  type PoolStoreError,
  PoolUnknownAccountError
} from './model.ts'
import {
  isCooldownActive,
  type PoolCandidate,
  type PoolDecision,
  type PoolReading,
  poolReadingFromSnapshot,
  poolRoute,
  rankPool,
  staleQuotaCooldowns
} from './rank.ts'
import { type PoolStoreApi, type PoolStoreSnapshot, PoolStoredReading } from './store.ts'

type LLMProviderService = typeof LLMProvider.Service

/** One subscription account of a pool: its own provider, built by the host with its credentials. */
export type PoolAccount = {
  /** Unique within the store; cooldowns and readings are keyed by it. */
  readonly id: string
  /** Breaks ranking ties and orders fill-first (higher first). Default 0. */
  readonly priority?: number
  readonly provider: LLMProviderService
}

export type PoolOptions = {
  /** Pins are keyed by pool id and route. */
  readonly id: string
  /** Accounts of one provider; requests must suit every one of them. */
  readonly accounts: ReadonlyArray<PoolAccount>
  readonly store: PoolStoreApi
  /** How old a reading may be and still rank accounts. Default 30 minutes. */
  readonly maxAgeMs?: number
  /** Quota left untouched on every window, in percent (0 to below 100). Default 0. */
  readonly reservePercent?: number
}

/** One account as the host UI sees it. */
export type PoolAccountState = {
  readonly id: string
  readonly priority: number
  /** The account's cooldown while it is active. */
  readonly cooldown: PoolCooldown | undefined
  readonly reading: ProviderSubscriptionUsageSnapshot | undefined
}

export type PoolState = {
  readonly poolId: string
  /** The account serving each route. */
  readonly pins: ReadonlyArray<PoolPin>
  readonly accounts: ReadonlyArray<PoolAccountState>
}

export type Pool = {
  readonly id: string
  /** The pooled provider: provide it as the loop's `LLMProvider`, innermost under host wrappers. */
  readonly provider: LLMProviderService
  /** Records an account's usage snapshot; hosts poll usage on their own schedule. */
  readonly recordReading: (
    accountId: string,
    snapshot: ProviderSubscriptionUsageSnapshot
  ) => Effect.Effect<void, PoolUnknownAccountError | PoolStoreError>
  /** Pins, active cooldowns, and readings for host UIs. */
  readonly state: Effect.Effect<PoolState, PoolStoreError>
}

/** Default `maxAgeMs`: readings older than 30 minutes no longer rank accounts. */
export const defaultPoolMaxAgeMs = 30 * 60_000

/**
 * A `rate_limit` whose `Retry-After` reaches this is a quota lockout, not a transient limit
 * (CLIProxyAPI `expiring-first` `QuotaCooldownFloor`).
 */
export const poolQuotaRetryAfterFloorMs = 30 * 60_000

/** The longest cooldown the pool records; a later or non-finite hint is not trusted. */
export const poolMaxCooldownMs = 366 * 24 * 60 * 60_000

/** How long an account whose credentials were rejected sits out. */
export const poolAuthCooldownMs = 30 * 60_000

type ValidAccount = PoolCandidate & { readonly provider: LLMProviderService }

const configError = (reason: PoolConfigError['reason'], message: string) =>
  Effect.fail(new PoolConfigError({ reason, message }))

/**
 * The cooldown an account-scoped failure puts its account in, or undefined when the failure is not
 * the account's (the loop's retry handles those): a `rate_limit` with a quota reset or a
 * `Retry-After` of at least `poolQuotaRetryAfterFloorMs` (quota), or `auth`.
 */
export const poolFailureCooldown = (
  error: LLMError,
  accountId: string,
  nowMs: number
): PoolCooldown | undefined => {
  const info = error.provider

  if (info === undefined) {
    return undefined
  }

  if (info.kind === 'auth') {
    return PoolAuthCooldown.make({
      accountId,
      startedAtMs: nowMs,
      untilMs: nowMs + poolAuthCooldownMs
    })
  }

  if (info.kind !== 'rate_limit') {
    return undefined
  }

  const trusted = (untilMs: number) =>
    Number.isFinite(untilMs) && untilMs > nowMs && untilMs - nowMs <= poolMaxCooldownMs

  if (info.quotaResetsAtMs !== undefined && trusted(info.quotaResetsAtMs)) {
    return PoolQuotaCooldown.make({ accountId, startedAtMs: nowMs, untilMs: info.quotaResetsAtMs })
  }

  if (
    info.retryAfterMs !== undefined &&
    info.retryAfterMs >= poolQuotaRetryAfterFloorMs &&
    trusted(nowMs + info.retryAfterMs)
  ) {
    return PoolQuotaCooldown.make({
      accountId,
      startedAtMs: nowMs,
      untilMs: nowMs + info.retryAfterMs
    })
  }

  return undefined
}

const iso = (ms: number) => {
  const date = new Date(ms)

  return Number.isFinite(date.getTime()) ? date.toISOString() : String(ms)
}

const minUntil = (cooldowns: ReadonlyArray<PoolCooldown>) =>
  cooldowns.reduce<number | undefined>(
    (earliest, cooldown) =>
      earliest === undefined || cooldown.untilMs < earliest ? cooldown.untilMs : earliest,
    undefined
  )

const emptySnapshot: PoolStoreSnapshot = { pin: undefined, cooldowns: [], readings: [] }

/**
 * Pools several subscription accounts of one provider behind one `LLMProvider` (ADR 0011).
 *
 * Each request goes to the account whose longest usage window resets soonest and still has quota
 * (expiring-first), or, without fresh readings, stays on the route's pinned account. An
 * account-scoped failure before the first event (an exhausted quota, rejected credentials) cools the
 * account down and the same request moves to the next account; every other failure, and any failure
 * after an event, reaches the caller unchanged. With every account out it fails `rate_limit`
 * (non-retryable) carrying the earliest quota reset.
 *
 * Store failures never fail a request: reads fall back to stateless fill-first and writes are
 * logged.
 */
export const makePool = (options: PoolOptions): Effect.Effect<Pool, PoolConfigError> =>
  Effect.gen(function* () {
    const poolId = options.id.trim()

    if (poolId === '') {
      return yield* configError('invalid_pool_id', 'Pool id must be a non-empty string')
    }

    if (options.accounts.length === 0) {
      return yield* configError('no_accounts', `Pool ${poolId} needs at least one account`)
    }

    const maxAgeMs = options.maxAgeMs ?? defaultPoolMaxAgeMs
    const reservePercent = options.reservePercent ?? 0

    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return yield* configError('invalid_max_age', 'maxAgeMs must be a positive number')
    }

    if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent >= 100) {
      return yield* configError(
        'invalid_reserve_percent',
        'reservePercent must be at least 0 and below 100'
      )
    }

    const accounts: Array<ValidAccount> = []

    for (const account of options.accounts) {
      const id = account.id.trim()
      const priority = account.priority ?? 0

      if (id === '' || id !== account.id) {
        return yield* configError(
          'invalid_account_id',
          'Account ids must be non-empty without surrounding whitespace'
        )
      }

      if (accounts.some(existing => existing.id === id)) {
        return yield* configError('duplicate_account_id', `Duplicate account id: ${id}`)
      }

      if (!Number.isFinite(priority)) {
        return yield* configError('invalid_priority', `Account ${id} has a non-finite priority`)
      }

      accounts.push({ id, priority, provider: account.provider })
    }

    const accountIds = accounts.map(account => account.id)
    const accountsById = new Map(accounts.map(account => [account.id, account]))
    const store = options.store

    const loadSnapshot = (route: string) =>
      store
        .load({ poolId, route, accountIds })
        .pipe(
          Effect.catch(error =>
            Effect.logWarning('pool: store load failed; routing without pool state').pipe(
              Effect.annotateLogs({ operation: error.operation }),
              Effect.as(emptySnapshot)
            )
          )
        )

    // Host store messages may carry connection details: log the operation only.
    const logStoreFailure = (operation: PoolStoreError['operation']) => () =>
      Effect.logWarning(`pool: store ${operation} failed`)

    const readingsOf = (snapshot: PoolStoreSnapshot) => {
      const readings = new Map<string, PoolReading>()

      for (const stored of snapshot.readings) {
        const reading = poolReadingFromSnapshot(stored.snapshot)

        if (reading !== undefined) {
          readings.set(stored.accountId, reading)
        }
      }

      return readings
    }

    const moveReason = (input: {
      readonly decision: PoolDecision
      readonly from: string
      readonly cooldowns: ReadonlyArray<PoolCooldown>
      readonly excluded: ReadonlySet<string>
    }) =>
      Match.value(input.decision).pipe(
        Match.tag('Quota', decision =>
          decision.resetsAtMs === undefined
            ? 'quota ranking, window not started'
            : `quota ranking, window resets ${iso(decision.resetsAtMs)}`
        ),
        Match.orElse(() => {
          const cooldown = input.cooldowns.find(current => current.accountId === input.from)

          if (cooldown !== undefined) {
            return Match.value(cooldown).pipe(
              Match.tag(
                'PoolQuotaCooldown',
                current => `quota cooldown until ${iso(current.untilMs)}`
              ),
              Match.tag(
                'PoolAuthCooldown',
                current => `auth cooldown until ${iso(current.untilMs)}`
              ),
              Match.exhaustive
            )
          }

          return input.excluded.has(input.from) ? 'failed this request' : 'not configured'
        })
      )

    const updatePin = (input: {
      readonly route: string
      readonly decision: PoolDecision
      readonly snapshot: PoolStoreSnapshot
      readonly cooldowns: ReadonlyArray<PoolCooldown>
      readonly excluded: ReadonlySet<string>
      readonly nowMs: number
    }) => {
      const current = input.snapshot.pin?.accountId
      const next = input.decision.accountId

      if (current === next) {
        return Effect.void
      }

      const pin = PoolPin.make({
        poolId,
        route: input.route,
        accountId: next,
        pinnedAtMs: input.nowMs
      })

      const log =
        current === undefined
          ? Effect.logDebug('pool: route pinned').pipe(Effect.annotateLogs({ to: next }))
          : Effect.logInfo(
              `pool: pin moved: ${moveReason({
                decision: input.decision,
                from: current,
                cooldowns: input.cooldowns,
                excluded: input.excluded
              })}`
            ).pipe(Effect.annotateLogs({ from: current, to: next }))

      return store.movePin({ expected: current, pin }).pipe(
        Effect.flatMap(written => (written ? log : Effect.void)),
        Effect.catch(logStoreFailure('movePin'))
      )
    }

    const exhaustedError = (input: {
      readonly cooldowns: ReadonlyArray<PoolCooldown>
      readonly lastError: LLMError | undefined
    }) => {
      const quota = input.cooldowns.filter(cooldown =>
        Predicate.isTagged(cooldown, 'PoolQuotaCooldown')
      )

      const quotaResetsAtMs = minUntil(quota)
      const until = minUntil(input.cooldowns)
      // The vendor id of the last failure; the pool id when no account was tried in this request.
      const provider = input.lastError?.provider?.provider ?? poolId

      const message =
        until === undefined
          ? `Every account of pool ${poolId} is unavailable`
          : `Every account of pool ${poolId} is unavailable until ${iso(until)}`

      return quotaResetsAtMs === undefined
        ? new LLMError({
            cause: 'provider_error',
            message,
            retryable: false,
            provider: ProviderErrorInfo.make({ provider, kind: 'auth' })
          })
        : new LLMError({
            cause: 'rate_limit',
            message,
            retryable: false,
            provider: ProviderErrorInfo.make({ provider, kind: 'rate_limit', quotaResetsAtMs })
          })
    }

    const attempt = (input: {
      readonly request: LLMRequest
      readonly route: string
      readonly account: ValidAccount
      readonly excluded: ReadonlySet<string>
      readonly recorded: ReadonlyArray<PoolCooldown>
    }): Stream.Stream<LLMEvent, LLMProviderError> =>
      Stream.unwrap(
        Ref.make(false).pipe(
          Effect.map(emitted =>
            input.account.provider.stream(input.request).pipe(
              Stream.tap(() => Ref.set(emitted, true)),
              Stream.catchTags({
                LLMError: error =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const nowMs = yield* Clock.currentTimeMillis
                      const cooldown = poolFailureCooldown(error, input.account.id, nowMs)

                      if ((yield* Ref.get(emitted)) || cooldown === undefined) {
                        return Stream.fail(error)
                      }

                      yield* store
                        .putCooldown(cooldown)
                        .pipe(Effect.catch(logStoreFailure('putCooldown')))
                      yield* Effect.logInfo(
                        `pool: failover after ${Predicate.isTagged(cooldown, 'PoolQuotaCooldown') ? 'quota exhaustion' : 'auth failure'}, cooldown until ${iso(cooldown.untilMs)}`
                      ).pipe(Effect.annotateLogs({ account: input.account.id }))

                      return pick({
                        request: input.request,
                        route: input.route,
                        excluded: new Set([...input.excluded, input.account.id]),
                        recorded: [...input.recorded, cooldown],
                        lastError: error
                      })
                    })
                  )
              })
            )
          )
        )
      )

    const pick = (input: {
      readonly request: LLMRequest
      readonly route: string
      readonly excluded: ReadonlySet<string>
      readonly recorded: ReadonlyArray<PoolCooldown>
      readonly lastError: LLMError | undefined
    }): Stream.Stream<LLMEvent, LLMProviderError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const snapshot = yield* loadSnapshot(input.route)
          const readings = readingsOf(snapshot)

          const stale = staleQuotaCooldowns({
            cooldowns: snapshot.cooldowns,
            readings,
            nowMs,
            maxAgeMs
          })

          yield* Effect.forEach(
            stale,
            cooldown =>
              store
                .clearCooldown({ accountId: cooldown.accountId, startedAtMs: cooldown.startedAtMs })
                .pipe(
                  Effect.flatMap(cleared =>
                    cleared
                      ? Effect.logInfo(
                          `pool: cleared cooldown (until ${iso(cooldown.untilMs)}): a newer reading shows quota left`
                        ).pipe(Effect.annotateLogs({ account: cooldown.accountId }))
                      : Effect.void
                  ),
                  Effect.catch(logStoreFailure('clearCooldown'))
                ),
            { discard: true }
          )

          const cooldowns = [
            ...snapshot.cooldowns.filter(
              cooldown => isCooldownActive(cooldown, nowMs) && !stale.includes(cooldown)
            ),
            ...input.recorded.filter(cooldown => isCooldownActive(cooldown, nowMs))
          ]

          const unavailable = new Set([
            ...input.excluded,
            ...cooldowns.map(cooldown => cooldown.accountId)
          ])

          const decision = rankPool({
            accounts,
            unavailable,
            readings,
            pin: snapshot.pin?.accountId,
            route: input.route,
            nowMs,
            maxAgeMs,
            reservePercent
          })

          const account = decision === undefined ? undefined : accountsById.get(decision.accountId)

          if (decision === undefined || account === undefined) {
            yield* Effect.logWarning('pool: every account is unavailable')

            return Stream.fail(
              exhaustedError({
                // Cooldowns recorded by this request count even if they already ran out.
                cooldowns: [
                  ...cooldowns,
                  ...input.recorded.filter(cooldown => !cooldowns.includes(cooldown))
                ],
                lastError: input.lastError
              })
            )
          }

          yield* updatePin({
            route: input.route,
            decision,
            snapshot,
            cooldowns,
            excluded: input.excluded,
            nowMs
          })
          yield* Effect.annotateCurrentSpan({ account: account.id, source: decision._tag })

          return attempt({
            request: input.request,
            route: input.route,
            account,
            excluded: input.excluded,
            recorded: input.recorded
          })
        }).pipe(
          Effect.withSpan('pool.pick', { attributes: { pool: poolId, route: input.route } }),
          Effect.annotateLogs({ pool: poolId, route: input.route })
        )
      )

    const provider: LLMProviderService = {
      stream: request => {
        const route = poolRoute(request.model)

        return route === ''
          ? Stream.fail(
              new LLMError({
                cause: 'validation_error',
                message: `Pool ${poolId} needs a model id`,
                retryable: false
              })
            )
          : pick({ request, route, excluded: new Set(), recorded: [], lastError: undefined })
      }
    }

    const recordReading = (accountId: string, snapshot: ProviderSubscriptionUsageSnapshot) =>
      accountsById.has(accountId)
        ? store.putReading(PoolStoredReading.make({ accountId, snapshot }))
        : Effect.fail(new PoolUnknownAccountError({ poolId, accountId }))

    const state = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const stored = yield* store.state({ poolId, accountIds })

      return {
        poolId,
        pins: stored.pins,
        accounts: accounts.map(account => ({
          id: account.id,
          priority: account.priority,
          cooldown: stored.cooldowns.find(
            cooldown => cooldown.accountId === account.id && isCooldownActive(cooldown, nowMs)
          ),
          reading: stored.readings.find(reading => reading.accountId === account.id)?.snapshot
        }))
      }
    })

    return { id: poolId, provider, recordReading, state }
  })
