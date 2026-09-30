import { Context, Data, Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase,
  type ConformanceSafety
} from '../src/case.ts'
import type { PortFixture, WireFixture } from '../src/fixture.ts'
import { ReplayHttpClient } from '../src/replay.ts'
import {
  conformanceCaseWarnings,
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  sanitizeConformanceMessage,
  type ConformanceSkipReason,
  type ConformanceTarget
} from '../src/runner.ts'

const now = new Date('2026-09-29T12:00:00.000Z')

const baseCase = (id: string, safety: ConformanceSafety = 'read') =>
  defineConformanceCase({
    id,
    safety,
    docs: 'Synthetic docs claim.',
    wire: 'Synthetic wire claim.',
    observed: { account: 'synthetic', date: '2026-09-20' },
    fixtures: [],
    run: Effect.void
  })

describe('conformanceSkipReason (safety policy)', () => {
  const safeties: ReadonlyArray<ConformanceSafety> = [
    'read',
    'write-reversible',
    'write-irreversible'
  ]

  const id = 'example.items.send'

  // [target label, target, expected skip reason per safety: read, write-reversible, write-irreversible]
  const matrix: ReadonlyArray<
    readonly [
      string,
      ConformanceTarget,
      readonly [
        ConformanceSkipReason | undefined,
        ConformanceSkipReason | undefined,
        ConformanceSkipReason | undefined
      ]
    ]
  > = [
    ['replay', { kind: 'replay' }, [undefined, undefined, undefined]],
    ['in-process', { kind: 'in-process' }, [undefined, undefined, undefined]],
    ['emulated', { kind: 'emulated' }, [undefined, undefined, undefined]],
    [
      'live default',
      { kind: 'live', account: 'synthetic' },
      [undefined, 'writes-not-allowed', 'manual-only']
    ],
    [
      'live allowWrites none',
      { kind: 'live', account: 'synthetic', allowWrites: 'none' },
      [undefined, 'writes-not-allowed', 'manual-only']
    ],
    [
      'live allowWrites reversible',
      { kind: 'live', account: 'synthetic', allowWrites: 'reversible' },
      [undefined, undefined, 'manual-only']
    ],
    [
      'live reversible + other irreversible id',
      {
        kind: 'live',
        account: 'synthetic',
        allowWrites: 'reversible',
        allowIrreversible: ['example.items.other', 'example.items']
      },
      [undefined, undefined, 'manual-only']
    ],
    [
      'live reversible + exact irreversible id',
      {
        kind: 'live',
        account: 'synthetic',
        allowWrites: 'reversible',
        allowIrreversible: [id]
      },
      [undefined, undefined, undefined]
    ],
    [
      'live none + exact irreversible id',
      { kind: 'live', account: 'synthetic', allowIrreversible: [id] },
      [undefined, 'writes-not-allowed', undefined]
    ]
  ]

  for (const [label, target, expected] of matrix) {
    it(`${label}`, () => {
      expect(safeties.map(safety => conformanceSkipReason(target, { id, safety }))).toEqual(
        expected
      )
    })
  }

  it.effect('skipped cases never build their layer or run', () =>
    Effect.gen(function* () {
      const built = yield* Ref.make<ReadonlyArray<string>>([])
      const ran = yield* Ref.make<ReadonlyArray<string>>([])

      const track = (testCase: ConformanceCase) =>
        ({
          ...testCase,
          run: Ref.update(ran, ids => [...ids, testCase.id])
        }) satisfies ConformanceCase

      const cases = [
        track(baseCase('example.policy.read', 'read')),
        track(baseCase('example.policy.reversible', 'write-reversible')),
        track(baseCase('example.policy.irreversible', 'write-irreversible'))
      ]

      const report = yield* runConformance(cases, {
        target: { kind: 'live', account: 'synthetic' },
        now,
        layer: testCase => Layer.effectDiscard(Ref.update(built, ids => [...ids, testCase.id]))
      })

      expect(yield* Ref.get(built)).toEqual(['example.policy.read'])
      expect(yield* Ref.get(ran)).toEqual(['example.policy.read'])
      expect(report.target).toEqual({ kind: 'live', account: 'synthetic' })
      expect(report.results.map(result => [result.id, result.status, result.skipReason])).toEqual([
        ['example.policy.read', 'passed', undefined],
        ['example.policy.reversible', 'skipped', 'writes-not-allowed'],
        ['example.policy.irreversible', 'skipped', 'manual-only']
      ])
      expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 2 })
      expect(conformanceReportFailed(report)).toBe(false)
    })
  )

  it.effect('an explicitly started irreversible case runs on live', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [baseCase('example.policy.send', 'write-irreversible')],
        {
          target: {
            kind: 'live',
            account: 'synthetic',
            allowIrreversible: ['example.policy.send']
          },
          now,
          layer: () => Layer.empty
        }
      )

      expect(report.results.map(result => result.status)).toEqual(['passed'])
    })
  )
})

