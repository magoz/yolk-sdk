/**
 * Fortnox read-only resource conformance cases: company information, the customer list, and the
 * reads of the article, price, cost center, payment, offer, print template, inbox, settings,
 * settings register, profile, and bookkeeping modules (internal; `cases.ts` lists them and `index.ts`
 * re-exports them).
 *
 * Every case is `read`: it only sends `GET` requests through the REAL connector actions (and the
 * host-only offer preview and inbox file downloads) and needs no seed. Identities come from what
 * a list answers (the first row is read back by its key), so no account data is hard-coded and a
 * case aborts with a `precondition:` mismatch when the practice company holds nothing to read.
 * Each claims only what the connector relies on when it decodes the answer: the envelope, the
 * pagination metadata where the connector requires it, and the wire types the Fortnox API
 * reference (https://api.fortnox.se/apidocs) and its examples document (for example numeric
 * strings in list rows where single reads send JSON numbers). None is observed live yet; a
 * sub-claim neither the OpenAPI schema nor the archived examples settle is marked
 * "(unverified: ...)" in its `wire`. Value types the connector's decoders already enforce (finite
 * numbers, integers) are stated in `wire` as decoding facts, not checked again.
 */
import { Chunk, Effect, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual
} from '@yolk-sdk/conformance/case'
import type { TypedConnectorAction } from '../../action.ts'
import { binaryStringToBytes } from '../../base64-internal.ts'
import { ConnectorHttpClient } from '../../http.ts'
import {
  fortnoxGetAccountAction,
  fortnoxGetFinancialYearAction,
  fortnoxGetVoucherAction,
  fortnoxListAccountsAction,
  fortnoxListFinancialYearsAction,
  fortnoxListVoucherSeriesAction,
  fortnoxListVouchersAction,
  FortnoxGetAccountInput,
  FortnoxGetVoucherInput,
  FortnoxListAccountsInput,
  FortnoxListFinancialYearsInput,
  FortnoxListVoucherSeriesInput,
  FortnoxListVouchersInput,
  type FortnoxAccount,
  type FortnoxFinancialYear
} from '../bookkeeping.ts'
import {
  fortnoxGetArticleAction,
  fortnoxListArticlesAction,
  FortnoxGetArticleInput,
  FortnoxListArticlesInput,
  type FortnoxArticle
} from '../articles.ts'
import {
  fortnoxGetCostCenterAction,
  fortnoxListCostCentersAction,
  FortnoxGetCostCenterInput,
  FortnoxListCostCentersInput
} from '../cost-centers.ts'
import {
  downloadFortnoxInboxFile,
  fortnoxGetInboxFolderAction,
  FortnoxGetInboxFolderInput,
  type FortnoxInboxFile
} from '../inbox.ts'
import {
  fortnoxGetCompanyInformationAction,
  fortnoxGetCustomerAction,
  fortnoxListCustomersAction
} from '../index.ts'
import {
  downloadFortnoxOfferPreview,
  fortnoxGetOfferAction,
  fortnoxListOffersAction,
  FortnoxGetOfferInput,
  FortnoxListOffersInput
} from '../offers.ts'
import {
  fortnoxGetInvoicePaymentAction,
  fortnoxGetSupplierInvoicePaymentAction,
  fortnoxListInvoicePaymentsAction,
  fortnoxListSupplierInvoicePaymentsAction,
  FortnoxInvoicePaymentNumberInput,
  FortnoxListInvoicePaymentsInput,
  FortnoxListSupplierInvoicePaymentsInput,
  FortnoxSupplierInvoicePaymentNumberInput
} from '../payments.ts'
import {
  fortnoxGetPriceAction,
  fortnoxGetPriceListAction,
  fortnoxListPriceListsAction,
  fortnoxListPricesAction,
  FortnoxGetPriceInput,
  FortnoxGetPriceListInput,
  FortnoxListPriceListsInput,
  FortnoxListPricesInput
} from '../prices.ts'
import {
  fortnoxListPrintTemplatesAction,
  FortnoxListPrintTemplatesInput
} from '../print-templates.ts'
import { fortnoxGetProfileAction, FortnoxGetProfileInput } from '../profile.ts'
import {
  FortnoxGetCompanyInformationInput,
  FortnoxGetCustomerInput,
  FortnoxListCustomersInput
} from '../schemas.ts'
import {
  fortnoxGetCompanySettingsAction,
  fortnoxGetLockedPeriodAction,
  fortnoxGetPredefinedAccountAction,
  fortnoxListLabelsAction,
  fortnoxListPredefinedAccountsAction,
  FortnoxGetCompanySettingsInput,
  FortnoxGetLockedPeriodInput,
  FortnoxGetPredefinedAccountInput,
  FortnoxListLabelsInput,
  FortnoxListPredefinedAccountsInput
} from '../settings.ts'
import {
  fortnoxGetModeOfPaymentAction,
  fortnoxGetTermsOfDeliveryAction,
  fortnoxGetTermsOfPaymentAction,
  fortnoxGetUnitAction,
  fortnoxGetWayOfDeliveryAction,
  fortnoxListModesOfPaymentAction,
  fortnoxListTermsOfDeliveryAction,
  fortnoxListTermsOfPaymentAction,
  fortnoxListUnitsAction,
  fortnoxListWaysOfDeliveryAction,
  FortnoxGetModeOfPaymentInput,
  FortnoxGetTermsOfDeliveryInput,
  FortnoxGetTermsOfPaymentInput,
  FortnoxGetUnitInput,
  FortnoxGetWayOfDeliveryInput,
  FortnoxListModesOfPaymentInput,
  FortnoxListTermsOfDeliveryInput,
  FortnoxListTermsOfPaymentInput,
  FortnoxListUnitsInput,
  FortnoxListWaysOfDeliveryInput
} from '../settings-registers.ts'
import { fortnoxGetSieFileAction, FortnoxGetSieFileInput } from '../sie.ts'
import {
  fortnoxListVoucherFileConnectionsAction,
  FortnoxListVoucherFileConnectionsInput
} from '../voucher-files.ts'
import { fortnoxArticleListRowNumbersFixture } from './article-list-row-numbers.ts'
import { fortnoxAccountBalancesListGetFixture } from './bookkeeping-accounts.ts'
import { fortnoxFinancialYearByIdAndDateFixture } from './bookkeeping-financial-years.ts'
import { fortnoxSieFileIbm437Fixture } from './bookkeeping-sie-file.ts'
import { fortnoxVoucherListGetBalancedFixture } from './bookkeeping-vouchers.ts'
import { fortnoxCompanyInformationFixture } from './company-information.ts'
import { fortnoxCostCenterListMatchesGetFixture } from './cost-center-list-get.ts'
import { fortnoxCustomerListMatchesGetFixture } from './customer-list-get.ts'
import { fortnoxInboxFolderFileBytesFixture } from './inbox-folder-file.ts'
import { fortnoxInvoicePaymentReadFixture } from './invoice-payment-read.ts'
import { fortnoxOfferRowsAndPreviewFixture } from './offer-rows-preview.ts'
import { fortnoxPredefinedAccountsAndLabelsFixture } from './predefined-accounts-labels.ts'
import { fortnoxPriceTierMatchesSublistFixture } from './price-tier-sublist.ts'
import { fortnoxPrintTemplatesUnpaginatedFixture } from './print-templates.ts'
import { fortnoxProfileMeFixture } from './profile-me.ts'
import { fortnoxSettingsCompanyAndLockedPeriodFixture } from './settings-company-locked-period.ts'
import { fortnoxSettingsRegistersFixture } from './settings-registers.ts'
import { fortnoxSupplierInvoicePaymentReadFixture } from './supplier-invoice-payment-read.ts'
import {
  downloadBudget,
  fortnoxConformanceIntegration,
  hasPdfTrailer,
  isPdfStart,
  successValue,
  type FortnoxConformanceCase
} from './shared.ts'

