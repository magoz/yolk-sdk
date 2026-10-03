import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, type HttpClientRequest } from 'effect/http'
import { defineConformanceCase, type ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  decodeWireFixture,
  isWireBase64BodyResponse,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi,
  type ReplayLedgerEntry
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { TelegramConnector } from '@yolk-sdk/connectors/telegram'
import {
  TelegramConformanceConfig,
  TelegramConformanceSeeds as TelegramConformanceSeedsSchema,
  telegramConformanceCases,
  telegramConformanceFixtureSeeds,
  telegramConformanceFixtures,
  telegramConformanceReplayBotToken,
  telegramErrorEnvelopeFixture,
  telegramGetFilePathCase,
  telegramGetFilePathFixture,
  telegramSendMessageCase,
  telegramSendMessageFixture,
  telegramValidateGetChatCase,
  telegramValidateGetChatFixture,
  type TelegramConformanceCase,
  type TelegramConformanceSeeds
} from '@yolk-sdk/connectors/telegram/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const credentialLayer = staticCredentialResolverLayer(
  ApiKeyCredential.make({ key: telegramConformanceReplayBotToken })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: TelegramConformanceSeeds = telegramConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(TelegramConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = telegramConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = telegramConformanceFixtures) =>
  (testCase: TelegramConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = telegramConformanceFixtures,
    seeds: TelegramConformanceSeeds = telegramConformanceFixtureSeeds
  ) =>
  (testCase: TelegramConformanceCase) =>
    portsOver(
      Layer.unwrap(
        makeReplayHttpClient(fixturesFor(testCase, fixtures)).pipe(
          Effect.tap(({ ledger }) =>
            Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
          ),
          Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
        )
      ),
      seeds
    )

const ledgerOf = (ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>, caseId: string) =>
  Effect.gen(function* () {
    const ledger = (yield* Ref.get(ledgers)).get(caseId)

    if (ledger === undefined) {
      return expect.fail(`no ledger for ${caseId}`)
    }

    return { entries: yield* ledger.entries, remaining: yield* ledger.remaining }
  })

/** `METHOD botMethod` per ledger entry: the token-bearing path is never compared or printed. */
const botMethods = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(
    entry => `${entry.method} ${entry.url.slice(entry.url.lastIndexOf('/') + 1).split('?', 1)[0]}`
  )

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  ['telegram.validate.get-chat', 'read'],
  ['telegram.errors.error-envelope', 'read'],
  ['telegram.files.get-file-path', 'read'],
  ['telegram.messages.send-message', 'write-irreversible']
] as const

const sendCaseId = 'telegram.messages.send-message'

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

/** The bot token of a Bot API URL (`/bot<token>/` or `/file/bot<token>/`). */
const tokenOf = (url: string): string | undefined => /\/bot([^/]+)\//.exec(url)?.[1]

