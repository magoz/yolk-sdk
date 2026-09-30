/**
 * Fortnox emulator state: the typed entities, the seed input, the default seed, and the
 * account-variance profiles (internal; re-exported by `src/fortnox.ts`).
 *
 * Entity shapes and the default entities follow the synthetic Fortnox conformance fixtures, copied
 * as data (the same customer and document numbers as `fortnoxConformanceFixtureSeeds`), never
 * imported from SDK code. Where no fixture records a value, the default is synthesized and says
 * so below: customer 1002, most invoice rows, and the company information have no fixture.
 *
 * @experimental
 */
import { Result, Struct } from 'effect'
import * as Schema from 'effect/Schema'

const DiscountType = Schema.Literals(['PERCENT', 'AMOUNT'])

const rowFields = {
  RowId: Schema.Int,
  AccountNumber: Schema.NullOr(Schema.Int),
  ArticleNumber: Schema.String,
  ContributionPercent: Schema.String,
  ContributionValue: Schema.String,
  CostCenter: Schema.String,
  DeliveredQuantity: Schema.String,
  Description: Schema.String,
  Discount: Schema.Finite,
  DiscountType,
  HouseWork: Schema.Boolean,
  Price: Schema.Finite,
  PriceExcludingVAT: Schema.Finite,
  Project: Schema.String,
  Total: Schema.Finite,
  TotalExcludingVAT: Schema.Finite,
  Unit: Schema.String,
  VAT: Schema.Finite,
  VATCode: Schema.String
}

/** A stored invoice row, in the single-invoice wire shape. Totals are derived. */
export const FortnoxEmulatorInvoiceRow = Schema.Struct(rowFields)

export type FortnoxEmulatorInvoiceRow = typeof FortnoxEmulatorInvoiceRow.Type

const EmailInformation = Schema.Struct({
  EmailAddressFrom: Schema.String,
  EmailAddressTo: Schema.String,
  EmailAddressCC: Schema.String,
  EmailAddressBCC: Schema.String,
  EmailSubject: Schema.String,
  EmailBody: Schema.String
})

const invoiceFields = {
  DocumentNumber: Schema.String,
  CustomerNumber: Schema.String,
  CustomerName: Schema.String,
  Balance: Schema.Finite,
  Booked: Schema.Boolean,
  Cancelled: Schema.Boolean,
  Comments: Schema.String,
  CostCenter: Schema.String,
  Credit: Schema.String,
  Currency: Schema.String,
  CurrencyRate: Schema.Finite,
  CurrencyUnit: Schema.Finite,
  DueDate: Schema.NullOr(Schema.String),
  EmailInformation,
  ExternalInvoiceReference1: Schema.String,
  ExternalInvoiceReference2: Schema.String,
  FinalPayDate: Schema.NullOr(Schema.String),
  Gross: Schema.Finite,
  InvoiceDate: Schema.String,
  InvoiceRows: Schema.Array(FortnoxEmulatorInvoiceRow),
  InvoiceType: Schema.String,
  Net: Schema.Finite,
  NotCompleted: Schema.Boolean,
  NoxFinans: Schema.Boolean,
  OCR: Schema.String,
  OurReference: Schema.String,
  Project: Schema.String,
  Sent: Schema.Boolean,
  TermsOfPayment: Schema.String,
  Total: Schema.Finite,
  TotalToPay: Schema.Finite,
  TotalVAT: Schema.Finite,
  VoucherNumber: Schema.NullOr(Schema.Int),
  VoucherSeries: Schema.NullOr(Schema.String),
  VoucherYear: Schema.NullOr(Schema.Int),
  WayOfDelivery: Schema.String,
  YourReference: Schema.String
}

/** A stored customer invoice with its rows. */
export const FortnoxEmulatorInvoice = Schema.Struct(invoiceFields)

export type FortnoxEmulatorInvoice = typeof FortnoxEmulatorInvoice.Type