const integration = fortnoxConformanceIntegration

/** Page size of every list a read case sends (one page is enough to find a row to read back). */
const listLimit = 10

type InputSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }

const read = <S extends InputSchema, A, R, E>(
  action: TypedConnectorAction<S, A, R, E>,
  input: S['Type']
) =>
  action
    .executeTyped({ integration, input })
    .pipe(Effect.flatMap(result => successValue(action.id, result)))

/** The first item of a list, or a `precondition:` mismatch naming what the company lacks. */
const firstOf = <A>(items: Chunk.Chunk<A>, lacking: string) => {
  const first = Chunk.toReadonlyArray(items)[0]

  return first === undefined ? precondition(lacking) : Effect.succeed(first)
}

type Scalar = string | number | boolean | null | undefined

/** Decoded scalar fields as a JSON record (unset reads as `null` on both sides of a compare). */
const scalars = (fields: Readonly<Record<string, Scalar>>): Schema.Json =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null]))

const precondition = (lacking: string) =>
  Effect.fail(new ConformanceMismatch({ message: `precondition: ${lacking}` }))

/**
 * Run `effect` with the host's `ConnectorHttpClient` wrapped so every response body is kept; the
 * requests and responses are the host's own, unchanged (no extra request is sent).
 */
const withResponseBodies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const bodies = yield* Ref.make<ReadonlyArray<string>>([])

    const observing = ConnectorHttpClient.of({
      request: request =>
        http
          .request(request)
          .pipe(Effect.tap(response => Ref.update(bodies, list => [...list, response.body])))
    })

    const value = yield* effect.pipe(Effect.provideService(ConnectorHttpClient, observing))

    return { value, bodies: yield* Ref.get(bodies) }
  })

const decodeMetaEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ MetaInformation: Schema.optionalKey(Schema.Json) }))
)

/** Whether a raw JSON envelope carries a top-level `MetaInformation` key. */
const carriesMetaInformation = (body: string): boolean => {
  const envelope = decodeMetaEnvelope(body)

  return Option.isSome(envelope) && envelope.value.MetaInformation !== undefined
}

/** Every observed answer of an unpaginated list leaves out `MetaInformation`. */
const expectUnpaginated = (bodies: ReadonlyArray<string>, list: string) =>
  expectConformance(
    bodies.length > 0 && !bodies.some(carriesMetaInformation),
    `expected the ${list} to carry no MetaInformation`
  )

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u

type Pagination = {
  readonly currentPage: number
  readonly totalPages: number
  readonly totalResources: number
}

/** `MetaInformation` decoded to pagination that covers the rows one page returned. */
const expectPagination = (pagination: Pagination, returned: number, list: string) =>
  expectConformance(
    pagination.currentPage === 1 &&
      pagination.totalPages >= 1 &&
      pagination.totalResources >= returned,
    `expected ${list} pagination metadata covering the returned rows`,
    {
      actual: {
        currentPage: pagination.currentPage,
        totalPages: pagination.totalPages,
        totalResources: pagination.totalResources,
        returned
      }
    }
  )

// Company information --------------------------------------------------------------------------

export const fortnoxCompanyInformationCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.company.information-decodes',
  title: 'Company information decodes from its CompanyInformation envelope',
  safety: 'read',
  docs: 'GET /3/companyinformation returns the `CompanyInformation` object (company name, organisation number, addresses) of the company the token belongs to.',
  wire: '`fortnox.get_company_information` decodes the `CompanyInformation` envelope (`DatabaseNumber` an integer or unset, the other fields strings or unset) with a non-empty `CompanyName`.',
  fixtures: [fortnoxCompanyInformationFixture.id],
  run: Effect.gen(function* () {
    const company = yield* read(
      fortnoxGetCompanyInformationAction,
      FortnoxGetCompanyInformationInput.make({})
    )

    yield* expectConformance(
      company.CompanyName.trim().length > 0,
      'expected a non-empty CompanyName'
    )
  })
})

// Customers ------------------------------------------------------------------------------------

export const fortnoxCustomerListMatchesGetCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.customer.list-matches-get',
  title: 'Customer lists page with MetaInformation and their rows read back by CustomerNumber',
  safety: 'read',
  docs: 'GET /3/customers returns `Customers` plus `MetaInformation`; GET /3/customers/{CustomerNumber} returns one `Customer`.',
  wire: '`fortnox.list_customers` (limit 10) decodes every row and pagination metadata covering them; the first row read back with `fortnox.get_customer` has the same `CustomerNumber` and `Name` (a mismatch never echoes either value: they may be personal data). Aborts with a precondition when the company has no customer.',
  fixtures: [fortnoxCustomerListMatchesGetFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* read(
      fortnoxListCustomersAction,
      FortnoxListCustomersInput.make({ limit: listLimit })
    )

    yield* expectPagination(listed.pagination, Chunk.size(listed.customers), 'customer')

    const row = yield* firstOf(listed.customers, 'the practice company needs a customer')

    const customer = yield* read(
      fortnoxGetCustomerAction,
      FortnoxGetCustomerInput.make({ customerNumber: row.CustomerNumber })
    )

    // Customer numbers and names are never echoed: they may be personal data.
    yield* expectConformance(
      customer.CustomerNumber === row.CustomerNumber,
      'expected the listed customer to read back with the same CustomerNumber'
    )
    yield* expectConformance(
      (customer.Name ?? null) === (row.Name ?? null),
      'expected the listed customer to read back with the same Name'
    )
  })
})

// Articles -------------------------------------------------------------------------------------

