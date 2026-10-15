import { Chunk, Effect, Layer, Logger, Predicate, References, Result, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from '@effect/vitest'
import {
  ContextTransformer,
  LLMDone,
  LLMError,
  LLMProvider,
  LLMTextDelta,
  LoopConfig,
  run,
  type LLMEvent,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import { ProviderErrorInfo, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageWindow
} from '@yolk-sdk/agent/providers/subscription-usage'
import {
  makePool,
  PoolAuthCooldown,
  poolAuthCooldownMs,
  poolFailureCooldown,
  poolMaxCooldownMs,
  PoolQuotaCooldown,
  type PoolAccount,
  type PoolOptions
} from '@yolk-sdk/pool'
import { makeMemoryPoolStore, PoolStoreError, type PoolStoreApi } from '@yolk-sdk/pool/store'

const t0 = Date.parse('2026-10-09T12:00:00.000Z')

const minute = 60_000

const hour = 60 * minute

const day = 24 * hour

const iso = (ms: number) => new Date(ms).toISOString()

/** What one call of a scripted account does. */
type Outcome =
  | { readonly kind: 'reply' }
  | { readonly kind: 'fail'; readonly error: LLMError }
  | { readonly kind: 'fail_after_event'; readonly error: LLMError }
  /** Moves the test clock forward, then fails before any event. */
  | { readonly kind: 'fail_later'; readonly afterMs: number; readonly error: LLMError }

const reply: Outcome = { kind: 'reply' }

const fail = (error: LLMError): Outcome => ({ kind: 'fail', error })

const llmError = (input: {
  readonly kind: ProviderErrorInfo['kind']
  readonly retryAfterMs?: number
  readonly quotaResetsAtMs?: number
}) =>
  new LLMError({
    cause: input.kind === 'rate_limit' ? 'rate_limit' : 'provider_error',
    message: `upstream ${input.kind}`,
    retryable: input.kind !== 'auth',
    provider: ProviderErrorInfo.make(
      input.quotaResetsAtMs !== undefined
        ? { provider: 'anthropic_claude', kind: input.kind, quotaResetsAtMs: input.quotaResetsAtMs }
        : input.retryAfterMs !== undefined
          ? { provider: 'anthropic_claude', kind: input.kind, retryAfterMs: input.retryAfterMs }
          : { provider: 'anthropic_claude', kind: input.kind }
    )
  })

const quotaExhausted = (resetsAtMs: number) =>
  llmError({ kind: 'rate_limit', quotaResetsAtMs: resetsAtMs })

/** An account whose calls follow `outcomes` in order (then reply); records each request. */
const scripted = (id: string, priority: number, outcomes: ReadonlyArray<Outcome> = []) => {
  const calls: Array<LLMRequest> = []
  const queue = [...outcomes]

  const account: PoolAccount = {
    id,
    priority,
    provider: LLMProvider.of({
      stream: request =>
        Stream.suspend((): Stream.Stream<LLMEvent, LLMError> => {
          calls.push(request)

          const outcome = queue.shift() ?? reply
          const text = LLMTextDelta.make({ text: `from ${id}` })

          if (outcome.kind === 'fail') {
            return Stream.fail(outcome.error)
          }

          if (outcome.kind === 'fail_after_event') {
            return Stream.make(text).pipe(Stream.concat(Stream.fail(outcome.error)))
          }

          if (outcome.kind === 'fail_later') {
            return Stream.fromEffect(TestClock.adjust(outcome.afterMs)).pipe(
              Stream.drain,
              Stream.concat(Stream.fail(outcome.error))
            )
          }

          return Stream.make(text, LLMDone.make({ stopReason: 'stop' }))
        })
    })
  }

  return { account, calls }
}

const request: LLMRequest = {
  model: 'Claude-Opus-5-5',
  systemPrompt: '',
  messages: [UserMessage.make({ content: 'hello' })],
  tools: []
}

const texts = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event => (Predicate.isTagged(event, 'TextDelta') ? [event.text] : []))

const setup = (options: Omit<PoolOptions, 'id' | 'store'> & { readonly store?: PoolStoreApi }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(t0)

    const store = options.store ?? makeMemoryPoolStore()
    const pool = yield* makePool({ ...options, id: 'claude', store })

    return { pool, store }
  })

const weekly = (usedPercent: number, resetsAtMs: number | undefined) =>
  resetsAtMs === undefined
    ? ProviderSubscriptionUsageWindow.make({
        id: 'seven-day',
        usedPercent,
        windowDurationMinutes: 10_080
      })
    : ProviderSubscriptionUsageWindow.make({
        id: 'seven-day',
        usedPercent,
        resetsAt: iso(resetsAtMs),
        windowDurationMinutes: 10_080
      })

