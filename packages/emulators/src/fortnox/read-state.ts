/**
 * Fortnox emulator read-only resources (internal; part of the state built by `src/fortnox/state.ts`
 * and served by `src/fortnox/read-api.ts`): articles, price lists and prices, cost centers,
 * customer and supplier invoice payments, offers, print templates, the inbox, company settings,
 * the locked period, predefined accounts, labels, the five settings registers, and the user.
 *
 * No conformance fixture records these resources: every shape is a minimal one named after the
 * fields the connector reads (`@yolk-sdk/connectors/fortnox`), and every default is synthetic
 * (Example AB, `example.test`). No route writes them.
 *
 * @experimental
 */
import { Struct } from 'effect'
import * as Schema from 'effect/Schema'

const NonEmpty = Schema.String.check(Schema.isNonEmpty())

/** A non-empty key that the connector also accepts in a URL path (no `.` or `..`). */
const Key = NonEmpty.check(Schema.isPattern(/^(?!\.{1,2}$)[^/]+$/u))

const DigitsKey = Schema.String.check(Schema.isPattern(/^[0-9]+$/u))

const NullableDate = Schema.NullOr(Schema.String)

// Articles ---------------------------------------------------------------------------------------

const articleFields = {
  ArticleNumber: Key,
  Description: Schema.String,
  Active: Schema.Boolean,
  Type: Schema.Literals(['STOCK', 'SERVICE']),
  Unit: Schema.String,
  EAN: Schema.String,
  VAT: Schema.Finite,
  PurchasePrice: Schema.Finite,
  QuantityInStock: Schema.Finite,
  StockGoods: Schema.Boolean,
  SalesAccount: Schema.NullOr(Schema.Int),
  SupplierNumber: Schema.String,
  Manufacturer: Schema.String,
  ManufacturerArticleNumber: Schema.String,
  Note: Schema.String
}

/** A stored article. `SalesPrice` is not stored: it is the default price list's base price. */
export const FortnoxEmulatorArticle = Schema.Struct(articleFields)

export type FortnoxEmulatorArticle = typeof FortnoxEmulatorArticle.Type

/** A seeded article: `ArticleNumber` and `Description` are required. */
export const FortnoxEmulatorArticleSeed = Schema.Struct(
  Struct.mapOmit(articleFields, ['ArticleNumber', 'Description'], Schema.optionalKey)
)

export type FortnoxEmulatorArticleSeed = typeof FortnoxEmulatorArticleSeed.Type

// Price lists and prices -------------------------------------------------------------------------

export const FortnoxEmulatorPriceList = Schema.Struct({
  Code: Key,
  Description: Schema.String,
  Comments: Schema.String,
  /** The company default price list (at most one). */
  PreSelected: Schema.Boolean
})

export type FortnoxEmulatorPriceList = typeof FortnoxEmulatorPriceList.Type

/** The connector puts `FromQuantity` in a URL path: only plain decimals (no exponent) round-trip. */
const FromQuantity = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.makeFilter((value: number) =>
    /e/i.test(String(value)) ? 'Expected a FromQuantity with a plain decimal form' : true
  )
)

/** One article price in one price list, from `FromQuantity` up. */
export const FortnoxEmulatorPrice = Schema.Struct({
  PriceList: Key,
  ArticleNumber: Key,
  FromQuantity,
  Price: Schema.Finite,
  Percent: Schema.Finite,
  /** Last modification, `YYYY-MM-DD`. */
  Date: Schema.String
})

export type FortnoxEmulatorPrice = typeof FortnoxEmulatorPrice.Type

// Cost centers -----------------------------------------------------------------------------------

export const FortnoxEmulatorCostCenter = Schema.Struct({
  Code: Key,
  Description: Schema.String,
  Note: Schema.String,
  Active: Schema.Boolean
})

export type FortnoxEmulatorCostCenter = typeof FortnoxEmulatorCostCenter.Type

// Payments ---------------------------------------------------------------------------------------

const invoicePaymentFields = {
  Number: DigitsKey,
  /** The customer invoice `DocumentNumber` (must be a held invoice). */
  InvoiceNumber: Key,
  Amount: Schema.Finite,
  AmountCurrency: Schema.Finite,
  PaymentDate: Schema.String,
  /** A mode of payment `Code`, or `""`. */
  ModeOfPayment: Schema.String,
  Booked: Schema.Boolean,
  VoucherNumber: Schema.NullOr(Schema.Int),
  VoucherSeries: Schema.NullOr(Schema.String),
  VoucherYear: Schema.NullOr(Schema.Int)
}

/**
 * A stored customer invoice payment. The invoice snapshot fields (`InvoiceCustomerName`,
 * `InvoiceTotal`, `Currency`, ...) are rendered from the held invoice, never stored.
 */
export const FortnoxEmulatorInvoicePayment = Schema.Struct(invoicePaymentFields)

export type FortnoxEmulatorInvoicePayment = typeof FortnoxEmulatorInvoicePayment.Type

/** A seeded invoice payment: `Number`, `InvoiceNumber`, `Amount`, `PaymentDate` are required. */
export const FortnoxEmulatorInvoicePaymentSeed = Schema.Struct(
  Struct.mapOmit(
    invoicePaymentFields,
    ['Number', 'InvoiceNumber', 'Amount', 'PaymentDate'],
    Schema.optionalKey
  )
)

export type FortnoxEmulatorInvoicePaymentSeed = typeof FortnoxEmulatorInvoicePaymentSeed.Type

