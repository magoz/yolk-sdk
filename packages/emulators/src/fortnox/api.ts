/**
 * Fortnox emulator API: the route table (with its evidence) and the stateful route handlers
 * registered on the `@emulators/core` app (internal; re-exported by `src/fortnox.ts`).
 *
 * Wire shapes follow the synthetic Fortnox conformance fixtures, copied as data. Each route lists
 * the conformance cases whose claims it follows; the observed quirks are implemented here.
 *
 * @experimental
 */
import type { Hono } from '@emulators/core'
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { handlerFailedResponse } from '../emulator-http.ts'
import type { EmulatorRouteEvidence } from '../route-evidence.ts'
import {
  buildRow,
  compareNumbers,
  defaultEmailInformation,
  formatQuantity,
  fortnoxEmulatorCountries,
  fortnoxEmulatorVatCodes,
  invoiceFromSeed,
  invoiceTotals,
  newRowDefaults,
  type FortnoxEmulatorCustomer,
  type FortnoxEmulatorInvoice,
  type FortnoxEmulatorInvoiceRow,
  type FortnoxEmulatorInvoiceRowSeed,
  type FortnoxEmulatorInvoiceSeed,
  type FortnoxEmulatorState
} from './state.ts'

/**
 * Drill knobs: each flips one observed quirk to the documented-but-wrong behavior, ONLY to prove
 * that the conformance cases catch a disagreement. Defaults follow the observed behavior.
 */
export type FortnoxEmulatorQuirks = {
  /** `false`: a positionally matched row that omits `Discount`/`DiscountType` resets them. */
  readonly stickyRowDiscount?: boolean
  /** `true`: a customer update with `""` clears the stored string instead of keeping it. */
  readonly emptyStringClears?: boolean
  /** `true`: `unpaid`/`unpaidoverdue`/`fullypaid` also match unbooked invoices. */
  readonly paymentFiltersIncludeUnbooked?: boolean
}

export type FortnoxApiEnv = {
  /** Clock in epoch milliseconds (the `unpaidoverdue` "today", new invoice dates, the outbox). */
  readonly now: () => number
  /** Origin used in `@url` links, for example `https://api.fortnox.se`. */
  readonly linkOrigin: string
  readonly quirks: Required<FortnoxEmulatorQuirks>
}

/**
 * `ErrorInformation` codes the emulator answers with. The two customer-not-found codes are copied
 * from the rejection fixture; the `2999xxx` codes are synthetic emulator codes.
 */
export const fortnoxEmulatorErrorCodes = {
  customerNotFound: 2000204,
  invoiceCustomerNotFound: 2000433,
  unauthorized: 2999001,
  invalidBody: 2999002,
  invalidField: 2999003,
  readOnlyField: 2999004,
  notEditable: 2999005,
  invoiceNotFound: 2999006,
  unknownRoute: 2999007,
  unsupportedQuery: 2999008,
  rateLimited: 2999009,
  upstreamError: 2999010
} as const

/** Fortnox API base path. */
export const fortnoxEmulatorBasePath = '/3'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/** A Fortnox `ErrorInformation` response with the lowercase fields of the rejection fixture. */
export const errorInformation = (status: number, code: number, message: string): Response =>
  jsonResponse(status, { ErrorInformation: { error: 1, message, code } })

const codes = fortnoxEmulatorErrorCodes

// Messages copied from the rejection fixture.
const customerNotFound = (): Response =>
  errorInformation(404, codes.customerNotFound, 'Synthetic placeholder: customer not found.')

const invoiceCustomerNotFound = (): Response =>
  errorInformation(400, codes.invoiceCustomerNotFound, 'Synthetic placeholder: customer not found.')

const invoiceNotFound = (): Response =>
  errorInformation(404, codes.invoiceNotFound, 'Synthetic: invoice not found.')

const invalidBody = (message: string): Response =>
  errorInformation(400, codes.invalidBody, `Synthetic: ${message}`)

const invalidField = (message: string): Response =>
  errorInformation(400, codes.invalidField, `Synthetic: ${message}`)

const noReferencedEntity = (kind: string, value: string): Response =>
  invalidField(`${kind} ${value} does not exist in the emulated company.`)

const readOnlyField = (message: string): Response =>
  errorInformation(400, codes.readOnlyField, `Synthetic: ${message}`)

const notEditable = (message: string): Response =>
  errorInformation(400, codes.notEditable, `Synthetic: ${message}`)

const unsupportedQuery = (key: string): Response =>
  errorInformation(
    400,
    codes.unsupportedQuery,
    key === 'lastmodified'
      ? 'Synthetic: query parameter lastmodified is not emulated (the emulator does not track modification times).'
      : `Synthetic: query parameter ${key} is not emulated.`
  )

// The synthetic invoice preview PDF from the preview fixture (`bodyBase64`), copied as data.
const previewPdfBase64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFtdIC9Db3VudCAwID4+CmVuZG9iagp0cmFpbGVyCjw8IC9Sb290IDEgMCBSID4+CiUlRU9GCg=='

const previewPdfBytes = (): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(previewPdfBase64), character => character.charCodeAt(0))

type RouteRequest = {
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** Parsed JSON body; `undefined` when absent or not JSON. */
  readonly body: Schema.Json | undefined
}

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

type RouteHandler = (
  state: FortnoxEmulatorState,
  request: RouteRequest,
  env: FortnoxApiEnv
) => Response