/** The article amounts Fortnox lists as numeric strings and reads as JSON numbers. */
const articleAmounts = (article: FortnoxArticle) => ({
  VAT: article.VAT,
  SalesPrice: article.SalesPrice,
  PurchasePrice: article.PurchasePrice,
  QuantityInStock: article.QuantityInStock
})

export const fortnoxArticleListRowNumbersCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.article.list-row-numeric-strings',
  title: 'Article list rows and single reads decode to the same amounts',
  safety: 'read',
  docs: 'GET /3/articles returns `Articles` plus `MetaInformation`, and the docs examples send `VAT`, `SalesPrice`, `PurchasePrice`, and `QuantityInStock` in list rows as numeric strings; GET /3/articles/{ArticleNumber} sends them as JSON numbers.',
  wire: '`fortnox.list_articles` (limit 10) decodes every row and pagination metadata; the first row read back with `fortnox.get_article` has the same `ArticleNumber`, and its `VAT`, `SalesPrice`, `PurchasePrice`, and `QuantityInStock` decode to the same values whichever wire type each answer uses (decoding enforces a finite number or unset). Aborts with a precondition when the company has no article.',
  fixtures: [fortnoxArticleListRowNumbersFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* read(
      fortnoxListArticlesAction,
      FortnoxListArticlesInput.make({ limit: listLimit })
    )

    yield* expectPagination(listed.pagination, Chunk.size(listed.articles), 'article')

    const row = yield* firstOf(listed.articles, 'the practice company needs an article')

    const article = yield* read(
      fortnoxGetArticleAction,
      FortnoxGetArticleInput.make({ articleNumber: row.ArticleNumber })
    )

    yield* expectEqual(
      scalars({ ArticleNumber: article.ArticleNumber, ...articleAmounts(article) }),
      scalars({ ArticleNumber: row.ArticleNumber, ...articleAmounts(row) }),
      'expected the list row and the single read to decode to the same amounts'
    )
  })
})

// Price lists and prices -----------------------------------------------------------------------

export const fortnoxPriceTierMatchesSublistCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.price.tier-matches-sublist',
  title: 'Price tiers read back as listed, and SalesPrice is the default price list base price',
  safety: 'read',
  docs: 'GET /3/pricelists lists price lists (one is `PreSelected`, the default); GET /3/prices/sublist/{PriceList}/{ArticleNumber} lists one article’s quantity tiers; GET /3/prices/{PriceList}/{ArticleNumber}/{FromQuantity} reads one tier. The article docs describe `SalesPrice` as the price in the default price list.',
  wire: '`fortnox.list_price_lists` (limit 10) holds a `PreSelected` price list that `fortnox.get_price_list` reads back with the same `Code`, `Description`, and `PreSelected`; for the first article of `fortnox.list_articles` (limit 1), `fortnox.list_prices` lists its tiers in that list, the first tier read back with `fortnox.get_price` has the same `Price` and `FromQuantity`, and the article’s `SalesPrice` equals the price of its `FromQuantity` 0 tier. Aborts with a precondition without a PreSelected price list, an article, or a base tier.',
  fixtures: [fortnoxPriceTierMatchesSublistFixture.id],
  run: Effect.gen(function* () {
    const priceLists = yield* read(
      fortnoxListPriceListsAction,
      FortnoxListPriceListsInput.make({ limit: listLimit })
    )

    yield* expectPagination(priceLists.pagination, Chunk.size(priceLists.priceLists), 'price list')

    const preSelected = Chunk.toReadonlyArray(priceLists.priceLists).find(
      priceList => priceList.PreSelected === true
    )

    if (preSelected === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: the practice company needs a PreSelected price list among the first ${listLimit}`
      })
    }

    const priceList = yield* read(
      fortnoxGetPriceListAction,
      FortnoxGetPriceListInput.make({ code: preSelected.Code })
    )

    yield* expectEqual(
      scalars({
        Code: priceList.Code,
        Description: priceList.Description,
        PreSelected: priceList.PreSelected
      }),
      scalars({
        Code: preSelected.Code,
        Description: preSelected.Description,
        PreSelected: preSelected.PreSelected
      }),
      'expected the PreSelected price list to read back as listed'
    )

    const articles = yield* read(
      fortnoxListArticlesAction,
      FortnoxListArticlesInput.make({ limit: 1 })
    )

    const article = yield* firstOf(articles.articles, 'the practice company needs an article')

    const tiers = yield* read(
      fortnoxListPricesAction,
      FortnoxListPricesInput.make({
        priceList: preSelected.Code,
        articleNumber: article.ArticleNumber
      })
    )

    yield* expectPagination(tiers.pagination, Chunk.size(tiers.prices), 'price')

    const tier = yield* firstOf(
      tiers.prices,
      'the first article needs a price in the PreSelected price list'
    )

    const price = yield* read(
      fortnoxGetPriceAction,
      FortnoxGetPriceInput.make({
        priceList: tier.PriceList,
        articleNumber: tier.ArticleNumber,
        fromQuantity: tier.FromQuantity
      })
    )

    yield* expectEqual(
      scalars({ FromQuantity: price.FromQuantity, Price: price.Price }),
      scalars({ FromQuantity: tier.FromQuantity, Price: tier.Price }),
      'expected the price tier to read back as listed'
    )

    const base = Chunk.toReadonlyArray(tiers.prices).find(candidate => candidate.FromQuantity === 0)

    if (base === undefined) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: the first article needs a base price (FromQuantity 0) in the PreSelected price list'
      })
    }

    yield* expectEqual(
      article.SalesPrice ?? null,
      base.Price ?? null,
      'expected the article SalesPrice to equal its base price in the PreSelected price list'
    )
  })
})

// Cost centers ---------------------------------------------------------------------------------

export const fortnoxCostCenterListMatchesGetCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.cost-center.list-matches-get',
  title: 'Cost center lists page with MetaInformation and their rows read back by Code',
  safety: 'read',
  docs: 'GET /3/costcenters returns `CostCenters` plus `MetaInformation`; GET /3/costcenters/{Code} returns one `CostCenter`.',
  wire: '`fortnox.list_cost_centers` (limit 10) decodes every row and pagination metadata; the first row read back with `fortnox.get_cost_center` has the same `Code`, `Description`, and `Active`. Aborts with a precondition when the company has no cost center.',
  fixtures: [fortnoxCostCenterListMatchesGetFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* read(
      fortnoxListCostCentersAction,
      FortnoxListCostCentersInput.make({ limit: listLimit })
    )

    yield* expectPagination(listed.pagination, Chunk.size(listed.costCenters), 'cost center')

    const row = yield* firstOf(listed.costCenters, 'the practice company needs a cost center')

    const costCenter = yield* read(
      fortnoxGetCostCenterAction,
      FortnoxGetCostCenterInput.make({ code: row.Code })
    )

    yield* expectEqual(
      scalars({
        Code: costCenter.Code,
        Description: costCenter.Description,
        Active: costCenter.Active
      }),
      scalars({ Code: row.Code, Description: row.Description, Active: row.Active }),
      'expected the listed cost center to read back as listed'
    )
  })
})

// Payments -------------------------------------------------------------------------------------

type PaymentFields = {
  readonly Number: string
  readonly InvoiceNumber: string
  readonly Amount?: number | null | undefined
  readonly PaymentDate?: string | null | undefined
  readonly VoucherNumber?: number | null | undefined
  readonly VoucherYear?: number | null | undefined
}

const paymentFields = (payment: PaymentFields) => ({
  Number: payment.Number,
  InvoiceNumber: payment.InvoiceNumber,
  Amount: payment.Amount,
  PaymentDate: payment.PaymentDate,
  VoucherNumber: payment.VoucherNumber,
  VoucherYear: payment.VoucherYear
})

export const fortnoxInvoicePaymentReadCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.payment.invoice-payment-wire-numbers',
  title: 'Invoice payments decode numeric-string voucher fields and read back by Number',
  safety: 'read',
  docs: 'GET /3/invoicepayments returns `InvoicePayments` plus `MetaInformation`; GET /3/invoicepayments/{Number} returns one `InvoicePayment`. The docs examples send `VoucherNumber`, `VoucherYear`, and `ModeOfPaymentAccount` as numeric strings.',
  wire: '`fortnox.list_invoice_payments` (limit 10) decodes every row and pagination metadata; `VoucherNumber`, `VoucherYear`, and `ModeOfPaymentAccount` decode from numeric strings or numbers (decoding enforces an integer or unset); the first row read back with `fortnox.get_invoice_payment` has the same `Number`, `InvoiceNumber`, `Amount`, `PaymentDate`, voucher fields, and `ModeOfPaymentAccount`. Aborts with a precondition when the company has no invoice payment.',
  fixtures: [fortnoxInvoicePaymentReadFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* read(
      fortnoxListInvoicePaymentsAction,
      FortnoxListInvoicePaymentsInput.make({ limit: listLimit })
    )

    const rows = Chunk.toReadonlyArray(listed.invoicePayments)

    yield* expectPagination(listed.pagination, rows.length, 'invoice payment')

    const row = yield* firstOf(
      listed.invoicePayments,
      'the practice company needs an invoice payment'
    )

    const payment = yield* read(
      fortnoxGetInvoicePaymentAction,
      FortnoxInvoicePaymentNumberInput.make({ paymentNumber: row.Number })
    )

    yield* expectEqual(
      scalars({ ...paymentFields(payment), ModeOfPaymentAccount: payment.ModeOfPaymentAccount }),
      scalars({ ...paymentFields(row), ModeOfPaymentAccount: row.ModeOfPaymentAccount }),
      'expected the listed invoice payment to read back as listed'
    )
  })
})

export const fortnoxSupplierInvoicePaymentReadCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.payment.supplier-payment-wire-numbers',
  title: 'Supplier invoice payments decode numeric-string voucher fields and read back by Number',
  safety: 'read',
  docs: 'GET /3/supplierinvoicepayments returns `SupplierInvoicePayments` plus `MetaInformation`; GET /3/supplierinvoicepayments/{Number} returns one `SupplierInvoicePayment`. The docs examples send `VoucherNumber` and `VoucherYear` as numeric strings.',
  wire: '`fortnox.list_supplier_invoice_payments` (limit 10) decodes every row and pagination metadata; `VoucherNumber` and `VoucherYear` decode from numeric strings or numbers (decoding enforces an integer or unset); the first row read back with `fortnox.get_supplier_invoice_payment` has the same `Number`, `InvoiceNumber`, `Amount`, `PaymentDate`, and voucher fields. Aborts with a precondition when the company has no supplier invoice payment.',
  fixtures: [fortnoxSupplierInvoicePaymentReadFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* read(
      fortnoxListSupplierInvoicePaymentsAction,
      FortnoxListSupplierInvoicePaymentsInput.make({ limit: listLimit })
    )

    const rows = Chunk.toReadonlyArray(listed.supplierInvoicePayments)

    yield* expectPagination(listed.pagination, rows.length, 'supplier invoice payment')

    const row = yield* firstOf(
      listed.supplierInvoicePayments,
      'the practice company needs a supplier invoice payment'
    )

    const payment = yield* read(
      fortnoxGetSupplierInvoicePaymentAction,
      FortnoxSupplierInvoicePaymentNumberInput.make({ paymentNumber: row.Number })
    )

    yield* expectEqual(
      scalars(paymentFields(payment)),
      scalars(paymentFields(row)),
      'expected the listed supplier invoice payment to read back as listed'
    )
  })
})

// Offers ---------------------------------------------------------------------------------------

export const fortnoxOfferRowsAndPreviewCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.offer.rows-on-get-and-preview-pdf',
  title: 'Offer rows come from a single read, and the offer preview is a complete PDF',
  safety: 'read',
  docs: 'GET /3/offers returns `Offers` plus `MetaInformation` (list rows without `OfferRows`); GET /3/offers/{DocumentNumber} returns one `Offer` with its `OfferRows` (the docs examples send row `Quantity` as a numeric string); GET /3/offers/{DocumentNumber}/preview returns the offer as a generated PDF without marking it sent.',
  wire: '`fortnox.list_offers` (limit 10) decodes every row and pagination metadata, and no list row carries `OfferRows` (unverified: the OpenAPI offer list item has no `OfferRows`, but no live run confirms Fortnox never sends them in a list); the first row read back with `fortnox.get_offer` has the same `DocumentNumber` and `CustomerNumber` and at least one row (decoding enforces each row `Quantity` a finite number or unset, sent as a numeric string or a number); `downloadFortnoxOfferPreview` returns bytes starting with `%PDF-` and ending with an `%%EOF` trailer. Aborts with a precondition when the company has no offer, or the first offer has no row.',
  fixtures: [fortnoxOfferRowsAndPreviewFixture.id],
  run: Effect.gen(function* () {
    const listed = yield* read(
      fortnoxListOffersAction,
      FortnoxListOffersInput.make({ limit: listLimit })
    )

    const rows = Chunk.toReadonlyArray(listed.offers)

    yield* expectPagination(listed.pagination, rows.length, 'offer')
    yield* expectConformance(
      rows.every(offer => offer.OfferRows === undefined),
      'expected offer list rows to carry no OfferRows',
      {
        actual: rows.flatMap(offer => (offer.OfferRows === undefined ? [] : [offer.DocumentNumber]))
      }
    )

    const row = yield* firstOf(listed.offers, 'the practice company needs an offer')

    const offer = yield* read(
      fortnoxGetOfferAction,
      FortnoxGetOfferInput.make({ documentNumber: row.DocumentNumber })
    )

    yield* expectEqual(
      scalars({ DocumentNumber: offer.DocumentNumber, CustomerNumber: offer.CustomerNumber }),
      scalars({ DocumentNumber: row.DocumentNumber, CustomerNumber: row.CustomerNumber }),
      'expected the listed offer to read back with the same DocumentNumber and CustomerNumber'
    )

    const offerRows = Chunk.toReadonlyArray(offer.OfferRows ?? Chunk.empty())

    yield* expectConformance(
      offerRows.length > 0,
      'precondition: the first listed offer needs at least one row'
    )

    const preview = yield* downloadFortnoxOfferPreview(
      integration,
      { documentNumber: row.DocumentNumber },
      downloadBudget
    )

    yield* expectConformance(isPdfStart(preview.bytes), 'expected the preview to start with %PDF-')
    yield* expectConformance(
      hasPdfTrailer(preview.bytes),
      'expected a complete PDF ending with an %%EOF trailer'
    )
  })
})

// Print templates ------------------------------------------------------------------------------

export const fortnoxPrintTemplatesUnpaginatedCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.print-templates.unpaginated',
  title: 'Print template lists are unpaginated and filtered by document type',
  safety: 'read',
  docs: 'GET /3/printtemplates returns `PrintTemplates` (`Template`, `Name`) for the document `type` (invoice when omitted); the docs list no pagination for it.',
  wire: '`fortnox.list_print_templates` decodes the invoice templates (no `type`) and the offer templates (`type=offer`), each raw answer (observed at the `ConnectorHttpClient` port) carries no `MetaInformation`, and each list holds at least one template (decoding enforces a non-empty `Template` code). Aborts with a precondition when either list is empty.',
  fixtures: [fortnoxPrintTemplatesUnpaginatedFixture.id],
  run: Effect.gen(function* () {
    for (const type of [undefined, 'offer'] as const) {
      const { value: listed, bodies } = yield* withResponseBodies(
        read(
          fortnoxListPrintTemplatesAction,
          FortnoxListPrintTemplatesInput.make(type === undefined ? {} : { type })
        )
      )

      const kind = type ?? 'invoice'

      yield* expectUnpaginated(bodies, `${kind} print templates`)
      yield* expectConformance(
        Chunk.size(listed.printTemplates) > 0,
        `precondition: the practice company needs a print template for ${kind}`
      )
    }
  })
})

// Inbox ----------------------------------------------------------------------------------------

/** How many direct subfolders of the root the inbox case reads while looking for a file. */
const inboxFolderCap = 12

export const fortnoxInboxFolderFileBytesCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.inbox.file-bytes-match-size',
  title: 'Inbox folders decode their files and subfolders, and a file downloads its listed Size',
  safety: 'read',
  docs: 'GET /3/inbox returns the root `Folder` (its `Files` and the static subfolders in `Folders`); GET /3/inbox/{Id} returns a subfolder for a folder Id and the file content for a file Id. The docs type file `Size` as a string while the examples send an integer.',
  wire: '`fortnox.get_inbox_folder` decodes the root folder with its subfolders; reading the root’s direct subfolders in order (at most 12) finds a file, and `downloadFortnoxInboxFile` returns exactly the file’s listed `Size` in bytes. Aborts with a precondition when neither the root nor those subfolders hold a file.',
  fixtures: [fortnoxInboxFolderFileBytesFixture.id],
  run: Effect.gen(function* () {
    const root = yield* read(fortnoxGetInboxFolderAction, FortnoxGetInboxFolderInput.make({}))
    const subfolders = Chunk.toReadonlyArray(root.Folders)

    yield* expectConformance(
      subfolders.length > 0,
      'expected the inbox root to list its subfolders'
    )

    let file: FortnoxInboxFile | undefined = Chunk.toReadonlyArray(root.Files)[0]

    for (const subfolder of subfolders.slice(0, inboxFolderCap)) {
      if (file !== undefined) break

      const folder = yield* read(
        fortnoxGetInboxFolderAction,
        FortnoxGetInboxFolderInput.make({ folderId: subfolder.Id })
      )

      file = Chunk.toReadonlyArray(folder.Files)[0]
    }

    if (file === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: the practice company needs an inbox file in the root or one of its first ${inboxFolderCap} subfolders`
      })
    }

    const downloaded = yield* downloadFortnoxInboxFile(
      integration,
      { fileId: file.Id },
      downloadBudget
    )

    yield* expectEqual(
      downloaded.bytes.byteLength,
      file.Size ?? null,
      'expected the downloaded file to be exactly its listed Size in bytes'
    )
  })
})