const supplierInvoicePaymentFields = {
  Number: DigitsKey,
  /**
   * The supplier invoice `GivenNumber`. Supplier invoices are not emulated, so the snapshot fields
   * below are stored with the payment and this reference is not checked.
   */
  InvoiceNumber: Key,
  Amount: Schema.Finite,
  AmountCurrency: Schema.Finite,
  Currency: Schema.String,
  CurrencyRate: Schema.Finite,
  CurrencyUnit: Schema.Finite,
  Booked: Schema.Boolean,
  Information: Schema.String,
  InvoiceDueDate: NullableDate,
  InvoiceOCR: Schema.String,
  InvoiceSupplierName: Schema.String,
  InvoiceSupplierNumber: Schema.String,
  InvoiceTotal: Schema.Finite,
  ModeOfPayment: Schema.String,
  PaymentDate: Schema.String,
  VoucherNumber: Schema.NullOr(Schema.Int),
  VoucherSeries: Schema.NullOr(Schema.String),
  VoucherYear: Schema.NullOr(Schema.Int)
}

export const FortnoxEmulatorSupplierInvoicePayment = Schema.Struct(supplierInvoicePaymentFields)

export type FortnoxEmulatorSupplierInvoicePayment =
  typeof FortnoxEmulatorSupplierInvoicePayment.Type

/** A seeded supplier invoice payment: `Number`, `InvoiceNumber`, `Amount`, `PaymentDate`. */
export const FortnoxEmulatorSupplierInvoicePaymentSeed = Schema.Struct(
  Struct.mapOmit(
    supplierInvoicePaymentFields,
    ['Number', 'InvoiceNumber', 'Amount', 'PaymentDate'],
    Schema.optionalKey
  )
)

export type FortnoxEmulatorSupplierInvoicePaymentSeed =
  typeof FortnoxEmulatorSupplierInvoicePaymentSeed.Type

// Offers -----------------------------------------------------------------------------------------

const DiscountType = Schema.Literals(['PERCENT', 'AMOUNT'])

const offerRowFields = {
  RowId: Schema.Int,
  /** A held article, or `""`. */
  ArticleNumber: Schema.String,
  AccountNumber: Schema.NullOr(Schema.Int),
  Description: Schema.String,
  /** Two-decimal numeric string (`"10.00"`), as Fortnox docs examples send it. */
  Quantity: Schema.String,
  Unit: Schema.String,
  Price: Schema.Finite,
  Discount: Schema.Finite,
  DiscountType,
  VAT: Schema.Finite,
  /** Derived: `Price × Quantity`, less the discount. */
  Total: Schema.Finite,
  CostCenter: Schema.String,
  Project: Schema.String
}

export const FortnoxEmulatorOfferRow = Schema.Struct(offerRowFields)

export type FortnoxEmulatorOfferRow = typeof FortnoxEmulatorOfferRow.Type

const OfferEmailInformation = Schema.Struct({
  EmailAddressFrom: Schema.String,
  EmailAddressTo: Schema.String,
  EmailAddressCC: Schema.String,
  EmailAddressBCC: Schema.String,
  EmailSubject: Schema.String
})

const offerScalarFields = {
  DocumentNumber: Key,
  CustomerNumber: Key,
  CustomerName: Schema.String,
  OfferDate: Schema.String,
  ExpireDate: Schema.String,
  DeliveryDate: NullableDate,
  Currency: Schema.String,
  CurrencyRate: Schema.Finite,
  VATIncluded: Schema.Boolean,
  Cancelled: Schema.Boolean,
  Sent: Schema.Boolean,
  NotCompleted: Schema.Boolean,
  /** `"0"` means no order was created (orders are not emulated). */
  OrderReference: Schema.String,
  /** `"0"` means no invoice was created. */
  InvoiceReference: Schema.String,
  OurReference: Schema.String,
  YourReference: Schema.String,
  Comments: Schema.String,
  Remarks: Schema.String,
  /** A held cost center, or `""`. */
  CostCenter: Schema.String,
  Project: Schema.String,
  EmailInformation: OfferEmailInformation
}

/** A stored offer with its rows; the totals are derived from the rows. */
export const FortnoxEmulatorOffer = Schema.Struct({
  ...offerScalarFields,
  OfferRows: Schema.Array(FortnoxEmulatorOfferRow),
  Net: Schema.Finite,
  Gross: Schema.Finite,
  TotalVAT: Schema.Finite,
  Total: Schema.Finite,
  TotalToPay: Schema.Finite
})

export type FortnoxEmulatorOffer = typeof FortnoxEmulatorOffer.Type

const { RowId: _rowId, Total: _total, ...offerRowSeedFields } = offerRowFields

/** A seeded offer row: `RowId` (numbered from 1 per offer) and `Total` are derived. */
export const FortnoxEmulatorOfferRowSeed = Schema.Struct(
  Struct.map(offerRowSeedFields, Schema.optionalKey)
)

export type FortnoxEmulatorOfferRowSeed = typeof FortnoxEmulatorOfferRowSeed.Type

/**
 * A seeded offer: `DocumentNumber` and `CustomerNumber` are required; `CustomerName` and the
 * `EmailInformation` recipient follow the customer.
 */
export const FortnoxEmulatorOfferSeed = Schema.Struct({
  ...Struct.mapOmit(offerScalarFields, ['DocumentNumber', 'CustomerNumber'], Schema.optionalKey),
  OfferRows: Schema.optionalKey(Schema.Array(FortnoxEmulatorOfferRowSeed))
})

export type FortnoxEmulatorOfferSeed = typeof FortnoxEmulatorOfferSeed.Type

// Print templates --------------------------------------------------------------------------------

const PrintTemplate = Schema.Struct({ Template: Key, Name: Schema.String })

/** Print templates per document type (`GET /3/printtemplates?type=`). */
export const FortnoxEmulatorPrintTemplates = Schema.Struct({
  invoice: Schema.Array(PrintTemplate),
  offer: Schema.Array(PrintTemplate),
  order: Schema.Array(PrintTemplate)
})