const customerFields = {
  CustomerNumber: Schema.String,
  Name: Schema.String,
  Active: Schema.Boolean,
  Address1: Schema.String,
  Address2: Schema.String,
  City: Schema.String,
  Comments: Schema.String,
  CostCenter: Schema.String,
  Country: Schema.String,
  CountryCode: Schema.String,
  Currency: Schema.String,
  Email: Schema.String,
  EmailInvoice: Schema.String,
  OrganisationNumber: Schema.String,
  OurReference: Schema.String,
  Phone1: Schema.String,
  Phone2: Schema.String,
  TermsOfPayment: Schema.String,
  Type: Schema.String,
  VATNumber: Schema.String,
  VATType: Schema.String,
  YourReference: Schema.String,
  ZipCode: Schema.String
}

/** A stored customer. `Country` is read-only (derived from `CountryCode`). */
export const FortnoxEmulatorCustomer = Schema.Struct(customerFields)

export type FortnoxEmulatorCustomer = typeof FortnoxEmulatorCustomer.Type

const companyFields = {
  CompanyName: Schema.String,
  OrganizationNumber: Schema.String,
  DatabaseNumber: Schema.Int,
  Address: Schema.String,
  City: Schema.String,
  ZipCode: Schema.String,
  CountryCode: Schema.String,
  VisitAddress: Schema.String,
  VisitCity: Schema.String,
  VisitZipCode: Schema.String,
  VisitCountryCode: Schema.String
}

/** The company the credential belongs to (`GET /3/companyinformation`). */
export const FortnoxEmulatorCompany = Schema.Struct(companyFields)

export type FortnoxEmulatorCompany = typeof FortnoxEmulatorCompany.Type

/** A recorded (never delivered) invoice email. */
export const FortnoxEmulatorOutboxEntry = Schema.Struct({
  DocumentNumber: Schema.String,
  EmailAddressTo: Schema.String,
  EmailAddressCC: Schema.String,
  EmailAddressBCC: Schema.String,
  EmailSubject: Schema.String,
  /** ISO timestamp from the emulator clock. */
  sentAt: Schema.String
})