class Counter extends Context.Service<Counter, Ref.Ref<number>>()('test/Counter') {}

class CaseFailure extends Data.TaggedError('CaseFailure')<{ readonly message: string }> {}

class LayerFailure extends Data.TaggedError('LayerFailure')<{ readonly message: string }> {}

describe('runConformance isolation', () => {
  it.effect('rebuilds per case a layer the ambient context already built and memoized', () =>
    Effect.gen(function* () {
      const builds = yield* Ref.make(0)

      const shared = Layer.effect(
        Counter,
        Ref.update(builds, count => count + 1).pipe(Effect.andThen(Ref.make(0)))
      )

      const bump = (id: string) =>
        defineConformanceCase({
          ...baseCase(id),
          run: Effect.gen(function* () {
            const counter = yield* Counter
            const before = yield* Ref.getAndUpdate(counter, count => count + 1)

            yield* expectEqual(before, 0, 'state leaked from an earlier case')
          })
        })

      // The outer provide builds `shared` once and puts its memo map in the ambient context.
      // Without `{ local: true }` each case would reuse that memoized build (and its counter).
      const report = yield* runConformance([bump('example.fresh.one'), bump('example.fresh.two')], {
        target: { kind: 'in-process' },
        now,
        layer: () => shared
      }).pipe(Effect.provide(shared))

      expect(report.summary).toEqual({ passed: 2, failed: 0, skipped: 0 })
      expect(yield* Ref.get(builds)).toBe(3)
    })
  )

  it.effect('gives each case fresh replay consumption', () =>
    Effect.gen(function* () {
      const fixture: WireFixture = {
        id: 'example.ping.synthetic',
        caseId: 'example.ping',
        evidence: 'unverified',
        recordedAt: '2026-09-28',
        account: 'synthetic',
        endpoint: 'https://api.example.test/ping',
        exchanges: [
          {
            request: { method: 'GET', url: 'https://api.example.test/ping' },
            response: { status: 200, headers: {}, body: 'pong' }
          }
        ]
      }

      const ping = (id: string) =>
        defineConformanceCase({
          ...baseCase(id),
          fixtures: [fixture.id],
          run: Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient

            const response = yield* client.execute(
              HttpClientRequest.get('https://api.example.test/ping')
            )

            yield* expectEqual(response.status, 200, 'ping answers 200')
          })
        })

      const report = yield* runConformance([ping('example.ping.one'), ping('example.ping.two')], {
        target: { kind: 'replay' },
        now,
        fixtures: [fixture],
        layer: () => ReplayHttpClient.layer([fixture])
      })

      expect(report.results.map(result => result.status)).toEqual(['passed', 'passed'])
    })
  )
})

