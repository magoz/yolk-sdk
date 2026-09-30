/**
 * Fortnox conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one claim about how the real Fortnox API behaves where it differs from (or
 * goes beyond) its documentation, and runs through the REAL connector actions and helpers over
 * the connector ports (`ConnectorHttpClient`, `ConnectorBinaryHttpClient`, `CredentialResolver`)
 * plus the host-supplied `FortnoxConformanceConfig` seed identities. The same cases run on replay
 * fixtures, an emulator, or by hand against a Fortnox developer test company ("practice
 * account"). None is observed live yet (`observed` absent = unverified).
 *
 * The row and customer mutation cases restore what they change, verify the restore by reading
 * back, and report (never swallow) a failed restore, also through `ConformanceCleanupReporter` when
 * the case is being interrupted. The rejection case writes nothing when Fortnox
 * behaves as claimed: it first confirms the customer is absent and names any invoice Fortnox
 * unexpectedly creates for manual cancellation.
 */
import { Cause, Chunk, Clock, Context, Data, Effect, Exit, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import type { ConnectorBinaryHttpClient } from '../../binary-http.ts'
import { failReporting } from '../../conformance/cleanup-reporter.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import type { ConnectorFileTransferError } from '../../file-transfer.ts'
import { decodeJsonResponse, type ConnectorHttpClient } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult } from '../../result.ts'
import { downloadFortnoxInvoicePreview } from '../files.ts'
import {
  fortnoxCreateInvoiceAction,
  fortnoxGetCustomerAction,
  fortnoxGetInvoiceAction,
  fortnoxListInvoicesAction,
  fortnoxUpdateCustomerAction,
  fortnoxUpdateInvoiceAction
} from '../index.ts'
import {
  FortnoxInvoiceOAuthCredentialSlot,
  fortnoxConnectorId,
  fortnoxOAuthSlotId
} from '../oauth.ts'
import {
  FortnoxCreateInvoiceInput,
  FortnoxCustomerNumber,
  FortnoxDocumentNumber,
  FortnoxGetCustomerInput,
  FortnoxGetInvoiceInput,
  FortnoxInvoiceRow,
  FortnoxListInvoicesInput,
  FortnoxUpdateInvoiceInput,
  type FortnoxCustomer,
  type FortnoxInvoice
} from '../schemas.ts'
import { getFortnoxResponse, readFortnox } from '../shared.ts'
import { FortnoxInvoiceApi, invoiceFromApi } from '../wire.ts'
import { fortnoxCustomerEmptyStringFixture } from './customer-empty-string.ts'
import { fortnoxInvoiceListPopulatedFixture } from './invoice-list-populated.ts'
import { fortnoxInvoicePaymentFiltersFixture } from './invoice-payment-filters.ts'
import { fortnoxInvoicePreviewPdfFixture } from './invoice-preview-pdf.ts'
import { fortnoxInvoiceRowDiscountFixture } from './invoice-row-discount.ts'
import { fortnoxInvoiceSendEmailFixture } from './invoice-send-email.ts'
import { fortnoxWriteRejectionFixture } from './write-rejection.ts'

/**
 * Host-supplied seed identities in the practice company. Cases never hard-code account data. A
 * case whose seed is missing fails with a `precondition:` `ConformanceMismatch` before any
 * request.
 */
export const FortnoxConformanceSeeds = Schema.Struct({
  /** Unbooked invoice with at least one row; its rows are changed and then restored. */
  discountInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber),
  /** Any invoice whose generated PDF preview can be downloaded. */
  previewInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber),
  /** Customer with a non-empty `Comments` value; it is changed and then restored. */
  customerNumber: Schema.optionalKey(FortnoxCustomerNumber),
  /** A customer number that does NOT exist in the practice company. */
  missingCustomerNumber: Schema.optionalKey(FortnoxCustomerNumber),
  /** Invoice to send by email (irreversible; manual runs only). */
  emailInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber),
  /**
   * The only address the email case may send to. The case aborts before sending unless the email
   * invoice's `EmailInformation.EmailAddressTo` equals it exactly (and no copy address is set).
   */
  emailRecipient: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isPattern(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/))
  )
})

export type FortnoxConformanceSeeds = typeof FortnoxConformanceSeeds.Type

export type FortnoxConformanceSeedKey = keyof FortnoxConformanceSeeds

/** Host-supplied seed identities for the Fortnox conformance cases. */
export class FortnoxConformanceConfig extends Context.Service<
  FortnoxConformanceConfig,
  FortnoxConformanceSeeds
>()('@yolk-sdk/connectors/fortnox/conformance/FortnoxConformanceConfig') {}

