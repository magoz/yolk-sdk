import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import type { ConformanceCase } from '@yolk-sdk/conformance/case'
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
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  FortnoxConformanceConfig,
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
  fortnoxWriteRejectionCase,
  fortnoxWriteRejectionFixture,
  type FortnoxConformanceCase,
  type FortnoxConformanceSeeds
} from '@yolk-sdk/connectors/fortnox/conformance'

const now = new Date('2026-09-29T12:00:00.000Z')

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
      // Last write restores the original rows with explicit discounts.
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
              Discount: 0,
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
      expect(discount.entries.at(-1)?.method).toBe('GET')

      const customer = yield* ledgerOf(ledgers, fortnoxCustomerEmptyStringCase.id)

      expect(bodiesOf(customer.entries, 'PUT')).toEqual([
        { Customer: { Comments: fortnoxConformanceCommentsMarker } },
        { Customer: { Comments: '' } },
        { Customer: { Comments: 'Synthetic note: invoice monthly by email.' } }
      ])
      expect(customer.entries.at(-1)?.method).toBe('GET')
    })
  )
})

describe('Fortnox conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    runConformance(fortnoxConformanceCases, { target, now, layer: replayCaseLayer }).pipe(
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

const drill = (testCase: FortnoxConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: ledgerCaseLayer(ledgers, [fixture])
    })

    expect(conformanceReportFailed(report)).toBe(true)

    return { failure: report.results[0]?.failure, ...(yield* ledgerOf(ledgers, testCase.id)) }
  })

describe('Fortnox conformance disagreement drills', () => {
  it.effect(
    'fails the sticky-discount case when an omitted discount resets to 0, and still restores',
    () =>
      Effect.gen(function* () {
        // Exchange 4 is the read-back after the update that omitted the first row's Discount.
        const tampered = replaceResponse(fortnoxInvoiceRowDiscountFixture, 4, response =>
          withBody(response, textBody(response).replace('"Discount":10,', '"Discount":0,'))
        )

        const { failure, entries } = yield* drill(fortnoxInvoiceRowDiscountCase, tampered)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'ConformanceMismatch',
          message: 'expected the omitted Discount to keep its previous value (10)'
        })

        // Restore-on-failure: after the failed middle assertion the original rows are still sent,
        // then read back.
        expect(methodsAndUrls(entries).slice(-2)).toEqual([
          'PUT https://api.fortnox.se/3/invoices/103',
          'GET https://api.fortnox.se/3/invoices/103'
        ])
        expect(bodiesOf(entries, 'PUT').at(-1)).toEqual(
          fortnoxInvoiceRowDiscountFixture.exchanges[7]?.request.body
        )
        expect(bodiesOf(entries, 'PUT')).toHaveLength(3)
      })
  )

  it.effect('fails the payment-filter case when the unbooked invoice is in the unpaid list', () =>
    Effect.gen(function* () {
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

  it.effect('reports a failed restore instead of swallowing it', () =>
    Effect.gen(function* () {
      // Exchange 8 verifies the restore; pretend the discount did not come back.
      const tampered = replaceResponse(fortnoxInvoiceRowDiscountFixture, 8, response =>
        withBody(response, textBody(response).replace('"Discount":0,', '"Discount":10,'))
      )

      const { failure } = yield* drill(fortnoxInvoiceRowDiscountCase, tampered)

      expect(failure?.tag).toBe('FortnoxConformanceRestoreFailed')
      expect(failure?.message).toContain('claim held before the restore')
      expect(failure?.message).toContain('expected the original invoice rows back after restoring')
    })
  )

  it.effect('fails with a precondition before any request when a seed is missing', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())
      const { discountInvoiceDocumentNumber: _omitted, ...seeds } = fortnoxConformanceFixtureSeeds

      const report = yield* runConformance([fortnoxInvoiceRowDiscountCase], {
        target: { kind: 'replay' },
        now,
        layer: testCase =>
          portsOver(
            Layer.unwrap(
              makeReplayHttpClient(fixturesFor(testCase)).pipe(
                Effect.tap(({ ledger }) =>
                  Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
                ),
                Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
              )
            ),
            seeds
          )
      })

      expect(report.results[0]?.failure?.message).toBe(
        'precondition: FortnoxConformanceConfig.discountInvoiceDocumentNumber is not configured'
      )
      expect((yield* ledgerOf(ledgers, fortnoxInvoiceRowDiscountCase.id)).entries).toEqual([])
    })
  )
})