describe('runConformance failures', () => {
  it.effect(
    'reports mismatches, own errors, layer build failures, and defects without crashing',
    () =>
      Effect.gen(function* () {
        // Different error types per case: the run infers the union without annotations.
        const cases = [
          {
            ...baseCase('example.fail.mismatch'),
            run: expectConformance(false, 'reasoning arrived after text', {
              expected: 'secret-expected-detail',
              actual: 'secret-actual-detail'
            })
          },
          {
            ...baseCase('example.fail.own-error'),
            run: Effect.fail(new CaseFailure({ message: 'upstream said no' }))
          },
          { ...baseCase('example.fail.layer'), run: Effect.void },
          {
            ...baseCase('example.fail.defect'),
            run: Effect.die(new Error('unexpected\n  boom'))
          },
          baseCase('example.fail.after')
        ]

        const report = yield* runConformance(cases, {
          target: { kind: 'emulated' },
          now,
          layer: testCase =>
            testCase.id === 'example.fail.layer'
              ? Layer.effectDiscard(
                  Effect.fail(new LayerFailure({ message: 'emulator not ready' }))
                )
              : Layer.empty
        })

        expect(report.results.map(result => [result.id, result.status, result.failure])).toEqual([
          [
            'example.fail.mismatch',
            'failed',
            { kind: 'failure', tag: 'ConformanceMismatch', message: 'reasoning arrived after text' }
          ],
          [
            'example.fail.own-error',
            'failed',
            { kind: 'failure', tag: 'CaseFailure', message: 'upstream said no' }
          ],
          [
            'example.fail.layer',
            'failed',
            { kind: 'failure', tag: 'LayerFailure', message: 'emulator not ready' }
          ],
          ['example.fail.defect', 'failed', { kind: 'defect', message: 'unexpected boom' }],
          ['example.fail.after', 'passed', undefined]
        ])
        expect(report.summary).toEqual({ passed: 1, failed: 4, skipped: 0 })
        expect(conformanceReportFailed(report)).toBe(true)
        expect(JSON.stringify(report)).not.toContain('secret-expected-detail')
        expect(JSON.stringify(report)).not.toContain('secret-actual-detail')
      })
  )

  it.effect(
    'sanitizes failure messages: masks bearer tokens, collapses whitespace, caps length',
    () =>
      Effect.gen(function* () {
        const long = 'x'.repeat(2_000)

        const report = yield* runConformance(
          [
            {
              ...baseCase('example.fail.bearer'),
              run: Effect.fail(
                new CaseFailure({ message: 'sent Authorization: Bearer abc.def-123\nthen failed' })
              )
            },
            {
              ...baseCase('example.fail.long'),
              run: Effect.fail(new CaseFailure({ message: long }))
            },
            { ...baseCase('example.fail.string'), run: Effect.fail('plain string failure') },
            { ...baseCase('example.fail.opaque'), run: Effect.fail({ status: 500 }) }
          ],
          { target: { kind: 'replay' }, now, layer: () => Layer.empty }
        )

        const [bearer, capped, plain, opaque] = report.results

        expect(bearer?.failure?.message).toBe('sent Authorization: <redacted> then failed')
        expect(capped?.failure?.message.length).toBe(300)
        expect(capped?.failure?.message.endsWith('...')).toBe(true)
        expect(plain?.failure).toEqual({ kind: 'failure', message: 'plain string failure' })
        expect(opaque?.failure).toEqual({ kind: 'failure', message: 'case failed' })
      })
  )

  it.effect('reports a throwing layer factory as a failed case and keeps running', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [baseCase('example.factory.throws'), baseCase('example.factory.after')],
        {
          target: { kind: 'replay' },
          now,
          layer: testCase => {
            if (testCase.id === 'example.factory.throws') {
              throw new Error('factory exploded')
            }

            return Layer.empty
          }
        }
      )

      expect(report.results.map(result => [result.id, result.status, result.failure])).toEqual([
        ['example.factory.throws', 'failed', { kind: 'defect', message: 'factory exploded' }],
        ['example.factory.after', 'passed', undefined]
      ])
    })
  )

  it('requires the per-case layer to provide every case requirement', () => {
    const needsCounter = defineConformanceCase({
      ...baseCase('example.types.counter'),
      run: Effect.gen(function* () {
        yield* Counter
      })
    })

    const needsNothing = baseCase('example.types.plain')

    const provided: Effect.Effect<unknown, never, never> = runConformance(
      [needsCounter, needsNothing],
      { target: { kind: 'replay' }, layer: () => Layer.effect(Counter, Ref.make(0)) }
    )

    const missing = runConformance([needsCounter, needsNothing], {
      target: { kind: 'replay' },
      // @ts-expect-error the layer must provide Counter
      layer: () => Layer.empty
    })

    expect(Effect.isEffect(provided) && Effect.isEffect(missing)).toBe(true)
  })

  it.effect('propagates interruption of the whole run', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()

      const fiber = yield* runConformance(
        [
          {
            ...baseCase('example.slow.case'),
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          }
        ],
        { target: { kind: 'replay' }, now, layer: () => Layer.empty }
      ).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
    })
  )

  it.effect('does not turn a case interrupting itself into a failed result', () =>
    Effect.gen(function* () {
      const exit = yield* runConformance(
        [{ ...baseCase('example.self.interrupt'), run: Effect.interrupt }],
        { target: { kind: 'replay' }, now, layer: () => Layer.empty }
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
    })
  )
})