export type FortnoxEmulatorPrintTemplates = typeof FortnoxEmulatorPrintTemplates.Type

// Inbox ------------------------------------------------------------------------------------------

/** An inbox folder. `root` (no parent) holds the static folders; every other folder has one. */
export const FortnoxEmulatorInboxFolder = Schema.Struct({
  Id: Key,
  Name: Schema.String,
  Email: Schema.String,
  ParentId: Schema.NullOr(Key)
})

export type FortnoxEmulatorInboxFolder = typeof FortnoxEmulatorInboxFolder.Type

const inboxFileFields = {
  Id: Key,
  Name: Schema.String,
  Path: Schema.String,
  ArchiveFileId: Schema.NullOr(Schema.String),
  Comments: Schema.String,
  /** The folder holding the file. */
  FolderId: Key,
  /** The file bytes, canonical standard base64 (`Size` is derived from them). */
  ContentBase64: Schema.String
}

export const FortnoxEmulatorInboxFile = Schema.Struct(inboxFileFields)

export type FortnoxEmulatorInboxFile = typeof FortnoxEmulatorInboxFile.Type

/** A seeded inbox file: `Path`, `ArchiveFileId`, and `Comments` are optional. */
export const FortnoxEmulatorInboxFileSeed = Schema.Struct(
  Struct.mapOmit(inboxFileFields, ['Id', 'Name', 'FolderId', 'ContentBase64'], Schema.optionalKey)
)

export type FortnoxEmulatorInboxFileSeed = typeof FortnoxEmulatorInboxFileSeed.Type

// Settings ---------------------------------------------------------------------------------------

export const FortnoxEmulatorCompanySettings = Schema.Struct({
  Name: Schema.String,
  OrganizationNumber: Schema.String,
  Address: Schema.String,
  ZipCode: Schema.String,
  City: Schema.String,
  Country: Schema.String,
  CountryCode: Schema.String,
  VisitName: Schema.String,
  VisitAddress: Schema.String,
  VisitZipCode: Schema.String,
  VisitCity: Schema.String,
  VisitCountry: Schema.String,
  VisitCountryCode: Schema.String,
  Email: Schema.String,
  Phone1: Schema.String,
  Phone2: Schema.String,
  WWW: Schema.String,
  BG: Schema.String,
  PG: Schema.String,
  IBAN: Schema.String,
  BIC: Schema.String,
  VATNumber: Schema.String,
  TaxEnabled: Schema.Boolean,
  Domicile: Schema.String,
  BranchCode: Schema.String
})

export type FortnoxEmulatorCompanySettings = typeof FortnoxEmulatorCompanySettings.Type

/** The locked bookkeeping period; `EndDate` `null` means none is locked. */
export const FortnoxEmulatorLockedPeriod = Schema.Struct({ EndDate: NullableDate })

export type FortnoxEmulatorLockedPeriod = typeof FortnoxEmulatorLockedPeriod.Type

export const FortnoxEmulatorPredefinedAccount = Schema.Struct({
  Name: Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/u)),
  Account: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9999 }))
})

export type FortnoxEmulatorPredefinedAccount = typeof FortnoxEmulatorPredefinedAccount.Type

export const FortnoxEmulatorLabel = Schema.Struct({
  Id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
  Description: Schema.String
})

export type FortnoxEmulatorLabel = typeof FortnoxEmulatorLabel.Type

export const FortnoxEmulatorModeOfPayment = Schema.Struct({
  Code: Key,
  Description: Schema.String,
  AccountNumber: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9999 }))
})

export type FortnoxEmulatorModeOfPayment = typeof FortnoxEmulatorModeOfPayment.Type

export const FortnoxEmulatorTermsOfPayment = Schema.Struct({
  Code: Key,
  Description: Schema.String
})

export type FortnoxEmulatorTermsOfPayment = typeof FortnoxEmulatorTermsOfPayment.Type

/** A terms-of-delivery or way-of-delivery register entry (the same fields). */
export const FortnoxEmulatorDeliveryRegisterEntry = Schema.Struct({
  Code: Key,
  Description: Schema.String,
  DescriptionEnglish: Schema.String
})

export type FortnoxEmulatorDeliveryRegisterEntry = typeof FortnoxEmulatorDeliveryRegisterEntry.Type

export const FortnoxEmulatorUnit = Schema.Struct({
  Code: Key,
  Description: Schema.String,
  CodeEnglish: Schema.String
})

export type FortnoxEmulatorUnit = typeof FortnoxEmulatorUnit.Type

/** The user behind the access token (`GET /3/me`). */
export const FortnoxEmulatorMe = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Email: Schema.String,
  Locale: Schema.String,
  SysAdmin: Schema.Boolean
})

export type FortnoxEmulatorMe = typeof FortnoxEmulatorMe.Type

// State and seed parts ---------------------------------------------------------------------------

/** The read-only parts of the state schema (spread into `FortnoxEmulatorStateSchema`). */
export const fortnoxReadStateFields = {
  articles: Schema.Array(FortnoxEmulatorArticle),
  priceLists: Schema.Array(FortnoxEmulatorPriceList),
  prices: Schema.Array(FortnoxEmulatorPrice),
  costCenters: Schema.Array(FortnoxEmulatorCostCenter),
  invoicePayments: Schema.Array(FortnoxEmulatorInvoicePayment),
  supplierInvoicePayments: Schema.Array(FortnoxEmulatorSupplierInvoicePayment),
  offers: Schema.Array(FortnoxEmulatorOffer),
  printTemplates: FortnoxEmulatorPrintTemplates,
  inboxFolders: Schema.Array(FortnoxEmulatorInboxFolder),
  inboxFiles: Schema.Array(FortnoxEmulatorInboxFile),
  companySettings: FortnoxEmulatorCompanySettings,
  lockedPeriod: FortnoxEmulatorLockedPeriod,
  predefinedAccounts: Schema.Array(FortnoxEmulatorPredefinedAccount),
  labels: Schema.Array(FortnoxEmulatorLabel),
  modesOfPayment: Schema.Array(FortnoxEmulatorModeOfPayment),
  termsOfPayment: Schema.Array(FortnoxEmulatorTermsOfPayment),
  termsOfDelivery: Schema.Array(FortnoxEmulatorDeliveryRegisterEntry),
  waysOfDelivery: Schema.Array(FortnoxEmulatorDeliveryRegisterEntry),
  units: Schema.Array(FortnoxEmulatorUnit),
  me: FortnoxEmulatorMe
}

