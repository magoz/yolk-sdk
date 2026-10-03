/**
 * Cross-checks: the Fortnox emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the REAL Fortnox connector actions, both in-process and over a
 * loopback socket; and each drill knob must make exactly its case fail. Tests may import SDK
 * packages; the emulator source never does.
 */
import { Effect, Layer, Predicate } from 'effect'
import { TestClock } from 'effect/testing'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { fortnoxApiBaseUrl } from '@yolk-sdk/connectors/fortnox'
import {
  FortnoxConformanceConfig,
  fortnoxConformanceCases,
  fortnoxConformanceCommentsMarker,
  fortnoxConformanceFixtureSeeds
} from '@yolk-sdk/connectors/fortnox/conformance'
import {
  makeFortnoxEmulator,
  type FortnoxEmulator,
  type FortnoxEmulatorQuirks,
  type FortnoxEmulatorState,
  type FortnoxLedgerEntry
} from '../src/fortnox.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const fortnoxOrigin = new URL(fortnoxApiBaseUrl).origin

/** The payment-filter case reads "today" from the Effect Clock; the overdue invoice is due 2026-09-15. */
const now = new Date('2026-09-29T12:00:00.000Z')

const credentialLayer = staticCredentialResolverLayer(
  OAuthCredential.make({
    provider: 'fortnox',
    accessToken: 'synthetic-fortnox-access-token',
    expiresAt: 4_000_000_000_000
  })
)

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(FortnoxConformanceConfig, fortnoxConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: FortnoxEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(fortnoxOrigin, emulator.fetch)])

/** Real `FetchHttpClient` underneath, routed to the emulator served on 127.0.0.1:0. */
const emulatedLayer = (emulator: FortnoxEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(fortnoxOrigin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

type Emulators = ReadonlyMap<string, FortnoxEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  quirks: FortnoxEmulatorQuirks,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, FortnoxEmulator>()

      for (const testCase of fortnoxConformanceCases) {
        emulators.set(testCase.id, await makeFortnoxEmulator({ now: () => now.getTime(), quirks }))
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const emulatorFor = (emulators: Emulators, caseId: string): FortnoxEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: FortnoxEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now.getTime())

    return yield* runConformance(fortnoxConformanceCases, {
      target,
      now,
      layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
    })
  })

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: 7,
    failed: 0,
    skipped: 0
  })

  for (const result of report.results) {
    expect(result.status, result.id).toBe('passed')
  }
}

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

/** The first sent row's `Discount` in a ledgered `PUT /3/invoices/{n}` body. */
const firstRowDiscount = (body: unknown): unknown => {
  const rows = field(field(body, 'Invoice'), 'InvoiceRows')

  return Array.isArray(rows) ? (field(rows[0], 'Discount') ?? 'omitted') : 'no rows'
}