describe('report sanitization', () => {
  // Synthetic credential-shaped values, assembled at runtime so the source holds no key literal.
  const openAiStyleKey = ['sk', 'synthetic0000000000000000'].join('-')
  const gatewayStyleKey = ['vck', 'synthetic0000000000000000'].join('_')

  const syntheticJwt = [
    'eyJhbGciOiJub25lIn0',
    'eyJzdWIiOiJzeW50aGV0aWMifQ',
    'c2lnbmF0dXJlMDAw'
  ].join('.')

  const secrets = [
    openAiStyleKey,
    gatewayStyleKey,
    syntheticJwt,
    'synthetic-api-key-value',
    'private-body-content',
    'synthetic-session-cookie',
    'synthetic-set-cookie',
    'synthetic-query-token',
    'synthetic-password',
    'plain-header-secret',
    'plainproxybasic',
    'plain-auth-token',
    'plain-api-key-header',
    'alpha beta',
    'delim;iter'
  ]

  const hostileMessage = [
    'upstream rejected the request: response={"api_key":"synthetic-api-key-value","body":"private-body-content"}',
    `key ${openAiStyleKey} and ${gatewayStyleKey} without an auth scheme`,
    `jwt ${syntheticJwt}`,
    'Cookie: session=synthetic-session-cookie',
    'Set-Cookie: id=synthetic-set-cookie; Path=/; HttpOnly',
    'url https://api.example.test/items?access_token=synthetic-query-token&page=2',
    'password=synthetic-password',
    'X-Api-Key: plain-header-secret',
    'Proxy-Authorization: Basic plainproxybasic',
    'request header x-auth-token: plain-auth-token',
    'api-key: plain-api-key-header',
    'login failed: password="synthetic alpha beta" retry later',
    "secret='quoted delim;iter value'"
  ].join('\n')

  class HostileError extends Data.TaggedError('HostileError')<{ readonly message: string }> {}

  const hostileTag = { _tag: 'Hostile tag {"api_key":"x"}', message: hostileMessage }

  it('redacts credentials, cookies, and JSON spans, and caps the length', () => {
    const sanitized = sanitizeConformanceMessage(hostileMessage)

    for (const secret of secrets) {
      expect(sanitized).not.toContain(secret)
    }

    expect(sanitized).toContain('upstream rejected the request: response=[json]')
    expect(sanitized).toContain('key <redacted> and <redacted> without an auth scheme')
    expect(sanitized).toContain('jwt <redacted>')
    expect(sanitized).toContain('Cookie: <redacted> Set-Cookie: <redacted>')
    expect(sanitized).toContain('access_token=<redacted>&page=2')
    expect(sanitized).not.toMatch(/\s{2,}/)
    expect(sanitizeConformanceMessage('x'.repeat(1_000))).toHaveLength(300)
  })

  it('redacts credential header lines and whole quoted values with spaces', () => {
    expect(sanitizeConformanceMessage('X-Api-Key: plain-header-secret')).toBe(
      'X-Api-Key: <redacted>'
    )
    expect(sanitizeConformanceMessage('Proxy-Authorization: Basic plainproxybasic')).toBe(
      'Proxy-Authorization: <redacted>'
    )
    expect(sanitizeConformanceMessage('failed with x-auth-token: plain-auth-token')).toBe(
      'failed with x-auth-token: <redacted>'
    )
    expect(sanitizeConformanceMessage('password="synthetic alpha beta" retry')).toBe(
      'password=<redacted> retry'
    )
    expect(sanitizeConformanceMessage("secret='quoted delim;iter value' next")).toBe(
      'secret=<redacted> next'
    )
    // A partially matched value never shields the rest of the header line.
    expect(
      sanitizeConformanceMessage(
        `Cookie: ${['vck', 'synthetic0000000000000000'].join('_')}=opaque; session=plain-cookie-secret`
      )
    ).toBe('Cookie: <redacted>')
    expect(
      sanitizeConformanceMessage(
        'Authorization: AWS4-HMAC-SHA256 Credential=x/y, SignedHeaders=host, Signature=plainsig'
      )
    ).toBe('Authorization: <redacted>')
    // Ordinary colon-separated text is untouched.
    expect(sanitizeConformanceMessage('expected status: 400, got 404')).toBe(
      'expected status: 400, got 404'
    )
  })

  it('elides nested and unbalanced JSON spans', () => {
    expect(sanitizeConformanceMessage('a {"x":[1,{"y":"}"}]} b [1, 2] c')).toBe(
      'a [json] b [json] c'
    )
    expect(sanitizeConformanceMessage('truncated body {"body":"private-body-content')).toBe(
      'truncated body [json]'
    )
    expect(sanitizeConformanceMessage('mismatched {"a":[1}] tail')).toBe('mismatched [json]')
  })

  it('redacts credential field pairs and auth schemes outside JSON', () => {
    expect(
      sanitizeConformanceMessage(
        "api_key: synthetic-api-key-value, token='synthetic-query-token' Authorization: Basic c3ludGhldGlj"
      )
    ).toBe('api_key: <redacted>')
    expect(sanitizeConformanceMessage("token='synthetic-query-token' next")).toBe(
      'token=<redacted> next'
    )
    // Usage counters and ordinary words are not credential fields.
    expect(sanitizeConformanceMessage('max_tokens: 64, prompt_tokens=12 keys ok')).toBe(
      'max_tokens: 64, prompt_tokens=12 keys ok'
    )
  })

  it.effect(
    'sanitizes failures, layer failures, and defects in results and the formatted report',
    () =>
      Effect.gen(function* () {
        const report = yield* runConformance(
          [
            {
              ...baseCase('example.hostile.failure'),
              run: Effect.fail(new HostileError({ message: hostileMessage }))
            },
            { ...baseCase('example.hostile.layer'), run: Effect.void },
            { ...baseCase('example.hostile.defect'), run: Effect.die(new Error(hostileMessage)) },
            { ...baseCase('example.hostile.string'), run: Effect.fail(hostileMessage) },
            { ...baseCase('example.hostile.tag'), run: Effect.fail(hostileTag) },
            { ...baseCase('example.hostile.tag-only'), run: Effect.fail({ _tag: 'Bad Tag!' }) },
            {
              ...baseCase('example.hostile.mismatch'),
              run: expectConformance(false, `claim failed for key ${openAiStyleKey}`, {
                actual: hostileMessage
              })
            }
          ],
          {
            target: { kind: 'replay' },
            now,
            layer: testCase =>
              testCase.id === 'example.hostile.layer'
                ? Layer.effectDiscard(Effect.fail(new LayerFailure({ message: hostileMessage })))
                : Layer.empty
          }
        )

        const sanitized = sanitizeConformanceMessage(hostileMessage)

        expect(report.results.map(result => result.failure)).toEqual([
          { kind: 'failure', tag: 'HostileError', message: sanitized },
          { kind: 'failure', tag: 'LayerFailure', message: sanitized },
          { kind: 'defect', message: sanitized },
          { kind: 'failure', message: sanitized },
          { kind: 'failure', message: sanitized },
          { kind: 'failure', message: 'case failed' },
          {
            kind: 'failure',
            tag: 'ConformanceMismatch',
            message: 'claim failed for key <redacted>'
          }
        ])

        const serialized = JSON.stringify(report)
        const formatted = formatConformanceReport(report)

        for (const secret of [...secrets, 'Hostile tag', 'Bad Tag!']) {
          expect(serialized).not.toContain(secret)
          expect(formatted).not.toContain(secret)
        }
      })
  )
})

