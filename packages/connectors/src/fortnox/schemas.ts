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

const OptionalBoolean = Schema.optional(Schema.Boolean)

// Fortnox uses JSON null for unset response fields. Preserve null; do not require omission.
const NullableString = Schema.optional(Schema.NullOr(Schema.String))

const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number))

const NullableBoolean = Schema.optional(Schema.NullOr(Schema.Boolean))

const NullableInt = Schema.optional(Schema.NullOr(Schema.Int))

// Resource fields deliberately retain Fortnox spelling and monetary wire types.
// This is a bounded read model, not a lossless export of every provider field.
export class FortnoxCompanyInformation extends Schema.Class<FortnoxCompanyInformation>(
  'FortnoxCompanyInformation'
)({
  CompanyName: Schema.String,
  OrganizationNumber: NullableString,
  DatabaseNumber: NullableInt,
  Address: NullableString,
  City: NullableString,
  ZipCode: NullableString,
  CountryCode: NullableString,
  VisitAddress: NullableString,
  VisitCity: NullableString,
  VisitZipCode: NullableString,
  VisitCountryCode: NullableString
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

const ContactResponseFields = {
  Name: Schema.String,
  Active: NullableBoolean,
  OrganisationNumber: NullableString,
  Email: NullableString,
  Phone: NullableString,
  Phone1: NullableString,
  Phone2: NullableString,
  Address1: NullableString,
  Address2: NullableString,
  City: NullableString,
  ZipCode: NullableString,
  Country: NullableString,
  CountryCode: NullableString,
  Currency: NullableString,
  VATNumber: NullableString,
  VATType: NullableString,
  TermsOfPayment: NullableString,
  OurReference: NullableString,
  YourReference: NullableString,
  Comments: NullableString
}

export class FortnoxCustomer extends Schema.Class<FortnoxCustomer>('FortnoxCustomer')({
  CustomerNumber: FortnoxCustomerNumber,
  ...ContactResponseFields,
  EmailInvoice: NullableString,
  Type: NullableString
}) {}

export class FortnoxSupplier extends Schema.Class<FortnoxSupplier>('FortnoxSupplier')({
  SupplierNumber: FortnoxSupplierNumber,
  ...ContactResponseFields,
  OurCustomerNumber: NullableString
}) {}

export class FortnoxInvoiceRow extends Schema.Class<FortnoxInvoiceRow>('FortnoxInvoiceRow')({
  RowId: NullableInt,
  AccountNumber: NullableInt,
  ArticleNumber: NullableString,
  Description: NullableString,
  DeliveredQuantity: NullableString,
  Unit: NullableString,
  Price: NullableNumber,
  PriceExcludingVAT: NullableNumber,
  Discount: NullableNumber,
  DiscountType: NullableString,
  VAT: NullableNumber,
  VATCode: NullableString,
  Total: NullableNumber,
  TotalExcludingVAT: NullableNumber,
  CostCenter: NullableString,
  Project: NullableString
}) {}

const InvoiceFields = {
  Currency: NullableString,
  InvoiceDate: NullableString,
  DueDate: NullableString,
  FinalPayDate: NullableString,
  Booked: NullableBoolean,
  Cancelled: NullableBoolean,
  OCR: NullableString,
  OurReference: NullableString,
  YourReference: NullableString,
  Comments: NullableString,
  CostCenter: NullableString,
  Project: NullableString,
  VoucherNumber: NullableInt,
  VoucherSeries: NullableString
}

export class FortnoxInvoice extends Schema.Class<FortnoxInvoice>('FortnoxInvoice')({
  DocumentNumber: FortnoxDocumentNumber,
  CustomerNumber: FortnoxCustomerNumber,
  CustomerName: NullableString,
  ...InvoiceFields,
  Total: NullableNumber,
  Balance: NullableNumber,
  TotalVAT: NullableNumber,
  TotalToPay: NullableNumber,
  Net: NullableNumber,
  Gross: NullableNumber,
  CurrencyRate: NullableNumber,
  Credit: NullableString,
  Sent: NullableBoolean,
  NotCompleted: NullableBoolean,
  InvoiceType: NullableString,
  VoucherYear: NullableInt,
  InvoiceRows: Schema.optional(Schema.Chunk(FortnoxInvoiceRow))
}) {}

export class FortnoxSupplierInvoiceRow extends Schema.Class<FortnoxSupplierInvoiceRow>(
  'FortnoxSupplierInvoiceRow'
)({
  Account: NullableInt,
  AccountDescription: NullableString,
  ArticleNumber: NullableString,
  ItemDescription: NullableString,
  Code: NullableString,
  Debit: NullableNumber,
  Credit: NullableNumber,
  DebitCurrency: NullableNumber,
  CreditCurrency: NullableNumber,
  Price: NullableNumber,
  Quantity: NullableNumber,
  Total: NullableNumber,
  Unit: NullableString,
  CostCenter: NullableString,
  Project: NullableString,
  TransactionInformation: NullableString
}) {}

export class FortnoxSupplierInvoice extends Schema.Class<FortnoxSupplierInvoice>(
  'FortnoxSupplierInvoice'
)({
  GivenNumber: FortnoxGivenNumber,
  SupplierNumber: FortnoxSupplierNumber,
  SupplierName: NullableString,
  InvoiceNumber: NullableString,
  ...InvoiceFields,
  // Fortnox returns these amounts as strings; do not coerce financial values.
  Total: NullableString,
  Balance: NullableString,
  CurrencyRate: NullableString,
  Credit: NullableBoolean,
  PaymentPending: NullableBoolean,
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

const CustomerWriteFields = {
  ...ContactFields,
  Name: NonEmptyString,
  EmailInvoice: OptionalString,
  Type: OptionalString
}

const CustomerUpdateFields = {
  Name: Schema.optional(NonEmptyString),
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
  Comments: OptionalString,
  EmailInvoice: OptionalString,
  Type: OptionalString
}

export class FortnoxCreateCustomerInput extends Schema.Class<FortnoxCreateCustomerInput>(
  'FortnoxCreateCustomerInput'
)(CustomerWriteFields) {}

export class FortnoxUpdateCustomerInput extends Schema.Class<FortnoxUpdateCustomerInput>(
  'FortnoxUpdateCustomerInput'
)({
  CustomerNumber: FortnoxCustomerNumber,
  ...CustomerUpdateFields
}) {}

// Booked, Cancelled, FinalPayDate, and voucher fields are provider-managed through
// dedicated invoice lifecycle/payment APIs and must not be exposed as create/update inputs.
const InvoiceMutationFields = {
  Currency: OptionalString,
  InvoiceDate: OptionalString,
  DueDate: OptionalString,
  OCR: OptionalString,
  OurReference: OptionalString,
  YourReference: OptionalString,
  Comments: OptionalString,
  CostCenter: OptionalString,
  Project: OptionalString,
  InvoiceRows: Schema.optional(Schema.Array(FortnoxInvoiceRow))
} as const

const InvoiceWriteFields = {
  CustomerNumber: FortnoxCustomerNumber,
  ...InvoiceMutationFields
} as const

const InvoiceUpdateFields = {
  CustomerNumber: Schema.optional(FortnoxCustomerNumber),
  ...InvoiceMutationFields
} as const

export class FortnoxCreateInvoiceInput extends Schema.Class<FortnoxCreateInvoiceInput>(
  'FortnoxCreateInvoiceInput'
)(InvoiceWriteFields) {}

export class FortnoxUpdateInvoiceInput extends Schema.Class<FortnoxUpdateInvoiceInput>(
  'FortnoxUpdateInvoiceInput'
)({
  DocumentNumber: FortnoxDocumentNumber,
  ...InvoiceUpdateFields
}) {}

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