const snapshot = (
  fetchedAtMs: number,
  ...windows: ReadonlyArray<ProviderSubscriptionUsageWindow>
) =>
  ProviderSubscriptionUsageSnapshot.make({
    provider: 'anthropic-claude',
    fetchedAt: iso(fetchedAtMs),
    windows: Chunk.fromIterable(windows)
  })

describe('makePool', () => {
  it.effect('routes fill-first without readings and pins the route', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10)
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [backup.account, primary.account] })

      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from primary'
      ])

      const state = yield* pool.state

      expect(state.pins.map(pin => [pin.route, pin.accountId, pin.pinnedAtMs])).toEqual([
        ['claude-opus-5-5', 'primary', t0]
      ])
      expect(backup.calls).toHaveLength(0)
    })
  )

  it.effect('fails over to the next account on quota exhaustion before any event', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + 2 * day))])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])

      const state = yield* pool.state

      expect(state.pins.map(pin => pin.accountId)).toEqual(['backup'])
      expect(state.accounts.find(account => account.id === 'primary')?.cooldown).toEqual(
        PoolQuotaCooldown.make({ accountId: 'primary', startedAtMs: t0, untilMs: t0 + 2 * day })
      )

      // The next request goes straight to backup while primary cools down.
      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])
      expect(primary.calls).toHaveLength(1)
      expect(backup.calls).toHaveLength(2)
    })
  )

  it.effect('treats a long Retry-After as quota and a short one as transient', () =>
    Effect.gen(function* () {
      const longLimit = llmError({ kind: 'rate_limit', retryAfterMs: 2 * hour })
      const shortLimit = llmError({ kind: 'rate_limit', retryAfterMs: 20_000 })
      const primary = scripted('primary', 10, [fail(shortLimit), fail(longLimit)])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      const transient = yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)

      expect(transient).toBe(shortLimit)
      expect((yield* pool.state).accounts.every(account => account.cooldown === undefined)).toBe(
        true
      )

      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])
      expect((yield* pool.state).accounts[0]?.cooldown).toEqual(
        PoolQuotaCooldown.make({ accountId: 'primary', startedAtMs: t0, untilMs: t0 + 2 * hour })
      )
    })
  )

  it.effect('cools down rejected credentials and fails over', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10, [fail(llmError({ kind: 'auth' }))])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])
      expect((yield* pool.state).accounts[0]?.cooldown).toEqual(
        PoolAuthCooldown.make({
          accountId: 'primary',
          startedAtMs: t0,
          untilMs: t0 + poolAuthCooldownMs
        })
      )
    })
  )

  it.effect('passes other failures and failures after an event through unchanged', () =>
    Effect.gen(function* () {
      const overloaded = llmError({ kind: 'overloaded' })
      const afterEvent = quotaExhausted(t0 + day)

      const primary = scripted('primary', 10, [
        fail(overloaded),
        { kind: 'fail_after_event', error: afterEvent }
      ])

      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      expect(yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)).toBe(
        overloaded
      )

      const events: Array<LLMEvent> = []

      const late = yield* pool.provider.stream(request).pipe(
        Stream.runForEach(event => Effect.sync(() => events.push(event))),
        Effect.flip
      )

      expect(late).toBe(afterEvent)
      expect(texts(events)).toEqual(['from primary'])
      expect(backup.calls).toHaveLength(0)
      expect((yield* pool.state).accounts.every(account => account.cooldown === undefined)).toBe(
        true
      )
    })
  )

  it.effect('fails non-retryably with the earliest quota reset when every account is out', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + 3 * day))])
      const backup = scripted('backup', 0, [fail(quotaExhausted(t0 + day))])
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      const error = yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'rate_limit',
        retryable: false,
        provider: { provider: 'anthropic_claude', kind: 'rate_limit', quotaResetsAtMs: t0 + day }
      })

      // Later requests fail at once, without calling an account.
      expect(
        yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)
      ).toMatchObject({
        retryable: false
      })
      expect(primary.calls).toHaveLength(1)
      expect(backup.calls).toHaveLength(1)
    })
  )

  it.effect('reports an auth outage without a quota reset', () =>
    Effect.gen(function* () {
      const only = scripted('only', 0, [fail(llmError({ kind: 'auth' }))])
      const { pool } = yield* setup({ accounts: [only.account] })

      const error = yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)

      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        provider: { kind: 'auth' }
      })
      expect(JSON.stringify(error)).not.toContain('quotaResetsAtMs')
    })
  )

  it.effect('returns to a recovered account only through ranking or a lost pin', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + hour))])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      yield* Stream.runCollect(pool.provider.stream(request))
      yield* TestClock.adjust(2 * hour)

      // Primary's cooldown is over, but without readings the route stays on backup.
      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])
      expect((yield* pool.state).accounts[0]?.cooldown).toBeUndefined()
    })
  )

  it.effect('follows readings: soonest weekly reset first', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10)
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      yield* pool.recordReading('primary', snapshot(t0, weekly(10, t0 + 4 * day)))
      yield* pool.recordReading('backup', snapshot(t0, weekly(80, t0 + day)))

      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])

      const unknown = yield* pool.recordReading('retired', snapshot(t0)).pipe(Effect.flip)

      expect(unknown).toMatchObject({ _tag: 'PoolUnknownAccountError', accountId: 'retired' })
    })
  )

  it.effect('clears a quota cooldown that a newer reading shows to be over', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + 3 * day))])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      yield* pool.recordReading('primary', snapshot(t0 - minute, weekly(90, t0 + 3 * day)))
      yield* pool.recordReading('backup', snapshot(t0 - minute, weekly(10, t0 + 5 * day)))
      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])

      // The reading from before the lockout cannot clear it.
      yield* TestClock.adjust(minute)
      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])
      expect((yield* pool.state).accounts[0]?.cooldown?._tag).toBe('PoolQuotaCooldown')

      // A limit reset was spent: a newer reading shows quota and the weekly reset is the soonest.
      yield* pool.recordReading('primary', snapshot(t0 + minute, weekly(0, t0 + 3 * day)))
      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from primary'
      ])
      expect((yield* pool.state).accounts[0]?.cooldown).toBeUndefined()
    })
  )

  it.effect('passes an implausibly far reset through without a cooldown', () =>
    Effect.gen(function* () {
      const farReset = quotaExhausted(t0 + 10 * 365 * day)
      const primary = scripted('primary', 10, [fail(farReset)])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      expect(yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)).toBe(
        farReset
      )
      expect((yield* pool.state).accounts.every(account => account.cooldown === undefined)).toBe(
        true
      )
      expect(backup.calls).toHaveLength(0)
    })
  )

  it.effect('rejects a request without a model id', () =>
    Effect.gen(function* () {
      const only = scripted('only', 0)
      const { pool } = yield* setup({ accounts: [only.account] })

      const error = yield* Stream.runCollect(pool.provider.stream({ ...request, model: ' ' })).pipe(
        Effect.flip
      )

      expect(error).toMatchObject({ _tag: 'LLMError', cause: 'validation_error', retryable: false })
      expect(only.calls).toHaveLength(0)
    })
  )

  it.effect(
    'reports quota exhaustion even when this request’s cooldown ran out before the end',
    () =>
      Effect.gen(function* () {
        // Primary's quota resets 1 ms after it fails; backup's credentials are rejected 5 ms later.
        const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + 1))])

        const backup = scripted('backup', 0, [
          { kind: 'fail_later', afterMs: 5, error: llmError({ kind: 'auth' }) }
        ])

        const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

        const error = yield* Stream.runCollect(pool.provider.stream(request)).pipe(Effect.flip)

        expect(error).toMatchObject({
          cause: 'rate_limit',
          retryable: false,
          provider: { kind: 'rate_limit' }
        })
        // The only quota cooldown already ran out: no reset in the past is reported.
        expect(JSON.stringify(error)).not.toContain('quotaResetsAtMs')
        expect(primary.calls).toHaveLength(1)
      })
  )

  it.effect('never logs store error messages', () =>
    Effect.gen(function* () {
      const entries: Array<string> = []

      const logger = Logger.make(options =>
        entries.push(
          JSON.stringify({
            message: options.message,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations)
          })
        )
      )

      const down = (operation: PoolStoreError['operation']) =>
        Effect.fail(new PoolStoreError({ operation, message: 'postgres://user:secret@db down' }))

      const store: PoolStoreApi = {
        ...makeMemoryPoolStore(),
        load: () => down('load'),
        movePin: () => down('movePin'),
        putCooldown: () => down('putCooldown')
      }

      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + day))])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account], store })

      yield* Stream.runCollect(pool.provider.stream(request)).pipe(
        Effect.provide(Logger.layer([logger]))
      )

      expect(entries.some(entry => entry.includes('store load failed'))).toBe(true)
      expect(entries.some(entry => entry.includes('store putCooldown failed'))).toBe(true)
      expect(entries.join('\n')).not.toContain('secret')
    })
  )

  it.effect('routes statelessly when the store fails', () =>
    Effect.gen(function* () {
      const failing = makeMemoryPoolStore()
      const storeError = new PoolStoreError({ operation: 'load', message: 'database down' })

      const store: PoolStoreApi = {
        ...failing,
        load: () => Effect.fail(storeError),
        movePin: () => Effect.fail(new PoolStoreError({ operation: 'movePin', message: 'down' })),
        putCooldown: () =>
          Effect.fail(new PoolStoreError({ operation: 'putCooldown', message: 'down' }))
      }

      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + day))])
      const backup = scripted('backup', 0)
      const { pool } = yield* setup({ accounts: [primary.account, backup.account], store })

      expect(texts(yield* Stream.runCollect(pool.provider.stream(request)))).toEqual([
        'from backup'
      ])
    })
  )

  it.effect.each([
    ['invalid_pool_id', { id: ' ' }],
    ['no_accounts', { accounts: [] }],
    ['invalid_account_id', { accounts: [scripted(' a', 0).account] }],
    ['duplicate_account_id', { accounts: [scripted('a', 0).account, scripted('a', 1).account] }],
    ['invalid_priority', { accounts: [scripted('a', Number.NaN).account] }],
    ['invalid_max_age', { maxAgeMs: 0 }],
    ['invalid_reserve_percent', { reservePercent: 100 }]
  ] as const)('rejects invalid configuration: %s', ([reason, override]) =>
    Effect.gen(function* () {
      const error = yield* makePool({
        id: 'claude',
        accounts: [scripted('a', 0).account],
        store: makeMemoryPoolStore(),
        ...override
      }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: 'PoolConfigError', reason })
    })
  )
})