describe('report tags', () => {
  const credentialTag = ['vck', 'synthetic0000000000000000'].join('_')

  it.effect('never reports a credential-shaped tag, with or without a message', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [
          {
            ...baseCase('example.tag.message'),
            run: Effect.fail({ _tag: credentialTag, message: 'boom' })
          },
          { ...baseCase('example.tag.bare'), run: Effect.fail({ _tag: credentialTag }) }
        ],
        { target: { kind: 'replay' }, now, layer: () => Layer.empty }
      )

      expect(report.results.map(result => result.failure)).toEqual([
        { kind: 'failure', message: 'boom' },
        { kind: 'failure', message: 'case failed' }
      ])
      expect(JSON.stringify(report)).not.toContain(credentialTag)
      expect(formatConformanceReport(report)).not.toContain(credentialTag)
    })
  )

  it.effect('redacts quoted credential header names in mismatch messages', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [
          {
            ...baseCase('example.mismatch.header'),
            run: expectConformance(
              false,
              'unexpected request headers {"x-api-key":"plain-mismatch-secret","accept":"*/*"}'
            )
          }
        ],
        { target: { kind: 'replay' }, now, layer: () => Layer.empty }
      )

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'unexpected request headers {"x-api-key":<redacted>,"accept":"*/*"}'
      })
      expect(JSON.stringify(report)).not.toContain('plain-mismatch-secret')
    })
  )

  it.effect('redacts nested quoted credential header keys in mismatch messages', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [
          {
            ...baseCase('example.mismatch.nested'),
            run: expectConformance(
              false,
              'sent {"headers":{"x-api-key":"plain-nested-secret"},"list":[{"x-figma-token":"plain-array-secret"}]}'
            )
          }
        ],
        { target: { kind: 'replay' }, now, layer: () => Layer.empty }
      )

      expect(report.results[0]?.failure?.message).toBe(
        'sent {"headers":{"x-api-key":<redacted>},"list":[{"x-figma-token":<redacted>}]}'
      )
      expect(JSON.stringify(report)).not.toContain('plain-nested-secret')
      expect(JSON.stringify(report)).not.toContain('plain-array-secret')
    })
  )
})