/**
 * Credential reference the cases bind to the `fortnox.oauth` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Fortnox `OAuthCredential`.
 */
export const fortnoxConformanceCredentialRef = 'fortnox.conformance'

/** The integration every Fortnox conformance case invokes the connector with. */
export const fortnoxConformanceIntegration = makeIntegration({
  connectorId: fortnoxConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: fortnoxOAuthSlotId,
      credentialRef: fortnoxConformanceCredentialRef
    })
  ]
})

/** A connector action returned an `ActionResult` failure where the case needed success. */
export class FortnoxConformanceActionFailed extends Data.TaggedError(
  'FortnoxConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    return `${this.actionId} failed: ${this.code}${status}`
  }
}

const restoreByHandAdvice =
  'restore the account by hand if it still differs from its original state.'

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Restoring the practice account after a write case failed. `caseOutcome` says whether the claim
 * itself held before restoring; `claimFailure` is a sanitized summary of why it failed. The account
 * may or may not still differ from its original state (for example, nothing changed when the first
 * write was rejected): check it, and restore it by hand only if it differs.
 */
export class FortnoxConformanceRestoreFailed extends Data.TaggedError(
  'FortnoxConformanceRestoreFailed'
)<{
  readonly caseId: string
  readonly reason: string
  readonly caseOutcome: 'claim held' | 'claim failed'
  readonly claimFailure?: string
}> {
  override get message(): string {
    const claim =
      this.caseOutcome === 'claim held'
        ? 'Claim held first.'
        : this.claimFailure === undefined
          ? 'Claim failed first.'
          : `Claim failed first: ${this.claimFailure}`

    // Conformance reports cap failure messages at 300 characters: the advice comes first so it
    // always survives, and each summary is capped at `failureSummaryLength`, so the whole message
    // fits even for the longest case id.
    return `${this.caseId}: restore failed; ${restoreByHandAdvice} Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type FortnoxConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | ConnectorFileTransferError
  | FortnoxConformanceActionFailed
  | FortnoxConformanceRestoreFailed

/** What every Fortnox conformance case requires from the host. */
export type FortnoxConformanceRequirements =
  | ConnectorHttpClient
  | ConnectorBinaryHttpClient
  | CredentialResolver
  | FortnoxConformanceConfig

export type FortnoxConformanceCase = ConformanceCase<
  FortnoxConformanceError,
  FortnoxConformanceRequirements
>

const integration = fortnoxConformanceIntegration

/** Trusted budget for the preview download (generous for a generated invoice PDF). */
const previewBudget = {
  maxBytes: 20 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxErrorBodyBytes: 64 * 1024
}

/** Synthetic marker written to the configured customer's `Comments` and then removed. */
export const fortnoxConformanceCommentsMarker = 'yolk-conformance marker: safe to restore'

const requireSeed = <K extends FortnoxConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* FortnoxConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: FortnoxConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, FortnoxConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new FortnoxConformanceActionFailed({ actionId, code })
      : new FortnoxConformanceActionFailed({ actionId, code, status })
  )
}

const getInvoice = (documentNumber: FortnoxDocumentNumber) =>
  fortnoxGetInvoiceAction
    .executeTyped({ integration, input: FortnoxGetInvoiceInput.make({ documentNumber }) })
    .pipe(Effect.flatMap(result => successValue(fortnoxGetInvoiceAction.id, result)))

const getCustomer = (customerNumber: FortnoxCustomerNumber) =>
  fortnoxGetCustomerAction
    .executeTyped({ integration, input: FortnoxGetCustomerInput.make({ customerNumber }) })
    .pipe(Effect.flatMap(result => successValue(fortnoxGetCustomerAction.id, result)))

type InvoiceListFilter = NonNullable<FortnoxListInvoicesInput['filter']>

/** Page size and page cap for exhaustive filtered listings. */
const listPageLimit = 500

const listPageCap = 10

/** Every invoice for one filter, following `pagination.nextPage` (bounded by `listPageCap`). */
const listAllInvoices = (filter: InvoiceListFilter) =>
  Effect.gen(function* () {
    const invoices: Array<FortnoxInvoice> = []
    let page = 1

    for (;;) {
      const listed = yield* fortnoxListInvoicesAction
        .executeTyped({
          integration,
          input: FortnoxListInvoicesInput.make({ filter, limit: listPageLimit, page })
        })
        .pipe(Effect.flatMap(result => successValue(fortnoxListInvoicesAction.id, result)))

      invoices.push(...Chunk.toReadonlyArray(listed.invoices))

      const nextPage = listed.pagination.nextPage

      if (nextPage === undefined) {
        return invoices
      }

      if (page >= listPageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: filter=${filter} spans more than ${listPageCap} pages of ${listPageLimit}; use a smaller practice company`
        })
      }

      page = nextPage
    }
  })