type FortnoxApiRoute = EmulatorRouteEvidence & {
  /**
   * Query parameters the route emulates; any other key answers 400 before the handler runs, so
   * a rejected request never writes. Empty by default.
   */
  readonly queryKeys: ReadonlyArray<string>
  readonly handler: RouteHandler
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

/** A real `YYYY-MM-DD` calendar date (no JavaScript rollover such as `2026-02-30`). */
const isIsoDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`)

  return (
    isoDatePattern.test(value) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  )
}

const today = (env: FortnoxApiEnv): string => new Date(env.now()).toISOString().slice(0, 10)

/** `date` plus `days`, or `undefined` when the result is not a representable `YYYY-MM-DD` date. */
const addDays = (date: string, days: number): string | undefined => {
  const result = new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000)

  if (Number.isNaN(result.getTime())) return undefined

  const iso = result.toISOString().slice(0, 10)

  return isIsoDate(iso) ? iso : undefined
}

const maxTermsOfPaymentDays = 365

/**
 * `TermsOfPayment` as a whole number of days (`0`–`365`, no sign or leading zeros), or
 * `undefined` when the value is not emulated. Fortnox also knows named terms (such as `K`); the
 * emulated company has day terms only.
 */
const termsOfPaymentDays = (value: string): number | undefined => {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(value)) return undefined

  const days = Number(value)

  return days <= maxTermsOfPaymentDays ? days : undefined
}

const unsupportedTermsOfPayment = (value: string): Response =>
  invalidField(
    `TermsOfPayment ${value} is not emulated (whole days from 0 to ${maxTermsOfPaymentDays} only).`
  )

/**
 * The customer categorical values the emulator deliberately models. This is the emulated subset,
 * not Fortnox's full enum: other values (for example export or EU reverse-charge VAT) would change
 * invoice VAT, which the emulator does not model, so they are rejected.
 */
const emulatedCustomerVatTypes: ReadonlyArray<string> = ['SEVAT']

const emulatedCustomerTypes: ReadonlyArray<string> = ['COMPANY', 'PRIVATE']

const unsupportedVatType = (value: string): Response =>
  invalidField(
    `VATType ${value} is not emulated (supported: ${emulatedCustomerVatTypes.join(', ')}).`
  )

const customerUrl = (env: FortnoxApiEnv, customerNumber: string): string =>
  `${env.linkOrigin}${fortnoxEmulatorBasePath}/customers/${encodeURIComponent(customerNumber)}`

const invoiceUrl = (env: FortnoxApiEnv, documentNumber: string): string =>
  `${env.linkOrigin}${fortnoxEmulatorBasePath}/invoices/${encodeURIComponent(documentNumber)}`

const renderCustomer = (env: FortnoxApiEnv, customer: FortnoxEmulatorCustomer) => ({
  '@url': customerUrl(env, customer.CustomerNumber),
  ...customer
})

// No fixture records the customer list: rows carry the list-only `Phone` and a subset of fields.
const renderCustomerRow = (env: FortnoxApiEnv, customer: FortnoxEmulatorCustomer) => ({
  '@url': customerUrl(env, customer.CustomerNumber),
  Address1: customer.Address1,
  Address2: customer.Address2,
  City: customer.City,
  CustomerNumber: customer.CustomerNumber,
  Email: customer.Email,
  Name: customer.Name,
  OrganisationNumber: customer.OrganisationNumber,
  Phone: customer.Phone1,
  ZipCode: customer.ZipCode
})

type EmailInformationFields = {
  -readonly [
    K in keyof FortnoxEmulatorInvoice['EmailInformation']
  ]: FortnoxEmulatorInvoice['EmailInformation'][K]
}

/**
 * A single-invoice read: JSON-number amounts. `dropEmptyCopies` leaves empty CC/BCC addresses out
 * of `EmailInformation`, as the email-send fixture response does.
 */
const renderInvoice = (
  env: FortnoxApiEnv,
  invoice: FortnoxEmulatorInvoice,
  dropEmptyCopies = false
) => {
  const source = invoice.EmailInformation

  const email: Partial<EmailInformationFields> = {
    EmailAddressFrom: source.EmailAddressFrom,
    EmailAddressTo: source.EmailAddressTo
  }

  if (!dropEmptyCopies || source.EmailAddressCC !== '') {
    email.EmailAddressCC = source.EmailAddressCC
  }

  if (!dropEmptyCopies || source.EmailAddressBCC !== '') {
    email.EmailAddressBCC = source.EmailAddressBCC
  }

  email.EmailSubject = source.EmailSubject
  email.EmailBody = source.EmailBody

  return {
    '@url': invoiceUrl(env, invoice.DocumentNumber),
    ...invoice,
    EmailInformation: email
  }
}

/** An invoice list row, in the list fixture's shape: `CurrencyRate` is a numeric string. */
const renderInvoiceRow = (env: FortnoxApiEnv, invoice: FortnoxEmulatorInvoice) => ({
  '@url': invoiceUrl(env, invoice.DocumentNumber),
  Balance: invoice.Balance,
  Booked: invoice.Booked,
  Cancelled: invoice.Cancelled,
  CostCenter: invoice.CostCenter,
  Currency: invoice.Currency,
  CurrencyRate: String(invoice.CurrencyRate),
  CurrencyUnit: invoice.CurrencyUnit,
  CustomerName: invoice.CustomerName,
  CustomerNumber: invoice.CustomerNumber,
  DocumentNumber: invoice.DocumentNumber,
  DueDate: invoice.DueDate,
  ExternalInvoiceReference1: invoice.ExternalInvoiceReference1,
  ExternalInvoiceReference2: invoice.ExternalInvoiceReference2,
  FinalPayDate: invoice.FinalPayDate,
  InvoiceDate: invoice.InvoiceDate,
  InvoiceType: invoice.InvoiceType,
  NoxFinans: invoice.NoxFinans,
  OCR: invoice.OCR,
  VoucherNumber: invoice.VoucherNumber,
  VoucherSeries: invoice.VoucherSeries,
  VoucherYear: invoice.VoucherYear,
  WayOfDelivery: invoice.WayOfDelivery,
  TermsOfPayment: invoice.TermsOfPayment,
  Project: invoice.Project,
  Sent: invoice.Sent,
  Total: invoice.Total
})

/** The 400 for the first query key the route does not emulate, or `undefined`. */
const unsupportedQueryKey = (
  query: URLSearchParams,
  allowed: ReadonlyArray<string>
): Response | undefined => {
  const key = [...query.keys()].find(candidate => !allowed.includes(candidate))

  return key === undefined ? undefined : unsupportedQuery(key)
}

const positiveInt = (
  query: URLSearchParams,
  key: string,
  fallback: number,
  maximum: number
): number | Response => {
  const raw = query.get(key)

  if (raw === null) {
    return fallback
  }

  const value = Number(raw)

  return /^\d+$/.test(raw) && value >= 1 && value <= maximum
    ? value
    : invalidField(`query parameter ${key} must be an integer from 1 to ${maximum}.`)
}

/** Fortnox default and maximum page sizes. */
const defaultLimit = 100

const maxLimit = 500

/** One page plus `MetaInformation` (`@TotalPages` is at least 1, as the empty-list fixture shows). */
const paginate = <A>(
  items: ReadonlyArray<A>,
  query: URLSearchParams
): { readonly items: ReadonlyArray<A>; readonly meta: Record<string, number> } | Response => {
  const limit = positiveInt(query, 'limit', defaultLimit, maxLimit)
  const page = positiveInt(query, 'page', 1, Number.MAX_SAFE_INTEGER)

  if (limit instanceof Response) return limit

  if (page instanceof Response) return page

  return {
    items: items.slice((page - 1) * limit, page * limit),
    meta: {
      '@CurrentPage': page,
      '@TotalPages': Math.max(1, Math.ceil(items.length / limit)),
      '@TotalResources': items.length
    }
  }
}

const contains = (value: string, search: string): boolean =>
  value.toLowerCase().includes(search.toLowerCase())

type CustomerSearch = (customer: FortnoxEmulatorCustomer, value: string) => boolean

const customerSearch = {
  customernumber: (customer, value) => customer.CustomerNumber === value,
  name: (customer, value) => contains(customer.Name, value),
  organisationnumber: (customer, value) => contains(customer.OrganisationNumber, value),
  email: (customer, value) => contains(customer.Email, value),
  city: (customer, value) => contains(customer.City, value),
  phone: (customer, value) => contains(customer.Phone1, value) || contains(customer.Phone2, value)
} satisfies Record<string, CustomerSearch>

const customerListQueryKeys: ReadonlyArray<string> = [
  'page',
  'limit',
  'filter',
  ...Object.keys(customerSearch)
]

const listCustomers: RouteHandler = (state, { query }, env) => {
  const filter = query.get('filter')

  if (filter !== null && filter !== 'active' && filter !== 'inactive') {
    return invalidField(`unknown customer filter ${filter}.`)
  }

  const matching = state.customers.filter(
    customer =>
      (filter === null || customer.Active === (filter === 'active')) &&
      Object.entries(customerSearch).every(([key, matches]) => {
        const value = query.get(key)

        return value === null || matches(customer, value)
      })
  )

  const page = paginate(matching, query)

  if (page instanceof Response) return page

  return jsonResponse(200, {
    Customers: page.items.map(customer => renderCustomerRow(env, customer)),
    MetaInformation: page.meta
  })
}

const findCustomer = (state: FortnoxEmulatorState, customerNumber: string) =>
  state.customers.find(customer => customer.CustomerNumber === customerNumber)

const findInvoice = (state: FortnoxEmulatorState, documentNumber: string) =>
  state.invoices.find(invoice => invoice.DocumentNumber === documentNumber)

const getCustomer: RouteHandler = (state, { params }, env) => {
  const customer = findCustomer(state, params.CustomerNumber ?? '')

  return customer === undefined
    ? customerNotFound()
    : jsonResponse(200, { Customer: renderCustomer(env, customer) })
}

/** The single resource object of a `{ <envelope>: { ... } }` write body. */
const envelopeObject = (
  body: Schema.Json | undefined,
  envelope: string
): Schema.JsonObject | Response => {
  const value = isJsonObject(body) ? body[envelope] : undefined

  return isJsonObject(body) &&
    Object.keys(body).every(key => key === envelope) &&
    isJsonObject(value)
    ? value
    : invalidBody(`the request body must be { "${envelope}": { ... } }.`)
}

const writableCustomerStrings = [
  'Name',
  'OrganisationNumber',
  'Email',
  'Phone1',
  'Phone2',
  'Address1',
  'Address2',
  'City',
  'ZipCode',
  'CountryCode',
  'Currency',
  'VATNumber',
  'VATType',
  'TermsOfPayment',
  'OurReference',
  'YourReference',
  'Comments',
  'EmailInvoice',
  'Type',
  'CostCenter'
] as const

type CustomerStringField = (typeof writableCustomerStrings)[number]

const isCustomerStringField = (key: string): key is CustomerStringField =>
  writableCustomerStrings.some(field => field === key)

type CustomerUpdates = {
  -readonly [K in keyof FortnoxEmulatorCustomer]?: FortnoxEmulatorCustomer[K]
}

/**
 * Why a customer field value is not emulated (fail closed), or `undefined`. The emulated company
 * has only SEK, no cost centers, terms of payment in whole days (0–365), `VATType` `SEVAT`, and
 * `Type` `COMPANY` or `PRIVATE`.
 */
const unsupportedCustomerValue = (
  key: CustomerStringField,
  value: string
): Response | undefined => {
  switch (key) {
    case 'Currency':
      return value === 'SEK' ? undefined : noReferencedEntity('Currency', value)
    case 'CostCenter':
      return value === '' ? undefined : noReferencedEntity('CostCenter', value)
    case 'TermsOfPayment':
      return termsOfPaymentDays(value) === undefined ? unsupportedTermsOfPayment(value) : undefined
    case 'VATType':
      return emulatedCustomerVatTypes.includes(value) ? undefined : unsupportedVatType(value)
    case 'Type':
      return emulatedCustomerTypes.includes(value)
        ? undefined
        : invalidField(
            `Type ${value} is not emulated (supported: ${emulatedCustomerTypes.join(', ')}).`
          )
    default:
      return undefined
  }
}

/**
 * Quirk 2: an empty string keeps the stored value (unless the `emptyStringClears` drill knob is
 * set); omitted fields keep theirs. Quirk 5: `Country` is read-only. Unknown fields, wrong types,
 * and values the emulator does not support (non-SEK `Currency`, a `CostCenter`, `TermsOfPayment`
 * other than 0–365 days, `VATType` other than `SEVAT`, `Type` other than `COMPANY`/`PRIVATE`) are
 * rejected; the update is atomic.
 */
const customerUpdates = (
  fields: Schema.JsonObject,
  customer: FortnoxEmulatorCustomer,
  env: FortnoxApiEnv
): CustomerUpdates | Response => {
  const updates: CustomerUpdates = {}

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'Country') {
      return readOnlyField('Country is read-only; set CountryCode instead.')
    }

    if (key === 'CustomerNumber') {
      if (value !== customer.CustomerNumber) {
        return invalidField('CustomerNumber cannot be changed.')
      }

      continue
    }

    if (key === 'Active') {
      if (!Predicate.isBoolean(value)) return invalidField('Active must be a boolean.')

      updates.Active = value

      continue
    }

    if (!isCustomerStringField(key)) {
      return invalidField(`unknown customer field ${key}.`)
    }

    if (!Predicate.isString(value)) {
      return invalidField(`${key} must be a string.`)
    }

    if (value === '' && !env.quirks.emptyStringClears) {
      continue
    }

    const unsupported = unsupportedCustomerValue(key, value)

    if (unsupported !== undefined) return unsupported

    if (key === 'CountryCode' && value !== '') {
      const country = fortnoxEmulatorCountries.get(value)

      if (country === undefined) return invalidField(`unknown CountryCode ${value}.`)

      updates.Country = country
    }

    updates[key] = value
  }

  return updates
}

const updateCustomer: RouteHandler = (state, { params, body }, env) => {
  const customer = findCustomer(state, params.CustomerNumber ?? '')

  if (customer === undefined) return customerNotFound()

  const fields = envelopeObject(body, 'Customer')

  if (fields instanceof Response) return fields

  const updates = customerUpdates(fields, customer, env)

  if (updates instanceof Response) return updates

  const updated: FortnoxEmulatorCustomer = { ...customer, ...updates }

  state.customers = state.customers.map(existing =>
    existing.CustomerNumber === updated.CustomerNumber ? updated : existing
  )

  return jsonResponse(200, { Customer: renderCustomer(env, updated) })
}

type InvoiceFilter = 'cancelled' | 'fullypaid' | 'unpaid' | 'unpaidoverdue' | 'unbooked'

const invoiceFilters: ReadonlyArray<InvoiceFilter> = [
  'cancelled',
  'fullypaid',
  'unpaid',
  'unpaidoverdue',
  'unbooked'
]

const isInvoiceFilter = (value: string): value is InvoiceFilter =>
  invoiceFilters.some(filter => filter === value)

/**
 * Quirk 3: the payment-status filters consider booked invoices only (unless the
 * `paymentFiltersIncludeUnbooked` drill knob is set); `unbooked` returns unbooked, uncancelled
 * invoices; `unpaidoverdue` needs a `DueDate` before today (UTC, from the emulator clock).
 */
const matchesInvoiceFilter = (
  invoice: FortnoxEmulatorInvoice,
  filter: InvoiceFilter,
  env: FortnoxApiEnv
): boolean => {
  const considered =
    (invoice.Booked || env.quirks.paymentFiltersIncludeUnbooked) && !invoice.Cancelled

  switch (filter) {
    case 'cancelled':
      return invoice.Cancelled
    case 'unbooked':
      return !invoice.Booked && !invoice.Cancelled
    case 'unpaid':
      return considered && invoice.Balance > 0
    case 'unpaidoverdue':
      return (
        considered &&
        invoice.Balance > 0 &&
        invoice.DueDate !== null &&
        isIsoDate(invoice.DueDate) &&
        invoice.DueDate < today(env)
      )
    case 'fullypaid':
      return considered && invoice.Balance === 0
  }
}

type InvoiceSearch = (invoice: FortnoxEmulatorInvoice, value: string) => boolean

const invoiceSearch = {
  customernumber: (invoice, value) => invoice.CustomerNumber === value,
  customername: (invoice, value) => contains(invoice.CustomerName, value),
  documentnumber: (invoice, value) => invoice.DocumentNumber === value,
  ocr: (invoice, value) => invoice.OCR === value
} satisfies Record<string, InvoiceSearch>

const invoiceListQueryKeys: ReadonlyArray<string> = [
  'page',
  'limit',
  'filter',
  'fromdate',
  'todate',
  ...Object.keys(invoiceSearch)
]

const listInvoices: RouteHandler = (state, { query }, env) => {
  const filter = query.get('filter')

  if (filter !== null && !isInvoiceFilter(filter)) {
    return invalidField(`unknown invoice filter ${filter}.`)
  }

  const fromDate = query.get('fromdate')
  const toDate = query.get('todate')

  for (const [key, value] of [
    ['fromdate', fromDate],
    ['todate', toDate]
  ] as const) {
    if (value !== null && !isIsoDate(value)) {
      return invalidField(`query parameter ${key} must be a YYYY-MM-DD date.`)
    }
  }

  const matching = state.invoices.filter(
    invoice =>
      (filter === null || matchesInvoiceFilter(invoice, filter, env)) &&
      (fromDate === null || invoice.InvoiceDate >= fromDate) &&
      (toDate === null || invoice.InvoiceDate <= toDate) &&
      Object.entries(invoiceSearch).every(([key, matches]) => {
        const value = query.get(key)

        return value === null || matches(invoice, value)
      })
  )

  const page = paginate(matching, query)

  if (page instanceof Response) return page

  return jsonResponse(200, {
    Invoices: page.items.map(invoice => renderInvoiceRow(env, invoice)),
    MetaInformation: page.meta
  })
}

const getInvoice: RouteHandler = (state, { params }, env) => {
  const invoice = findInvoice(state, params.DocumentNumber ?? '')

  return invoice === undefined
    ? invoiceNotFound()
    : jsonResponse(200, { Invoice: renderInvoice(env, invoice) })
}

type RowPatch = {
  -readonly [K in keyof FortnoxEmulatorInvoiceRowSeed]?: FortnoxEmulatorInvoiceRowSeed[K]
}

const vatRates: ReadonlyArray<number> = [...fortnoxEmulatorVatCodes.keys()]

/**
 * One row of an `InvoiceRows` write. `null` means omitted. Referenced articles, cost centers, and
 * projects must exist (the emulated company has none); accounts must be in 1000-8999.
 */
const rowPatch = (value: Schema.Json, index: number): RowPatch | Response => {
  if (!isJsonObject(value)) {
    return invalidField(`InvoiceRows[${index}] must be an object.`)
  }

  const patch: RowPatch = {}
  const label = (key: string) => `InvoiceRows[${index}].${key}`

  for (const [key, field] of Object.entries(value)) {
    if (field === null) continue

    switch (key) {
      case 'RowId':
        if (!Predicate.isNumber(field) || !Number.isSafeInteger(field) || field < 1) {
          return invalidField(`${label(key)} must be a positive integer.`)
        }

        patch.RowId = field
        break
      case 'AccountNumber':
        if (
          !Predicate.isNumber(field) ||
          !Number.isInteger(field) ||
          field < 1000 ||
          field > 8999
        ) {
          return invalidField(`${label(key)} must be an account number from 1000 to 8999.`)
        }

        patch.AccountNumber = field
        break
      case 'ArticleNumber':
      case 'CostCenter':
      case 'Project':
        if (!Predicate.isString(field)) return invalidField(`${label(key)} must be a string.`)

        if (field !== '') return noReferencedEntity(key, field)

        patch[key] = field
        break
      case 'Description':
      case 'Unit':
        if (!Predicate.isString(field)) return invalidField(`${label(key)} must be a string.`)

        patch[key] = field
        break
      case 'DeliveredQuantity': {
        const quantity = Predicate.isString(field) ? Number(field.trim()) : field

        if (
          !Predicate.isNumber(quantity) ||
          !Number.isFinite(quantity) ||
          quantity < 0 ||
          (Predicate.isString(field) && field.trim() === '')
        ) {
          return invalidField(`${label(key)} must be a non-negative number.`)
        }

        patch.DeliveredQuantity = formatQuantity(quantity)
        break
      }

      case 'Price':
        if (!Predicate.isNumber(field) || !Number.isFinite(field)) {
          return invalidField(`${label(key)} must be a finite number.`)
        }

        patch.Price = field
        break
      case 'Discount':
        if (!Predicate.isNumber(field) || !Number.isFinite(field) || field < 0) {
          return invalidField(`${label(key)} must be a non-negative number.`)
        }

        patch.Discount = field
        break
      case 'DiscountType':
        if (field !== 'PERCENT' && field !== 'AMOUNT') {
          return invalidField(`${label(key)} must be PERCENT or AMOUNT.`)
        }

        patch.DiscountType = field
        break
      case 'VAT':
        if (!Predicate.isNumber(field) || !vatRates.includes(field)) {
          return invalidField(`${label(key)} must be one of ${vatRates.join(', ')}.`)
        }

        patch.VAT = field
        break
      default:
        return invalidField(`${label(key)} is not a writable invoice row field.`)
    }
  }

  return patch
}

const rowPatches = (value: Schema.Json): ReadonlyArray<RowPatch> | Response => {
  if (!Array.isArray(value)) {
    return invalidField('InvoiceRows must be an array.')
  }

  const patches: Array<RowPatch> = []

  for (const [index, row] of value.entries()) {
    const patch = rowPatch(row, index)

    if (patch instanceof Response) return patch

    patches.push(patch)
  }

  return patches
}

type RowIds = { next: number }

/**
 * Quirk 1: `InvoiceRows` replaces the row list. Without any `RowId`, rows match existing rows by
 * position; with a `RowId`, that row is updated and rows without one are added. A matched row
 * keeps every omitted field, including `Discount`/`DiscountType` (unless the `stickyRowDiscount`
 * drill knob is off, which resets them); `Discount: 0` clears. RowIds are regenerated for every
 * row, and totals follow from the fields.
 */
const mergeRows = (
  existing: ReadonlyArray<FortnoxEmulatorInvoiceRow>,
  patches: ReadonlyArray<RowPatch>,
  ids: RowIds,
  env: FortnoxApiEnv
): ReadonlyArray<FortnoxEmulatorInvoiceRow> | Response => {
  const byRowId = patches.some(patch => patch.RowId !== undefined)
  const rows: Array<FortnoxEmulatorInvoiceRow> = []

  for (const [index, patch] of patches.entries()) {
    const base = byRowId
      ? existing.find(row => patch.RowId !== undefined && row.RowId === patch.RowId)
      : existing[index]

    if (byRowId && patch.RowId !== undefined && base === undefined) {
      return invalidField(`InvoiceRows[${index}].RowId ${patch.RowId} does not exist.`)
    }

    const start = { ...newRowDefaults, ...base }

    // Drill knob only: forget the matched row's discount instead of keeping it.
    if (base !== undefined && !env.quirks.stickyRowDiscount) {
      start.Discount = 0
      start.DiscountType = 'PERCENT'
    }

    rows.push(buildRow({ ...start, ...patch, RowId: ids.next++ }))
  }

  return rows
}

const invoiceTextFields = ['Comments', 'OurReference', 'YourReference', 'OCR'] as const

type InvoiceTextField = (typeof invoiceTextFields)[number]

const isInvoiceTextField = (key: string): key is InvoiceTextField =>
  invoiceTextFields.some(field => field === key)

const invoiceReadOnlyFields: ReadonlyArray<string> = [
  'Balance',
  'Booked',
  'Cancelled',
  'CustomerName',
  'FinalPayDate',
  'Gross',
  'Net',
  'Sent',
  'Total',
  'TotalToPay',
  'TotalVAT',
  'VoucherNumber',
  'VoucherSeries',
  'VoucherYear'
]

type InvoiceScalars = {
  CustomerNumber?: string
  Currency?: string
  InvoiceDate?: string
  DueDate?: string
  CostCenter?: string
  Project?: string
} & { -readonly [K in InvoiceTextField]?: string }

type InvoiceUpdates = {
  readonly scalars: InvoiceScalars
  readonly customer: FortnoxEmulatorCustomer | undefined
  readonly rows: ReadonlyArray<RowPatch> | undefined
}

/**
 * The writable invoice fields of a create or update body (the connector's invoice mutation
 * fields). Quirk 4: an unknown `CustomerNumber` is rejected with the rejection fixture's 400
 * `ErrorInformation`; other invalid or read-only fields are rejected with 400 too.
 */
const invoiceUpdates = (
  fields: Schema.JsonObject,
  state: FortnoxEmulatorState,
  existing: FortnoxEmulatorInvoice | undefined
): InvoiceUpdates | Response => {
  const scalars: InvoiceScalars = {}
  let customer: FortnoxEmulatorCustomer | undefined
  let rows: ReadonlyArray<RowPatch> | undefined

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'DocumentNumber') {
      if (existing === undefined || value !== existing.DocumentNumber) {
        return readOnlyField('DocumentNumber is assigned by Fortnox and cannot be changed.')
      }

      continue
    }

    if (key === 'InvoiceRows') {
      const patches = rowPatches(value)

      if (patches instanceof Response) return patches

      if (existing === undefined && patches.some(patch => patch.RowId !== undefined)) {
        return readOnlyField('RowId is assigned by Fortnox.')
      }

      rows = patches

      continue
    }

    if (invoiceReadOnlyFields.includes(key)) {
      return readOnlyField(`${key} is read-only.`)
    }

    if (!Predicate.isString(value)) {
      return invalidField(
        key === 'CustomerNumber' || key === 'Currency' || isInvoiceTextField(key)
          ? `${key} must be a string.`
          : `unknown or unsupported invoice field ${key}.`
      )
    }

    switch (key) {
      case 'CustomerNumber':
        customer = findCustomer(state, value)

        if (customer === undefined) return invoiceCustomerNotFound()

        scalars.CustomerNumber = value
        break
      case 'Currency':
        if (value !== 'SEK') return noReferencedEntity('Currency', value)

        scalars.Currency = value
        break
      case 'InvoiceDate':
      case 'DueDate':
        if (!isIsoDate(value)) return invalidField(`${key} must be a YYYY-MM-DD date.`)

        scalars[key] = value
        break
      case 'CostCenter':
      case 'Project':
        if (value !== '') return noReferencedEntity(key, value)

        scalars[key] = value
        break
      default:
        if (!isInvoiceTextField(key)) {
          return invalidField(`unknown or unsupported invoice field ${key}.`)
        }

        scalars[key] = value
    }
  }

  return { scalars, customer, rows }
}

const replaceInvoice = (state: FortnoxEmulatorState, updated: FortnoxEmulatorInvoice): void => {
  state.invoices = state.invoices.map(invoice =>
    invoice.DocumentNumber === updated.DocumentNumber ? updated : invoice
  )
}

const updateInvoice: RouteHandler = (state, { params, body }, env) => {
  const invoice = findInvoice(state, params.DocumentNumber ?? '')

  if (invoice === undefined) return invoiceNotFound()

  const fields = envelopeObject(body, 'Invoice')

  if (fields instanceof Response) return fields

  if (invoice.Booked) return notEditable('a booked invoice cannot be updated.')

  if (invoice.Cancelled) return notEditable('a cancelled invoice cannot be updated.')

  const updates = invoiceUpdates(fields, state, invoice)

  if (updates instanceof Response) return updates

  let updated: FortnoxEmulatorInvoice = {
    ...invoice,
    ...updates.scalars,
    CustomerName: updates.customer?.Name ?? invoice.CustomerName
  }

  if (updates.rows !== undefined) {
    const ids: RowIds = { next: state.counters.nextRowId }
    const rows = mergeRows(invoice.InvoiceRows, updates.rows, ids, env)

    if (rows instanceof Response) return rows

    const totals = invoiceTotals(rows)

    updated = { ...updated, InvoiceRows: rows, ...totals, Balance: totals.Total }
    state.counters = { ...state.counters, nextRowId: ids.next }
  }

  replaceInvoice(state, updated)

  return jsonResponse(200, { Invoice: renderInvoice(env, updated) })
}

const createInvoice: RouteHandler = (state, { body }, env) => {
  const fields = envelopeObject(body, 'Invoice')

  if (fields instanceof Response) return fields

  const updates = invoiceUpdates(fields, state, undefined)

  if (updates instanceof Response) return updates

  const { customer } = updates

  if (customer === undefined) return invalidField('CustomerNumber is required.')

  // The invoice inherits the customer's currency when it names none; check the effective value
  // (a seeded customer can carry any currency) before anything is committed.
  const currency = updates.scalars.Currency ?? customer.Currency

  if (currency !== 'SEK') return noReferencedEntity('Currency', currency)

  // Likewise the inherited VAT type (invoice VAT comes from the rows only) and payment terms,
  // which the invoice records and derives its due date from.
  if (!emulatedCustomerVatTypes.includes(customer.VATType)) {
    return unsupportedVatType(customer.VATType)
  }

  const terms = termsOfPaymentDays(customer.TermsOfPayment)

  if (terms === undefined) return unsupportedTermsOfPayment(customer.TermsOfPayment)

  const invoiceDate = updates.scalars.InvoiceDate ?? today(env)
  const dueDate = updates.scalars.DueDate ?? addDays(invoiceDate, terms)

  if (dueDate === undefined) {
    return invalidField(
      `the due date ${invoiceDate} + ${terms} days is not a representable YYYY-MM-DD date.`
    )
  }

  const ids: RowIds = { next: state.counters.nextRowId }

  const seed: FortnoxEmulatorInvoiceSeed = {
    ...updates.scalars,
    DocumentNumber: String(state.counters.nextDocumentNumber),
    CustomerNumber: customer.CustomerNumber,
    InvoiceDate: invoiceDate,
    DueDate: dueDate,
    EmailInformation: defaultEmailInformation(customer, state.company),
    InvoiceRows: updates.rows ?? []
  }

  const invoice = invoiceFromSeed(seed, customer, state.company, ids)

  state.invoices = [...state.invoices, invoice].sort((left, right) =>
    compareNumbers(left.DocumentNumber, right.DocumentNumber)
  )
  state.counters = {
    nextRowId: ids.next,
    nextDocumentNumber: state.counters.nextDocumentNumber + 1
  }

  return jsonResponse(201, { Invoice: renderInvoice(env, invoice) })
}

const previewInvoice: RouteHandler = (state, { params }) =>
  findInvoice(state, params.DocumentNumber ?? '') === undefined
    ? invoiceNotFound()
    : new Response(previewPdfBytes(), {
        status: 200,
        headers: { 'content-type': 'application/pdf' }
      })

/** Marks the invoice `Sent` and records an outbox entry. Nothing is ever delivered. */
const emailInvoice: RouteHandler = (state, { params }, env) => {
  const invoice = findInvoice(state, params.DocumentNumber ?? '')

  if (invoice === undefined) return invoiceNotFound()

  if (invoice.Cancelled) return notEditable('a cancelled invoice cannot be sent.')

  const email = invoice.EmailInformation

  if (email.EmailAddressTo.trim() === '') {
    return invalidField('the invoice has no EmailInformation.EmailAddressTo.')
  }

  const updated: FortnoxEmulatorInvoice = { ...invoice, Sent: true }

  replaceInvoice(state, updated)
  state.outbox = [
    ...state.outbox,
    {
      DocumentNumber: invoice.DocumentNumber,
      EmailAddressTo: email.EmailAddressTo,
      EmailAddressCC: email.EmailAddressCC,
      EmailAddressBCC: email.EmailAddressBCC,
      EmailSubject: email.EmailSubject.replaceAll('{no}', invoice.DocumentNumber),
      sentAt: new Date(env.now()).toISOString()
    }
  ]

  return jsonResponse(200, { Invoice: renderInvoice(env, updated, true) })
}

const companyInformation: RouteHandler = state =>
  jsonResponse(200, { CompanyInformation: state.company })

const connectorRoute = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  handler: RouteHandler,
  queryKeys: ReadonlyArray<string> = []
): FortnoxApiRoute => ({
  method,
  path: `${fortnoxEmulatorBasePath}${path}`,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  queryKeys,
  handler
})

const listCase = 'fortnox.invoice.list-populated'

const previewCase = 'fortnox.invoice.preview-pdf'

const filtersCase = 'fortnox.invoice.payment-filters-exclude-unbooked'

const discountCase = 'fortnox.invoice.row-discount-sticky'

const emptyStringCase = 'fortnox.customer.empty-string-keeps-value'

const rejectionCase = 'fortnox.write.rejection-error-information'

const emailCase = 'fortnox.invoice.send-email'

/** The route table: evidence plus handler. `fortnoxEmulatorRoutes` is its evidence part. */
export const fortnoxApiRoutes: ReadonlyArray<FortnoxApiRoute> = [
  connectorRoute('GET', '/companyinformation', false, [], companyInformation),
  connectorRoute('GET', '/customers', false, [], listCustomers, customerListQueryKeys),
  connectorRoute(
    'GET',
    '/customers/{CustomerNumber}',
    false,
    [emptyStringCase, rejectionCase],
    getCustomer
  ),
  connectorRoute('PUT', '/customers/{CustomerNumber}', true, [emptyStringCase], updateCustomer),
  connectorRoute(
    'GET',
    '/invoices',
    false,
    [listCase, filtersCase],
    listInvoices,
    invoiceListQueryKeys
  ),
  connectorRoute('POST', '/invoices', true, [rejectionCase], createInvoice),
  connectorRoute('GET', '/invoices/{DocumentNumber}', false, [discountCase, emailCase], getInvoice),
  connectorRoute('PUT', '/invoices/{DocumentNumber}', true, [discountCase], updateInvoice),
  connectorRoute('GET', '/invoices/{DocumentNumber}/preview', false, [previewCase], previewInvoice),
  connectorRoute('GET', '/invoices/{DocumentNumber}/email', true, [emailCase], emailInvoice)
]

/** One observed Fortnox quirk the emulator implements, and the case that claims it. */
export type FortnoxEmulatorQuirk = {
  readonly id: string
  /** `METHOD path` of the route that implements it. */
  readonly route: string
  /** The conformance case whose claim it follows; `undefined` when no case covers it yet. */
  readonly caseId: string | undefined
  /** The drill knob that flips it, if any. */
  readonly knob: keyof FortnoxEmulatorQuirks | undefined
  readonly summary: string
}

/** The observed quirks, each tied to its conformance case id. */
export const fortnoxEmulatorQuirks: ReadonlyArray<FortnoxEmulatorQuirk> = [
  {
    id: 'row-discount-sticky',
    route: 'PUT /3/invoices/{DocumentNumber}',
    caseId: discountCase,
    knob: 'stickyRowDiscount',
    summary:
      'InvoiceRows replaces the rows; rows without RowId match by position; an omitted Discount/DiscountType keeps its value; Discount 0 clears; RowIds regenerate; totals are recomputed.'
  },
  {
    id: 'empty-string-keeps-value',
    route: 'PUT /3/customers/{CustomerNumber}',
    caseId: emptyStringCase,
    knob: 'emptyStringClears',
    summary: 'A customer update with "" for a string field keeps the stored value.'
  },
  {
    id: 'payment-filters-exclude-unbooked',
    route: 'GET /3/invoices',
    caseId: filtersCase,
    knob: 'paymentFiltersIncludeUnbooked',
    summary:
      'unpaid, unpaidoverdue, and fullypaid consider booked invoices only; unbooked lists unbooked, uncancelled invoices; unpaidoverdue needs DueDate before today.'
  },
  {
    id: 'rejection-error-information',
    route: 'POST /3/invoices',
    caseId: rejectionCase,
    knob: undefined,
    summary:
      'Writes for an unknown customer, or with invalid fields, answer 400 with a lowercase ErrorInformation { error, message, code }.'
  },
  {
    id: 'customer-country-read-only',
    route: 'PUT /3/customers/{CustomerNumber}',
    caseId: undefined,
    knob: undefined,
    summary:
      'Customer Country is read-only (derived from CountryCode); sending it answers 400 ErrorInformation. No conformance case covers it yet.'
  }
]

const templatePattern = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split(/(\{[A-Za-z]+\})/)
      .map(part =>
        /^\{[A-Za-z]+\}$/.test(part) ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('')}$`
  )