// Settings -------------------------------------------------------------------------------------

export const fortnoxSettingsCompanyAndLockedPeriodCase: FortnoxConformanceCase =
  defineConformanceCase({
    id: 'fortnox.settings.company-and-locked-period',
    title: 'Company settings and the locked period decode from their envelopes',
    safety: 'read',
    docs: 'GET /3/settings/company returns `CompanySettings`; GET /3/settings/lockedperiod returns `LockedPeriod` with the `EndDate` of the locked bookkeeping period.',
    wire: '`fortnox.get_company_settings` decodes `CompanySettings` with a non-empty `Name`; `fortnox.get_locked_period` decodes `LockedPeriod`, whose `EndDate` is a `YYYY-MM-DD` date, empty, or unset (unverified: how a company without a locked period answers; a 404 aborts with a precondition rather than failing the claim).',
    fixtures: [fortnoxSettingsCompanyAndLockedPeriodFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* read(
        fortnoxGetCompanySettingsAction,
        FortnoxGetCompanySettingsInput.make({})
      )

      yield* expectConformance(
        Predicate.isString(settings.Name) && settings.Name.trim().length > 0,
        'expected CompanySettings to carry a non-empty Name'
      )

      const lockedResult = yield* fortnoxGetLockedPeriodAction.executeTyped({
        integration,
        input: FortnoxGetLockedPeriodInput.make({})
      })

      if (Predicate.isTagged(lockedResult, 'Failure') && lockedResult.error.status === 404) {
        return yield* precondition('HTTP 404: no locked period, or the route is missing')
      }

      const locked = yield* successValue(fortnoxGetLockedPeriodAction.id, lockedResult)
      const endDate = locked.EndDate ?? ''

      yield* expectConformance(
        endDate === '' || isoDatePattern.test(endDate),
        'expected the locked period EndDate to be a YYYY-MM-DD date, empty, or unset',
        { actual: endDate }
      )
    })
  })

