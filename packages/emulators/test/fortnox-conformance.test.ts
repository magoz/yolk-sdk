/**
 * Cross-checks: the Fortnox emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the REAL Fortnox connector actions, both in-process and over a
 * loopback socket; each drill knob must make exactly its case fail, and so must each read case's
 * disagreement drill (a 200 fault answering one route with a body that breaks the case's claim);
 * and the default emulator must answer every read case fixture request with the recorded answer,
 * byte for byte. Tests may import SDK packages; the emulator source never does.
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
import { isWireBase64BodyResponse, isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import {
  FortnoxConformanceConfig,
  fortnoxAccountBalancesListGetFixture,
  fortnoxArticleListRowNumbersFixture,
  fortnoxCompanyInformationFixture,
  fortnoxConformanceCases,
  fortnoxConformanceCommentsMarker,
  fortnoxConformanceFixtureSeeds,
  fortnoxCostCenterListMatchesGetFixture,
  fortnoxCustomerListMatchesGetFixture,
  fortnoxFinancialYearByIdAndDateFixture,
  fortnoxInboxFolderFileBytesFixture,
  fortnoxInvoicePaymentReadFixture,
  fortnoxOfferRowsAndPreviewFixture,
  fortnoxPredefinedAccountsAndLabelsFixture,
  fortnoxPriceTierMatchesSublistFixture,
  fortnoxPrintTemplatesUnpaginatedFixture,
  fortnoxProfileMeFixture,
  fortnoxReadConformanceCases,
  fortnoxSettingsCompanyAndLockedPeriodFixture,
  fortnoxSettingsRegistersFixture,
  fortnoxSieFileIbm437Fixture,
  fortnoxSupplierInvoicePaymentReadFixture,
  fortnoxVoucherListGetBalancedFixture
} from '@yolk-sdk/connectors/fortnox/conformance'
import {
  makeFortnoxEmulator,
  type FortnoxEmulator,
  type FortnoxEmulatorQuirks,
  type FortnoxEmulatorState,
  type FortnoxFault,
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

/** One fresh emulator per case (same seed, `faults` added to each), closed when the effect ends. */
const withEmulators = <A, E, R>(
  quirks: FortnoxEmulatorQuirks,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>,
  faults: ReadonlyArray<FortnoxFault> = []
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, FortnoxEmulator>()

      for (const testCase of fortnoxConformanceCases) {
        const emulator = await makeFortnoxEmulator({ now: () => now.getTime(), quirks })

        for (const fault of faults) emulator.faults.add(fault)

        emulators.set(testCase.id, emulator)
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
    passed: fortnoxConformanceCases.length,
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
          const readIds = fortnoxConformanceCases
            .filter(testCase => testCase.safety === 'read')
            .map(testCase => testCase.id)

          expect(readIds).toHaveLength(21)

          for (const id of readIds) {
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

const drill = (quirks: FortnoxEmulatorQuirks, faults: ReadonlyArray<FortnoxFault> = []) =>
  withEmulators(
    quirks,
    emulators => runAll(emulators, { kind: 'in-process' }, inProcessLayer),
    faults
  )

const expectOnlyFailure = (report: ConformanceReport, caseId: string, message: string) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: fortnoxConformanceCases.length - 1,
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

/** A 200 answer for exactly one `GET` path: every emulator answers it with `body` instead. */
const answer = (path: string, body: FortnoxFault['body']): FortnoxFault => ({
  kind: 'status',
  status: 200,
  body,
  match: { method: 'GET', path }
})

const meta = { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 1 }

/**
 * One disagreement drill per read case: the route answers with a body that contradicts the case's
 * claim (installed on every case's emulator), and exactly that case fails with that message.
 */
const readDrills: ReadonlyArray<{
  readonly caseId: string
  readonly fault: FortnoxFault
  readonly message: string
  /** Text from the drill body the report must never echo (it may be personal data). */
  readonly unechoed?: string
}> = [
  {
    caseId: 'fortnox.company.information-decodes',
    fault: answer('/3/companyinformation', { CompanyInformation: { CompanyName: ' ' } }),
    message: 'expected a non-empty CompanyName'
  },
  {
    caseId: 'fortnox.customer.list-matches-get',
    fault: answer('/3/customers', {
      Customers: [{ CustomerNumber: '1001', Name: 'Drill name' }],
      MetaInformation: meta
    }),
    message: 'expected the listed customer to read back with the same Name',
    unechoed: 'Drill name'
  },
  {
    caseId: 'fortnox.article.list-row-numeric-strings',
    fault: answer('/3/articles/KIT-1', {
      Article: {
        ArticleNumber: 'KIT-1',
        Description: 'Workshop kit (synthetic)',
        VAT: 25,
        SalesPrice: 999,
        PurchasePrice: 120,
        QuantityInStock: 15
      }
    }),
    message: 'expected the list row and the single read to decode to the same amounts'
  },
  {
    caseId: 'fortnox.price.tier-matches-sublist',
    fault: answer('/3/prices/A/KIT-1/0', {
      Price: { PriceList: 'A', ArticleNumber: 'KIT-1', FromQuantity: 0, Price: 1 }
    }),
    message: 'expected the price tier to read back as listed'
  },
  {
    // The first tier (10) reads back as listed; the base tier disagrees with SalesPrice (250).
    caseId: 'fortnox.price.tier-matches-sublist',
    fault: answer('/3/prices/sublist/A/KIT-1', {
      Prices: [
        { PriceList: 'A', ArticleNumber: 'KIT-1', FromQuantity: 10, Price: 220 },
        { PriceList: 'A', ArticleNumber: 'KIT-1', FromQuantity: 0, Price: 1 }
      ],
      MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 2 }
    }),
    message: 'expected the article SalesPrice to equal its base price in the PreSelected price list'
  },
  {
    caseId: 'fortnox.cost-center.list-matches-get',
    fault: answer('/3/costcenters/CC1', {
      CostCenter: { Code: 'CC1', Description: 'Sales (synthetic)', Note: '', Active: false }
    }),
    message: 'expected the listed cost center to read back as listed'
  },
  {
    caseId: 'fortnox.payment.invoice-payment-wire-numbers',
    fault: answer('/3/invoicepayments/1', {
      InvoicePayment: {
        Number: '1',
        InvoiceNumber: '101',
        Amount: 1250,
        PaymentDate: '2026-09-20',
        VoucherNumber: '2',
        VoucherYear: '3',
        ModeOfPaymentAccount: '1930'
      }
    }),
    message: 'expected the listed invoice payment to read back as listed'
  },
  {
    caseId: 'fortnox.payment.supplier-payment-wire-numbers',
    fault: answer('/3/supplierinvoicepayments/1', {
      SupplierInvoicePayment: {
        Number: '1',
        InvoiceNumber: '1',
        Amount: 500,
        PaymentDate: '2026-09-25',
        VoucherNumber: '3',
        VoucherYear: '3'
      }
    }),
    message: 'expected the listed supplier invoice payment to read back as listed'
  },
  {
    caseId: 'fortnox.offer.rows-on-get-and-preview-pdf',
    fault: answer('/3/offers', {
      Offers: [{ DocumentNumber: '1', CustomerNumber: '1001', OfferRows: [{ Quantity: '1.00' }] }],
      MetaInformation: meta
    }),
    message: 'expected offer list rows to carry no OfferRows'
  },
  {
    caseId: 'fortnox.offer.rows-on-get-and-preview-pdf',
    fault: answer('/3/offers/1/preview', '%PDF-1.4 cut short'),
    message: 'expected a complete PDF ending with an %%EOF trailer'
  },
  {
    caseId: 'fortnox.print-templates.unpaginated',
    fault: answer('/3/printtemplates', {
      PrintTemplates: [{ Template: 'invoice-standard', Name: 'Standard invoice (synthetic)' }],
      MetaInformation: meta
    }),
    message: 'expected the invoice print templates to carry no MetaInformation'
  },
  {
    caseId: 'fortnox.inbox.file-bytes-match-size',
    fault: answer('/3/inbox/00000000-0000-4000-8000-000000000001', 'drill'),
    message: 'expected the downloaded file to be exactly its listed Size in bytes'
  },
  {
    caseId: 'fortnox.settings.company-and-locked-period',
    fault: answer('/3/settings/company', { CompanySettings: { Name: ' ' } }),
    message: 'expected CompanySettings to carry a non-empty Name'
  },
  {
    caseId: 'fortnox.settings.company-and-locked-period',
    fault: answer('/3/settings/lockedperiod', { LockedPeriod: { EndDate: '30/06/2026' } }),
    message: 'expected the locked period EndDate to be a YYYY-MM-DD date, empty, or unset'
  },
  {
    // A company without a locked period: Fortnox may answer 404 (unverified).
    caseId: 'fortnox.settings.company-and-locked-period',
    fault: {
      kind: 'status',
      status: 404,
      match: { method: 'GET', path: '/3/settings/lockedperiod' }
    },
    message: 'precondition: HTTP 404: no locked period, or the route is missing'
  },
  {
    caseId: 'fortnox.settings.predefined-accounts-and-labels',
    fault: answer('/3/predefinedaccounts/BG', { PreDefinedAccount: { Name: 'BG', Account: 1931 } }),
    message: 'expected the listed predefined account to read back as listed'
  },
  {
    caseId: 'fortnox.settings.predefined-accounts-and-labels',
    fault: answer('/3/predefinedaccounts', {
      PreDefinedAccounts: [{ Name: 'BG', Account: 1930 }],
      MetaInformation: meta
    }),
    message: 'expected the predefined accounts to carry no MetaInformation'
  },
  {
    caseId: 'fortnox.settings.predefined-accounts-and-labels',
    fault: answer('/3/labels', {
      Labels: [{ Id: 1, Description: 'Priority (synthetic)' }],
      MetaInformation: meta
    }),
    message: 'expected the labels to carry no MetaInformation'
  },
  {
    caseId: 'fortnox.settings.predefined-accounts-and-labels',
    fault: answer('/3/labels', {
      Labels: [
        { Id: 1, Description: 'Priority (synthetic)' },
        { Id: 1, Description: 'Follow up (synthetic)' }
      ]
    }),
    message: 'expected every label to carry a distinct Id'
  },
  {
    caseId: 'fortnox.settings.registers-list-matches-get',
    fault: answer('/3/modesofpayments/BG', {
      ModeOfPayment: { Code: 'BG', Description: 'Bankgiro (synthetic)', AccountNumber: 1931 }
    }),
    message: 'expected the listed mode of payment to read back as listed'
  },
  {
    caseId: 'fortnox.settings.registers-list-matches-get',
    fault: answer('/3/termsofpayments/10', {
      TermsOfPayment: { Code: '10', Description: 'Drill' }
    }),
    message: 'expected the listed terms of payment to read back as listed'
  },
  {
    caseId: 'fortnox.settings.registers-list-matches-get',
    fault: answer('/3/termsofdeliveries/EXW', {
      TermsOfDelivery: { Code: 'EXW', Description: 'Ex works (synthetic)', DescriptionEnglish: '' }
    }),
    message: 'expected the listed terms of delivery to read back as listed'
  },
  {
    caseId: 'fortnox.settings.registers-list-matches-get',
    fault: answer('/3/wayofdeliveries/P', {
      WayOfDelivery: { Code: 'P', Description: 'Drill', DescriptionEnglish: 'Mail' }
    }),
    message: 'expected the listed way of delivery to read back as listed'
  },
  {
    caseId: 'fortnox.settings.registers-list-matches-get',
    fault: answer('/3/units/h', { Unit: { Code: 'h', Description: 'Hour (synthetic)' } }),
    message: 'expected the listed unit to read back as listed'
  },
  {
    caseId: 'fortnox.profile.me',
    fault: answer('/3/me', { Me: { Id: ' ' } }),
    message: 'expected the profile to carry a non-empty Id'
  },
  {
    caseId: 'fortnox.bookkeeping.financial-year-id-and-date',
    fault: answer('/3/financialyears/2', {
      FinancialYear: {
        Id: 2,
        FromDate: '2026-01-01',
        ToDate: '2026-06-30',
        AccountChartType: 'Bas 2026',
        AccountingMethod: 'ACCRUAL'
      }
    }),
    message: 'expected the financial year to read back by Id as listed'
  },
  {
    caseId: 'fortnox.bookkeeping.account-balances-list-get',
    fault: answer('/3/accounts/1930', {
      Account: {
        Number: 1930,
        Description: 'Bank account (synthetic)',
        Active: true,
        BalanceBroughtForward: 15000,
        BalanceCarriedForward: 1,
        Year: 2
      }
    }),
    message: 'expected the listed account to read back with the same balances'
  },
  {
    caseId: 'fortnox.bookkeeping.voucher-list-get-balanced',
    fault: answer('/3/vouchers/A/1', {
      Voucher: {
        Description: 'Bank fee (synthetic)',
        TransactionDate: '2026-09-01',
        VoucherNumber: 1,
        VoucherRows: [
          { Account: 6570, Debit: 125.5, Credit: 0 },
          { Account: 1930, Debit: 0, Credit: 125 }
        ],
        VoucherSeries: 'A',
        Year: 2
      }
    }),
    message: 'expected the voucher to carry at least two rows that balance'
  },
  {
    caseId: 'fortnox.bookkeeping.voucher-list-get-balanced',
    fault: answer('/3/vouchers/sublist/A', {
      Vouchers: [{ VoucherNumber: 1, VoucherSeries: 'A', Year: 1 }],
      MetaInformation: meta
    }),
    message: 'expected the series list to hold the first voucher'
  },
  {
    // A row of another voucher without VoucherYear: the action skips it, the raw claim fails.
    caseId: 'fortnox.bookkeeping.voucher-list-get-balanced',
    fault: answer('/3/voucherfileconnections', {
      VoucherFileConnections: [
        { FileId: 'drill-file', Name: 'x.pdf', VoucherNumber: '1', VoucherSeries: 'B' }
      ],
      MetaInformation: meta
    }),
    message: 'expected every voucher file connection row to carry VoucherYear'
  },
  {
    caseId: 'fortnox.bookkeeping.sie-file-ibm437',
    fault: {
      kind: 'status',
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: '#FLAGGA 0\r\n#FORMAT ANSI\r\n#SIETYP 1\r\n',
      match: { method: 'GET', path: '/3/sie/1' }
    },
    message: 'expected the SIE file to declare #FORMAT PC8 and #SIETYP 1'
  }
]

const readCaseIds = fortnoxReadConformanceCases.map(testCase => testCase.id)

describe('disagreement drill (read cases)', () => {
  it('covers every read case without a quirk knob, in case order', () => {
    expect([...new Set(readDrills.map(entry => entry.caseId))]).toEqual(readCaseIds)
  })

  for (const entry of readDrills) {
    it.effect(`${entry.fault.match?.path} fails only ${entry.caseId}: ${entry.message}`, () =>
      Effect.gen(function* () {
        const report = yield* drill({}, [entry.fault])

        expectOnlyFailure(report, entry.caseId, entry.message)

        if (entry.unechoed !== undefined) {
          expect(formatConformanceReport(report)).not.toContain(entry.unechoed)
          expect(JSON.stringify(report.results)).not.toContain(entry.unechoed)
        }
      })
    )
  }
})

/** The read case fixtures, the source of the default emulator's read answers. */
const readFixtures = [
  fortnoxCompanyInformationFixture,
  fortnoxCustomerListMatchesGetFixture,
  fortnoxArticleListRowNumbersFixture,
  fortnoxPriceTierMatchesSublistFixture,
  fortnoxCostCenterListMatchesGetFixture,
  fortnoxInvoicePaymentReadFixture,
  fortnoxSupplierInvoicePaymentReadFixture,
  fortnoxOfferRowsAndPreviewFixture,
  fortnoxPrintTemplatesUnpaginatedFixture,
  fortnoxInboxFolderFileBytesFixture,
  fortnoxSettingsCompanyAndLockedPeriodFixture,
  fortnoxPredefinedAccountsAndLabelsFixture,
  fortnoxSettingsRegistersFixture,
  fortnoxProfileMeFixture,
  fortnoxFinancialYearByIdAndDateFixture,
  fortnoxAccountBalancesListGetFixture,
  fortnoxVoucherListGetBalancedFixture,
  fortnoxSieFileIbm437Fixture
]

const base64Of = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)))