const compiledRoutes = fortnoxApiRoutes.map(route => ({
  route,
  pattern: templatePattern(route.path)
}))

/** The route answering `method` + concrete `path`, or `undefined` (fail closed). */
export const matchFortnoxRoute = (method: string, path: string): FortnoxApiRoute | undefined =>
  compiledRoutes.find(
    candidate => candidate.route.method === method.toUpperCase() && candidate.pattern.test(path)
  )?.route

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Parsed JSON, or `undefined` for invalid JSON. */
export const parseJsonText = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

/** `{Name}` path templates become `:Name` core route parameters. */
const corePath = (template: string): string => template.replace(/\{([A-Za-z]+)\}/g, ':$1')

/** Header the wrapper sets on core requests: the job whose fault decision the route asks for. */
export const fortnoxJobHeader = 'x-emulator-job-id'

/**
 * The wrapper's fault decision for the core request of job `jobId`, asked only once the route
 * would answer successfully: `true` when a fault answers instead (it is used up, and the wrapper
 * sends its answer), `false` when none applies.
 */
export type FortnoxFaultDecision = (jobId: string | undefined) => boolean

/**
 * The core's answer when a fault answered: the wrapper sends the fault's answer itself, outside
 * the core, so a reset or a close before it is read never cancels it.
 */
