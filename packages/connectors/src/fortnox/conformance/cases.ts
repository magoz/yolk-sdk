/**
 * Fortnox conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case proves one claim about how the real Fortnox API behaves where it differs from (or
 * goes beyond) its documentation, and runs through the REAL connector actions and helpers over
 * the connector ports (`ConnectorHttpClient`, `ConnectorBinaryHttpClient`, `CredentialResolver`)
 * plus the host-supplied `FortnoxConformanceConfig` seed identities. The same cases run on replay
 * fixtures, an emulator, or by hand against a Fortnox developer test company ("practice
 * account"). None is observed live yet (`observed` absent = unverified).
 *
 * Write cases restore what they change and report (never swallow) a failed restore.
 */
import { Cause, Chunk, Context, Data, Effect, Exit, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import type { ConnectorBinaryHttpClient } from '../../binary-http.ts'
import {
  makeCredentialBinding,
  resolveCredential,
  type CredentialResolver
} from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import type { ConnectorFileTransferError } from '../../file-transfer.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../../http.ts'
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
import { fortnoxApiBaseUrl } from '../shared.ts'
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
  emailInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber)
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

/**
 * Restoring the practice account after a write case failed. The account may be left changed and
 * must be restored by hand. `caseOutcome` says whether the claim itself held before restoring.
 */
export class FortnoxConformanceRestoreFailed extends Data.TaggedError(
  'FortnoxConformanceRestoreFailed'
)<{
  readonly caseId: string
  readonly reason: string
  readonly caseOutcome: 'claim held' | 'claim failed'
}> {
  override get message(): string {
    return `${this.caseId}: restoring the practice account failed (${this.reason}); ${this.caseOutcome} before the restore. Restore the account by hand.`
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

const failureSummary = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)
  const tag = Predicate.hasProperty(value, '_tag') ? String(value._tag) : 'defect'
  const message = Predicate.hasProperty(value, 'message') ? String(value.message) : ''

  return message.length > 0 ? `${tag}: ${message}` : tag
}

/**
 * Run `use`, then ALWAYS run `restore` (also after a failure or interruption, uninterruptibly).
 * A failed restore fails the case with `FortnoxConformanceRestoreFailed`, which says whether the
 * claim itself held; otherwise the outcome of `use` is returned unchanged.
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
        return yield* new FortnoxConformanceRestoreFailed({
          caseId,
          reason: failureSummary(restored.cause),
          caseOutcome: Exit.isSuccess(outcome) ? 'claim held' : 'claim failed'
        })
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
  wire: 'A populated company returns at least one invoice together with `MetaInformation`, and list rows can send amounts as numeric strings (for example `CurrencyRate: "1"`) next to JSON numbers: `fortnox.list_invoices` decodes every row, reports pagination, and every amount is a finite number or unset.',
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

export const fortnoxInvoicePaymentFiltersCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.invoice.payment-filters-exclude-unbooked',
  title: 'Payment-status invoice filters leave out unbooked invoices',
  safety: 'read',
  docs: 'GET /3/invoices accepts `filter` values `cancelled`, `fullypaid`, `unpaid`, `unpaidoverdue`, and `unbooked`; the docs do not say how the payment-status filters treat unbooked invoices.',
  wire: 'An unbooked invoice with an outstanding balance appears under `filter=unbooked` but not under `filter=unpaid` or `filter=unpaidoverdue`, so an empty payment-status result does not prove nothing is outstanding.',
  fixtures: [fortnoxInvoicePaymentFiltersFixture.id],
  run: Effect.gen(function* () {
    const unbooked = yield* listAllInvoices('unbooked')

    const outstanding = unbooked.find(
      invoice =>
        invoice.Booked !== true &&
        invoice.Cancelled !== true &&
        invoice.Balance !== null &&
        invoice.Balance !== undefined &&
        invoice.Balance !== 0
    )

    if (outstanding === undefined) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: the practice company needs an unbooked, uncancelled invoice with a non-zero balance'
      })
    }

    for (const filter of ['unpaid', 'unpaidoverdue'] as const) {
      const listed = yield* listAllInvoices(filter)

      yield* expectConformance(
        !listed.some(invoice => invoice.DocumentNumber === outstanding.DocumentNumber),
        `expected the unbooked invoice to be absent from filter=${filter}`,
        { expected: 'absent', actual: 'present' }
      )
    }
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

const originalDiscount = (row: FortnoxInvoiceRow): number => row.Discount ?? 0

/**
 * Writable fields of a read row, without `RowId` (positional matching) and without read-only
 * totals. `discount` controls the pricing fields: the original values sent explicitly, a set
 * percent discount, or both `Discount` and `DiscountType` omitted.
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
      out.Discount = originalDiscount(row)
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

// What a restore must bring back, per row. RowIds are regenerated on every update.
const rowSignature = (row: FortnoxInvoiceRow) => ({
  ArticleNumber: row.ArticleNumber ?? null,
  Description: row.Description ?? null,
  DeliveredQuantity: row.DeliveredQuantity ?? null,
  Price: row.Price ?? null,
  Discount: originalDiscount(row),
  DiscountType: row.DiscountType ?? null
})

/** Send the original rows with explicit discounts, then verify them by reading back. */
const restoreInvoiceRows = (
  documentNumber: FortnoxDocumentNumber,
  rows: ReadonlyArray<FortnoxInvoiceRow>
) =>
  Effect.gen(function* () {
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
  })