const requests = (entries: ReadonlyArray<FortnoxLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.path} ${entry.status}`)

/** The state without RowIds and the RowId counter, which every row update regenerates. */
const withoutRowIds = (state: FortnoxEmulatorState) => ({
  ...state,
  counters: { nextDocumentNumber: state.counters.nextDocumentNumber },
  invoices: state.invoices.map(invoice => ({
    ...invoice,
    InvoiceRows: invoice.InvoiceRows.map(({ RowId: _rowId, ...row }) => row)
  }))
})

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means per case: the read and rejection cases leave the exact seed;
  // the empty-string case restores what it wrote and ends exactly at the seed; the row-discount
  // case restores what it wrote and differs from the seed only in the RowIds and the RowId
  // counter, which Fortnox regenerates by design (the test proves they changed); the email case
  // is irreversible by definition and leaves exactly `Sent` plus one outbox entry. Customers and
  // company information end exactly at the seed in every case.
  it.effect(
    'passes every Fortnox case; the row-discount case differs from the seed only in RowIds and the RowId counter; the empty-string case ends exactly at the seed; email leaves Sent and one outbox entry',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'in-process' })

          const seedOf = (id: string) => seeds.get(id)
          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          // Read cases change nothing.
          for (const id of [
            'fortnox.invoice.list-populated',
            'fortnox.invoice.preview-pdf',
            'fortnox.invoice.payment-filters-exclude-unbooked'
          ]) {
            expect(stateOf(id), id).toEqual(seedOf(id))
            expect(
              ledgerOf(id).every(entry => entry.method === 'GET' && entry.status === 200),
              id
            ).toBe(true)
          }

          // Row discount: set 10, omit, set 0, then the restore (Discount 5 again) and its read.
          const discountId = 'fortnox.invoice.row-discount-sticky'
          const discountLedger = ledgerOf(discountId)

          expect(requests(discountLedger)).toEqual([
            'GET /3/invoices/103 200',
            ...Array.from({ length: 4 }, () => [
              'PUT /3/invoices/103 200',
              'GET /3/invoices/103 200'
            ]).flat()
          ])
          expect(
            discountLedger
              .filter(entry => entry.method === 'PUT')
              .map(entry => firstRowDiscount(entry.body))
          ).toEqual([10, 'omitted', 0, 5])

          // Reversible: equal to the seed except the regenerated RowIds and RowId counter, which
          // Fortnox regenerates by design (proof below that they changed).
          const discountState = stateOf(discountId)
          const discountSeed = seedOf(discountId)

          expect(discountSeed).toBeDefined()

          if (discountSeed !== undefined) {
            expect(withoutRowIds(discountState)).toEqual(withoutRowIds(discountSeed))
            expect(discountState).not.toEqual(discountSeed)
            expect(
              discountState.invoices
                .find(invoice => invoice.DocumentNumber === '103')
                ?.InvoiceRows.map(row => row.RowId)
            ).not.toEqual([1, 2])
            expect(discountState.counters.nextRowId).toBeGreaterThan(
              discountSeed.counters.nextRowId
            )
          }

          // Empty string: marker, "", then the restore of the original Comments; exact seed.
          const emptyStringId = 'fortnox.customer.empty-string-keeps-value'
          const customerPuts = ledgerOf(emptyStringId).filter(entry => entry.method === 'PUT')

          expect(customerPuts.map(entry => entry.body)).toEqual([
            { Customer: { Comments: fortnoxConformanceCommentsMarker } },
            { Customer: { Comments: '' } },
            { Customer: { Comments: 'Synthetic note: invoice monthly by email.' } }
          ])
          expect(stateOf(emptyStringId)).toEqual(seedOf(emptyStringId))

          // Rejection: absence confirmed (404), the create rejected (400), nothing written.
          const rejectionId = 'fortnox.write.rejection-error-information'

          expect(requests(ledgerOf(rejectionId))).toEqual([
            'GET /3/customers/99999 404',
            'POST /3/invoices 400'
          ])
          expect(stateOf(rejectionId)).toEqual(seedOf(rejectionId))

          // Email (irreversible by definition; runs because the target is not live): exactly Sent
          // on invoice 104 and one outbox entry, nothing else.
          const emailId = 'fortnox.invoice.send-email'
          const emailState = stateOf(emailId)

          expect(requests(ledgerOf(emailId))).toEqual([
            'GET /3/invoices/104 200',
            'GET /3/invoices/104/email 200'
          ])
          expect(emailState.invoices.find(invoice => invoice.DocumentNumber === '104')?.Sent).toBe(
            true
          )
          expect(emailState.outbox).toEqual([
            {
              DocumentNumber: '104',
              EmailAddressTo: 'billing@example.test',
              EmailAddressCC: '',
              EmailAddressBCC: '',
              EmailSubject: 'Invoice 104 from Example AB',
              sentAt: now.toISOString()
            }
          ])

          const emailSeed = seedOf(emailId)

          expect(emailSeed).toBeDefined()

          if (emailSeed !== undefined) {
            expect(emailState).toEqual({
              ...emailSeed,
              invoices: emailSeed.invoices.map(invoice =>
                invoice.DocumentNumber === '104' ? { ...invoice, Sent: true } : invoice
              ),
              outbox: emailState.outbox
            })
          }

          // Every part of each emulator's state other than invoices, counters, and the outbox
          // (customers and company information) ends exactly at its seed.
          for (const [id, emulator] of emulators) {
            const { customers, company } = emulator.snapshot()

            expect({ customers, company }, id).toEqual({
              customers: seedOf(id)?.customers,
              company: seedOf(id)?.company
            })
          }

          // No credential ever reaches the ledger.
          for (const emulator of emulators.values()) {
            expect(JSON.stringify(emulator.ledger.entries())).not.toContain(
              'synthetic-fortnox-access-token'
            )
          }
        })
      )
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect('passes every Fortnox case through FetchHttpClient and EmulatedHttpClient', () =>
    withEmulators({}, emulators =>
      Effect.gen(function* () {
        const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

        expectAllPassed(report)
        expect(report.target).toEqual({ kind: 'emulated' })

        for (const testCase of fortnoxConformanceCases) {
          const entries = emulatorFor(emulators, testCase.id).ledger.entries()

          expect(entries.length, testCase.id).toBeGreaterThan(0)
          expect(
            entries.every(entry => entry.evidence === 'unverified'),
            testCase.id
          ).toBe(true)
        }
      })
    )
  )
})

const drill = (quirks: FortnoxEmulatorQuirks) =>
  withEmulators(quirks, emulators => runAll(emulators, { kind: 'in-process' }, inProcessLayer))

const expectOnlyFailure = (report: ConformanceReport, caseId: string, message: string) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: 6,
    failed: 1,
    skipped: 0
  })

  const failed = report.results.find(result => result.status === 'failed')

  expect(failed?.id).toBe(caseId)
  expect(failed?.failure?.tag).toBe('ConformanceMismatch')
  expect(failed?.failure?.message).toContain(message)
}

describe('disagreement drill (quirk knobs)', () => {
  it.effect('stickyRowDiscount: false fails only the row-discount case', () =>
    Effect.gen(function* () {
      expectOnlyFailure(
        yield* drill({ stickyRowDiscount: false }),
        'fortnox.invoice.row-discount-sticky',
        'expected the omitted Discount to keep its previous value (10)'
      )
    })
  )

  it.effect('emptyStringClears: true fails only the empty-string case', () =>
    Effect.gen(function* () {
      expectOnlyFailure(
        yield* drill({ emptyStringClears: true }),
        'fortnox.customer.empty-string-keeps-value',
        'expected an empty-string Comments update to keep the stored value'
      )
    })
  )

  it.effect('paymentFiltersIncludeUnbooked: true fails only the payment-filter case', () =>
    Effect.gen(function* () {
      expectOnlyFailure(
        yield* drill({ paymentFiltersIncludeUnbooked: true }),
        'fortnox.invoice.payment-filters-exclude-unbooked',
        'expected the unbooked invoice to be absent from filter=unpaid'
      )
    })
  )
})