describe('runConformance concurrency', () => {
  const recording = (log: Ref.Ref<ReadonlyArray<string>>, id: string) =>
    defineConformanceCase({
      ...baseCase(id),
      run: Ref.update(log, entries => [...entries, `${id}:start`]).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Ref.update(log, entries => [...entries, `${id}:end`]))
      )
    })

  it.effect('runs one case at a time by default', () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([])

      yield* runConformance([recording(log, 'example.seq.a'), recording(log, 'example.seq.b')], {
        target: { kind: 'live', account: 'synthetic' },
        now,
        layer: () => Layer.empty
      })

      expect(yield* Ref.get(log)).toEqual([
        'example.seq.a:start',
        'example.seq.a:end',
        'example.seq.b:start',
        'example.seq.b:end'
      ])
    })
  )

  it.effect('runs cases in parallel up to the concurrency limit, keeping result order', () =>
    Effect.gen(function* () {
      const latch = yield* Deferred.make<void>()

      const report = yield* runConformance(
        [
          { ...baseCase('example.par.waits'), run: Deferred.await(latch) },
          { ...baseCase('example.par.opens'), run: Deferred.succeed(latch, undefined) }
        ],
        { target: { kind: 'replay' }, now, layer: () => Layer.empty, concurrency: 2 }
      )

      expect(report.results.map(result => [result.id, result.status])).toEqual([
        ['example.par.waits', 'passed'],
        ['example.par.opens', 'passed']
      ])
    })
  )
})