const FortnoxReadState = Schema.Struct(fortnoxReadStateFields)

/** The read-only parts of the emulator state. */
export type FortnoxReadState = typeof FortnoxReadState.Type

const readSeedFields = {
  ...fortnoxReadStateFields,
  articles: Schema.Array(FortnoxEmulatorArticleSeed),
  invoicePayments: Schema.Array(FortnoxEmulatorInvoicePaymentSeed),
  supplierInvoicePayments: Schema.Array(FortnoxEmulatorSupplierInvoicePaymentSeed),
  offers: Schema.Array(FortnoxEmulatorOfferSeed),
  inboxFiles: Schema.Array(FortnoxEmulatorInboxFileSeed)
}

/** The read-only seed keys (spread into `FortnoxEmulatorSeed`); each replaces the profile's part. */
export const fortnoxReadSeedFields = Struct.map(readSeedFields, Schema.optionalKey)

const FortnoxReadEntities = Schema.Struct(readSeedFields)

/** Every read-only seed part, as a profile supplies it. */
export type FortnoxReadEntities = typeof FortnoxReadEntities.Type

// Default entities (synthetic) -------------------------------------------------------------------

const defaultArticles: ReadonlyArray<FortnoxEmulatorArticleSeed> = [
  {
    ArticleNumber: 'KIT-1',
    Description: 'Workshop kit (synthetic)',
    Type: 'STOCK',
    Unit: 'st',
    EAN: '2000000000015',
    PurchasePrice: 120,
    QuantityInStock: 15,
    StockGoods: true,
    SalesAccount: 3001,
    Manufacturer: 'Example Tools AB',
    ManufacturerArticleNumber: 'EX-KIT-1'
  },
  {
    ArticleNumber: 'SRV-1',
    Description: 'Consulting hour (synthetic)',
    Type: 'SERVICE',
    Unit: 'h',
    SalesAccount: 3041,
    Note: 'Synthetic service article.'
  },
  {
    ArticleNumber: 'SRV-OLD',
    Description: 'Retired service (synthetic)',
    Active: false,
    Type: 'SERVICE',
    Unit: 'h',
    SalesAccount: 3041
  }
]

const defaultPriceLists: ReadonlyArray<FortnoxEmulatorPriceList> = [
  { Code: 'A', Description: 'Standard (synthetic)', Comments: '', PreSelected: true },
  {
    Code: 'B',
    Description: 'Reseller (synthetic)',
    Comments: 'Synthetic reseller prices.',
    PreSelected: false
  }
]

const price = (
  priceList: string,
  articleNumber: string,
  fromQuantity: number,
  amount: number
): FortnoxEmulatorPrice => ({
  PriceList: priceList,
  ArticleNumber: articleNumber,
  FromQuantity: fromQuantity,
  Price: amount,
  Percent: 0,
  Date: '2026-08-01'
})

const defaultPrices: ReadonlyArray<FortnoxEmulatorPrice> = [
  price('A', 'KIT-1', 0, 250),
  price('A', 'KIT-1', 10, 220),
  price('A', 'SRV-1', 0, 950),
  price('A', 'SRV-OLD', 0, 800),
  price('B', 'KIT-1', 0, 200)
]

const defaultCostCenters: ReadonlyArray<FortnoxEmulatorCostCenter> = [
  { Code: 'CC1', Description: 'Sales (synthetic)', Note: '', Active: true },
  { Code: 'CC2', Description: 'Support (synthetic)', Note: 'Synthetic note.', Active: true },
  { Code: 'CC9', Description: 'Closed unit (synthetic)', Note: '', Active: false }
]

// Invoice 101 is fully paid (Balance 0, FinalPayDate 2026-09-20): one booked payment of its Total.
const defaultInvoicePayments: ReadonlyArray<FortnoxEmulatorInvoicePaymentSeed> = [
  {
    Number: '1',
    InvoiceNumber: '101',
    Amount: 1250,
    PaymentDate: '2026-09-20',
    ModeOfPayment: 'BG',
    Booked: true,
    VoucherNumber: 1,
    VoucherSeries: 'C',
    VoucherYear: 3
  }
]

const defaultSupplierInvoicePayments: ReadonlyArray<FortnoxEmulatorSupplierInvoicePaymentSeed> = [
  {
    Number: '1',
    InvoiceNumber: '1',
    Amount: 500,
    PaymentDate: '2026-09-25',
    ModeOfPayment: 'BG',
    InvoiceDueDate: '2026-09-30',
    InvoiceSupplierName: 'Example Supplier AB',
    InvoiceSupplierNumber: '1',
    InvoiceTotal: 500
  }
]

const offerEmail = (subject: string, recipient: string) => ({
  EmailAddressFrom: 'offers@example.test',
  EmailAddressTo: recipient,
  EmailAddressCC: '',
  EmailAddressBCC: '',
  EmailSubject: subject
})