export const fortnoxPredefinedAccountsAndLabelsCase: FortnoxConformanceCase = defineConformanceCase(
  {
    id: 'fortnox.settings.predefined-accounts-and-labels',
    title: 'Predefined accounts and labels decode without pagination',
    safety: 'read',
    docs: 'GET /3/predefinedaccounts returns `PreDefinedAccounts` (`Name`, `Account`), GET /3/predefinedaccounts/{Name} one `PreDefinedAccount`, and GET /3/labels returns `Labels` (`Id`, `Description`); the docs list no pagination for either list.',
    wire: '`fortnox.list_predefined_accounts` decodes the accounts, and its raw answer (observed at the `ConnectorHttpClient` port) carries no `MetaInformation`; the first one read back with `fortnox.get_predefined_account` has the same `Name` and `Account`; `fortnox.list_labels` decodes the labels (possibly none) with distinct `Id`s, and its raw answer carries no `MetaInformation` either. Aborts with a precondition when the company has no predefined account.',
    fixtures: [fortnoxPredefinedAccountsAndLabelsFixture.id],
    run: Effect.gen(function* () {
      const { value: accounts, bodies: accountBodies } = yield* withResponseBodies(
        read(fortnoxListPredefinedAccountsAction, FortnoxListPredefinedAccountsInput.make({}))
      )

      yield* expectUnpaginated(accountBodies, 'predefined accounts')

      const row = yield* firstOf(
        accounts.predefinedAccounts,
        'the practice company needs a predefined account'
      )

      const account = yield* read(
        fortnoxGetPredefinedAccountAction,
        FortnoxGetPredefinedAccountInput.make({ name: row.Name })
      )

      yield* expectEqual(
        scalars({ Name: account.Name, Account: account.Account }),
        scalars({ Name: row.Name, Account: row.Account }),
        'expected the listed predefined account to read back as listed'
      )

      const { value: listedLabels, bodies: labelBodies } = yield* withResponseBodies(
        read(fortnoxListLabelsAction, FortnoxListLabelsInput.make({}))
      )

      yield* expectUnpaginated(labelBodies, 'labels')

      const labels = Chunk.toReadonlyArray(listedLabels.labels)

      yield* expectConformance(
        new Set(labels.map(label => label.Id)).size === labels.length,
        'expected every label to carry a distinct Id'
      )
    })
  }
)

// Settings registers ---------------------------------------------------------------------------

/** One Code-keyed register: its first listed entry and that entry read back, as compared fields. */
const registerReadBack = <Row extends { readonly Code: string }, ListR, ListE, GetR, GetE>(
  register: string,
  list: Effect.Effect<
    {
      readonly rows: Chunk.Chunk<Row>
      readonly pagination: Pagination
    },
    ListE,
    ListR
  >,
  get: (row: Row) => Effect.Effect<Row, GetE, GetR>,
  fields: (row: Row) => Readonly<Record<string, Scalar>>
) =>
  Effect.gen(function* () {
    const listed = yield* list

    yield* expectPagination(listed.pagination, Chunk.size(listed.rows), register)

    const row = yield* firstOf(listed.rows, `the practice company needs a ${register}`)
    const entry = yield* get(row)

    yield* expectEqual(
      scalars(fields(entry)),
      scalars(fields(row)),
      `expected the listed ${register} to read back as listed`
    )
  })

export const fortnoxSettingsRegistersCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.settings.registers-list-matches-get',
  title: 'Settings register lists page with MetaInformation and their rows read back by Code',
  safety: 'read',
  docs: 'GET /3/modesofpayments, /3/termsofpayments, /3/termsofdeliveries, /3/wayofdeliveries, and /3/units list a register (plus `MetaInformation`), and GET /3/<register>/{Code} reads one entry. The docs examples send a mode of payment `AccountNumber` as a string in list rows and as a number in single reads.',
  wire: 'For each of the five registers, the list action (limit 10) decodes every row and pagination metadata, and the first row read back with the get action by `Code` has the same fields (`Description`, plus `AccountNumber` for modes of payment, `DescriptionEnglish` for terms and ways of delivery, `CodeEnglish` for units); a mode of payment `AccountNumber` decodes to the same integer whichever wire type each answer uses (the docs examples send a string in list rows; the case does not require it). Aborts with a precondition when a register is empty.',
  fixtures: [fortnoxSettingsRegistersFixture.id],
  run: Effect.gen(function* () {
    yield* registerReadBack(
      'mode of payment',
      read(
        fortnoxListModesOfPaymentAction,
        FortnoxListModesOfPaymentInput.make({ limit: listLimit })
      ).pipe(
        Effect.map(listed => ({ rows: listed.modesOfPayment, pagination: listed.pagination }))
      ),
      row =>
        read(fortnoxGetModeOfPaymentAction, FortnoxGetModeOfPaymentInput.make({ code: row.Code })),
      entry => ({
        Code: entry.Code,
        Description: entry.Description,
        AccountNumber: entry.AccountNumber
      })
    )

    yield* registerReadBack(
      'terms of payment',
      read(
        fortnoxListTermsOfPaymentAction,
        FortnoxListTermsOfPaymentInput.make({ limit: listLimit })
      ).pipe(
        Effect.map(listed => ({ rows: listed.termsOfPayment, pagination: listed.pagination }))
      ),
      row =>
        read(
          fortnoxGetTermsOfPaymentAction,
          FortnoxGetTermsOfPaymentInput.make({ code: row.Code })
        ),
      entry => ({ Code: entry.Code, Description: entry.Description })
    )

    yield* registerReadBack(
      'terms of delivery',
      read(
        fortnoxListTermsOfDeliveryAction,
        FortnoxListTermsOfDeliveryInput.make({ limit: listLimit })
      ).pipe(
        Effect.map(listed => ({ rows: listed.termsOfDelivery, pagination: listed.pagination }))
      ),
      row =>
        read(
          fortnoxGetTermsOfDeliveryAction,
          FortnoxGetTermsOfDeliveryInput.make({ code: row.Code })
        ),
      entry => ({
        Code: entry.Code,
        Description: entry.Description,
        DescriptionEnglish: entry.DescriptionEnglish
      })
    )

    yield* registerReadBack(
      'way of delivery',
      read(
        fortnoxListWaysOfDeliveryAction,
        FortnoxListWaysOfDeliveryInput.make({ limit: listLimit })
      ).pipe(
        Effect.map(listed => ({ rows: listed.waysOfDelivery, pagination: listed.pagination }))
      ),
      row =>
        read(fortnoxGetWayOfDeliveryAction, FortnoxGetWayOfDeliveryInput.make({ code: row.Code })),
      entry => ({
        Code: entry.Code,
        Description: entry.Description,
        DescriptionEnglish: entry.DescriptionEnglish
      })
    )

    yield* registerReadBack(
      'unit',
      read(fortnoxListUnitsAction, FortnoxListUnitsInput.make({ limit: listLimit })).pipe(
        Effect.map(listed => ({ rows: listed.units, pagination: listed.pagination }))
      ),
      row => read(fortnoxGetUnitAction, FortnoxGetUnitInput.make({ code: row.Code })),
      entry => ({
        Code: entry.Code,
        Description: entry.Description,
        CodeEnglish: entry.CodeEnglish
      })
    )
  })
})