describe('conformance warnings', () => {
  const fixture = (
    id: string,
    evidence: WireFixture['evidence'],
    recordedAt: string
  ): WireFixture => ({
    id,
    caseId: 'example.warn.case',
    evidence,
    recordedAt,
    account: 'synthetic',
    endpoint: 'https://api.example.test/items',
    exchanges: [
      {
        request: { method: 'GET', url: 'https://api.example.test/items' },
        response: { status: 200, headers: {}, body: '[]' }
      }
    ]
  })

  const fixtures = [
    fixture('example.warn.fresh-verified', 'verified', '2026-09-28'),
    fixture('example.warn.fresh-unverified', 'unverified', '2026-09-28'),
    fixture('example.warn.stale-verified', 'verified', '2026-08-01'),
    fixture('example.warn.bad-date', 'verified', 'yesterday')
  ]

  const referencing = {
    fixtures: [
      'example.warn.fresh-verified',
      'example.warn.fresh-unverified',
      'example.warn.stale-verified',
      'example.warn.bad-date',
      'example.warn.absent'
    ]
  }

  it('flags unverified cases and every fixture problem on replay', () => {
    expect(
      conformanceCaseWarnings(referencing, { target: { kind: 'replay' }, now, fixtures })
    ).toEqual([
      { kind: 'unverified-case' },
      { kind: 'unverified-fixture', fixtureId: 'example.warn.fresh-unverified' },
      { kind: 'stale-fixture', fixtureId: 'example.warn.stale-verified', ageDays: 59 },
      { kind: 'stale-fixture', fixtureId: 'example.warn.bad-date' },
      { kind: 'missing-fixture', fixtureId: 'example.warn.absent' }
    ])
  })

  it('honours maxFixtureAgeDays for fixtures and observations', () => {
    expect(
      conformanceCaseWarnings(
        { ...referencing, observed: { account: 'synthetic', date: '2026-09-20' } },
        {
          target: { kind: 'emulated' },
          now,
          fixtures: fixtures.slice(0, 1),
          maxFixtureAgeDays: 0
        }
      )
    ).toEqual([
      { kind: 'stale-observation', ageDays: 9 },
      { kind: 'stale-fixture', fixtureId: 'example.warn.fresh-verified', ageDays: 1 },
      { kind: 'missing-fixture', fixtureId: 'example.warn.fresh-unverified' },
      { kind: 'missing-fixture', fixtureId: 'example.warn.stale-verified' },
      { kind: 'missing-fixture', fixtureId: 'example.warn.bad-date' },
      { kind: 'missing-fixture', fixtureId: 'example.warn.absent' }
    ])
  })

  it('reports no fixture warnings without supplied fixtures, and only case-level ones on live', () => {
    expect(conformanceCaseWarnings(referencing, { target: { kind: 'replay' }, now })).toEqual([
      { kind: 'unverified-case' }
    ])

    expect(
      conformanceCaseWarnings(
        { ...referencing, observed: { account: 'synthetic', date: '2026-07-01' } },
        { target: { kind: 'live', account: 'synthetic' }, now, fixtures }
      )
    ).toEqual([{ kind: 'stale-observation', ageDays: 90 }])

    expect(
      conformanceCaseWarnings(
        { ...referencing, observed: { account: 'synthetic', date: '2026-09-28' } },
        { target: { kind: 'live', account: 'synthetic' }, now, fixtures }
      )
    ).toEqual([])
  })

  it('accepts port fixtures next to wire fixtures: unverified without observed, stale by observed date', () => {
    const port = (id: string, observed?: PortFixture['observed']): PortFixture => {
      const synthetic: PortFixture = {
        id,
        port: 'ExampleClient',
        method: 'listItems',
        request: { folder: 'INBOX' },
        response: { items: [] }
      }

      return observed === undefined ? synthetic : { ...synthetic, observed }
    }

    const mixed = [
      fixture('example.warn.fresh-verified', 'verified', '2026-09-28'),
      port('example.port.synthetic'),
      port('example.port.fresh', { account: 'practice', date: '2026-09-28' }),
      port('example.port.stale', { account: 'practice', date: '2026-08-01' })
    ]

    expect(
      conformanceCaseWarnings(
        {
          observed: { account: 'synthetic', date: '2026-09-28' },
          fixtures: [
            'example.warn.fresh-verified',
            'example.port.synthetic',
            'example.port.fresh',
            'example.port.stale',
            'example.port.absent'
          ]
        },
        { target: { kind: 'replay' }, now, fixtures: mixed }
      )
    ).toEqual([
      { kind: 'unverified-fixture', fixtureId: 'example.port.synthetic' },
      { kind: 'stale-fixture', fixtureId: 'example.port.stale', ageDays: 59 },
      { kind: 'missing-fixture', fixtureId: 'example.port.absent' }
    ])
  })

  it.effect('attaches warnings to results, including skipped ones', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [
          defineConformanceCase({
            id: 'example.warn.write',
            safety: 'write-reversible',
            docs: 'Docs claim.',
            wire: 'Wire claim.',
            fixtures: [],
            run: Effect.void
          })
        ],
        { target: { kind: 'live', account: 'synthetic' }, now, layer: () => Layer.empty }
      )

      expect(report.results[0]).toEqual({
        id: 'example.warn.write',
        safety: 'write-reversible',
        status: 'skipped',
        skipReason: 'writes-not-allowed',
        durationMs: 0,
        warnings: [{ kind: 'unverified-case' }]
      })
    })
  )

  it.effect('defaults the reference time to the Effect Clock', () =>
    Effect.gen(function* () {
      const report = yield* runConformance([baseCase('example.clock.case')], {
        target: { kind: 'replay' },
        layer: () => Layer.empty
      })

      // `it.effect` runs on the TestClock, which starts at the epoch.
      expect(report.startedAt).toBe('1970-01-01T00:00:00.000Z')
      // The observation (2026-09-20) is in the future relative to the epoch: not stale.
      expect(report.results[0]?.warnings).toEqual([])
    })
  )
})