describe('Telegram conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(telegramConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(telegramConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      telegramConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of telegramConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions or the host-only download helper', () => {
    const actionIds = new Set(TelegramConnector.actions.map(action => action.id))

    for (const testCase of telegramConformanceCases) {
      const cited = [...`${testCase.docs} ${testCase.wire}`.matchAll(/`(telegram\.[a-z_]+)`/g)].map(
        match => match[1]
      )

      expect(cited.filter(id => id === undefined || !actionIds.has(id))).toEqual([])
    }

    expect(telegramGetFilePathCase.docs).toContain('`downloadTelegramFile`')
    expect(telegramValidateGetChatCase.docs).toContain('it does not call getMe')
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      telegramConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual([
      'telegram.errors.error-envelope',
      'telegram.errors.error-envelope',
      'telegram.files.get-file-path',
      sendCaseId
    ])
  })

  it('say the send case cannot be undone', () => {
    expect(telegramSendMessageCase.wire).toContain('write-irreversible')
    expect(telegramSendMessageCase.docs).toContain('cannot be undone through it')
  })

  it.effect(
    'ship synthetic fixtures with synthetic tokens that decode and pass the secret scan',
    () =>
      Effect.gen(function* () {
        for (const fixture of telegramConformanceFixtures) {
          expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
          expect(scanFixtureForSecrets(fixture)).toEqual([])
          expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

          for (const { request, response } of fixture.exchanges) {
            expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
            expect(request.url.startsWith('https://api.telegram.org/')).toBe(true)
            // Only the replay token, or the error case's synthetic invalid one, ever appears.
            expect([
              telegramConformanceReplayBotToken,
              '0:yolk-conformance-invalid-token'
            ]).toContain(tokenOf(request.url))

            if (response.status >= 400) {
              expect(JSON.parse(textBody(response))).toEqual({
                ok: false,
                error_code: response.status,
                description: expect.any(String)
              })
            }
          }
        }
      })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(telegramConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: telegramConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      expect(formatConformanceReport(report)).not.toContain(telegramConformanceReplayBotToken)
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(telegramConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(4)

      for (const testCase of telegramConformanceCases) {
        const { entries, remaining } = yield* ledgerOf(ledgers, testCase.id)
        const [fixture] = fixturesFor(testCase)

        if (fixture === undefined) {
          return expect.fail(`no fixture for ${testCase.id}`)
        }

        expect(remaining).toEqual([])
        expect(entries).toHaveLength(fixture.exchanges.length)

        entries.forEach((entry, index) => {
          const exchange: WireExchange | undefined = fixture.exchanges[index]

          expect(entry.match).toEqual({
            outcome: 'matched',
            fixtureId: fixture.id,
            exchangeIndex: index
          })
          expect(entry.bodyJson ?? entry.bodyText).toEqual(exchange?.request.body)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
          expect(Object.keys(entry.headers)).not.toContain('authorization')
        })
      }
    })
  )
})

describe('Telegram conformance safety on a live target', () => {
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(telegramConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default, and never the send with reversible writes', () =>
    Effect.gen(function* () {
      const expected = caseIds.map(([id, safety]) =>
        safety === 'read' ? [id, 'passed', null] : [id, 'skipped', 'manual-only']
      )

      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(expected)
      expect(
        yield* statuses({ kind: 'live', account: 'synthetic', allowWrites: 'reversible' })
      ).toEqual(expected)
      expect(
        yield* statuses({
          kind: 'live',
          account: 'synthetic',
          allowIrreversible: ['telegram.messages']
        })
      ).toEqual(expected)
    })
  )

  it.effect('runs the send only when its exact id is requested', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowIrreversible: [sendCaseId]
      })

      expect(results.map(([, status]) => status)).toEqual(Array(4).fill('passed'))
    })
  )
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails.

const replaceResponse = (
  fixture: WireFixture,
  index: number,
  response: (original: WireResponse) => WireResponse
): WireFixture => {
  const swap = (exchange: WireExchange, position: number): WireExchange =>
    position === index ? { ...exchange, response: response(exchange.response) } : exchange

  const [first, ...rest] = fixture.exchanges

  return {
    ...fixture,
    exchanges: [swap(first, 0), ...rest.map((exchange, offset) => swap(exchange, offset + 1))]
  }
}

const replaceInBody =
  (from: string, to: string) =>
  (response: WireResponse): WireResponse => {
    const body = textBody(response)

    expect(body).toContain(from)

    return { status: response.status, headers: response.headers, body: body.replace(from, to) }
  }

const withStatus =
  (status: number, body: string) =>
  (response: WireResponse): WireResponse => ({ status, headers: response.headers, body })