// Profile --------------------------------------------------------------------------------------

export const fortnoxProfileMeCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.profile.me',
  title: 'The token user profile decodes from its Me envelope',
  safety: 'read',
  docs: 'GET /3/me returns `Me` (`Id`, `Name`, `Email`, `Locale`, `SysAdmin`) for the user the token belongs to.',
  wire: '`fortnox.get_profile` decodes the `Me` envelope (`SysAdmin` a boolean or unset, the other fields strings or unset) with a non-empty `Id`.',
  fixtures: [fortnoxProfileMeFixture.id],
  run: Effect.gen(function* () {
    const me = yield* read(fortnoxGetProfileAction, FortnoxGetProfileInput.make({}))

    yield* expectConformance(
      Predicate.isString(me.Id) && me.Id.trim().length > 0,
      'expected the profile to carry a non-empty Id'
    )
  })
})

// Bookkeeping ----------------------------------------------------------------------------------

/** The first financial year a list answers (Fortnox lists the newest first). */
const firstFinancialYear = Effect.gen(function* () {
  const listed = yield* read(
    fortnoxListFinancialYearsAction,
    FortnoxListFinancialYearsInput.make({ limit: listLimit })
  )

  yield* expectPagination(listed.pagination, Chunk.size(listed.financialYears), 'financial year')

  return yield* firstOf(listed.financialYears, 'the practice company needs a financial year')
})

const financialYearFields = (year: FortnoxFinancialYear) =>
  scalars({
    Id: year.Id,
    FromDate: year.FromDate,
    ToDate: year.ToDate,
    AccountChartType: year.AccountChartType,
    AccountingMethod: year.AccountingMethod
  })

export const fortnoxFinancialYearByIdAndDateCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.bookkeeping.financial-year-by-id-and-date',
  title: 'Financial years read back by Id and by a date they contain',
  safety: 'read',
  docs: 'GET /3/financialyears returns `FinancialYears` plus `MetaInformation` (the archived example lists the newest year first and names the chart type `accountCharts`); GET /3/financialyears/{Id} returns one `FinancialYear`; `?date=YYYY-MM-DD` lists the year containing that date.',
  wire: '`fortnox.list_financial_years` (limit 10) decodes every row and pagination metadata covering them; the first row has `YYYY-MM-DD` `FromDate` and `ToDate` with `FromDate` not after `ToDate`, and reads back with the same fields both by `id` and by its `FromDate` (`fortnox.get_financial_year`), the chart type decoding the same whether sent as `AccountChartType` or `accountCharts` (unverified: which name live list rows use). Aborts with a precondition when the company has no financial year.',
  fixtures: [fortnoxFinancialYearByIdAndDateFixture.id],
  run: Effect.gen(function* () {
    const year = yield* firstFinancialYear

    yield* expectConformance(
      isoDatePattern.test(year.FromDate) &&
        isoDatePattern.test(year.ToDate) &&
        year.FromDate <= year.ToDate,
      'expected the financial year to span YYYY-MM-DD dates in order',
      { actual: { FromDate: year.FromDate, ToDate: year.ToDate } }
    )

    const byId = yield* read(fortnoxGetFinancialYearAction, { id: year.Id })
    const byDate = yield* read(fortnoxGetFinancialYearAction, { date: year.FromDate })

    yield* expectEqual(
      financialYearFields(byId),
      financialYearFields(year),
      'expected the financial year to read back by Id as listed'
    )
    yield* expectEqual(
      financialYearFields(byDate),
      financialYearFields(year),
      'expected the financial year to read back by its FromDate as listed'
    )
  })
})

const accountFields = (account: FortnoxAccount) =>
  scalars({
    Number: account.Number,
    Description: account.Description,
    Active: account.Active,
    BalanceBroughtForward: account.BalanceBroughtForward,
    BalanceCarriedForward: account.BalanceCarriedForward,
    Year: account.Year
  })

export const fortnoxAccountBalancesListGetCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.bookkeeping.account-balances-list-get',
  title: 'Accounts list per financial year and read back with the same balances',
  safety: 'read',
  docs: 'GET /3/accounts?financialyear={Id} returns `Accounts` plus `MetaInformation`, sorted by number, each with its opening `BalanceBroughtForward` and closing `BalanceCarriedForward` in that year; GET /3/accounts/{Number}?financialyear={Id} returns one `Account` (the archived example sends `Project` as the number 0).',
  wire: '`fortnox.list_accounts` (the first listed financial year, limit 10) decodes a populated page: pagination metadata covering the rows, account numbers ascending, every row in that year (`Year` its Id, or unset); the first account read back with `fortnox.get_account` in the same year has the same `Number`, `Description`, `Active`, `BalanceBroughtForward`, `BalanceCarriedForward`, and `Year` (decoding enforces finite balances or unset). Aborts with a precondition when the year has no account.',
  fixtures: [fortnoxAccountBalancesListGetFixture.id],
  run: Effect.gen(function* () {
    const year = yield* firstFinancialYear

    const listed = yield* read(
      fortnoxListAccountsAction,
      FortnoxListAccountsInput.make({ financialYearId: year.Id, limit: listLimit })
    )

    const rows = Chunk.toReadonlyArray(listed.accounts)

    yield* expectPagination(listed.pagination, rows.length, 'account')

    const first = yield* firstOf(listed.accounts, 'the first financial year needs an account')

    yield* expectConformance(
      rows.every((row, index) => index === 0 || (rows[index - 1]?.Number ?? 0) < row.Number),
      'expected accounts sorted by ascending number'
    )
    yield* expectConformance(
      rows.every(row => row.Year === undefined || row.Year === null || row.Year === year.Id),
      'expected every listed account in the requested financial year'
    )

    const account = yield* read(
      fortnoxGetAccountAction,
      FortnoxGetAccountInput.make({ accountNumber: first.Number, financialYearId: year.Id })
    )

    yield* expectEqual(
      accountFields(account),
      accountFields(first),
      'expected the listed account to read back with the same balances'
    )
  })
})

const toOre = (value: number | null | undefined) => Math.round((value ?? 0) * 100)