describe('formatConformanceReport', () => {
  it.effect('prints one plain line per case and a summary line', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [
          defineConformanceCase({
            id: 'example.format.pass',
            safety: 'read',
            docs: 'Docs claim.',
            wire: 'Wire claim.',
            fixtures: ['example.format.pass.synthetic', 'example.format.absent'],
            run: Effect.void
          }),
          {
            ...baseCase('example.format.fail'),
            run: expectConformance(false, 'claim did not hold')
          },
          baseCase('example.format.skip', 'write-irreversible')
        ],
        {
          target: { kind: 'live', account: 'synthetic' },
          now,
          layer: () => Layer.empty
        }
      )

      expect(formatConformanceReport(report)).toBe(
        [
          'PASS  example.format.pass  [read]  warnings: unverified-case',
          'FAIL  example.format.fail  [read]  ConformanceMismatch: claim did not hold',
          'SKIP  example.format.skip  [write-irreversible]  manual-only',
          '1 passed, 1 failed, 1 skipped; target live (account synthetic); started 2026-09-29T12:00:00.000Z'
        ].join('\n')
      )
    })
  )

  it.effect('formats fixture warnings and defects', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [
          defineConformanceCase({
            id: 'example.format.warn',
            safety: 'read',
            docs: 'Docs claim.',
            wire: 'Wire claim.',
            observed: { account: 'synthetic', date: '2026-01-01' },
            fixtures: ['example.format.absent'],
            run: Effect.die('boom')
          })
        ],
        { target: { kind: 'replay' }, now, fixtures: [], layer: () => Layer.empty }
      )

      expect(formatConformanceReport(report)).toBe(
        [
          'FAIL  example.format.warn  [read]  defect boom  warnings: stale-observation(271d), missing-fixture:example.format.absent',
          '0 passed, 1 failed, 0 skipped; target replay; started 2026-09-29T12:00:00.000Z'
        ].join('\n')
      )
      expect(formatConformanceReport(report)).not.toMatch(/\u001b\[/)
    })
  )
})
