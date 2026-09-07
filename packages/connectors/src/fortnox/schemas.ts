import * as Schema from 'effect/Schema'

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())
// Reject dot segments and malformed UTF-16 before encoding identifiers into URL paths.
const Identifier = NonEmptyString.check(
  Schema.isPattern(/^(?!\.{1,2}$)[^\u0000-\u001f\u007f\uD800-\uDFFF]+$/)
)
export const FortnoxCustomerNumber = Identifier.pipe(Schema.brand('FortnoxCustomerNumber'))
export type FortnoxCustomerNumber = typeof FortnoxCustomerNumber.Type
export const FortnoxDocumentNumber = Identifier.pipe(Schema.brand('FortnoxDocumentNumber'))
export type FortnoxDocumentNumber = typeof FortnoxDocumentNumber.Type
export const FortnoxSupplierNumber = Identifier.pipe(Schema.brand('FortnoxSupplierNumber'))
export type FortnoxSupplierNumber = typeof FortnoxSupplierNumber.Type
export const FortnoxGivenNumber = Schema.Trimmed.check(Schema.isPattern(/^[0-9]+$/)).pipe(
  Schema.brand('FortnoxGivenNumber')
)
export type FortnoxGivenNumber = typeof FortnoxGivenNumber.Type

const OptionalString = Schema.optional(Schema.String)
const OptionalNumber = Schema.optional(Schema.Number)
const OptionalBoolean = Schema.optional(Schema.Boolean)

// Resource fields deliberately retain Fortnox spelling and monetary wire types.
// This is a bounded read model, not a lossless export of every provider field.
export class FortnoxCompanyInformation extends Schema.Class<FortnoxCompanyInformation>(
  'FortnoxCompanyInformation'
)({
  CompanyName: Schema.String,
  OrganizationNumber: OptionalString,
  DatabaseNumber: Schema.optional(Schema.Int),
  Address: OptionalString,
  City: OptionalString,
  ZipCode: OptionalString,
  CountryCode: OptionalString,
  VisitAddress: OptionalString,
  VisitCity: OptionalString,
  VisitZipCode: OptionalString,
  VisitCountryCode: OptionalString
}) {}

const ContactFields = {
  Name: Schema.String,
  Active: OptionalBoolean,
  OrganisationNumber: OptionalString,
  Email: OptionalString,
  Phone: OptionalString,
  Phone1: OptionalString,
  Phone2: OptionalString,
  Address1: OptionalString,
  Address2: OptionalString,
  City: OptionalString,
  ZipCode: OptionalString,
  Country: OptionalString,
  CountryCode: OptionalString,
  Currency: OptionalString,
  VATNumber: OptionalString,
  VATType: OptionalString,
  TermsOfPayment: OptionalString,
  OurReference: OptionalString,
  YourReference: OptionalString,
  Comments: OptionalString
}

export class FortnoxCustomer extends Schema.Class<FortnoxCustomer>('FortnoxCustomer')({
  CustomerNumber: FortnoxCustomerNumber,
  ...ContactFields,
  EmailInvoice: OptionalString,
  Type: OptionalString
}) {}

export class FortnoxSupplier extends Schema.Class<FortnoxSupplier>('FortnoxSupplier')({
  SupplierNumber: FortnoxSupplierNumber,
  ...ContactFields,
  OurCustomerNumber: OptionalString
}) {}

export class FortnoxInvoiceRow extends Schema.Class<FortnoxInvoiceRow>('FortnoxInvoiceRow')({
  RowId: Schema.optional(Schema.Int),
  AccountNumber: Schema.optional(Schema.Int),
  ArticleNumber: OptionalString,
  Description: OptionalString,
  DeliveredQuantity: OptionalString,
  Unit: OptionalString,
  Price: OptionalNumber,
  PriceExcludingVAT: OptionalNumber,
  Discount: OptionalNumber,
  DiscountType: OptionalString,
  VAT: OptionalNumber,
  VATCode: OptionalString,
  Total: Schema.optional(Schema.NullOr(Schema.Number)),
  TotalExcludingVAT: OptionalNumber,
  CostCenter: Schema.optional(Schema.NullOr(Schema.String)),
  Project: OptionalString
}) {}