export const fortnoxVoucherListGetBalancedCase: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.bookkeeping.voucher-list-get-balanced',
  title: 'Vouchers list per financial year and read back with balanced rows',
  safety: 'read',
  docs: 'GET /3/vouchers?financialyear={Id} returns `Vouchers` plus `MetaInformation`; a voucher is unique by `VoucherSeries`, `VoucherNumber`, and `Year`, which every row carries; GET /3/vouchers/{VoucherSeries}/{VoucherNumber}?financialyear={Id} returns one `Voucher` with `VoucherRows`; GET /3/voucherseries lists `VoucherSeriesCollection`; GET /3/voucherfileconnections lists `VoucherFileConnections` (the archived examples send `VoucherNumber` as a string).',
  wire: '`fortnox.list_vouchers` (the first listed financial year, limit 10) decodes a populated page with pagination metadata covering the rows, every row in that year; `fortnox.list_voucher_series` for that year holds the first voucher’s series; `fortnox.get_voucher` reads the first voucher back with the same series, number, year, `Description`, and `TransactionDate`, at least two rows, and its rows not marked removed balance (total `Debit` equals total `Credit` in whole öre; unverified: how removed rows count); `fortnox.list_voucher_file_connections` for it decodes, and every connection names that voucher. Aborts with a precondition when the year has no voucher.',
  fixtures: [fortnoxVoucherListGetBalancedFixture.id],
  run: Effect.gen(function* () {
    const year = yield* firstFinancialYear

    const listed = yield* read(
      fortnoxListVouchersAction,
      FortnoxListVouchersInput.make({ financialYearId: year.Id, limit: listLimit })
    )

    yield* expectPagination(listed.pagination, Chunk.size(listed.vouchers), 'voucher')

    const first = yield* firstOf(listed.vouchers, 'the first financial year needs a voucher')

    yield* expectConformance(
      Chunk.toReadonlyArray(listed.vouchers).every(row => row.Year === year.Id),
      'expected every listed voucher in the requested financial year'
    )

    const series = yield* read(
      fortnoxListVoucherSeriesAction,
      FortnoxListVoucherSeriesInput.make({ financialYearId: year.Id, limit: 500 })
    )

    yield* expectConformance(
      Chunk.toReadonlyArray(series.voucherSeries).some(item => item.Code === first.VoucherSeries),
      'expected the voucher series list to hold the first voucher’s series'
    )

    const voucher = yield* read(
      fortnoxGetVoucherAction,
      FortnoxGetVoucherInput.make({
        voucherSeries: first.VoucherSeries,
        voucherNumber: first.VoucherNumber,
        financialYearId: year.Id
      })
    )

    yield* expectEqual(
      scalars({
        VoucherSeries: voucher.VoucherSeries,
        VoucherNumber: voucher.VoucherNumber,
        Year: voucher.Year,
        Description: voucher.Description,
        TransactionDate: voucher.TransactionDate
      }),
      scalars({
        VoucherSeries: first.VoucherSeries,
        VoucherNumber: first.VoucherNumber,
        Year: first.Year,
        Description: first.Description,
        TransactionDate: first.TransactionDate
      }),
      'expected the listed voucher to read back as listed'
    )

    const rows = Chunk.toReadonlyArray(voucher.VoucherRows ?? Chunk.empty()).filter(
      row => row.Removed !== true
    )

    const debit = rows.reduce((total, row) => total + toOre(row.Debit), 0)
    const credit = rows.reduce((total, row) => total + toOre(row.Credit), 0)

    yield* expectConformance(
      rows.length >= 2 && debit === credit,
      'expected the voucher to carry at least two rows that balance',
      { actual: { rows: rows.length, debit: debit / 100, credit: credit / 100 } }
    )

    const connections = yield* read(
      fortnoxListVoucherFileConnectionsAction,
      FortnoxListVoucherFileConnectionsInput.make({
        voucherSeries: voucher.VoucherSeries,
        voucherNumber: voucher.VoucherNumber,
        financialYearId: year.Id
      })
    )

    yield* expectConformance(
      Chunk.toReadonlyArray(connections.connections).every(
        connection =>
          connection.VoucherSeries === voucher.VoucherSeries &&
          connection.VoucherNumber === voucher.VoucherNumber
      ),
      'expected every voucher file connection to name the voucher'
    )
  })
})

const sieRecord = (bytes: Uint8Array, record: string) =>
  new TextDecoder('latin1')
    .decode(bytes)
    .split(/\r?\n/u)
    .some(line => line.trim() === record)

export const fortnoxSieFileIbm437Case: FortnoxConformanceCase = defineConformanceCase({
  id: 'fortnox.bookkeeping.sie-file-ibm437',
  title: 'A type 1 SIE file downloads as untouched PC8 bytes',
  safety: 'read',
  docs: 'GET /3/sie/{Type}?financialyear={Id} streams the SIE file (`application/octet-stream`); SIE filformat 4C requires `#FLAGGA` as the first record and IBM PC 8-bit text (`#FORMAT PC8`, code page 437).',
  wire: '`fortnox.get_sie_file` (type 1, the first listed financial year) returns bytes that start with `#FLAGGA` and hold the records `#FORMAT PC8` and `#SIETYP 1`, with `byteLength` equal to the decoded `contentBase64` length (unverified: whether Fortnox writes `#FORMAT PC8`). Aborts with a precondition when the company has no financial year.',
  fixtures: [fortnoxSieFileIbm437Fixture.id],
  run: Effect.gen(function* () {
    const year = yield* firstFinancialYear

    const file = yield* read(
      fortnoxGetSieFileAction,
      FortnoxGetSieFileInput.make({ sieType: 1, financialYearId: year.Id })
    )

    const bytes = binaryStringToBytes(atob(file.contentBase64))

    yield* expectEqual(
      file.byteLength,
      bytes.byteLength,
      'expected byteLength to equal the downloaded SIE bytes'
    )
    yield* expectConformance(
      sieRecord(bytes, '#FORMAT PC8') && sieRecord(bytes, '#SIETYP 1'),
      'expected the SIE file to declare #FORMAT PC8 and #SIETYP 1'
    )
  })
})

/** The read cases, in fixture order (`fortnoxConformanceCases` lists them after the other seven). */
export const fortnoxReadConformanceCases: ReadonlyArray<FortnoxConformanceCase> = [
  fortnoxCompanyInformationCase,
  fortnoxCustomerListMatchesGetCase,
  fortnoxArticleListRowNumbersCase,
  fortnoxPriceTierMatchesSublistCase,
  fortnoxCostCenterListMatchesGetCase,
  fortnoxInvoicePaymentReadCase,
  fortnoxSupplierInvoicePaymentReadCase,
  fortnoxOfferRowsAndPreviewCase,
  fortnoxPrintTemplatesUnpaginatedCase,
  fortnoxInboxFolderFileBytesCase,
  fortnoxSettingsCompanyAndLockedPeriodCase,
  fortnoxPredefinedAccountsAndLabelsCase,
  fortnoxSettingsRegistersCase,
  fortnoxProfileMeCase,
  fortnoxFinancialYearByIdAndDateCase,
  fortnoxAccountBalancesListGetCase,
  fortnoxVoucherListGetBalancedCase,
  fortnoxSieFileIbm437Case
]