describe('pool under the agent loop', () => {
  it.effect('fails over inside one loop attempt and leaves transient retries to the loop', () =>
    Effect.gen(function* () {
      const overloaded = llmError({ kind: 'overloaded' })
      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + day))])
      const backup = scripted('backup', 0, [fail(overloaded), fail(overloaded)])
      const { pool } = yield* setup({ accounts: [primary.account, backup.account] })

      const events = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: '',
        tools: [],
        model: 'claude-opus-5-5'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(LLMProvider, pool.provider),
            TestToolExecutor.layer({})
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ContextTransformer.identity,
                LoopConfig.layer({
                  maxTurns: 4,
                  maxRetries: 2,
                  retryBaseDelayMs: 0,
                  toolConcurrency: 1
                })
              )
            )
          )
        )
      )

      const retries = Array.from(events).filter(event => Predicate.isTagged(event, 'AgentRetry'))

      // Quota failover is invisible to the loop; the two overloads are its two retries.
      expect(retries).toHaveLength(2)
      expect(primary.calls).toHaveLength(1)
      expect(backup.calls).toHaveLength(3)
      expect(Array.from(events).some(event => Predicate.isTagged(event, 'AgentEnd'))).toBe(true)
    })
  )

  it.effect('stops the loop at once when every account is exhausted', () =>
    Effect.gen(function* () {
      const primary = scripted('primary', 10, [fail(quotaExhausted(t0 + day))])
      const { pool } = yield* setup({ accounts: [primary.account] })

      const result = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: '',
        tools: [],
        model: 'claude-opus-5-5'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(LLMProvider, pool.provider),
            TestToolExecutor.layer({})
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ContextTransformer.identity,
                LoopConfig.layer({
                  maxTurns: 4,
                  maxRetries: 3,
                  retryBaseDelayMs: 0,
                  toolConcurrency: 1
                })
              )
            )
          )
        ),
        Effect.result
      )

      expect(Result.isFailure(result) && Predicate.isTagged(result.failure, 'LLMError')).toBe(true)
      expect(primary.calls).toHaveLength(1)
    })
  )
})