const defaultOffers: ReadonlyArray<FortnoxEmulatorOfferSeed> = [
  {
    DocumentNumber: '1',
    CustomerNumber: '1001',
    OfferDate: '2026-09-01',
    ExpireDate: '2026-09-30',
    OurReference: 'Example Seller',
    CostCenter: 'CC1',
    Sent: true,
    Comments: 'Synthetic offer.',
    OfferRows: [
      {
        ArticleNumber: 'SRV-1',
        Description: 'Consulting hour (synthetic)',
        Quantity: '10.00',
        Unit: 'h',
        Price: 950
      },
      {
        ArticleNumber: 'KIT-1',
        Description: 'Workshop kit (synthetic)',
        Quantity: '2.00',
        Unit: 'st',
        Price: 250,
        Discount: 10,
        DiscountType: 'PERCENT'
      }
    ]
  },
  {
    DocumentNumber: '2',
    CustomerNumber: '1002',
    OfferDate: '2026-09-20',
    ExpireDate: '2026-10-20',
    NotCompleted: true,
    OfferRows: [
      {
        ArticleNumber: 'KIT-1',
        Description: 'Workshop kit (synthetic)',
        Quantity: '20.00',
        Unit: 'st',
        Price: 220
      }
    ]
  },
  {
    DocumentNumber: '3',
    CustomerNumber: '1001',
    OfferDate: '2026-08-01',
    ExpireDate: '2026-08-31',
    Cancelled: true,
    OfferRows: [{ Description: 'Synthetic cancelled line', Quantity: '1.00', Price: 100 }]
  }
]

/** Fortnox docs: the inbox root always holds these nine static folders. */
const staticInboxFolders: ReadonlyArray<readonly [string, string]> = [
  ['inbox_a', 'Asset register'],
  ['inbox_d', 'Daily takings'],
  ['inbox_s', 'Supplier invoices'],
  ['inbox_v', 'Vouchers'],
  ['inbox_b', 'Bank files'],
  ['inbox_l', 'Payroll'],
  ['inbox_kf', 'Customer invoices'],
  ['inbox_o', 'Orders'],
  ['inbox_of', 'Offers']
]

const inboxEmail = (id: string) => `${id}.100001@inbox.example.test`

const defaultInboxFolders: ReadonlyArray<FortnoxEmulatorInboxFolder> = [
  { Id: 'root', Name: 'Inbox', Email: inboxEmail('root'), ParentId: null },
  ...staticInboxFolders.map(([id, name]) => ({
    Id: id,
    Name: `${name} (synthetic)`,
    Email: inboxEmail(id),
    ParentId: 'root'
  }))
]

const textBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

const defaultInboxFiles: ReadonlyArray<FortnoxEmulatorInboxFileSeed> = [
  {
    Id: '00000000-0000-4000-8000-000000000001',
    Name: 'supplier-invoice-synthetic.txt',
    Path: 'inbox_s/supplier-invoice-synthetic.txt',
    ArchiveFileId: '00000000-0000-4000-8000-000000000101',
    FolderId: 'inbox_s',
    ContentBase64: textBase64(
      'Synthetic supplier invoice from Example Supplier AB (example.test).\n'
    )
  },
  {
    Id: '00000000-0000-4000-8000-000000000002',
    Name: 'receipt-synthetic.txt',
    Path: 'inbox_v/receipt-synthetic.txt',
    Comments: 'Synthetic receipt.',
    FolderId: 'inbox_v',
    ContentBase64: textBase64('Synthetic receipt (example.test).\n')
  }
]

/** The default read-only entities (synthetic Example AB data, mutually consistent). */
export const defaultReadEntities: FortnoxReadEntities = {
  articles: defaultArticles,
  priceLists: defaultPriceLists,
  prices: defaultPrices,
  costCenters: defaultCostCenters,
  invoicePayments: defaultInvoicePayments,
  supplierInvoicePayments: defaultSupplierInvoicePayments,
  offers: defaultOffers,
  printTemplates: {
    invoice: [
      { Template: 'invoice-standard', Name: 'Standard invoice (synthetic)' },
      { Template: 'invoice-reminder', Name: 'Reminder (synthetic)' }
    ],
    offer: [{ Template: 'offer-standard', Name: 'Standard offer (synthetic)' }],
    order: [{ Template: 'order-standard', Name: 'Standard order (synthetic)' }]
  },
  inboxFolders: defaultInboxFolders,
  inboxFiles: defaultInboxFiles,
  companySettings: {
    Name: 'Example AB',
    OrganizationNumber: '000000-0002',
    Address: 'Exempelgatan 10',
    ZipCode: '000 02',
    City: 'Exempelstad',
    Country: 'Sverige',
    CountryCode: 'SE',
    VisitName: 'Example AB',
    VisitAddress: 'Exempelgatan 10',
    VisitZipCode: '000 02',
    VisitCity: 'Exempelstad',
    VisitCountry: 'Sverige',
    VisitCountryCode: 'SE',
    Email: 'info@example.test',
    Phone1: '',
    Phone2: '',
    WWW: 'https://example.test',
    BG: '',
    PG: '',
    IBAN: '',
    BIC: '',
    VATNumber: '',
    TaxEnabled: true,
    Domicile: 'Exempelstad',
    BranchCode: ''
  },
  lockedPeriod: { EndDate: '2026-06-30' },
  predefinedAccounts: [
    { Name: 'BG', Account: 1930 },
    { Name: 'SALES', Account: 3001 },
    { Name: 'SALES2', Account: 3041 },
    { Name: 'OUTVAT_MP1', Account: 2611 }
  ],
  labels: [
    { Id: 1, Description: 'Priority (synthetic)' },
    { Id: 2, Description: 'Follow up (synthetic)' }
  ],
  modesOfPayment: [
    { Code: 'BG', Description: 'Bankgiro (synthetic)', AccountNumber: 1930 },
    { Code: 'KONT', Description: 'Cash (synthetic)', AccountNumber: 1910 }
  ],
  termsOfPayment: [
    { Code: '10', Description: '10 days (synthetic)' },
    { Code: '30', Description: '30 days (synthetic)' }
  ],
  termsOfDelivery: [
    { Code: 'EXW', Description: 'Ex works (synthetic)', DescriptionEnglish: 'Ex works' }
  ],
  waysOfDelivery: [{ Code: 'P', Description: 'Post (synthetic)', DescriptionEnglish: 'Mail' }],
  units: [
    { Code: 'h', Description: 'Hour (synthetic)', CodeEnglish: 'h' },
    { Code: 'st', Description: 'Piece (synthetic)', CodeEnglish: 'pcs' }
  ],
  me: {
    Id: 'synthetic-user-1',
    Name: 'Example User',
    Email: 'user@example.test',
    Locale: 'sv_SE',
    SysAdmin: true
  }
}