const answeredOutsideCore = (): Response => new Response(null, { status: 204 })

/**
 * Register every route of the table on the core app, over the generation's state. Each request is
 * planned, then faulted, then committed: the handler runs on a draft of the state (handlers replace
 * whole lists and counters, never edit them in place, so a shallow copy keeps every write off the
 * state); a refusal (any answer that is not 2xx) is sent as is and uses up no fault; a successful
 * answer asks `decideFault`, and only an unfaulted one commits the draft. The three steps run
 * synchronously together, so no other request interleaves. A handler that throws answers
 * `handlerFailedResponse()` (nothing written), which the wrapper turns into its `ErrorInformation`
 * 500 with `responseError` in the ledger.
 */
export const registerFortnoxApi = (
  app: Hono,
  state: FortnoxEmulatorState,
  env: FortnoxApiEnv,
  decideFault: FortnoxFaultDecision
): void => {
  for (const route of fortnoxApiRoutes) {
    app.on(route.method, corePath(route.path), async context => {
      try {
        const query = new URL(context.req.url).searchParams

        // Fail closed on query parameters the route does not emulate, before the handler can write.
        const unsupported = unsupportedQueryKey(query, route.queryKeys)

        if (unsupported !== undefined) return unsupported

        const text = await context.req.text()
        const draft: FortnoxEmulatorState = { ...state }

        const response = route.handler(
          draft,
          {
            params: context.req.param(),
            query,
            body: text === '' ? undefined : parseJsonText(text)
          },
          env
        )

        if (!response.ok) return response

        if (decideFault(context.req.header(fortnoxJobHeader))) return answeredOutsideCore()

        Object.assign(state, draft)

        return response
      } catch {
        return handlerFailedResponse()
      }
    })
  }
}