const okFalse = (code: number, description: string) =>
  JSON.stringify({ ok: false, error_code: code, description })

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(telegramConformanceCases, {
      target: { kind: 'replay' },
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  telegramConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

type ReportedFailure = { readonly kind: string; readonly tag: string; readonly message: string }

const sentText = 'yolk-conformance run-synthetic: synthetic conformance message, safe to ignore'

const unknownSendAdvice = `send outcome unknown: the message may have been delivered; look for "${sentText}" in the seeded chat by hand (the connector cannot delete it)`

const actionFailed = (message: string): ReportedFailure => ({
  kind: 'failure',
  tag: 'TelegramConformanceActionFailed',
  message
})

const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly failure: ReportedFailure
}> = [
  {
    // A 200 carrying ok: false: the connector's status-only check would report success.
    fixture: replaceResponse(
      telegramValidateGetChatFixture,
      0,
      withStatus(200, okFalse(400, 'Bad Request: chat not found'))
    ),
    failure: mismatch('expected the 2xx getChat answer to carry ok: true')
  },
  {
    fixture: replaceResponse(
      telegramErrorEnvelopeFixture,
      0,
      withStatus(200, okFalse(400, 'Bad Request: chat not found'))
    ),
    failure: mismatch('expected telegram.validate to fail for a chat the bot is not a member of')
  },
  {
    // An absolute file_path: the helper refuses it before any download.
    fixture: replaceResponse(
      telegramGetFilePathFixture,
      0,
      replaceInBody('"file_path":"documents/file_0.txt"', '"file_path":"/documents/file_0.txt"')
    ),
    failure: actionFailed('telegram.conformance.download_file failed: invalid_metadata')
  },
  {
    // A 2xx whose body says ok: false: the connector reports it sent; the case cannot tell.
    fixture: replaceResponse(
      telegramSendMessageFixture,
      0,
      withStatus(200, okFalse(403, 'Forbidden: bot is not a member of the supergroup chat'))
    ),
    failure: actionFailed(
      `telegram.send_message failed: undecodable_answer (HTTP 200); ${unknownSendAdvice}`
    )
  }
]

describe('Telegram conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { fixture, failure } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          { id: fixture.caseId, failure }
        ])
      })
    )
  }

  it.effect('the error envelope needs only ok: false, not the fields the connector ignores', () =>
    Effect.gen(function* () {
      const bare = replaceResponse(
        replaceResponse(telegramErrorEnvelopeFixture, 0, withStatus(400, '{"ok":false}')),
        1,
        withStatus(404, '{"ok":false}')
      )

      expect(yield* suiteFailures(withReplaced(bare))).toEqual([])
    })
  )

  it.effect('a getFile answer without file_size is a seed precondition, not a claim failure', () =>
    Effect.gen(function* () {
      expect(
        yield* suiteFailures(
          withReplaced(
            replaceResponse(telegramGetFilePathFixture, 0, replaceInBody('"file_size":32,', ''))
          )
        )
      ).toEqual([
        {
          id: 'telegram.files.get-file-path',
          failure: mismatch(
            'precondition: fileId must name a file whose getFile answer reports file_size'
          )
        }
      ])
    })
  )

  for (const [caseId] of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          telegramConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }

  it.effect('an error envelope answered 5xx fails the 4xx claim', () =>
    Effect.gen(function* () {
      const failures = yield* suiteFailures(
        withReplaced(
          replaceResponse(
            telegramErrorEnvelopeFixture,
            1,
            withStatus(502, okFalse(502, 'Bad Gateway'))
          )
        )
      )

      expect(failures).toEqual([
        {
          id: 'telegram.errors.error-envelope',
          failure: mismatch(
            'expected a bot token that names no bot to answer a 4xx status (telegram_validate_failed)'
          )
        }
      ])
    })
  )

  for (const [label, edit, code] of [
    [
      'a different file_id',
      replaceInBody(
        '"file_id":"BQACAgIAAxkDAAIC-yolk_synthetic_file_0001"',
        '"file_id":"BQACAgIAAxkDAAIC-yolk_synthetic_file_9999"'
      ),
      'invalid_metadata'
    ],
    [
      'a file_size the download does not match',
      replaceInBody('"file_size":32', '"file_size":31'),
      'partial_content'
    ]
  ] as const) {
    it.effect(`the download helper refuses ${label}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          withReplaced(replaceResponse(telegramGetFilePathFixture, 0, edit))
        )

        expect(failures).toEqual([
          {
            id: 'telegram.files.get-file-path',
            failure: {
              kind: 'failure',
              tag: 'TelegramConformanceActionFailed',
              message: `telegram.conformance.download_file failed: ${code}`
            }
          }
        ])
      })
    )
  }
})

const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
  })

const sendDrill = (fixture: WireFixture, seeds = telegramConformanceFixtureSeeds) =>
  Effect.gen(function* () {
    yield* atTestNow

    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([telegramSendMessageCase], {
      target: { kind: 'replay' },
      now,
      layer: ledgerCaseLayer(ledgers, [fixture], seeds)
    })

    return { failure: report.results[0]?.failure, ...(yield* ledgerOf(ledgers, sendCaseId)) }
  })

const serverError = okFalse(502, 'Bad Gateway')

describe('Telegram conformance irreversible send safety', () => {
  it.effect('a definitive 4xx send (rate limited) reports nothing sent, without advice', () =>
    Effect.gen(function* () {
      const { failure, entries } = yield* sendDrill(
        replaceResponse(
          telegramSendMessageFixture,
          0,
          withStatus(
            429,
            JSON.stringify({
              ok: false,
              error_code: 429,
              description: 'Too Many Requests: retry after 7',
              parameters: { retry_after: 7 }
            })
          )
        )
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TelegramConformanceActionFailed',
        message: 'telegram.send_message failed: telegram_rate_limited (HTTP 429)'
      })
      expect(botMethods(entries)).toEqual(['POST sendMessage'])
    })
  )

  it.effect('a 408 send is ambiguous, not a definitive rejection (it may still be delivered)', () =>
    Effect.gen(function* () {
      const { failure } = yield* sendDrill(
        replaceResponse(
          telegramSendMessageFixture,
          0,
          withStatus(408, okFalse(408, 'Request Timeout'))
        )
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TelegramConformanceActionFailed',
        message: `telegram.send_message failed: telegram_send_failed (HTTP 408); ${unknownSendAdvice}`
      })
    })
  )

  it.effect('an ambiguous 5xx send is reported with the exact text to look for', () =>
    Effect.gen(function* () {
      const { failure } = yield* sendDrill(
        replaceResponse(telegramSendMessageFixture, 0, withStatus(502, serverError))
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TelegramConformanceActionFailed',
        message: `telegram.send_message failed: telegram_send_failed (HTTP 502); ${unknownSendAdvice}`
      })
    })
  )

  it.effect('a 2xx send whose body is not { ok: true } is an unknown outcome, not a mismatch', () =>
    Effect.gen(function* () {
      for (const body of ['not json at all', '{"result":{"message_id":101}}', '']) {
        const { failure } = yield* sendDrill(
          replaceResponse(telegramSendMessageFixture, 0, withStatus(200, body))
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'TelegramConformanceActionFailed',
          message: `telegram.send_message failed: undecodable_answer (HTTP 200); ${unknownSendAdvice}`
        })
      }
    })
  )

  it.effect('a send that fails in transport is ambiguous, and no failure carries the token', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance(telegramConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results.find(result => result.id === sendCaseId)?.failure).toEqual({
        kind: 'failure',
        tag: 'TelegramConformanceActionFailed',
        message: `telegram.send_message failed: transport_failed; ${unknownSendAdvice}`
      })
      expect(report.summary.failed).toBe(4)
      expect(formatConformanceReport(report)).not.toContain(telegramConformanceReplayBotToken)
      expect(JSON.stringify(report)).not.toContain(telegramConformanceReplayBotToken)
    })
  )

  for (const seed of ['chatId', 'runId'] as const) {
    it.effect(`refuses the send before any request without ${seed}`, () =>
      Effect.gen(function* () {
        const { [seed]: _dropped, ...seeds } = telegramConformanceFixtureSeeds

        const { failure, entries } = yield* sendDrill(telegramSendMessageFixture, seeds)

        expect(failure).toEqual(
          mismatch(`precondition: TelegramConformanceConfig.${seed} is not configured`)
        )
        expect(entries).toEqual([])
      })
    )
  }

  it('accepts chat ids and file ids of the documented shapes only', () => {
    const decode = Schema.decodeUnknownOption(TelegramConformanceSeedsSchema)

    expect(Option.isSome(decode({ chatId: '-1001000000001', fileId: 'AbC_-1' }))).toBe(true)
    expect(Option.isSome(decode({ chatId: '@yolk_practice' }))).toBe(true)
    expect(Option.isNone(decode({ chatId: '12 34' }))).toBe(true)
    expect(Option.isNone(decode({ fileId: 'a/b' }))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
  })
})

// Interruption drills: the send is masked, so an interruption waits for its answer; an ambiguous
// answer still reaches the owner through the ConformanceCleanupReporter.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

/** A send client that holds the sendMessage response until released. */
const holdingSend = (fixture: WireFixture) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const { client, ledger } = yield* makeReplayHttpClient([fixture])

    const holding = HttpClient.transform(client, (response, request) =>
      request.url.endsWith('/sendMessage')
        ? response.pipe(
            Effect.tap(() => Deferred.succeed(sent, undefined)),
            Effect.tap(() => Deferred.await(release))
          )
        : response
    )

    return { sent, release, holding, ledger }
  })

const interruptAfter = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  sent: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    yield* Deferred.await(sent)

    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interrupting)

    return yield* Fiber.await(fiber)
  })

const ambiguousSendFixture = replaceResponse(
  telegramSendMessageFixture,
  0,
  withStatus(502, serverError)
)

describe('Telegram conformance interruption reporting', () => {
  it.effect('reports an ambiguous send answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, holding } = yield* holdingSend(ambiguousSendFixture)

      const fiber = yield* telegramSendMessageCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(warnings)).toEqual([
        `telegram.send_message failed: telegram_send_failed (HTTP 502); ${unknownSendAdvice}`
      ])
    })
  )

  it.effect('reports an undecodable 2xx send answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, holding } = yield* holdingSend(
        replaceResponse(telegramSendMessageFixture, 0, withStatus(200, '<html>proxy</html>'))
      )

      const fiber = yield* telegramSendMessageCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(warnings)).toEqual([
        `telegram.send_message failed: undecodable_answer (HTTP 200); ${unknownSendAdvice}`
      ])
    })
  )

  it.effect('finishes a masked successful send on interruption and reports nothing', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, holding, ledger } = yield* holdingSend(telegramSendMessageFixture)

      const fiber = yield* telegramSendMessageCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(botMethods(yield* ledger.entries)).toEqual(['POST sendMessage'])
      expect(yield* ledger.remaining).toEqual([])
      expect(yield* Ref.get(warnings)).toEqual([])
    })
  )

  it.effect(
    'reports nothing extra when an uninterrupted send is ambiguous (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter
        const { client } = yield* makeReplayHttpClient([ambiguousSendFixture])

        const exit = yield* telegramSendMessageCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

describe('Telegram conformance run interruption', () => {
  it.effect('stops the whole run when interrupted during an ambiguous send', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, holding } = yield* holdingSend(ambiguousSendFixture)

      const fiber = yield* runConformance([telegramSendMessageCase, sentinelCase(sentinelRan)], {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
      }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(sentinelRan)).toBe(false)

      // Same shape as the Dropbox failing-restore drill (effect 4.0.0): the run ends with the
      // case's own failure and no Interrupt in the cause, produces no report, and resumes no case.
      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to fail')
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: 'TelegramConformanceActionFailed',
        sendOutcome: 'unknown'
      })
      expect(yield* Ref.get(warnings)).toHaveLength(1)
    })
  )

  it.effect('ends interrupt-only, without a later case, when the send succeeded', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, holding } = yield* holdingSend(telegramSendMessageFixture)

      const fiber = yield* runConformance([telegramSendMessageCase, sentinelCase(sentinelRan)], {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
      }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(sentinelRan)).toBe(false)

      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to be interrupted')
      }

      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(yield* Ref.get(warnings)).toEqual([])
    })
  )
})
