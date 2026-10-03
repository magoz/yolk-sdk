import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient } from 'effect/http'
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
import {
  ConnectorBinaryHttpClient,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  FortnoxConformanceConfig,
  FortnoxConformanceRestoreFailed,
  fortnoxConformanceCases,
  fortnoxConformanceCommentsMarker,
  fortnoxConformanceFixtureSeeds,
  fortnoxConformanceFixtures,
  fortnoxCustomerEmptyStringCase,
  fortnoxCustomerEmptyStringFixture,
  fortnoxInvoicePaymentFiltersCase,
  fortnoxInvoicePaymentFiltersFixture,
  fortnoxInvoicePreviewPdfFixture,
  fortnoxInvoiceRowDiscountCase,
  fortnoxInvoiceRowDiscountFixture,
  fortnoxInvoiceSendEmailCase,
  fortnoxInvoiceSendEmailFixture,
  fortnoxWriteRejectionCase,
  fortnoxWriteRejectionFixture,
  type FortnoxConformanceCase,
  type FortnoxConformanceSeeds
} from '@yolk-sdk/connectors/fortnox/conformance'

const now = new Date('2026-09-29T12:00:00.000Z')

/**
 * Pin the Effect `Clock` (a `TestClock` under `it.effect`) to `now`: the payment-filter case reads
 * "today" from it, and the synthetic overdue invoice is due 2026-09-15.
 */
const atTestNow = TestClock.setTime(now.getTime())

const credentialLayer = staticCredentialResolverLayer(
  OAuthCredential.make({
    provider: 'fortnox',
    accessToken: 'synthetic-fortnox-access-token',
    expiresAt: 4_000_000_000_000
  })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: FortnoxConformanceSeeds = fortnoxConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(FortnoxConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = fortnoxConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: FortnoxConformanceCase) =>
  portsOver(ReplayHttpClient.layer(fixturesFor(testCase)))

/** Replay layer that also hands its ledger to the test, keyed by case id. */
const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = fortnoxConformanceFixtures
  ) =>
  (testCase: FortnoxConformanceCase) =>
    portsOver(
      Layer.unwrap(
        makeReplayHttpClient(fixturesFor(testCase, fixtures)).pipe(
          Effect.tap(({ ledger }) =>
            Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
          ),
          Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
        )
      )
    )

const ledgerOf = (ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>, caseId: string) =>
  Effect.gen(function* () {
    const ledger = (yield* Ref.get(ledgers)).get(caseId)

    if (ledger === undefined) {
      return expect.fail(`no ledger for ${caseId}`)
    }

    return { entries: yield* ledger.entries, remaining: yield* ledger.remaining }
  })