const InvoiceFields = {
  Currency: OptionalString,
  InvoiceDate: OptionalString,
  DueDate: OptionalString,
  FinalPayDate: OptionalString,
  Booked: OptionalBoolean,
  Cancelled: OptionalBoolean,
  OCR: OptionalString,
  OurReference: OptionalString,
  YourReference: OptionalString,
  Comments: OptionalString,
  CostCenter: OptionalString,
  Project: OptionalString,
  VoucherNumber: Schema.optional(Schema.Int),
  VoucherSeries: OptionalString
}

export class FortnoxInvoice extends Schema.Class<FortnoxInvoice>('FortnoxInvoice')({
  DocumentNumber: FortnoxDocumentNumber,
  CustomerNumber: FortnoxCustomerNumber,
  CustomerName: OptionalString,
  ...InvoiceFields,
  Total: OptionalNumber,
  Balance: OptionalNumber,
  TotalVAT: OptionalNumber,
  TotalToPay: OptionalNumber,
  Net: OptionalNumber,
  Gross: OptionalNumber,
  CurrencyRate: OptionalNumber,
  Credit: OptionalString,
  Sent: OptionalBoolean,
  NotCompleted: OptionalBoolean,
  InvoiceType: OptionalString,
  VoucherYear: Schema.optional(Schema.Int),
  InvoiceRows: Schema.optional(Schema.Chunk(FortnoxInvoiceRow))
}) {}

export class FortnoxSupplierInvoiceRow extends Schema.Class<FortnoxSupplierInvoiceRow>(
  'FortnoxSupplierInvoiceRow'
)({
  Account: Schema.optional(Schema.Int),
  AccountDescription: OptionalString,
  ArticleNumber: OptionalString,
  ItemDescription: OptionalString,
  Code: OptionalString,
  Debit: OptionalNumber,
  Credit: OptionalNumber,
  DebitCurrency: OptionalNumber,
  CreditCurrency: OptionalNumber,
  Price: OptionalNumber,
  Quantity: OptionalNumber,
  Total: Schema.optional(Schema.NullOr(Schema.Number)),
  Unit: OptionalString,
  CostCenter: Schema.optional(Schema.NullOr(Schema.String)),
  Project: OptionalString,
  TransactionInformation: OptionalString
}) {}

export class FortnoxSupplierInvoice extends Schema.Class<FortnoxSupplierInvoice>(
  'FortnoxSupplierInvoice'
)({
  GivenNumber: FortnoxGivenNumber,
  SupplierNumber: FortnoxSupplierNumber,
  SupplierName: OptionalString,
  InvoiceNumber: OptionalString,
  ...InvoiceFields,
  // Fortnox returns these amounts as strings; do not coerce financial values.
  Total: OptionalString,
  Balance: OptionalString,
  CurrencyRate: OptionalString,
  Credit: OptionalBoolean,
  PaymentPending: OptionalBoolean,
  SupplierInvoiceRows: Schema.optional(Schema.Chunk(FortnoxSupplierInvoiceRow))
}) {}

const PaginationFields = {
  page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  lastModified: Schema.optional(NonEmptyString)
}

// A single search pair reflects Fortnox's one resource-specific search-field limit.
export class FortnoxCustomerSearch extends Schema.Class<FortnoxCustomerSearch>(
  'FortnoxCustomerSearch'
)({
  field: Schema.Literals([
    'customernumber',
    'name',
    'organisationnumber',
    'email',
    'city',
    'phone'
  ]),
  value: NonEmptyString
}) {}
export class FortnoxSupplierSearch extends Schema.Class<FortnoxSupplierSearch>(
  'FortnoxSupplierSearch'
)({
  field: Schema.Literals([
    'suppliernumber',
    'name',
    'organisationnumber',
    'email',
    'city',
    'phone'
  ]),
  value: NonEmptyString
}) {}
export class FortnoxInvoiceSearch extends Schema.Class<FortnoxInvoiceSearch>(
  'FortnoxInvoiceSearch'
)({
  field: Schema.Literals(['customernumber', 'customername', 'documentnumber', 'ocr']),
  value: NonEmptyString
}) {}
export class FortnoxSupplierInvoiceSearch extends Schema.Class<FortnoxSupplierInvoiceSearch>(
  'FortnoxSupplierInvoiceSearch'
)({
  field: Schema.Literals([
    'suppliernumber',
    'suppliername',
    'invoicenumber',
    'serialnumber',
    'ocr'
  ]),
  value: NonEmptyString
}) {}