const rowDiscountCaseId = 'fortnox.invoice.row-discount-sticky'

export const fortnoxInvoiceRowDiscountCase: FortnoxConformanceCase = defineConformanceCase({
  id: rowDiscountCaseId,
  title: 'An omitted row Discount keeps its previous value on positional row updates',
  safety: 'write-reversible',
  docs: 'PUT /3/invoices/{DocumentNumber} with `InvoiceRows` replaces the row list; without `RowId`, rows are matched to existing rows by position. The docs do not say what happens to pricing fields left out of a matched row.',
  wire: 'On an unbooked invoice, a positionally matched row sent WITHOUT `Discount` keeps its previous discount (10 stays 10); only an explicit `Discount: 0` clears it. The case restores the original rows (with explicit discounts) afterwards and verifies them.',
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
    // The case writes `DiscountType: PERCENT`; an unset original type could not be restored.
    yield* expectConformance(
      rows.every(row => row.DiscountType === 'PERCENT'),
      'precondition: every discount invoice row must already have DiscountType PERCENT, so restoring the rows cannot change it'
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
      restoreInvoiceRows(documentNumber, rows)
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

export const fortnoxWriteRejectionCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.write.rejection-error-information',
  title: 'Rejected writes carry ErrorInformation with a code and message',
  safety: 'write-reversible',
  docs: 'Errors return a non-2xx status with an `ErrorInformation` envelope; the responses guide spells its fields `error`/`message`/`code` while the OpenAPI schema uses `Error`/`Message`/`Code`.',
  wire: 'Creating an invoice for a customer number that does not exist is rejected with a 4xx status and an `ErrorInformation` code and message: `fortnox.create_invoice` returns an `ActionResult` failure with `underlying.providerCode` and the provider message instead of the generic fallback. A rejected write changes nothing. The case first confirms the customer is missing (404) and aborts otherwise; the residual risk is that if Fortnox unexpectedly accepted the write, an invoice would be created (the case then fails and names it for manual clean-up).',
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

    yield* expectEqual(
      lookup.error.status ?? null,
      404,
      'precondition: could not confirm that missingCustomerNumber is absent (expected 404); nothing was written'
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

// Same credential rules as the connector's own Fortnox requests.
const fortnoxAccessToken = Effect.gen(function* () {
  const credential = yield* resolveCredential(integration, FortnoxInvoiceOAuthCredentialSlot)

  if (
    !Predicate.isTagged(credential, 'OAuthCredential') ||
    credential.provider !== 'fortnox' ||
    !/^[\x21-\x7e]+$/.test(credential.accessToken)
  ) {
    return yield* new ConnectorError({
      cause: 'credential_invalid',
      message: 'Fortnox requires a Fortnox OAuth credential with a non-empty access token',
      connectorId: integration.connectorId,
      slotId: FortnoxInvoiceOAuthCredentialSlot.id
    })
  }

  return credential.accessToken
})

export const fortnoxInvoiceSendEmailCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.invoice.send-email',
  title: 'Sending an invoice by email answers with the invoice',
  safety: 'write-irreversible',
  docs: 'GET /3/invoices/{DocumentNumber}/email sends the invoice by email to the customer invoice address and returns the invoice.',
  wire: 'The send request answers 2xx with an `Invoice` envelope for the same DocumentNumber. Whether a test (practice) company actually delivers the email is not established: record delivery evidence by hand. The connector has no send action, so this case uses the raw ConnectorHttpClient and never runs live unless a person allows its exact id.',
  fixtures: [fortnoxInvoiceSendEmailFixture.id],
  run: Effect.gen(function* () {
    const documentNumber = yield* requireSeed('emailInvoiceDocumentNumber')
    const token = yield* fortnoxAccessToken
    const http = yield* ConnectorHttpClient

    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url: `${fortnoxApiBaseUrl}/invoices/${encodeURIComponent(documentNumber)}/email`,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'manual',
        credentials: 'omit'
      })
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