/** Longest failure summary embedded in a `FortnoxConformanceRestoreFailed` message. */
const failureSummaryLength = 60

/** Short, sanitized `Tag: message` summary of a failure (credential patterns redacted). */
const failureSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)
  const tag = Predicate.hasProperty(value, '_tag') ? String(value._tag) : 'defect'
  const message = Predicate.hasProperty(value, 'message') ? String(value.message) : ''

  // A mismatch message is case-authored and self-explanatory; other failures keep their tag.
  const raw =
    message.length === 0
      ? tag
      : value instanceof ConformanceMismatch
        ? message
        : `${tag}: ${message}`

  const summary = sanitizeConformanceMessage(raw)

  return summary.length > failureSummaryLength
    ? `${summary.slice(0, failureSummaryLength - 3).trimEnd()}...`
    : summary
}

/**
 * Run `use`, then ALWAYS run `restore` (also after a failure or interruption, uninterruptibly).
 * A failed restore fails the case with `FortnoxConformanceRestoreFailed`, which says whether the
 * claim itself held and, if not, summarizes why; otherwise the outcome of `use` (including an
 * interruption) is returned unchanged. A failed restore raised while the case is being interrupted
 * is also handed to `ConformanceCleanupReporter` (via `failReporting`) before leaving the mask, since
 * an interruption may replace it.
 */
const withRestore = <A, E, R, E2, R2>(
  caseId: string,
  use: Effect.Effect<A, E, R>,
  restore: Effect.Effect<void, E2, R2>
): Effect.Effect<A, E | FortnoxConformanceRestoreFailed, R | R2> =>
  Effect.uninterruptibleMask(unmask =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(unmask(use))
      const restored = yield* Effect.exit(restore)

      if (Exit.isFailure(restored)) {
        return yield* failReporting(
          unmask,
          Exit.isSuccess(outcome)
            ? new FortnoxConformanceRestoreFailed({
                caseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim held'
              })
            : new FortnoxConformanceRestoreFailed({
                caseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim failed',
                claimFailure: failureSummary(outcome.cause)
              }),
          Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)
        )
      }

      return yield* outcome
    })
  )

const isFiniteOrUnset = (value: number | null | undefined): boolean =>
  value === null || value === undefined || Number.isFinite(value)

const invoiceAmounts = (invoice: FortnoxInvoice) => [
  invoice.Total,
  invoice.Balance,
  invoice.TotalVAT,
  invoice.TotalToPay,
  invoice.Net,
  invoice.Gross,
  invoice.CurrencyRate
]

export const fortnoxInvoiceListPopulatedCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.invoice.list-populated',
  title: 'Invoice lists decode with pagination metadata and wire-typed amounts',
  safety: 'read',
  docs: 'GET /3/invoices returns `Invoices` plus `MetaInformation` (`@CurrentPage`, `@TotalPages`, `@TotalResources`); the OpenAPI invoice-list wrapper omits `MetaInformation`, and invoice amounts are documented as numbers.',
  wire: 'A populated company returns at least one invoice together with `MetaInformation`: `fortnox.list_invoices` decodes every row and reports pagination, and every invoice amount decodes to a finite number or is unset, whether Fortnox sends it as a JSON number or as a numeric string (for example `CurrencyRate: "1"`).',
  fixtures: [fortnoxInvoiceListPopulatedFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* fortnoxListInvoicesAction
      .executeTyped({ integration, input: FortnoxListInvoicesInput.make({ limit: 10 }) })
      .pipe(Effect.flatMap(result => successValue(fortnoxListInvoicesAction.id, result)))

    const invoices = Chunk.toReadonlyArray(listed.invoices)
    const { currentPage, totalPages, totalResources } = listed.pagination

    yield* expectConformance(
      invoices.length >= 1,
      'precondition: the practice company needs at least one invoice'
    )
    yield* expectConformance(
      currentPage >= 1 && totalPages >= 1 && totalResources >= invoices.length,
      'expected pagination metadata covering the returned invoices',
      { actual: { currentPage, totalPages, totalResources, returned: invoices.length } }
    )

    const unreadable = invoices.filter(invoice => !invoiceAmounts(invoice).every(isFiniteOrUnset))

    yield* expectConformance(
      unreadable.length === 0,
      'expected every invoice amount to decode to a finite number or unset',
      { actual: unreadable.map(invoice => invoice.DocumentNumber) }
    )
  })
})

const isPdfStart = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'

const hasPdfTrailer = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.byteLength - 1024))).includes('%%EOF')

export const fortnoxInvoicePreviewPdfCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.invoice.preview-pdf',
  title: 'Invoice preview returns a complete generated PDF',
  safety: 'read',
  docs: 'GET /3/invoices/{DocumentNumber}/preview returns the invoice as a generated PDF; unlike /print it does not mark the invoice as sent.',
  wire: 'The preview endpoint answers 200 with a complete PDF body, whatever content type it declares: `downloadFortnoxInvoicePreview` over the binary port returns bytes starting with `%PDF-` and ending with an `%%EOF` trailer.',
  fixtures: [fortnoxInvoicePreviewPdfFixture.id],
  run: Effect.gen(function* () {
    const documentNumber = yield* requireSeed('previewInvoiceDocumentNumber')

    const preview = yield* downloadFortnoxInvoicePreview(
      integration,
      { documentNumber },
      previewBudget
    )

    yield* expectConformance(isPdfStart(preview.bytes), 'expected the preview to start with %PDF-')
    yield* expectConformance(
      hasPdfTrailer(preview.bytes),
      'expected a complete PDF ending with an %%EOF trailer'
    )
  })
})

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

/** `date` is a `YYYY-MM-DD` date strictly before the `YYYY-MM-DD` date `today`. */
const isDateBefore = (date: string | null | undefined, today: string): boolean =>
  Predicate.isString(date) && isoDatePattern.test(date) && date < today

export const fortnoxInvoicePaymentFiltersCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.invoice.payment-filters-exclude-unbooked',
  title: 'Payment-status invoice filters leave out unbooked invoices',
  safety: 'read',
  docs: 'GET /3/invoices accepts `filter` values `cancelled`, `fullypaid`, `unpaid`, `unpaidoverdue`, and `unbooked`; the docs do not say how the payment-status filters treat unbooked invoices.',
  wire: 'An unbooked, uncancelled invoice with a positive balance appears under `filter=unbooked` but not under `filter=unpaid`; an unbooked, uncancelled invoice with a positive balance whose `DueDate` is before today (Effect `Clock`, UTC date) is also absent from `filter=unpaidoverdue`. So an empty payment-status result does not prove nothing is outstanding. The case needs such an overdue unbooked invoice and aborts with a precondition otherwise.',
  fixtures: [fortnoxInvoicePaymentFiltersFixture.id],
  run: Effect.gen(function* () {
    const today = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10)
    const unbooked = yield* listAllInvoices('unbooked')

    const outstanding = unbooked.filter(
      invoice =>
        invoice.Booked !== true &&
        invoice.Cancelled !== true &&
        Predicate.isNumber(invoice.Balance) &&
        invoice.Balance > 0
    )

    const unpaidCandidate = outstanding[0]

    if (unpaidCandidate === undefined) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: the practice company needs an unbooked, uncancelled invoice with a positive balance'
      })
    }

    const overdueCandidate = outstanding.find(invoice => isDateBefore(invoice.DueDate, today))

    if (overdueCandidate === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: the practice company needs an unbooked, uncancelled invoice with a positive balance and a DueDate before today (${today})`
      })
    }

    const unpaid = yield* listAllInvoices('unpaid')

    yield* expectConformance(
      !unpaid.some(invoice => invoice.DocumentNumber === unpaidCandidate.DocumentNumber),
      'expected the unbooked invoice to be absent from filter=unpaid',
      { expected: 'absent', actual: unpaidCandidate.DocumentNumber }
    )

    const unpaidOverdue = yield* listAllInvoices('unpaidoverdue')

    yield* expectConformance(
      !unpaidOverdue.some(invoice => invoice.DocumentNumber === overdueCandidate.DocumentNumber),
      'expected the overdue unbooked invoice to be absent from filter=unpaidoverdue',
      { expected: 'absent', actual: overdueCandidate.DocumentNumber }
    )
  })
})

type WritableInvoiceRow = {
  ArticleNumber?: string
  AccountNumber?: number
  Description?: string
  DeliveredQuantity?: string
  Unit?: string
  Price?: number
  VAT?: number
  CostCenter?: string
  Project?: string
  Discount?: number
  DiscountType?: string
}

const setWritable = <K extends keyof WritableInvoiceRow>(
  row: WritableInvoiceRow,
  key: K,
  value: WritableInvoiceRow[K] | null | undefined
): void => {
  // Null and "" mean unset on the wire; omitting them keeps the positional row's value.
  if (value !== null && value !== undefined && value !== '') {
    row[key] = value
  }
}

type RowDiscount =
  | { readonly kind: 'original' }
  | { readonly kind: 'set'; readonly discount: number }
  | { readonly kind: 'omit' }

/**
 * Writable fields of a read row, without `RowId` (positional matching) and without read-only
 * totals. `discount` controls the pricing fields: the original values sent explicitly (the case
 * precondition guarantees both are set), a set percent discount, or both `Discount` and
 * `DiscountType` omitted. `VATCode` is never sent (the row's `VAT` is), but the restore check
 * compares it.
 */
const writableRow = (row: FortnoxInvoiceRow, discount: RowDiscount): FortnoxInvoiceRow => {
  const out: WritableInvoiceRow = {}

  setWritable(out, 'ArticleNumber', row.ArticleNumber)
  setWritable(out, 'AccountNumber', row.AccountNumber)
  setWritable(out, 'Description', row.Description)
  setWritable(out, 'DeliveredQuantity', row.DeliveredQuantity)
  setWritable(out, 'Unit', row.Unit)
  setWritable(out, 'Price', row.Price)
  setWritable(out, 'VAT', row.VAT)
  setWritable(out, 'CostCenter', row.CostCenter)
  setWritable(out, 'Project', row.Project)

  switch (discount.kind) {
    case 'original':
      setWritable(out, 'Discount', row.Discount)
      setWritable(out, 'DiscountType', row.DiscountType)
      break
    case 'set':
      out.Discount = discount.discount
      out.DiscountType = 'PERCENT'
      break
    case 'omit':
      break
  }

  return FortnoxInvoiceRow.make(out)
}

/** Rows the restore can write back exactly: an explicit numeric `Discount` and a PERCENT type. */
const hasRestorableDiscount = (row: FortnoxInvoiceRow): boolean =>
  Predicate.isNumber(row.Discount) && row.DiscountType === 'PERCENT'

const invoiceRows = (invoice: FortnoxInvoice): ReadonlyArray<FortnoxInvoiceRow> =>
  Chunk.toReadonlyArray(invoice.InvoiceRows ?? Chunk.empty())

const putInvoiceRows = (
  documentNumber: FortnoxDocumentNumber,
  rows: ReadonlyArray<FortnoxInvoiceRow>
) =>
  fortnoxUpdateInvoiceAction
    .executeTyped({
      integration,
      input: FortnoxUpdateInvoiceInput.make({ DocumentNumber: documentNumber, InvoiceRows: rows })
    })
    .pipe(Effect.flatMap(result => successValue(fortnoxUpdateInvoiceAction.id, result)))

/** Update every row positionally (no RowId); the first row's discount follows `firstRow`. */
const updateRows = (
  documentNumber: FortnoxDocumentNumber,
  rows: ReadonlyArray<FortnoxInvoiceRow>,
  firstRow: RowDiscount
) =>
  putInvoiceRows(
    documentNumber,
    rows.map((row, index) => writableRow(row, index === 0 ? firstRow : { kind: 'original' }))
  )

const firstRowDiscount = (documentNumber: FortnoxDocumentNumber) =>
  getInvoice(documentNumber).pipe(Effect.map(invoice => invoiceRows(invoice)[0]?.Discount ?? null))

/**
 * Every row field the case writes, plus `VATCode`. RowIds are regenerated on every update and
 * derived row totals follow from these fields, so neither is compared per row.
 */
const restoredRowFields = [
  'ArticleNumber',
  'AccountNumber',
  'Description',
  'DeliveredQuantity',
  'Unit',
  'Price',
  'VAT',
  'VATCode',
  'CostCenter',
  'Project',
  'Discount',
  'DiscountType'
] as const

/** Invoice-level totals a restore must bring back. */
const restoredInvoiceTotals = ['Total', 'TotalVAT', 'Net', 'Gross'] as const

/**
 * Fields exactly as read: `null` stays `null`, and an absent field stays absent (it is left out
 * rather than normalized), so a restore that changes either is caught.
 */
const exactFields = (fields: ReadonlyArray<readonly [string, Schema.Json | undefined]>) =>
  Object.fromEntries(
    fields.flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const]))
  )

const rowSignature = (row: FortnoxInvoiceRow) =>
  exactFields(restoredRowFields.map(key => [key, row[key]] as const))

const invoiceTotals = (invoice: FortnoxInvoice) =>
  exactFields(restoredInvoiceTotals.map(key => [key, invoice[key]] as const))

/**
 * Send the original rows with their explicit discounts, then verify by reading back that every
 * written row field (plus `VATCode`) and the invoice totals equal the original read exactly.
 */
const restoreInvoiceRows = (documentNumber: FortnoxDocumentNumber, original: FortnoxInvoice) =>
  Effect.gen(function* () {
    const rows = invoiceRows(original)

    yield* putInvoiceRows(
      documentNumber,
      rows.map(row => writableRow(row, { kind: 'original' }))
    )

    const restored = yield* getInvoice(documentNumber)

    yield* expectEqual(
      invoiceRows(restored).map(rowSignature),
      rows.map(rowSignature),
      'expected the original invoice rows back after restoring'
    )
    yield* expectEqual(
      invoiceTotals(restored),
      invoiceTotals(original),
      'expected the original invoice totals back after restoring'
    )
  })

const rowDiscountCaseId = 'fortnox.invoice.row-discount-sticky'

export const fortnoxInvoiceRowDiscountCase: FortnoxConformanceCase = defineConformanceCase({
  id: rowDiscountCaseId,
  title: 'An omitted row Discount keeps its previous value on positional row updates',
  safety: 'write-reversible',
  docs: 'PUT /3/invoices/{DocumentNumber} with `InvoiceRows` replaces the row list; without `RowId`, rows are matched to existing rows by position. The docs do not say what happens to pricing fields left out of a matched row.',
  wire: 'On an unbooked invoice, a positionally matched row sent WITHOUT `Discount` keeps its previous discount (10 stays 10); only an explicit `Discount: 0` clears it. The case needs every row to have an explicit `Discount` and `DiscountType: PERCENT` before any write, then restores the original rows (with their explicit discounts) and verifies every written row field, `VATCode`, and the invoice totals against the original read.',
  fixtures: [fortnoxInvoiceRowDiscountFixture.id],
  run: Effect.gen(function* () {
    const documentNumber = yield* requireSeed('discountInvoiceDocumentNumber')
    const original = yield* getInvoice(documentNumber)
    const rows = invoiceRows(original)

    yield* expectConformance(
      original.Booked !== true,
      'precondition: the discount invoice must be unbooked'
    )
    yield* expectConformance(
      rows.length > 0,
      'precondition: the discount invoice needs at least one row'
    )
    // The restore writes each row's original Discount and DiscountType back explicitly; an unset
    // (null or absent) value could not be written back, so the restore would not be exact.
    yield* expectConformance(
      rows.every(hasRestorableDiscount),
      'precondition: every discount invoice row needs an explicit Discount and DiscountType PERCENT, so the restore can write them back exactly; nothing was written'
    )

    yield* withRestore(
      rowDiscountCaseId,
      Effect.gen(function* () {
        yield* updateRows(documentNumber, rows, { kind: 'set', discount: 10 })
        yield* expectEqual(
          yield* firstRowDiscount(documentNumber),
          10,
          'precondition: setting Discount 10 on the first row did not take effect'
        )

        yield* updateRows(documentNumber, rows, { kind: 'omit' })
        yield* expectEqual(
          yield* firstRowDiscount(documentNumber),
          10,
          'expected the omitted Discount to keep its previous value (10)'
        )

        yield* updateRows(documentNumber, rows, { kind: 'set', discount: 0 })
        yield* expectEqual(
          yield* firstRowDiscount(documentNumber),
          0,
          'expected an explicit Discount 0 to clear the discount'
        )
      }),
      restoreInvoiceRows(documentNumber, original)
    )
  })
})

const updateCustomerComments = (customerNumber: FortnoxCustomerNumber, comments: string) =>
  fortnoxUpdateCustomerAction
    .executeTyped({ integration, input: { CustomerNumber: customerNumber, Comments: comments } })
    .pipe(Effect.flatMap(result => successValue(fortnoxUpdateCustomerAction.id, result)))

const customerComments = (customer: FortnoxCustomer): string | null => customer.Comments ?? null

/** Write the original `Comments` back, then verify it by reading back. */
const restoreCustomerComments = (customerNumber: FortnoxCustomerNumber, comments: string) =>
  Effect.gen(function* () {
    yield* updateCustomerComments(customerNumber, comments)

    yield* expectEqual(
      customerComments(yield* getCustomer(customerNumber)),
      comments,
      'expected the original Comments back after restoring'
    )
  })

const emptyStringCaseId = 'fortnox.customer.empty-string-keeps-value'

export const fortnoxCustomerEmptyStringCase: FortnoxConformanceCase = defineConformanceCase({
  id: emptyStringCaseId,
  title: 'An empty string does not clear a stored customer field',
  safety: 'write-reversible',
  docs: 'PUT /3/customers/{CustomerNumber} updates the provided fields; the docs do not say how to clear an optional string field such as `Comments`.',
  wire: 'Updating `Comments` to `""` leaves the stored value unchanged: an empty string does not clear a stored value (how to clear one is not established). The case needs a customer whose `Comments` is non-empty (an empty value could not be restored), writes a synthetic marker, then restores the original value and verifies it.',
  fixtures: [fortnoxCustomerEmptyStringFixture.id],
  run: Effect.gen(function* () {
    const customerNumber = yield* requireSeed('customerNumber')
    const original = customerComments(yield* getCustomer(customerNumber))

    if (original === null || original.trim().length === 0) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: the configured customer needs a non-empty Comments value (an empty value cannot be restored)'
      })
    }

    yield* withRestore(
      emptyStringCaseId,
      Effect.gen(function* () {
        yield* updateCustomerComments(customerNumber, fortnoxConformanceCommentsMarker)
        yield* expectEqual(
          customerComments(yield* getCustomer(customerNumber)),
          fortnoxConformanceCommentsMarker,
          'precondition: writing the marker to Comments did not take effect'
        )

        yield* updateCustomerComments(customerNumber, '')
        yield* expectEqual(
          customerComments(yield* getCustomer(customerNumber)),
          fortnoxConformanceCommentsMarker,
          'expected an empty-string Comments update to keep the stored value'
        )
      }),
      restoreCustomerComments(customerNumber, original)
    )
  })
})

const providerCodeOf = (underlying: unknown): number | string | undefined => {
  if (!Predicate.hasProperty(underlying, 'providerCode')) {
    return undefined
  }

  const code = underlying.providerCode

  return Predicate.isNumber(code) || (Predicate.isString(code) && code.length > 0)
    ? code
    : undefined
}

/**
 * Fortnox `ErrorInformation` codes documented as "Customer not found" (see the Fortnox error-code
 * guide). A 4xx lookup failure carrying one of them confirms the customer is absent like a 404.
 */
const customerNotFoundProviderCodes: ReadonlyArray<string> = ['2000204', '2000433']

/**
 * A failed customer lookup confirms absence only on 404, or on another 4xx (never 401 or 403)
 * whose `ErrorInformation` code means "customer not found". Anything else is not proof of absence.
 */
const confirmsCustomerAbsent = (error: {
  readonly status?: number | undefined
  readonly underlying?: unknown
}): boolean => {
  const { status } = error

  if (status === 404) {
    return true
  }

  if (status === undefined || status < 400 || status >= 500 || status === 401 || status === 403) {
    return false
  }

  const code = providerCodeOf(error.underlying)

  return code !== undefined && customerNotFoundProviderCodes.includes(String(code).trim())
}

export const fortnoxWriteRejectionCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.write.rejection-error-information',
  title: 'Rejected writes carry ErrorInformation with a code and message',
  safety: 'write-reversible',
  docs: 'Errors return a non-2xx status with an `ErrorInformation` envelope; the responses guide spells its fields `error`/`message`/`code` while the OpenAPI schema uses `Error`/`Message`/`Code`.',
  wire: 'Creating an invoice for a customer number that does not exist is rejected with a 4xx status and an `ErrorInformation` code and message: `fortnox.create_invoice` returns an `ActionResult` failure with `underlying.providerCode` and the provider message instead of the generic fallback. A rejected write changes nothing. The case first confirms the customer is absent (404, or another 4xx with a customer-not-found `ErrorInformation` code; 401, 403, and other failures abort before the write). It does not restore anything: if Fortnox unexpectedly accepted the write, an invoice would be created, and the case fails and names it for manual cancellation.',
  fixtures: [fortnoxWriteRejectionFixture.id],
  run: Effect.gen(function* () {
    const customerNumber = yield* requireSeed('missingCustomerNumber')

    const lookup = yield* fortnoxGetCustomerAction.executeTyped({
      integration,
      input: FortnoxGetCustomerInput.make({ customerNumber })
    })

    if (Predicate.isTagged(lookup, 'Success')) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: missingCustomerNumber exists in the practice company; nothing was written'
      })
    }

    yield* expectConformance(
      confirmsCustomerAbsent(lookup.error),
      'precondition: could not confirm that missingCustomerNumber is absent (expected 404, or a 4xx with a customer-not-found ErrorInformation code); nothing was written',
      { actual: lookup.error.status ?? null }
    )

    const result = yield* fortnoxCreateInvoiceAction.executeTyped({
      integration,
      input: FortnoxCreateInvoiceInput.make({
        CustomerNumber: customerNumber,
        Comments: 'yolk-conformance probe: expected to be rejected'
      })
    })

    if (Predicate.isTagged(result, 'Success')) {
      return yield* new ConformanceMismatch({
        message: `expected a rejection, but Fortnox created invoice ${result.value.DocumentNumber}; cancel it by hand`
      })
    }

    const { status, message } = result.error

    yield* expectConformance(
      status !== undefined && status >= 400 && status < 500,
      'expected a 4xx rejection',
      { actual: status ?? null }
    )
    yield* expectConformance(
      providerCodeOf(result.error.underlying) !== undefined,
      'expected an ErrorInformation provider code (underlying.providerCode)'
    )
    yield* expectConformance(
      message.trim().length > 0 && message !== `Fortnox request failed (HTTP ${status})`,
      'expected the ErrorInformation message instead of the generic fallback'
    )
  })
})

const InvoiceEnvelope = Schema.Struct({ Invoice: FortnoxInvoiceApi })

const OptionalEmailAddress = Schema.optional(Schema.NullOr(Schema.String))

/** The recipients of an invoice email as `GET /3/invoices/{DocumentNumber}` reports them. */
const InvoiceEmailRecipientsEnvelope = Schema.Struct({
  Invoice: Schema.Struct({
    DocumentNumber: FortnoxDocumentNumber,
    EmailInformation: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          EmailAddressTo: OptionalEmailAddress,
          EmailAddressCC: OptionalEmailAddress,
          EmailAddressBCC: OptionalEmailAddress
        })
      )
    )
  })
})

type InvoiceEmailRecipients = (typeof InvoiceEmailRecipientsEnvelope.Type)['Invoice']

const emailInvoiceReadId = 'fortnox.conformance.read_invoice_email_information'

const invoicePath = (documentNumber: FortnoxDocumentNumber) =>
  `invoices/${encodeURIComponent(documentNumber)}`

const isUnsetAddress = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim().length === 0

export const fortnoxInvoiceSendEmailCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.invoice.send-email',
  title: 'Sending an invoice by email answers with the invoice',
  safety: 'write-irreversible',
  docs: 'GET /3/invoices/{DocumentNumber}/email sends the invoice by email to the customer invoice address and returns the invoice.',
  wire: 'The send request answers 2xx with an `Invoice` envelope for the same DocumentNumber. Whether a test (practice) company actually delivers the email is not established: record delivery evidence by hand. Before sending, the case reads the invoice and aborts unless `EmailInformation.EmailAddressTo` equals the host-supplied `emailRecipient` seed exactly and no CC/BCC address is set. The connector has no send action, so the send is a raw GET through the shared Fortnox request helper with manual redirects and no ambient credentials (any 3xx fails the case), and the case never runs live unless a person allows its exact id.',
  fixtures: [fortnoxInvoiceSendEmailFixture.id],
  run: Effect.gen(function* () {
    const documentNumber = yield* requireSeed('emailInvoiceDocumentNumber')
    const recipient = yield* requireSeed('emailRecipient')

    const recipients: InvoiceEmailRecipients = yield* readFortnox(
      integration,
      FortnoxInvoiceOAuthCredentialSlot,
      invoicePath(documentNumber),
      InvoiceEmailRecipientsEnvelope,
      envelope => envelope.Invoice
    ).pipe(Effect.flatMap(result => successValue(emailInvoiceReadId, result)))

    const email = recipients.EmailInformation ?? undefined

    // Addresses are never echoed: they may be personal data.
    yield* expectConformance(
      email?.EmailAddressTo === recipient,
      'precondition: the email invoice EmailInformation.EmailAddressTo does not equal FortnoxConformanceConfig.emailRecipient exactly; nothing was sent'
    )
    yield* expectConformance(
      isUnsetAddress(email?.EmailAddressCC) && isUnsetAddress(email?.EmailAddressBCC),
      'precondition: the email invoice has an EmailAddressCC or EmailAddressBCC; clear them so only emailRecipient is addressed; nothing was sent'
    )

    // Manual redirects and no ambient credentials: a redirect must never be followed (or count as
    // sent) on this irreversible request.
    const response = yield* getFortnoxResponse(
      integration,
      FortnoxInvoiceOAuthCredentialSlot,
      `${invoicePath(documentNumber)}/email`,
      { redirect: 'manual', credentials: 'omit' }
    )

    yield* expectConformance(
      response.status < 300 || response.status >= 400,
      'expected no redirect from the email send; a 3xx is not treated as sent',
      { actual: response.status }
    )
    yield* expectConformance(
      response.status >= 200 && response.status < 300,
      'expected a 2xx response to the email send',
      { actual: response.status }
    )

    const invoice = invoiceFromApi((yield* decodeJsonResponse(InvoiceEnvelope, response)).Invoice)

    yield* expectEqual(
      invoice.DocumentNumber,
      documentNumber,
      'expected the response to carry the sent invoice'
    )
  })
})

/** Every Fortnox conformance case, in fixture order. */
export const fortnoxConformanceCases: ReadonlyArray<FortnoxConformanceCase> = [
  fortnoxInvoiceListPopulatedCase,
  fortnoxInvoicePreviewPdfCase,
  fortnoxInvoicePaymentFiltersCase,
  fortnoxInvoiceRowDiscountCase,
  fortnoxCustomerEmptyStringCase,
  fortnoxWriteRejectionCase,
  fortnoxInvoiceSendEmailCase
]