export class FortnoxListCustomersInput extends Schema.Class<FortnoxListCustomersInput>(
  'FortnoxListCustomersInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxCustomerSearch),
  filter: Schema.optional(Schema.Literals(['active', 'inactive']))
}) {}
export class FortnoxListSuppliersInput extends Schema.Class<FortnoxListSuppliersInput>(
  'FortnoxListSuppliersInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxSupplierSearch)
}) {}
export class FortnoxListInvoicesInput extends Schema.Class<FortnoxListInvoicesInput>(
  'FortnoxListInvoicesInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxInvoiceSearch),
  filter: Schema.optional(
    Schema.Literals(['cancelled', 'fullypaid', 'unpaid', 'unpaidoverdue', 'unbooked'])
  ),
  fromDate: Schema.optional(NonEmptyString),
  toDate: Schema.optional(NonEmptyString)
}) {}
export class FortnoxListSupplierInvoicesInput extends Schema.Class<FortnoxListSupplierInvoicesInput>(
  'FortnoxListSupplierInvoicesInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxSupplierInvoiceSearch),
  filter: Schema.optional(
    Schema.Literals([
      'cancelled',
      'fullypaid',
      'unpaid',
      'unpaidoverdue',
      'unbooked',
      'pendingpayment',
      'authorizepending'
    ])
  ),
  fromDate: Schema.optional(NonEmptyString),
  toDate: Schema.optional(NonEmptyString)
}) {}

export class FortnoxGetCompanyInformationInput extends Schema.Class<FortnoxGetCompanyInformationInput>(
  'FortnoxGetCompanyInformationInput'
)({}) {}
export class FortnoxGetCustomerInput extends Schema.Class<FortnoxGetCustomerInput>(
  'FortnoxGetCustomerInput'
)({
  customerNumber: FortnoxCustomerNumber
}) {}
export class FortnoxGetInvoiceInput extends Schema.Class<FortnoxGetInvoiceInput>(
  'FortnoxGetInvoiceInput'
)({
  documentNumber: FortnoxDocumentNumber
}) {}
export class FortnoxGetSupplierInput extends Schema.Class<FortnoxGetSupplierInput>(
  'FortnoxGetSupplierInput'
)({
  supplierNumber: FortnoxSupplierNumber
}) {}
export class FortnoxGetSupplierInvoiceInput extends Schema.Class<FortnoxGetSupplierInvoiceInput>(
  'FortnoxGetSupplierInvoiceInput'
)({
  givenNumber: FortnoxGivenNumber
}) {}

export class FortnoxPagination extends Schema.Class<FortnoxPagination>('FortnoxPagination')({
  currentPage: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  totalPages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalResources: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextPage: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
}) {}
export class FortnoxListCustomersOutput extends Schema.Class<FortnoxListCustomersOutput>(
  'FortnoxListCustomersOutput'
)({
  customers: Schema.Chunk(FortnoxCustomer),
  pagination: FortnoxPagination
}) {}
export class FortnoxListInvoicesOutput extends Schema.Class<FortnoxListInvoicesOutput>(
  'FortnoxListInvoicesOutput'
)({
  invoices: Schema.Chunk(FortnoxInvoice),
  pagination: FortnoxPagination
}) {}
export class FortnoxListSuppliersOutput extends Schema.Class<FortnoxListSuppliersOutput>(
  'FortnoxListSuppliersOutput'
)({
  suppliers: Schema.Chunk(FortnoxSupplier),
  pagination: FortnoxPagination
}) {}
export class FortnoxListSupplierInvoicesOutput extends Schema.Class<FortnoxListSupplierInvoicesOutput>(
  'FortnoxListSupplierInvoicesOutput'
)({
  supplierInvoices: Schema.Chunk(FortnoxSupplierInvoice),
  pagination: FortnoxPagination
}) {}