/**
 * The business data of the `empty-company` profile: no articles, prices, cost centers, payments,
 * offers, labels, or inbox files. The settings, registers, print templates, the user, and the
 * inbox folders stay (every Fortnox company has them).
 */
export const emptyCompanyReadEntities: FortnoxReadEntities = {
  ...defaultReadEntities,
  articles: [],
  priceLists: [],
  prices: [],
  costCenters: [],
  invoicePayments: [],
  supplierInvoicePayments: [],
  offers: [],
  labels: [],
  inboxFiles: []
}

// Building ---------------------------------------------------------------------------------------

/** The customer and invoice facts the read-only resources reference. */
export type FortnoxReadReferences = {
  readonly customers: ReadonlyArray<{
    readonly CustomerNumber: string
    readonly Name: string
    readonly EmailInvoice: string
  }>
  readonly invoiceNumbers: ReadonlyArray<string>
}

/** The first value that occurs twice, or `undefined`. */
export const duplicate = (values: ReadonlyArray<string | number>): string | number | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

/** Numeric-aware order for Fortnox numbers (`"999" < "1001"`). */
export const compareNumbers = (left: string, right: string): number =>
  left.localeCompare(right, 'en', { numeric: true })

const byKey =
  <A>(key: (item: A) => string) =>
  (left: A, right: A): number =>
    compareNumbers(key(left), key(right))

export const round2 = (value: number): number => Math.round(value * 100) / 100

const canonicalBase64 = (value: string): boolean =>
  value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && btoa(atob(value)) === value

const unique = (label: string, values: ReadonlyArray<string | number>): string | undefined => {
  const repeated = duplicate(values)

  return repeated === undefined ? undefined : `duplicate ${label} ${repeated}`
}

/** A reference to an entity that must exist when it is not empty. */
const dangling = (
  owner: string,
  kind: string,
  value: string,
  held: ReadonlyArray<string>
): string | undefined =>
  value === '' || held.includes(value) ? undefined : `${owner} references missing ${kind} ${value}`

const firstProblem = (problems: ReadonlyArray<string | undefined>): string | undefined =>
  problems.find(problem => problem !== undefined)

/** The folders reachable from `root` (each folder's parent chain ends there, without cycles). */
const reachableFolders = (folders: ReadonlyArray<FortnoxEmulatorInboxFolder>): Set<string> => {
  const reached = new Set<string>(['root'])
  let grew = true

  while (grew) {
    grew = false

    for (const folder of folders) {
      if (!reached.has(folder.Id) && folder.ParentId !== null && reached.has(folder.ParentId)) {
        reached.add(folder.Id)
        grew = true
      }
    }
  }

  return reached
}