const methodsAndUrls = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.url}`)

/** `METHOD exchangeIndex` per ledger entry: which recorded exchange answered each request. */
const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched' ? `${entry.method} ${entry.match.exchangeIndex}` : 'unmatched'
  )

const bodiesOf = (entries: ReadonlyArray<ReplayLedgerEntry>, method: string) =>
  entries.flatMap(entry => (entry.method === method ? [entry.bodyJson] : []))

const synthetic = (id: string) => `${id}.synthetic`

describe('Fortnox conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(fortnoxConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual([
      ['fortnox.invoice.list-populated', 'read'],
      ['fortnox.invoice.preview-pdf', 'read'],
      ['fortnox.invoice.payment-filters-exclude-unbooked', 'read'],
      ['fortnox.invoice.row-discount-sticky', 'write-reversible'],
      ['fortnox.customer.empty-string-keeps-value', 'write-reversible'],
      ['fortnox.write.rejection-error-information', 'write-reversible'],
      ['fortnox.invoice.send-email', 'write-irreversible']
    ])
    expect(fortnoxConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      fortnoxConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of fortnoxConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of fortnoxConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const exchange of fixture.exchanges) {
          expect(Object.keys(exchange.request.headers ?? {})).not.toContain('authorization')
          expect(exchange.request.url.startsWith('https://api.fortnox.se/3/')).toBe(true)
        }
      }

      const preview = fortnoxInvoicePreviewPdfFixture.exchanges[0].response

      expect(isWireBase64BodyResponse(preview)).toBe(true)
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(fortnoxConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: fortnoxConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 7, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.status).toBe('passed')
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      expect(formatConformanceReport(report).split('\n').at(-1)).toBe(
        '7 passed, 0 failed, 0 skipped; target replay; started 2026-09-29T12:00:00.000Z'
      )
    })
  )

  it.effect('consume every recorded exchange and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(fortnoxConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(7)

      for (const testCase of fortnoxConformanceCases) {
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
          // The synthetic fixtures record exactly what the cases send.
          expect(entry.bodyJson).toEqual(exchange?.request.body)
          expect(entry.headers.authorization).toBe('<redacted>')
        })
      }
    })
  )

  it.effect('restore the invoice rows and the customer Comments (ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      yield* runConformance([fortnoxInvoiceRowDiscountCase, fortnoxCustomerEmptyStringCase], {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      const discount = yield* ledgerOf(ledgers, fortnoxInvoiceRowDiscountCase.id)
      const puts = bodiesOf(discount.entries, 'PUT')

      expect(puts).toHaveLength(4)
      // Last write restores the original rows with their explicit discounts (first row: 5).
      expect(puts[3]).toEqual({
        Invoice: {
          InvoiceRows: [
            {
              AccountNumber: 3001,
              Description: 'Consulting hours (synthetic)',
              DeliveredQuantity: '2.00',
              Unit: 'h',
              Price: 500,
              VAT: 25,
              Discount: 5,
              DiscountType: 'PERCENT'
            },
            {
              AccountNumber: 3001,
              Description: 'Travel (synthetic)',
              DeliveredQuantity: '1.00',
              Price: 250,
              VAT: 25,
              Discount: 0,
              DiscountType: 'PERCENT'
            }
          ]
        }
      })
      // The restore request differs from the explicit Discount 0 step before it.
      expect(puts[3]).not.toEqual(puts[2])
      // The restore PUT and its read-back were answered by the recorded restore exchanges (7, 8).
      expect(exchangeIndices(discount.entries)).toEqual([
        'GET 0',
        'PUT 1',
        'GET 2',
        'PUT 3',
        'GET 4',
        'PUT 5',
        'GET 6',
        'PUT 7',
        'GET 8'
      ])
      // The omitted-discount write sends the first row without Discount/DiscountType or RowId.
      expect(puts[1]).toEqual({
        Invoice: {
          InvoiceRows: [
            {
              AccountNumber: 3001,
              Description: 'Consulting hours (synthetic)',
              DeliveredQuantity: '2.00',
              Unit: 'h',
              Price: 500,
              VAT: 25
            },
            {
              AccountNumber: 3001,
              Description: 'Travel (synthetic)',
              DeliveredQuantity: '1.00',
              Price: 250,
              VAT: 25,
              Discount: 0,
              DiscountType: 'PERCENT'
            }
          ]
        }
      })

      const customer = yield* ledgerOf(ledgers, fortnoxCustomerEmptyStringCase.id)

      expect(bodiesOf(customer.entries, 'PUT')).toEqual([
        { Customer: { Comments: fortnoxConformanceCommentsMarker } },
        { Customer: { Comments: '' } },
        { Customer: { Comments: 'Synthetic note: invoice monthly by email.' } }
      ])
      expect(customer.entries.at(-1)?.method).toBe('GET')
    })
  )

  it.effect('read the email invoice recipient before sending (ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance([fortnoxInvoiceSendEmailCase], {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(1)
      expect(
        methodsAndUrls((yield* ledgerOf(ledgers, fortnoxInvoiceSendEmailCase.id)).entries)
      ).toEqual([
        'GET https://api.fortnox.se/3/invoices/104',
        'GET https://api.fortnox.se/3/invoices/104/email'
      ])
    })
  )
})

/**
 * Ports over a fake `ConnectorHttpClient` that records every `ConnectorHttpRequest` and answers it
 * with the next recorded response of `fixture`.
 */
const capturingPorts = (fixture: WireFixture, captured: Array<ConnectorHttpRequest>) => {
  const responses = fixture.exchanges.map(exchange => exchange.response)

  return Layer.mergeAll(
    Layer.succeed(ConnectorHttpClient, {
      request: request =>
        Effect.suspend(() => {
          const response = responses[captured.length]

          captured.push(request)

          return response === undefined
            ? Effect.die(`unexpected request ${request.method} ${request.url}`)
            : Effect.succeed(
                ConnectorHttpResponse.make({
                  status: response.status,
                  headers: { ...response.headers },
                  body: textBody(response)
                })
              )
        })
    }),
    Layer.succeed(ConnectorBinaryHttpClient, {
      request: () => Effect.die('the binary port is not used')
    }),
    credentialLayer,
    Layer.succeed(FortnoxConformanceConfig, fortnoxConformanceFixtureSeeds)
  )
}

describe('Fortnox conformance request transport options', () => {
  it.effect('sends the email with manual redirects and no ambient credentials', () =>
    Effect.gen(function* () {
      const captured: Array<ConnectorHttpRequest> = []

      yield* fortnoxInvoiceSendEmailCase.run.pipe(
        Effect.provide(capturingPorts(fortnoxInvoiceSendEmailFixture, captured))
      )

      expect(captured.map(request => `${request.method} ${request.url}`)).toEqual([
        'GET https://api.fortnox.se/3/invoices/104',
        'GET https://api.fortnox.se/3/invoices/104/email'
      ])

      const [read, send] = captured

      expect(send).toMatchObject({ redirect: 'manual', credentials: 'omit' })
      expect(send?.headers?.authorization).toBe('Bearer synthetic-fortnox-access-token')
      // The recipient read goes through the shared helper without the flags.
      expect(read === undefined ? [] : Object.keys(read)).not.toContain('redirect')
      expect(read === undefined ? [] : Object.keys(read)).not.toContain('credentials')
    })
  )

  it.effect('leaves connector action requests without the email transport options', () =>
    Effect.gen(function* () {
      const captured: Array<ConnectorHttpRequest> = []

      yield* fortnoxInvoiceRowDiscountCase.run.pipe(
        Effect.provide(capturingPorts(fortnoxInvoiceRowDiscountFixture, captured))
      )

      expect(captured).toHaveLength(fortnoxInvoiceRowDiscountFixture.exchanges.length)
      expect(new Set(captured.map(request => request.method))).toEqual(new Set(['GET', 'PUT']))

      for (const request of captured) {
        expect(Object.keys(request)).not.toContain('redirect')
        expect(Object.keys(request)).not.toContain('credentials')
      }
    })
  )
})

describe('Fortnox conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(fortnoxConformanceCases, { target, now, layer: replayCaseLayer })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default', () =>
    Effect.gen(function* () {
      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual([
        ['fortnox.invoice.list-populated', 'passed', null],
        ['fortnox.invoice.preview-pdf', 'passed', null],
        ['fortnox.invoice.payment-filters-exclude-unbooked', 'passed', null],
        ['fortnox.invoice.row-discount-sticky', 'skipped', 'writes-not-allowed'],
        ['fortnox.customer.empty-string-keeps-value', 'skipped', 'writes-not-allowed'],
        ['fortnox.write.rejection-error-information', 'skipped', 'writes-not-allowed'],
        ['fortnox.invoice.send-email', 'skipped', 'manual-only']
      ])
    })
  )

  it.effect('keeps the email case manual-only when reversible writes are allowed', () =>
    Effect.gen(function* () {
      expect(
        yield* statuses({ kind: 'live', account: 'synthetic', allowWrites: 'reversible' })
      ).toEqual([
        ['fortnox.invoice.list-populated', 'passed', null],
        ['fortnox.invoice.preview-pdf', 'passed', null],
        ['fortnox.invoice.payment-filters-exclude-unbooked', 'passed', null],
        ['fortnox.invoice.row-discount-sticky', 'passed', null],
        ['fortnox.customer.empty-string-keeps-value', 'passed', null],
        ['fortnox.write.rejection-error-information', 'passed', null],
        ['fortnox.invoice.send-email', 'skipped', 'manual-only']
      ])
    })
  )
})

// Disagreement drills: replay a fixture that contradicts a claim and check the case fails with a
// ConformanceMismatch (and, for write cases, still restores).

// Keeps the fixture id so the case still selects it.
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

const textBody = (response: WireResponse): string => {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

const withBody = (response: WireResponse, body: string): WireResponse => ({
  status: response.status,
  headers: response.headers,
  body
})

/** A copy of `fixture` (same id) with only the exchanges at `indices`, in that order. */
const pickExchanges = (
  fixture: WireFixture,
  indices: readonly [number, ...Array<number>]
): WireFixture => {
  const at = (index: number): WireExchange =>
    fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

  const [first, ...rest] = indices

  return { ...fixture, exchanges: [at(first), ...rest.map(at)] }
}

const jsonResponse = (response: WireResponse, status: number, body: string): WireResponse => ({
  status,
  headers: response.headers,
  body
})

/** Replace the first occurrence of `from` in a text body, failing if it is not there. */
const replaceInBody =
  (from: string, to: string) =>
  (response: WireResponse): WireResponse => {
    const body = textBody(response)

    expect(body).toContain(from)

    return withBody(response, body.replace(from, to))
  }

const replayRun = (
  testCase: FortnoxConformanceCase,
  fixture: WireFixture,
  seeds: FortnoxConformanceSeeds = fortnoxConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: caseUnderTest =>
        portsOver(
          Layer.unwrap(
            makeReplayHttpClient(fixturesFor(caseUnderTest, [fixture])).pipe(
              Effect.tap(({ ledger }) =>
                Ref.update(ledgers, current => new Map(current).set(caseUnderTest.id, ledger))
              ),
              Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
            )
          ),
          seeds
        )
    })

    return {
      report,
      failure: report.results[0]?.failure,
      ...(yield* ledgerOf(ledgers, testCase.id))
    }
  })

const drill = (
  testCase: FortnoxConformanceCase,
  fixture: WireFixture,
  seeds: FortnoxConformanceSeeds = fortnoxConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    const run = yield* replayRun(testCase, fixture, seeds)

    expect(conformanceReportFailed(run.report)).toBe(true)

    return run
  })

const discountFixture = fortnoxInvoiceRowDiscountFixture

const restorePut = discountFixture.exchanges[7]?.request.body

describe('Fortnox conformance disagreement drills', () => {
  it.effect(
    'fails the sticky-discount case when an omitted discount resets to 0, and still restores',
    () =>
      Effect.gen(function* () {
        // Failure path: after the failing read-back (4) only the restore exchanges (7, 8) remain,
        // so the ledger proves the restore requests were answered by them.
        const failurePath = replaceResponse(
          pickExchanges(discountFixture, [0, 1, 2, 3, 4, 7, 8]),
          4,
          replaceInBody('"Discount":10,', '"Discount":0,')
        )

        const { failure, entries, remaining } = yield* drill(
          fortnoxInvoiceRowDiscountCase,
          failurePath
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'ConformanceMismatch',
          message: 'expected the omitted Discount to keep its previous value (10)'
        })
        expect(exchangeIndices(entries)).toEqual([
          'GET 0',
          'PUT 1',
          'GET 2',
          'PUT 3',
          'GET 4',
          'PUT 5',
          'GET 6'
        ])
        expect(failurePath.exchanges[5]?.request.body).toEqual(restorePut)
        expect(bodiesOf(entries, 'PUT').at(-1)).toEqual(restorePut)
        expect(remaining).toEqual([])
      })
  )

  it.effect('restores after the case fiber is interrupted mid-flow, then stays interrupted', () =>
    Effect.gen(function* () {
      // The case hangs after the first write (PUT 1); the restore exchanges (7, 8) follow it.
      const fixture = pickExchanges(discountFixture, [0, 1, 7, 8])
      const { client, ledger } = yield* makeReplayHttpClient([fixture])
      const reached = yield* Deferred.make<void>()
      const answered = yield* Ref.make(0)

      const hangingClient = HttpClient.make(request =>
        Effect.gen(function* () {
          const response = yield* client.execute(request)
          const count = yield* Ref.updateAndGet(answered, current => current + 1)

          if (count === 2) {
            yield* Deferred.succeed(reached, undefined)

            return yield* Effect.never
          }

          return response
        })
      )

      const fiber = yield* fortnoxInvoiceRowDiscountCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, hangingClient))),
        Effect.forkChild
      )

      yield* Deferred.await(reached)
      yield* Fiber.interrupt(fiber)

      const exit = yield* Fiber.await(fiber)
      const entries = yield* ledger.entries

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(entries)).toEqual(['GET 0', 'PUT 1', 'PUT 2', 'GET 3'])
      expect(bodiesOf(entries, 'PUT').at(-1)).toEqual(restorePut)
      expect(yield* ledger.remaining).toEqual([])
    })
  )

  it.effect(
    'reports only the rejected first write, with no restore by hand, when nothing changed',
    () =>
      Effect.gen(function* () {
        const failurePath = replaceResponse(
          pickExchanges(discountFixture, [0, 1, 7, 8]),
          1,
          response =>
            jsonResponse(
              response,
              400,
              '{"ErrorInformation":{"error":1,"message":"Synthetic placeholder: invalid row.","code":2000359}}'
            )
        )

        const { failure, entries } = yield* drill(fortnoxInvoiceRowDiscountCase, failurePath)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'FortnoxConformanceActionFailed',
          message: 'fortnox.update_invoice failed: fortnox_request_failed (HTTP 400)'
        })
        expect(exchangeIndices(entries)).toEqual(['GET 0', 'PUT 1', 'PUT 2', 'GET 3'])
      })
  )

  it.effect('aborts the sticky-discount case before any write without explicit discounts', () =>
    Effect.gen(function* () {
      for (const [from, to] of [
        ['"Discount":5,', '"Discount":null,'],
        ['"Discount":5,', ''],
        ['"DiscountType":"PERCENT"', '"DiscountType":null']
      ] as const) {
        const tampered = replaceResponse(discountFixture, 0, replaceInBody(from, to))
        const { failure, entries } = yield* drill(fortnoxInvoiceRowDiscountCase, tampered)

        expect(failure?.message).toBe(
          'precondition: every discount invoice row needs an explicit Discount and DiscountType PERCENT, so the restore can write them back exactly; nothing was written'
        )
        expect(methodsAndUrls(entries)).toEqual(['GET https://api.fortnox.se/3/invoices/103'])
      }
    })
  )

  it.effect('fails the payment-filter case when the unbooked invoice is in the unpaid list', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const unbookedList = fortnoxInvoicePaymentFiltersFixture.exchanges[0].response

      const tampered = replaceResponse(fortnoxInvoicePaymentFiltersFixture, 1, () => unbookedList)

      const { failure } = yield* drill(fortnoxInvoicePaymentFiltersCase, tampered)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected the unbooked invoice to be absent from filter=unpaid'
      })
    })
  )

  it.effect(
    'fails the payment-filter case when the overdue unbooked invoice is unpaidoverdue',
    () =>
      Effect.gen(function* () {
        yield* atTestNow

        const unbookedList = fortnoxInvoicePaymentFiltersFixture.exchanges[0].response

        const tampered = replaceResponse(fortnoxInvoicePaymentFiltersFixture, 2, () => unbookedList)

        const { failure } = yield* drill(fortnoxInvoicePaymentFiltersCase, tampered)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'ConformanceMismatch',
          message: 'expected the overdue unbooked invoice to be absent from filter=unpaidoverdue'
        })
      })
  )

  it.effect('aborts the payment-filter case unless the unbooked invoice is overdue today', () =>
    Effect.gen(function* () {
      // On its due date (2026-09-15) the synthetic invoice is not overdue yet.
      yield* TestClock.setTime(Date.parse('2026-09-15T12:00:00.000Z'))

      const { failure, entries } = yield* drill(
        fortnoxInvoicePaymentFiltersCase,
        fortnoxInvoicePaymentFiltersFixture
      )

      expect(failure?.message).toBe(
        'precondition: the practice company needs an unbooked, uncancelled invoice with a positive balance and a DueDate before today (2026-09-15)'
      )
      expect(methodsAndUrls(entries)).toEqual([
        'GET https://api.fortnox.se/3/invoices?filter=unbooked&limit=500&page=1'
      ])
    })
  )

  it.effect(
    'aborts the payment-filter case without an unbooked invoice with a positive balance',
    () =>
      Effect.gen(function* () {
        yield* atTestNow

        const tampered = replaceResponse(
          fortnoxInvoicePaymentFiltersFixture,
          0,
          replaceInBody('"Balance":1250,', '"Balance":0,')
        )

        const { failure } = yield* drill(fortnoxInvoicePaymentFiltersCase, tampered)

        expect(failure?.message).toBe(
          'precondition: the practice company needs an unbooked, uncancelled invoice with a positive balance'
        )
      })
  )

  it.effect('fails the empty-string case when "" clears the field, and still restores', () =>
    Effect.gen(function* () {
      // Exchange 4 is the read-back after the empty-string update.
      const tampered = replaceResponse(fortnoxCustomerEmptyStringFixture, 4, response =>
        withBody(
          response,
          textBody(response).replace(
            `"Comments":"${fortnoxConformanceCommentsMarker}"`,
            '"Comments":""'
          )
        )
      )

      const { failure, entries } = yield* drill(fortnoxCustomerEmptyStringCase, tampered)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected an empty-string Comments update to keep the stored value'
      })
      expect(bodiesOf(entries, 'PUT').at(-1)).toEqual({
        Customer: { Comments: 'Synthetic note: invoice monthly by email.' }
      })
    })
  )

  it.effect('fails the rejection case when the error body has no ErrorInformation', () =>
    Effect.gen(function* () {
      const tampered = replaceResponse(fortnoxWriteRejectionFixture, 1, response =>
        withBody(response, '{"message":"Bad Request"}')
      )

      const { failure } = yield* drill(fortnoxWriteRejectionCase, tampered)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected an ErrorInformation provider code (underlying.providerCode)'
      })
    })
  )

  it.effect('aborts the rejection case before writing when the customer exists', () =>
    Effect.gen(function* () {
      const tampered = replaceResponse(fortnoxWriteRejectionFixture, 0, response => ({
        status: 200,
        headers: response.headers,
        body: '{"Customer":{"CustomerNumber":"99999","Name":"Example Customer AB"}}'
      }))

      const { failure, entries } = yield* drill(fortnoxWriteRejectionCase, tampered)

      expect(failure?.message).toBe(
        'precondition: missingCustomerNumber exists in the practice company; nothing was written'
      )
      expect(methodsAndUrls(entries)).toEqual(['GET https://api.fortnox.se/3/customers/99999'])
    })
  )

  it.effect('treats a 4xx customer-not-found ErrorInformation code as absent', () =>
    Effect.gen(function* () {
      for (const code of ['2000433', '"2000204"']) {
        const tampered = replaceResponse(fortnoxWriteRejectionFixture, 0, response =>
          jsonResponse(
            response,
            400,
            `{"ErrorInformation":{"Error":1,"Message":"Synthetic placeholder: customer not found.","Code":${code}}}`
          )
        )

        const { report, entries } = yield* replayRun(fortnoxWriteRejectionCase, tampered)

        expect(conformanceReportFailed(report)).toBe(false)
        expect(methodsAndUrls(entries)).toEqual([
          'GET https://api.fortnox.se/3/customers/99999',
          'POST https://api.fortnox.se/3/invoices'
        ])
      }
    })
  )

  it.effect('aborts the rejection case before writing unless the lookup proves absence', () =>
    Effect.gen(function* () {
      const notFound =
        '{"ErrorInformation":{"error":1,"message":"Synthetic placeholder: customer not found.","code":2000204}}'

      for (const [status, body] of [
        [401, notFound],
        [403, notFound],
        [400, '{"ErrorInformation":{"error":1,"message":"Synthetic placeholder.","code":2000359}}'],
        [400, '{"message":"Bad Request"}'],
        [500, notFound]
      ] as const) {
        const tampered = replaceResponse(fortnoxWriteRejectionFixture, 0, response =>
          jsonResponse(response, status, body)
        )

        const { failure, entries } = yield* drill(fortnoxWriteRejectionCase, tampered)

        expect(failure?.message).toBe(
          'precondition: could not confirm that missingCustomerNumber is absent (expected 404, or a 4xx with a customer-not-found ErrorInformation code); nothing was written'
        )
        expect(methodsAndUrls(entries)).toEqual(['GET https://api.fortnox.se/3/customers/99999'])
      }
    })
  )

  it.effect('aborts the email case before sending unless the recipient is the seed', () =>
    Effect.gen(function* () {
      for (const [from, to, message] of [
        [
          '"EmailAddressTo":"billing@example.test"',
          '"EmailAddressTo":"Billing@example.test"',
          'precondition: the email invoice EmailInformation.EmailAddressTo does not equal FortnoxConformanceConfig.emailRecipient exactly; nothing was sent'
        ],
        [
          '"EmailAddressTo":"billing@example.test",',
          '',
          'precondition: the email invoice EmailInformation.EmailAddressTo does not equal FortnoxConformanceConfig.emailRecipient exactly; nothing was sent'
        ],
        [
          '"EmailAddressCC":""',
          '"EmailAddressCC":"copy@example.test"',
          'precondition: the email invoice has an EmailAddressCC or EmailAddressBCC; clear them so only emailRecipient is addressed; nothing was sent'
        ],
        [
          '"EmailAddressBCC":""',
          '"EmailAddressBCC":"hidden@example.test"',
          'precondition: the email invoice has an EmailAddressCC or EmailAddressBCC; clear them so only emailRecipient is addressed; nothing was sent'
        ]
      ] as const) {
        const tampered = replaceResponse(fortnoxInvoiceSendEmailFixture, 0, replaceInBody(from, to))

        const { failure, entries } = yield* drill(fortnoxInvoiceSendEmailCase, tampered)

        expect(failure?.message).toBe(message)
        expect(failure?.message).not.toContain('example.test')
        expect(methodsAndUrls(entries)).toEqual(['GET https://api.fortnox.se/3/invoices/104'])
      }
    })
  )

  it.effect('fails the email case on a redirect instead of treating it as sent', () =>
    Effect.gen(function* () {
      for (const status of [301, 302, 303, 307, 308]) {
        const redirected = replaceResponse(fortnoxInvoiceSendEmailFixture, 1, response => ({
          status,
          headers: { ...response.headers, location: 'https://api.fortnox.se/3/invoices/104' },
          body: ''
        }))

        const { failure, entries, remaining } = yield* drill(
          fortnoxInvoiceSendEmailCase,
          redirected
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'ConformanceMismatch',
          message: 'expected no redirect from the email send; a 3xx is not treated as sent'
        })
        // The Location is never requested.
        expect(methodsAndUrls(entries)).toEqual([
          'GET https://api.fortnox.se/3/invoices/104',
          'GET https://api.fortnox.se/3/invoices/104/email'
        ])
        expect(remaining).toEqual([])
      }
    })
  )

  it.effect('aborts the email case before any request without an emailRecipient seed', () =>
    Effect.gen(function* () {
      const { emailRecipient: _omitted, ...seeds } = fortnoxConformanceFixtureSeeds

      const { failure, entries } = yield* drill(
        fortnoxInvoiceSendEmailCase,
        fortnoxInvoiceSendEmailFixture,
        seeds
      )

      expect(failure?.message).toBe(
        'precondition: FortnoxConformanceConfig.emailRecipient is not configured'
      )
      expect(entries).toEqual([])
    })
  )

  it.effect('reports a failed restore instead of swallowing it', () =>
    Effect.gen(function* () {
      // Exchange 8 verifies the restore: each tampering leaves a written field or a total unrestored.
      for (const [from, to, reason] of [
        [
          '"Discount":5,',
          '"Discount":0,',
          'expected the original invoice rows back after restoring'
        ],
        [
          '"AccountNumber":3001,',
          '"AccountNumber":3010,',
          'expected the original invoice rows back after restoring'
        ],
        [
          '"VATCode":"MP1"',
          '"VATCode":"MP2"',
          'expected the original invoice rows back after restoring'
        ],
        ['"Unit":"h"', '"Unit":null', 'expected the original invoice rows back after restoring'],
        [
          '"Total":1500,"TotalToPay"',
          '"Total":1501,"TotalToPay"',
          'expected the original invoice totals back after restoring'
        ],
        [
          '"Gross":1200,',
          '"Gross":1250,',
          'expected the original invoice totals back after restoring'
        ]
      ] as const) {
        const tampered = replaceResponse(discountFixture, 8, replaceInBody(from, to))

        const { failure, entries } = yield* drill(fortnoxInvoiceRowDiscountCase, tampered)

        expect(failure?.tag).toBe('FortnoxConformanceRestoreFailed')
        expect(failure?.message).toBe(
          `fortnox.invoice.row-discount-sticky: restore failed; restore the account by hand if it still differs from its original state. Restore error: ${reason}. Claim held first.`
        )
        expect(exchangeIndices(entries).slice(-2)).toEqual(['PUT 7', 'GET 8'])
      }
    })
  )

  it.effect('summarizes the failed claim when the restore also fails', () =>
    Effect.gen(function* () {
      // Full fixture: after the failing read-back (4) the restore is answered by the Discount 0
      // exchanges (5, 6), so its read-back does not show the original rows.
      const tampered = replaceResponse(
        discountFixture,
        4,
        replaceInBody('"Discount":10,', '"Discount":0,')
      )

      const { failure } = yield* drill(fortnoxInvoiceRowDiscountCase, tampered)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'FortnoxConformanceRestoreFailed',
        message:
          'fortnox.invoice.row-discount-sticky: restore failed; restore the account by hand if it still differs from its original state. Restore error: expected the original invoice rows back after restoring. Claim failed first: expected the omitted Discount to keep its previous value...'
      })
    })
  )

  it.effect(
    'keeps the restore-by-hand advice within the report cap for a long restore failure',
    () =>
      Effect.gen(function* () {
        // The claim fails (4: "" cleared Comments), then the restore PUT (5) is rejected with a
        // long provider message: both summaries are capped, and the advice comes first.
        const tampered = replaceResponse(
          replaceResponse(fortnoxCustomerEmptyStringFixture, 4, response =>
            withBody(
              response,
              textBody(response).replace(
                `"Comments":"${fortnoxConformanceCommentsMarker}"`,
                '"Comments":""'
              )
            )
          ),
          5,
          response =>
            jsonResponse(
              response,
              400,
              `{"ErrorInformation":{"error":1,"message":"${'Synthetic placeholder: rejected. '.repeat(8)}","code":2000359}}`
            )
        )

        const { failure } = yield* drill(fortnoxCustomerEmptyStringCase, tampered)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'FortnoxConformanceRestoreFailed',
          message:
            'fortnox.customer.empty-string-keeps-value: restore failed; restore the account by hand if it still differs from its original state. Restore error: FortnoxConformanceActionFailed: fortnox.update_customer f... Claim failed first: expected an empty-string Comments update to keep the stor...'
        })
      })
  )

  it.effect(
    'fits a restore failure with the longest case id and maximal summaries in the report',
    () =>
      Effect.gen(function* () {
        const caseId = fortnoxConformanceCases
          .map(testCase => testCase.id)
          .reduce((longest, id) => (id.length > longest.length ? id : longest))

        // A summary at its cap (60 characters, ending in "..."), and an untruncated 60-character
        // restore error without a final period, which gains one (61): the true worst case.
        const summary = `${'Synthetic failure summary; '.repeat(3).slice(0, 57)}...`
        const restoreError = 'Synthetic restore error without a final period, sixty chars!'

        expect(summary).toHaveLength(60)
        expect(restoreError).toHaveLength(60)

        const failing = defineConformanceCase({
          id: caseId,
          safety: 'read',
          docs: 'Synthetic.',
          wire: 'Synthetic.',
          fixtures: [],
          run: Effect.fail(
            new FortnoxConformanceRestoreFailed({
              caseId,
              reason: restoreError,
              caseOutcome: 'claim failed',
              claimFailure: summary
            })
          )
        })

        const report = yield* runConformance([failing], {
          target: { kind: 'replay' },
          now,
          layer: () => Layer.empty
        })

        const message = report.results[0]?.failure?.message ?? expect.fail('expected a failure')

        expect(message).toBe(
          `${caseId}: restore failed; restore the account by hand if it still differs from its original state. Restore error: ${restoreError}. Claim failed first: ${summary}`
        )
        expect(message.length).toBeLessThanOrEqual(300)
      })
  )

  it.effect('fails with a precondition before any request when a seed is missing', () =>
    Effect.gen(function* () {
      const { discountInvoiceDocumentNumber: _omitted, ...seeds } = fortnoxConformanceFixtureSeeds

      const { failure, entries } = yield* drill(
        fortnoxInvoiceRowDiscountCase,
        discountFixture,
        seeds
      )

      expect(failure?.message).toBe(
        'precondition: FortnoxConformanceConfig.discountInvoiceDocumentNumber is not configured'
      )
      expect(entries).toEqual([])
    })
  )
})

// Interruption drills: a failed restore raised while the case is being interrupted still reaches
// the owner through the ConformanceCleanupReporter, with the full message naming the case.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

/** The restore read-back (exchange 8 in the full fixture) no longer shows the original rows. */
const unrestoredRows = replaceInBody('"Discount":5,', '"Discount":0,')

const restoreFailedAdvice =
  'fortnox.invoice.row-discount-sticky: restore failed; restore the account by hand if it still differs from its original state. Restore error: expected the original invoice rows back after restoring.'

const interruptionMoments = [
  {
    moment: 'during the claim',
    // The claim's first write (PUT 1) is held; only the restore exchanges (7, 8) follow it.
    fixture: replaceResponse(pickExchanges(discountFixture, [0, 1, 7, 8]), 3, unrestoredRows),
    heldPut: 1,
    message: `${restoreFailedAdvice} Claim failed first: interrupted`
  },
  {
    moment: 'during the restore',
    // The claim holds; the restore's write (the fourth PUT, exchange 7) is held.
    fixture: replaceResponse(discountFixture, 8, unrestoredRows),
    heldPut: 4,
    message: `${restoreFailedAdvice} Claim held first.`
  }
] as const

/** `client`, with the `heldPut`-th PUT response held until `release` (and `sent` signalled). */
const holdingPut = (
  client: HttpClient.HttpClient,
  heldPut: number,
  sent: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    const puts = yield* Ref.make(0)

    return HttpClient.transform(client, (response, request) =>
      request.method === 'PUT'
        ? Ref.updateAndGet(puts, n => n + 1).pipe(
            Effect.flatMap(n =>
              n === heldPut
                ? response.pipe(
                    Effect.tap(() => Deferred.succeed(sent, undefined)),
                    Effect.tap(() => Deferred.await(release))
                  )
                : response
            )
          )
        : response
    )
  })

describe('Fortnox conformance interruption reporting', () => {
  for (const { moment, fixture, heldPut, message } of interruptionMoments) {
    it.effect(`reports a failed restore when interrupted ${moment}`, () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const { warnings, reporter } = yield* capturingReporter

        const { client } = yield* makeReplayHttpClient([fixture])
        const holding = yield* holdingPut(client, heldPut, sent, release)

        const fiber = yield* fortnoxInvoiceRowDiscountCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.forkChild
        )

        yield* Deferred.await(sent)

        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        yield* Fiber.await(fiber)

        // Whatever the fiber's exit, the owner sees the failed restore and what to do by hand.
        expect(yield* Ref.get(warnings)).toEqual([message])
      })
    )
  }

  it.effect(
    'reports nothing extra when an uninterrupted restore fails (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const { client } = yield* makeReplayHttpClient([
          replaceResponse(discountFixture, 8, unrestoredRows)
        ])

        const exit = yield* fortnoxInvoiceRowDiscountCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the failed restore to fail the case')
        }

        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'FortnoxConformanceRestoreFailed' })
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})

// Run-level interruption drill: runConformance over [a write case whose restore fails, a sentinel].
// Interrupting the case must stop the run: the sentinel never starts.

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

describe('Fortnox conformance run interruption', () => {
  for (const { moment, fixture, heldPut, message } of interruptionMoments) {
    it.effect(`stops the whole run when interrupted ${moment} with a failing restore`, () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sentinelRan = yield* Ref.make(false)
        const { warnings, reporter } = yield* capturingReporter

        const { client } = yield* makeReplayHttpClient([fixture])
        const holding = yield* holdingPut(client, heldPut, sent, release)

        const fiber = yield* runConformance(
          [fortnoxInvoiceRowDiscountCase, sentinelCase(sentinelRan)],
          {
            target: { kind: 'replay' },
            now,
            layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
          }
        ).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

        yield* Deferred.await(sent)

        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)

        const exit = yield* Fiber.await(fiber)

        expect(yield* Ref.get(sentinelRan)).toBe(false)

        // As for Dropbox: the run ends with the case's own RestoreFailed, and no Interrupt in the
        // cause, so it produces no report and resumes no case.
        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to fail')
        }

        expect(Cause.hasInterrupts(exit.cause)).toBe(false)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'FortnoxConformanceRestoreFailed' })
        expect(yield* Ref.get(warnings)).toEqual([message])
      })
    )
  }

  it.effect(
    'ends interrupt-only, without a report or a later case, when the restore succeeds',
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sentinelRan = yield* Ref.make(false)
        const { warnings, reporter } = yield* capturingReporter

        const { client, ledger } = yield* makeReplayHttpClient([
          pickExchanges(discountFixture, [0, 1, 7, 8])
        ])

        const holding = yield* holdingPut(client, 1, sent, release)

        const fiber = yield* runConformance(
          [fortnoxInvoiceRowDiscountCase, sentinelCase(sentinelRan)],
          {
            target: { kind: 'replay' },
            now,
            layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
          }
        ).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

        yield* Deferred.await(sent)

        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)

        const exit = yield* Fiber.await(fiber)

        expect(yield* Ref.get(sentinelRan)).toBe(false)

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to be interrupted')
        }

        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
        expect(yield* ledger.remaining).toEqual([])
      })
  )
})