describe('poolFailureCooldown', () => {
  const at = (info: { readonly retryAfterMs?: number; readonly quotaResetsAtMs?: number }) =>
    poolFailureCooldown(llmError({ kind: 'rate_limit', ...info }), 'a', t0)

  it('trusts hints up to poolMaxCooldownMs ahead', () => {
    expect(at({ quotaResetsAtMs: t0 + poolMaxCooldownMs })?.untilMs).toBe(t0 + poolMaxCooldownMs)
    expect(at({ quotaResetsAtMs: t0 + poolMaxCooldownMs + 1 })).toBeUndefined()
    expect(at({ retryAfterMs: poolMaxCooldownMs })?.untilMs).toBe(t0 + poolMaxCooldownMs)
    expect(at({ retryAfterMs: poolMaxCooldownMs + 1 })).toBeUndefined()
  })

  it('ignores non-finite and past hints', () => {
    expect(at({ quotaResetsAtMs: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(at({ quotaResetsAtMs: Number.NaN })).toBeUndefined()
    expect(at({ quotaResetsAtMs: t0 - 1 })).toBeUndefined()
    expect(at({ retryAfterMs: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  it('ignores an untrusted reset but keeps a trusted long Retry-After', () => {
    expect(
      poolFailureCooldown(
        new LLMError({
          cause: 'rate_limit',
          message: 'quota',
          retryable: true,
          provider: ProviderErrorInfo.make({
            provider: 'anthropic_claude',
            kind: 'rate_limit',
            retryAfterMs: 2 * hour,
            quotaResetsAtMs: Number.POSITIVE_INFINITY
          })
        }),
        'a',
        t0
      )?.untilMs
    ).toBe(t0 + 2 * hour)
  })
})