/** Integrity problems of the read-only parts (duplicates, dangling references), or `undefined`. */
const readProblem = (
  entities: FortnoxReadEntities,
  references: FortnoxReadReferences
): string | undefined => {
  const articles = entities.articles.map(item => item.ArticleNumber)
  const priceLists = entities.priceLists.map(item => item.Code)
  const costCenters = entities.costCenters.map(item => item.Code)
  const units = entities.units.map(item => item.Code)
  const modes = entities.modesOfPayment.map(item => item.Code)
  const customers = references.customers.map(customer => customer.CustomerNumber)
  const folders = entities.inboxFolders.map(folder => folder.Id)
  const reached = reachableFolders(entities.inboxFolders)
  const root = entities.inboxFolders.find(folder => folder.Id === 'root')

  const templates = entities.printTemplates

  return firstProblem([
    unique('ArticleNumber', articles),
    unique('price list Code', priceLists),
    unique(
      'price',
      entities.prices.map(
        item => `${item.PriceList}/${item.ArticleNumber}/${String(item.FromQuantity)}`
      )
    ),
    unique('cost center Code', costCenters),
    unique(
      'invoice payment Number',
      entities.invoicePayments.map(item => item.Number)
    ),
    unique(
      'supplier invoice payment Number',
      entities.supplierInvoicePayments.map(item => item.Number)
    ),
    unique(
      'offer DocumentNumber',
      entities.offers.map(item => item.DocumentNumber)
    ),
    unique(
      'invoice print template',
      templates.invoice.map(item => item.Template)
    ),
    unique(
      'offer print template',
      templates.offer.map(item => item.Template)
    ),
    unique(
      'order print template',
      templates.order.map(item => item.Template)
    ),
    unique('inbox Id', [...folders, ...entities.inboxFiles.map(file => file.Id)]),
    unique(
      'predefined account Name',
      entities.predefinedAccounts.map(item => item.Name)
    ),
    unique(
      'label Id',
      entities.labels.map(item => item.Id)
    ),
    unique('mode of payment Code', modes),
    unique(
      'terms of payment Code',
      entities.termsOfPayment.map(item => item.Code)
    ),
    unique(
      'terms of delivery Code',
      entities.termsOfDelivery.map(item => item.Code)
    ),
    unique(
      'way of delivery Code',
      entities.waysOfDelivery.map(item => item.Code)
    ),
    unique('unit Code', units),
    entities.priceLists.filter(item => item.PreSelected).length > 1
      ? 'more than one PreSelected price list'
      : undefined,
    ...entities.articles.map(item =>
      dangling(`article ${item.ArticleNumber}`, 'unit', item.Unit ?? '', units)
    ),
    ...entities.prices.flatMap(item => [
      dangling(`price of ${item.ArticleNumber}`, 'price list', item.PriceList, priceLists),
      dangling(`price in ${item.PriceList}`, 'article', item.ArticleNumber, articles)
    ]),
    ...entities.invoicePayments.flatMap(item => [
      dangling(
        `invoice payment ${item.Number}`,
        'invoice',
        item.InvoiceNumber,
        references.invoiceNumbers
      ),
      dangling(`invoice payment ${item.Number}`, 'mode of payment', item.ModeOfPayment ?? '', modes)
    ]),
    ...entities.supplierInvoicePayments.map(item =>
      dangling(
        `supplier invoice payment ${item.Number}`,
        'mode of payment',
        item.ModeOfPayment ?? '',
        modes
      )
    ),
    ...entities.offers.flatMap(offer => [
      dangling(`offer ${offer.DocumentNumber}`, 'customer', offer.CustomerNumber, customers),
      dangling(`offer ${offer.DocumentNumber}`, 'cost center', offer.CostCenter ?? '', costCenters),
      ...(offer.OfferRows ?? []).flatMap(row => [
        dangling(`offer ${offer.DocumentNumber}`, 'article', row.ArticleNumber ?? '', articles),
        dangling(`offer ${offer.DocumentNumber}`, 'unit', row.Unit ?? '', units),
        dangling(`offer ${offer.DocumentNumber}`, 'cost center', row.CostCenter ?? '', costCenters),
        row.Quantity !== undefined && !Number.isFinite(Number(row.Quantity))
          ? `offer ${offer.DocumentNumber} has a non-numeric row Quantity`
          : undefined
      ])
    ]),
    root === undefined || root.ParentId !== null
      ? 'the inbox needs a root folder (Id root, ParentId null)'
      : undefined,
    ...entities.inboxFolders.map(folder =>
      reached.has(folder.Id) ? undefined : `inbox folder ${folder.Id} is not reachable from root`
    ),
    ...entities.inboxFiles.flatMap(file => [
      dangling(`inbox file ${file.Id}`, 'folder', file.FolderId, folders),
      canonicalBase64(file.ContentBase64)
        ? undefined
        : `inbox file ${file.Id} ContentBase64 is not canonical standard base64`
    ])
  ])
}

const articleFromSeed = (seed: FortnoxEmulatorArticleSeed): FortnoxEmulatorArticle => ({
  ArticleNumber: seed.ArticleNumber,
  Description: seed.Description,
  Active: seed.Active ?? true,
  Type: seed.Type ?? 'SERVICE',
  Unit: seed.Unit ?? '',
  EAN: seed.EAN ?? '',
  VAT: seed.VAT ?? 25,
  PurchasePrice: seed.PurchasePrice ?? 0,
  QuantityInStock: seed.QuantityInStock ?? 0,
  StockGoods: seed.StockGoods ?? false,
  SalesAccount: seed.SalesAccount ?? null,
  SupplierNumber: seed.SupplierNumber ?? '',
  Manufacturer: seed.Manufacturer ?? '',
  ManufacturerArticleNumber: seed.ManufacturerArticleNumber ?? '',
  Note: seed.Note ?? ''
})

const invoicePaymentFromSeed = (
  seed: FortnoxEmulatorInvoicePaymentSeed
): FortnoxEmulatorInvoicePayment => ({
  Number: seed.Number,
  InvoiceNumber: seed.InvoiceNumber,
  Amount: seed.Amount,
  AmountCurrency: seed.AmountCurrency ?? seed.Amount,
  PaymentDate: seed.PaymentDate,
  ModeOfPayment: seed.ModeOfPayment ?? '',
  Booked: seed.Booked ?? false,
  VoucherNumber: seed.VoucherNumber ?? null,
  VoucherSeries: seed.VoucherSeries ?? null,
  VoucherYear: seed.VoucherYear ?? null
})

const supplierInvoicePaymentFromSeed = (
  seed: FortnoxEmulatorSupplierInvoicePaymentSeed
): FortnoxEmulatorSupplierInvoicePayment => ({
  Number: seed.Number,
  InvoiceNumber: seed.InvoiceNumber,
  Amount: seed.Amount,
  AmountCurrency: seed.AmountCurrency ?? seed.Amount,
  Currency: seed.Currency ?? 'SEK',
  CurrencyRate: seed.CurrencyRate ?? 1,
  CurrencyUnit: seed.CurrencyUnit ?? 1,
  Booked: seed.Booked ?? false,
  Information: seed.Information ?? '',
  InvoiceDueDate: seed.InvoiceDueDate ?? null,
  InvoiceOCR: seed.InvoiceOCR ?? '',
  InvoiceSupplierName: seed.InvoiceSupplierName ?? '',
  InvoiceSupplierNumber: seed.InvoiceSupplierNumber ?? '',
  InvoiceTotal: seed.InvoiceTotal ?? seed.Amount,
  ModeOfPayment: seed.ModeOfPayment ?? '',
  PaymentDate: seed.PaymentDate,
  VoucherNumber: seed.VoucherNumber ?? null,
  VoucherSeries: seed.VoucherSeries ?? null,
  VoucherYear: seed.VoucherYear ?? null
})