describe('read case fixtures and the default emulator', () => {
  it('cover every read case without a quirk knob, in case order', () => {
    expect(readFixtures.map(fixture => fixture.caseId)).toEqual(readCaseIds)
  })

  it.effect('answer every recorded request with the recorded status, content type, and body', () =>
    Effect.promise(async () => {
      const emulator = await makeFortnoxEmulator({ now: () => now.getTime() })

      try {
        for (const fixture of readFixtures) {
          for (const { request, response } of fixture.exchanges) {
            const answered = await emulator.fetch(
              new Request(request.url, {
                method: request.method,
                headers: { ...request.headers, authorization: 'Bearer synthetic-parity-token' }
              })
            )

            expect(answered.status, request.url).toBe(response.status)
            expect(answered.headers.get('content-type'), request.url).toBe(
              response.headers?.['content-type']
            )

            if (isWireBase64BodyResponse(response)) {
              expect(base64Of(await answered.arrayBuffer()), request.url).toBe(response.bodyBase64)
            } else if (isWireStreamResponse(response)) {
              expect.fail(`${request.url}: no read fixture streams`)
            } else {
              expect(await answered.text(), request.url).toBe(response.body)
            }
          }
        }

        // Reading every fixture request changed nothing.
        expect(emulator.ledger.entries().every(entry => entry.method === 'GET')).toBe(true)
      } finally {
        await emulator.close()
      }
    })
  )
})