export type FortnoxEmulatorOutboxEntry = typeof FortnoxEmulatorOutboxEntry.Type

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Counters = Schema.Struct({
  /** Next RowId handed out; RowIds are regenerated on every row update. */
  nextRowId: Counter,
  /** Next DocumentNumber handed out by `POST /3/invoices`. */
  nextDocumentNumber: Counter
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const FortnoxEmulatorStateSchema = Schema.Struct({
  company: FortnoxEmulatorCompany,
  customers: Schema.Array(FortnoxEmulatorCustomer),
  invoices: Schema.Array(FortnoxEmulatorInvoice),
  outbox: Schema.Array(FortnoxEmulatorOutboxEntry),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (route handlers replace whole entity lists);
 * every entity is replaced, never edited in place.
 */
export type FortnoxEmulatorState = {
  company: FortnoxEmulatorCompany
  customers: ReadonlyArray<FortnoxEmulatorCustomer>
  invoices: ReadonlyArray<FortnoxEmulatorInvoice>
  outbox: ReadonlyArray<FortnoxEmulatorOutboxEntry>
  counters: typeof Counters.Type
}

/** A seeded invoice row: the writable row fields; totals and `VATCode` are derived. */
export const FortnoxEmulatorInvoiceRowSeed = Schema.Struct({
  RowId: Schema.optionalKey(Schema.Int),
  AccountNumber: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  ArticleNumber: Schema.optionalKey(Schema.String),
  CostCenter: Schema.optionalKey(Schema.String),
  DeliveredQuantity: Schema.optionalKey(Schema.String),
  Description: Schema.optionalKey(Schema.String),
  Discount: Schema.optionalKey(Schema.Finite),
  DiscountType: Schema.optionalKey(DiscountType),
  Price: Schema.optionalKey(Schema.Finite),
  Project: Schema.optionalKey(Schema.String),
  Unit: Schema.optionalKey(Schema.String),
  VAT: Schema.optionalKey(Schema.Finite)
})

export type FortnoxEmulatorInvoiceRowSeed = typeof FortnoxEmulatorInvoiceRowSeed.Type

const { InvoiceRows: _invoiceRows, ...invoiceScalarFields } = invoiceFields

/**
 * A seeded invoice: `DocumentNumber` and `CustomerNumber` are required; everything else has a
 * synthetic default. Totals (`Net`, `Gross`, `TotalVAT`, `Total`, `TotalToPay`) are always
 * computed from the rows; `Balance` defaults to `Total`.
 */
export const FortnoxEmulatorInvoiceSeed = Schema.Struct({
  ...Struct.mapOmit(invoiceScalarFields, ['DocumentNumber', 'CustomerNumber'], Schema.optionalKey),
  InvoiceRows: Schema.optionalKey(Schema.Array(FortnoxEmulatorInvoiceRowSeed))
})

export type FortnoxEmulatorInvoiceSeed = typeof FortnoxEmulatorInvoiceSeed.Type

/** A seeded customer: `CustomerNumber` and `Name` are required; `Country` follows `CountryCode`. */
export const FortnoxEmulatorCustomerSeed = Schema.Struct(
  Struct.mapOmit(customerFields, ['CustomerNumber', 'Name'], Schema.optionalKey)
)

export type FortnoxEmulatorCustomerSeed = typeof FortnoxEmulatorCustomerSeed.Type

/** Account-variance profiles for the default seed. */
export const FortnoxEmulatorProfile = Schema.Literals([
  'default',
  'empty-company',
  'no-booked-invoices'
])

export type FortnoxEmulatorProfile = typeof FortnoxEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities); `company`,
 * `customers`, and `invoices`, when given, replace that part of the profile.
 */
export const FortnoxEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(FortnoxEmulatorProfile),
  company: Schema.optionalKey(FortnoxEmulatorCompany),
  customers: Schema.optionalKey(Schema.Array(FortnoxEmulatorCustomerSeed)),
  invoices: Schema.optionalKey(Schema.Array(FortnoxEmulatorInvoiceSeed))
})

export type FortnoxEmulatorSeed = typeof FortnoxEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(FortnoxEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(FortnoxEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

/** `CountryCode` to the Swedish country name Fortnox derives `Country` from (a small table). */
export const fortnoxEmulatorCountries = new Map([
  ['SE', 'Sverige'],
  ['NO', 'Norge'],
  ['DK', 'Danmark'],
  ['FI', 'Finland'],
  ['DE', 'Tyskland'],
  ['GB', 'Storbritannien'],
  ['US', 'USA']
])

/** VAT percent to Fortnox sales VAT code. */
export const fortnoxEmulatorVatCodes = new Map([
  [25, 'MP1'],
  [12, 'MP2'],
  [6, 'MP3'],
  [0, 'MF']
])

export const round2 = (value: number): number => Math.round(value * 100) / 100

/** Row total: `Price × DeliveredQuantity`, less a percent (or amount) discount. */
export const rowTotal = (
  row: Pick<FortnoxEmulatorInvoiceRow, 'Price' | 'DeliveredQuantity' | 'Discount' | 'DiscountType'>
): number => {
  const gross = row.Price * Number(row.DeliveredQuantity)

  return round2(
    row.DiscountType === 'AMOUNT' ? gross - row.Discount : (gross * (100 - row.Discount)) / 100
  )
}

type RowInput = Pick<
  FortnoxEmulatorInvoiceRow,
  | 'RowId'
  | 'AccountNumber'
  | 'ArticleNumber'
  | 'CostCenter'
  | 'DeliveredQuantity'
  | 'Description'
  | 'Discount'
  | 'DiscountType'
  | 'Price'
  | 'Project'
  | 'Unit'
  | 'VAT'
>

/** A full row (fixture key order) with derived totals and VAT code. */
export const buildRow = (input: RowInput): FortnoxEmulatorInvoiceRow => {
  const total = rowTotal(input)

  return {
    AccountNumber: input.AccountNumber,
    ArticleNumber: input.ArticleNumber,
    ContributionPercent: '0',
    ContributionValue: '0',
    CostCenter: input.CostCenter,
    DeliveredQuantity: input.DeliveredQuantity,
    Description: input.Description,
    Discount: input.Discount,
    DiscountType: input.DiscountType,
    HouseWork: false,
    Price: input.Price,
    PriceExcludingVAT: input.Price,
    Project: input.Project,
    RowId: input.RowId,
    Total: total,
    TotalExcludingVAT: total,
    Unit: input.Unit,
    VAT: input.VAT,
    VATCode: fortnoxEmulatorVatCodes.get(input.VAT) ?? ''
  }
}

/** Defaults for a new row (no positional match). */
export const newRowDefaults: Omit<RowInput, 'RowId'> = {
  AccountNumber: 3001,
  ArticleNumber: '',
  CostCenter: '',
  DeliveredQuantity: '1.00',
  Description: '',
  Discount: 0,
  DiscountType: 'PERCENT',
  Price: 0,
  Project: '',
  Unit: '',
  VAT: 25
}

/** Fortnox-style quantity: two decimals (`"2.00"`). */
export const formatQuantity = (value: number): string => value.toFixed(2)

export type InvoiceTotals = Pick<
  FortnoxEmulatorInvoice,
  'Net' | 'Gross' | 'TotalVAT' | 'Total' | 'TotalToPay'
>

/**
 * Invoice totals from the rows: `Net = Gross = Σ row totals`, `TotalVAT = Σ row total × VAT%`,
 * and `Total = TotalToPay = Net + TotalVAT` rounded to whole kronor (half up), matching the
 * synthetic row-discount fixture (1150 + 287.5 → 1438).
 */
export const invoiceTotals = (rows: ReadonlyArray<FortnoxEmulatorInvoiceRow>): InvoiceTotals => {
  const net = round2(rows.reduce((sum, row) => sum + row.Total, 0))
  const vat = round2(rows.reduce((sum, row) => sum + (row.Total * row.VAT) / 100, 0))
  const total = Math.round(net + vat)

  return { Net: net, Gross: net, TotalVAT: vat, Total: total, TotalToPay: total }
}

// Default entities. Fixture-derived: customer 1001 (empty-string fixture) and the invoice headers
// of 101-105 (list, payment-filter, row-discount, and email fixtures). Where two fixtures disagree
// the more specific one wins: invoice 103 (and its two rows) follows the row-discount fixture, not
// the list fixture (its Balance, DueDate, InvoiceDate, and OCR differ there). Synthesized: customer
// 1002, the rows of invoices 101, 102, 104, and 105 (chosen so their computed totals equal the
// fixture totals), the company information (no fixture), and every default `customerFromSeed` and
// `invoiceFromSeed` fill in for a field the seed omits.

const exampleCustomer: FortnoxEmulatorCustomerSeed = {
  CustomerNumber: '1001',
  Name: 'Example Customer AB',
  Active: true,
  Address1: 'Exempelgatan 1',
  Address2: '',
  City: 'Exempelstad',
  Comments: 'Synthetic note: invoice monthly by email.',
  CostCenter: '',
  CountryCode: 'SE',
  Currency: 'SEK',
  Email: 'billing@example.test',
  EmailInvoice: 'billing@example.test',
  OrganisationNumber: '000000-0000',
  OurReference: '',
  Phone1: '',
  Phone2: '',
  TermsOfPayment: '30',
  Type: 'COMPANY',
  VATNumber: '',
  VATType: 'SEVAT',
  YourReference: '',
  ZipCode: '000 00'
}

const exampleTrading: FortnoxEmulatorCustomerSeed = {
  CustomerNumber: '1002',
  Name: 'Example Trading AB',
  Active: true,
  Address1: 'Exempelvägen 2',
  City: 'Exempelstad',
  Comments: '',
  CountryCode: 'SE',
  Currency: 'SEK',
  Email: 'accounts@example.test',
  EmailInvoice: 'accounts@example.test',
  OrganisationNumber: '000000-0001',
  TermsOfPayment: '30',
  Type: 'COMPANY',
  VATType: 'SEVAT',
  ZipCode: '000 01'
}

const singleRow = (description: string, price: number): FortnoxEmulatorInvoiceRowSeed => ({
  AccountNumber: 3001,
  Description: description,
  DeliveredQuantity: '1.00',
  Price: price,
  VAT: 25,
  Discount: 0,
  DiscountType: 'PERCENT'
})

const defaultInvoices: ReadonlyArray<FortnoxEmulatorInvoiceSeed> = [
  {
    DocumentNumber: '101',
    CustomerNumber: '1001',
    Balance: 0,
    Booked: true,
    DueDate: '2026-09-30',
    FinalPayDate: '2026-09-20',
    InvoiceDate: '2026-08-31',
    OCR: '10151',
    Sent: true,
    VoucherNumber: 12,
    VoucherSeries: 'B',
    VoucherYear: 3,
    InvoiceRows: [singleRow('Monthly service (synthetic)', 1000)]
  },
  {
    DocumentNumber: '102',
    CustomerNumber: '1002',
    Balance: 3750,
    Booked: true,
    DueDate: '2026-09-30',
    InvoiceDate: '2026-08-31',
    OCR: '10250',
    Sent: true,
    VoucherNumber: 13,
    VoucherSeries: 'B',
    VoucherYear: 3,
    InvoiceRows: [singleRow('Project delivery (synthetic)', 3000)]
  },
  {
    DocumentNumber: '103',
    CustomerNumber: '1001',
    Booked: false,
    DueDate: '2026-10-31',
    InvoiceDate: '2026-09-30',
    OCR: '10350',
    InvoiceRows: [
      {
        RowId: 1,
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
        RowId: 2,
        AccountNumber: 3001,
        Description: 'Travel (synthetic)',
        DeliveredQuantity: '1.00',
        Price: 250,
        VAT: 25,
        Discount: 0,
        DiscountType: 'PERCENT'
      }
    ]
  },
  {
    DocumentNumber: '104',
    CustomerNumber: '1001',
    Balance: 625,
    Booked: true,
    DueDate: '2026-10-31',
    InvoiceDate: '2026-09-30',
    VoucherNumber: 14,
    VoucherSeries: 'B',
    VoucherYear: 3,
    EmailInformation: {
      EmailAddressFrom: 'invoices@example.test',
      EmailAddressTo: 'billing@example.test',
      EmailAddressCC: '',
      EmailAddressBCC: '',
      EmailSubject: 'Invoice {no} from Example AB',
      EmailBody: 'Synthetic invoice email body.'
    },
    InvoiceRows: [singleRow('Support hours (synthetic)', 500)]
  },
  {
    DocumentNumber: '105',
    CustomerNumber: '1001',
    Booked: false,
    DueDate: '2026-09-15',
    InvoiceDate: '2026-08-16',
    InvoiceRows: [singleRow('Workshop (synthetic)', 1000)]
  }
]

const defaultCompany: FortnoxEmulatorCompany = {
  CompanyName: 'Example AB',
  OrganizationNumber: '000000-0002',
  DatabaseNumber: 100001,
  Address: 'Exempelgatan 10',
  City: 'Exempelstad',
  ZipCode: '000 02',
  CountryCode: 'SE',
  VisitAddress: 'Exempelgatan 10',
  VisitCity: 'Exempelstad',
  VisitZipCode: '000 02',
  VisitCountryCode: 'SE'
}

type ProfileEntities = {
  readonly company: FortnoxEmulatorCompany
  readonly customers: ReadonlyArray<FortnoxEmulatorCustomerSeed>
  readonly invoices: ReadonlyArray<FortnoxEmulatorInvoiceSeed>
}

const unbooked = (invoice: FortnoxEmulatorInvoiceSeed): FortnoxEmulatorInvoiceSeed => {
  const { Balance: _balance, FinalPayDate: _finalPayDate, ...rest } = invoice

  return { ...rest, Booked: false, VoucherNumber: null, VoucherSeries: null, VoucherYear: null }
}

const profileEntities = (profile: FortnoxEmulatorProfile): ProfileEntities => {
  switch (profile) {
    case 'default':
      return {
        company: defaultCompany,
        customers: [exampleCustomer, exampleTrading],
        invoices: defaultInvoices
      }
    case 'empty-company':
      return { company: defaultCompany, customers: [], invoices: [] }
    case 'no-booked-invoices':
      return {
        company: defaultCompany,
        customers: [exampleCustomer, exampleTrading],
        invoices: defaultInvoices.map(unbooked)
      }
  }
}

/** Numeric-aware order for Fortnox numbers (`"999" < "1001"`). */
export const compareNumbers = (left: string, right: string): number =>
  left.localeCompare(right, 'en', { numeric: true })

const customerFromSeed = (seed: FortnoxEmulatorCustomerSeed): FortnoxEmulatorCustomer => {
  const countryCode = seed.CountryCode ?? 'SE'

  return {
    CustomerNumber: seed.CustomerNumber,
    Name: seed.Name,
    Active: seed.Active ?? true,
    Address1: seed.Address1 ?? '',
    Address2: seed.Address2 ?? '',
    City: seed.City ?? '',
    Comments: seed.Comments ?? '',
    CostCenter: seed.CostCenter ?? '',
    Country: seed.Country ?? fortnoxEmulatorCountries.get(countryCode) ?? '',
    CountryCode: countryCode,
    Currency: seed.Currency ?? 'SEK',
    Email: seed.Email ?? '',
    EmailInvoice: seed.EmailInvoice ?? '',
    OrganisationNumber: seed.OrganisationNumber ?? '',
    OurReference: seed.OurReference ?? '',
    Phone1: seed.Phone1 ?? '',
    Phone2: seed.Phone2 ?? '',
    TermsOfPayment: seed.TermsOfPayment ?? '30',
    Type: seed.Type ?? 'COMPANY',
    VATNumber: seed.VATNumber ?? '',
    VATType: seed.VATType ?? 'SEVAT',
    YourReference: seed.YourReference ?? '',
    ZipCode: seed.ZipCode ?? ''
  }
}

/** Default invoice email for a customer (the email fixture's sender, subject, and body). */
export const defaultEmailInformation = (
  customer: FortnoxEmulatorCustomer | undefined,
  company: FortnoxEmulatorCompany
): FortnoxEmulatorInvoice['EmailInformation'] => ({
  EmailAddressFrom: 'invoices@example.test',
  EmailAddressTo: customer?.EmailInvoice ?? '',
  EmailAddressCC: '',
  EmailAddressBCC: '',
  EmailSubject: `Invoice {no} from ${company.CompanyName}`,
  EmailBody: 'Synthetic invoice email body.'
})

export type RowIdSource = { next: number }

const rowFromSeed = (
  seed: FortnoxEmulatorInvoiceRowSeed,
  ids: RowIdSource
): FortnoxEmulatorInvoiceRow =>
  buildRow({
    ...newRowDefaults,
    ...seed,
    DeliveredQuantity: formatQuantity(Number(seed.DeliveredQuantity ?? '1')),
    RowId: seed.RowId ?? ids.next++
  })

/** Build a stored invoice from a seed; row ids come from `ids` unless the seed names them. */
export const invoiceFromSeed = (
  seed: FortnoxEmulatorInvoiceSeed,
  customer: FortnoxEmulatorCustomer | undefined,
  company: FortnoxEmulatorCompany,
  ids: RowIdSource
): FortnoxEmulatorInvoice => {
  const rows = (seed.InvoiceRows ?? []).map(row => rowFromSeed(row, ids))
  const totals = invoiceTotals(rows)

  return {
    DocumentNumber: seed.DocumentNumber,
    CustomerNumber: seed.CustomerNumber,
    CustomerName: seed.CustomerName ?? customer?.Name ?? '',
    Balance: seed.Balance ?? totals.Total,
    Booked: seed.Booked ?? false,
    Cancelled: seed.Cancelled ?? false,
    Comments: seed.Comments ?? '',
    CostCenter: seed.CostCenter ?? '',
    Credit: seed.Credit ?? 'false',
    Currency: seed.Currency ?? customer?.Currency ?? 'SEK',
    CurrencyRate: seed.CurrencyRate ?? 1,
    CurrencyUnit: seed.CurrencyUnit ?? 1,
    DueDate: seed.DueDate ?? null,
    EmailInformation: seed.EmailInformation ?? defaultEmailInformation(customer, company),
    ExternalInvoiceReference1: seed.ExternalInvoiceReference1 ?? '',
    ExternalInvoiceReference2: seed.ExternalInvoiceReference2 ?? '',
    FinalPayDate: seed.FinalPayDate ?? null,
    Gross: totals.Gross,
    InvoiceDate: seed.InvoiceDate ?? '2026-09-30',
    InvoiceRows: rows,
    InvoiceType: seed.InvoiceType ?? 'INVOICE',
    Net: totals.Net,
    NotCompleted: seed.NotCompleted ?? false,
    NoxFinans: seed.NoxFinans ?? false,
    OCR: seed.OCR ?? '',
    OurReference: seed.OurReference ?? '',
    Project: seed.Project ?? '',
    Sent: seed.Sent ?? false,
    TermsOfPayment: seed.TermsOfPayment ?? customer?.TermsOfPayment ?? '30',
    Total: totals.Total,
    TotalToPay: totals.TotalToPay,
    TotalVAT: totals.TotalVAT,
    VoucherNumber: seed.VoucherNumber ?? null,
    VoucherSeries: seed.VoucherSeries ?? null,
    VoucherYear: seed.VoucherYear ?? null,
    WayOfDelivery: seed.WayOfDelivery ?? '',
    YourReference: seed.YourReference ?? ''
  }
}

const duplicate = (values: ReadonlyArray<string | number>): string | number | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

const quantityProblem = (rows: ReadonlyArray<FortnoxEmulatorInvoiceRowSeed>) =>
  rows.find(
    row => row.DeliveredQuantity !== undefined && !Number.isFinite(Number(row.DeliveredQuantity))
  )

/** Integrity problems a decoded seed can still have (duplicates, dangling references). */
const seedProblem = (entities: ProfileEntities): string | undefined => {
  const customerNumbers = entities.customers.map(customer => customer.CustomerNumber)
  const documentNumbers = entities.invoices.map(invoice => invoice.DocumentNumber)

  const rowIds = entities.invoices.flatMap(invoice =>
    (invoice.InvoiceRows ?? []).flatMap(row => (row.RowId === undefined ? [] : [row.RowId]))
  )

  const duplicateCustomer = duplicate(customerNumbers)
  const duplicateInvoice = duplicate(documentNumbers)
  const duplicateRow = duplicate(rowIds)

  if (duplicateCustomer !== undefined) return `duplicate CustomerNumber ${duplicateCustomer}`

  if (duplicateInvoice !== undefined) return `duplicate DocumentNumber ${duplicateInvoice}`

  if (duplicateRow !== undefined) return `duplicate RowId ${duplicateRow}`

  const dangling = entities.invoices.find(
    invoice => !customerNumbers.includes(invoice.CustomerNumber)
  )

  if (dangling !== undefined) {
    return `invoice ${dangling.DocumentNumber} references missing customer ${dangling.CustomerNumber}`
  }

  const badQuantity = entities.invoices.find(
    invoice => quantityProblem(invoice.InvoiceRows ?? []) !== undefined
  )

  return badQuantity === undefined
    ? undefined
    : `invoice ${badQuantity.DocumentNumber} has a non-numeric DeliveredQuantity`
}

const nextNumber = (numbers: ReadonlyArray<string>): number =>
  numbers.reduce((max, value) => {
    const parsed = Number(value)

    return Number.isSafeInteger(parsed) && parsed >= max ? parsed + 1 : max
  }, 1)

/** Build the emulator state for a decoded seed; a string is an integrity problem. */
const stateFromSeed = (seed: FortnoxEmulatorSeed): FortnoxEmulatorState | string => {
  const profile = profileEntities(seed.profile ?? 'default')

  const entities: ProfileEntities = {
    company: seed.company ?? profile.company,
    customers: seed.customers ?? profile.customers,
    invoices: seed.invoices ?? profile.invoices
  }

  const problem = seedProblem(entities)

  if (problem !== undefined) {
    return problem
  }

  const customers = entities.customers
    .map(customerFromSeed)
    .sort((left, right) => compareNumbers(left.CustomerNumber, right.CustomerNumber))

  const explicitRowIds = entities.invoices.flatMap(invoice =>
    (invoice.InvoiceRows ?? []).flatMap(row => (row.RowId === undefined ? [] : [row.RowId]))
  )

  const ids: RowIdSource = { next: Math.max(0, ...explicitRowIds) + 1 }

  const invoices = entities.invoices
    .map(invoice =>
      invoiceFromSeed(
        invoice,
        customers.find(customer => customer.CustomerNumber === invoice.CustomerNumber),
        entities.company,
        ids
      )
    )
    .sort((left, right) => compareNumbers(left.DocumentNumber, right.DocumentNumber))

  return {
    company: entities.company,
    customers,
    invoices,
    outbox: [],
    counters: {
      nextRowId: ids.next,
      nextDocumentNumber: nextNumber(invoices.map(invoice => invoice.DocumentNumber))
    }
  }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildSeedState = (input: unknown): FortnoxEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): FortnoxEmulatorState | string => {
  const decoded = decodeStateInput(input)

  if (Result.isFailure(decoded)) {
    return issueMessage(decoded.failure.issue)
  }

  return { ...decoded.success }
}