const offerRowFromSeed = (
  seed: FortnoxEmulatorOfferRowSeed,
  rowId: number
): FortnoxEmulatorOfferRow => {
  const quantity = Number(seed.Quantity ?? '1')
  const unitPrice = seed.Price ?? 0
  const discount = seed.Discount ?? 0
  const discountType = seed.DiscountType ?? 'PERCENT'
  const gross = unitPrice * quantity

  return {
    RowId: rowId,
    ArticleNumber: seed.ArticleNumber ?? '',
    AccountNumber: seed.AccountNumber ?? 3001,
    Description: seed.Description ?? '',
    Quantity: quantity.toFixed(2),
    Unit: seed.Unit ?? '',
    Price: unitPrice,
    Discount: discount,
    DiscountType: discountType,
    VAT: seed.VAT ?? 25,
    Total: round2(discountType === 'AMOUNT' ? gross - discount : (gross * (100 - discount)) / 100),
    CostCenter: seed.CostCenter ?? '',
    Project: seed.Project ?? ''
  }
}

/** Offer totals from the rows, as the emulator computes invoice totals (whole-kronor `Total`). */
const offerFromSeed = (
  seed: FortnoxEmulatorOfferSeed,
  customer: FortnoxReadReferences['customers'][number] | undefined
): FortnoxEmulatorOffer => {
  const rows = (seed.OfferRows ?? []).map((row, index) => offerRowFromSeed(row, index + 1))
  const net = round2(rows.reduce((sum, row) => sum + row.Total, 0))
  const vat = round2(rows.reduce((sum, row) => sum + (row.Total * row.VAT) / 100, 0))
  const total = Math.round(net + vat)

  return {
    DocumentNumber: seed.DocumentNumber,
    CustomerNumber: seed.CustomerNumber,
    CustomerName: seed.CustomerName ?? customer?.Name ?? '',
    OfferDate: seed.OfferDate ?? '2026-09-30',
    ExpireDate: seed.ExpireDate ?? '2026-10-30',
    DeliveryDate: seed.DeliveryDate ?? null,
    Currency: seed.Currency ?? 'SEK',
    CurrencyRate: seed.CurrencyRate ?? 1,
    VATIncluded: seed.VATIncluded ?? false,
    Cancelled: seed.Cancelled ?? false,
    Sent: seed.Sent ?? false,
    NotCompleted: seed.NotCompleted ?? false,
    OrderReference: seed.OrderReference ?? '0',
    InvoiceReference: seed.InvoiceReference ?? '0',
    OurReference: seed.OurReference ?? '',
    YourReference: seed.YourReference ?? '',
    Comments: seed.Comments ?? '',
    Remarks: seed.Remarks ?? '',
    CostCenter: seed.CostCenter ?? '',
    Project: seed.Project ?? '',
    EmailInformation:
      seed.EmailInformation ??
      offerEmail('Offer {no} from Example AB', customer?.EmailInvoice ?? ''),
    OfferRows: rows,
    Net: net,
    Gross: net,
    TotalVAT: vat,
    Total: total,
    TotalToPay: total
  }
}

const inboxFileFromSeed = (seed: FortnoxEmulatorInboxFileSeed): FortnoxEmulatorInboxFile => ({
  Id: seed.Id,
  Name: seed.Name,
  Path: seed.Path ?? '',
  ArchiveFileId: seed.ArchiveFileId ?? null,
  Comments: seed.Comments ?? '',
  FolderId: seed.FolderId,
  ContentBase64: seed.ContentBase64
})

/**
 * Build the read-only state from its seed parts; a string is an integrity problem (a duplicate
 * key, or a reference to an entity that is not held). Lists are kept in key order.
 */
export const buildReadState = (
  entities: FortnoxReadEntities,
  references: FortnoxReadReferences
): FortnoxReadState | string => {
  const problem = readProblem(entities, references)

  if (problem !== undefined) return problem

  return {
    ...entities,
    articles: entities.articles.map(articleFromSeed).sort(byKey(item => item.ArticleNumber)),
    priceLists: [...entities.priceLists].sort(byKey(item => item.Code)),
    prices: [...entities.prices].sort(
      (left, right) =>
        compareNumbers(left.PriceList, right.PriceList) ||
        compareNumbers(left.ArticleNumber, right.ArticleNumber) ||
        left.FromQuantity - right.FromQuantity
    ),
    costCenters: [...entities.costCenters].sort(byKey(item => item.Code)),
    invoicePayments: entities.invoicePayments
      .map(invoicePaymentFromSeed)
      .sort(byKey(item => item.Number)),
    supplierInvoicePayments: entities.supplierInvoicePayments
      .map(supplierInvoicePaymentFromSeed)
      .sort(byKey(item => item.Number)),
    offers: entities.offers
      .map(offer =>
        offerFromSeed(
          offer,
          references.customers.find(customer => customer.CustomerNumber === offer.CustomerNumber)
        )
      )
      .sort(byKey(item => item.DocumentNumber)),
    inboxFiles: entities.inboxFiles.map(inboxFileFromSeed),
    predefinedAccounts: [...entities.predefinedAccounts].sort(byKey(item => item.Name)),
    labels: [...entities.labels].sort((left, right) => left.Id - right.Id),
    modesOfPayment: [...entities.modesOfPayment].sort(byKey(item => item.Code)),
    termsOfPayment: [...entities.termsOfPayment].sort(byKey(item => item.Code)),
    termsOfDelivery: [...entities.termsOfDelivery].sort(byKey(item => item.Code)),
    waysOfDelivery: [...entities.waysOfDelivery].sort(byKey(item => item.Code)),
    units: [...entities.units].sort(byKey(item => item.Code))
  }
}
