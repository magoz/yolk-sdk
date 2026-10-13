// Fortnox `payment` scope: customer invoice payments (/3/invoicepayments) and supplier invoice
// payments (/3/supplierinvoicepayments).
import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import {
  AccountNumber,
  closedInput,
  NonEmptyString,
  NullableBoolean,
  NullableInt,
  NullableNumber,
  NullableString,
  OptionalNonEmptyString,
  OptionalNumber,
  OptionalString,
  PaginationFields
} from './fields.ts'
import { FortnoxPaymentOAuthCredentialSlot } from './oauth.ts'
import { FortnoxDocumentNumber, FortnoxGivenNumber, FortnoxPagination } from './schemas.ts'
import {
  deleteFortnox,
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'
import { StringOrInt, WireNullableInt, WireNullableNumber } from './wire.ts'

// Fortnox docs: the payment `Number` is an integer ("Payment number").
const PaymentNumber = Schema.Trimmed.check(Schema.isPattern(/^[0-9]+$/u))

export const FortnoxInvoicePaymentNumber = PaymentNumber.pipe(
  Schema.brand('FortnoxInvoicePaymentNumber')
)

export type FortnoxInvoicePaymentNumber = typeof FortnoxInvoicePaymentNumber.Type

export const FortnoxSupplierInvoicePaymentNumber = PaymentNumber.pipe(
  Schema.brand('FortnoxSupplierInvoicePaymentNumber')
)

export type FortnoxSupplierInvoicePaymentNumber = typeof FortnoxSupplierInvoicePaymentNumber.Type

// Wire boundary. Fortnox docs examples send `Number` and `InvoiceNumber` as strings or integers,
// and `VoucherNumber`, `VoucherYear`, and `ModeOfPaymentAccount` as numeric strings.
// Bounded read model of a payment write-off (Fortnox docs: WriteOffs[WriteOff]).
export class FortnoxPaymentWriteOff extends Schema.Class<FortnoxPaymentWriteOff>(
  'FortnoxPaymentWriteOff'
)({
  Amount: NullableNumber,
  AccountNumber: NullableInt,
  CostCenter: NullableString,
  Currency: NullableString,
  Description: NullableString,
  Project: NullableString,
  TransactionInformation: NullableString
}) {}

const FortnoxPaymentWriteOffApi = Schema.Struct({
  ...FortnoxPaymentWriteOff.fields,
  Amount: WireNullableNumber,
  AccountNumber: WireNullableInt
})

// Fields shared by both payment resources. Writable fields are the write inputs below.
const PaymentResponseFields = {
  Amount: NullableNumber,
  AmountCurrency: NullableNumber,
  Booked: NullableBoolean,
  Currency: NullableString,
  CurrencyRate: NullableNumber,
  CurrencyUnit: NullableNumber,
  InvoiceDueDate: NullableString,
  InvoiceOCR: NullableString,
  InvoiceTotal: NullableNumber,
  ModeOfPayment: NullableString,
  PaymentDate: NullableString,
  Source: NullableString,
  VoucherNumber: NullableInt,
  VoucherSeries: NullableString,
  VoucherYear: NullableInt,
  // List rows only (current Fortnox OpenAPI).
  WriteOffExist: NullableBoolean,
  WriteOffs: Schema.optional(Schema.Chunk(FortnoxPaymentWriteOff))
}

// Amounts follow the customer-invoice convention (number | null): both payment resources type
// amounts as JSON numbers in Fortnox docs; only InvoiceTotal may arrive as a numeric string.
const PaymentApiFields = {
  Amount: WireNullableNumber,
  AmountCurrency: WireNullableNumber,
  CurrencyRate: WireNullableNumber,
  CurrencyUnit: WireNullableNumber,
  InvoiceTotal: WireNullableNumber,
  VoucherNumber: WireNullableInt,
  VoucherYear: WireNullableInt,
  WriteOffs: Schema.optional(Schema.Array(FortnoxPaymentWriteOffApi))
}

const writeOffsFromApi = (writeOffs: ReadonlyArray<typeof FortnoxPaymentWriteOffApi.Type>) =>
  Chunk.fromIterable(writeOffs.map(writeOff => FortnoxPaymentWriteOff.make(writeOff)))

export class FortnoxInvoicePayment extends Schema.Class<FortnoxInvoicePayment>(
  'FortnoxInvoicePayment'
)({
  Number: FortnoxInvoicePaymentNumber,
  // The customer invoice DocumentNumber the payment belongs to.
  InvoiceNumber: FortnoxDocumentNumber,
  InvoiceCustomerName: NullableString,
  InvoiceCustomerNumber: NullableString,
  ModeOfPaymentAccount: NullableInt,
  ...PaymentResponseFields
}) {}

const FortnoxInvoicePaymentApi = Schema.Struct({
  ...FortnoxInvoicePayment.fields,
  ...PaymentApiFields,
  Number: StringOrInt.pipe(Schema.decodeTo(FortnoxInvoicePaymentNumber)),
  InvoiceNumber: StringOrInt.pipe(Schema.decodeTo(FortnoxDocumentNumber)),
  ModeOfPaymentAccount: WireNullableInt
})

const invoicePaymentFromApi = (value: typeof FortnoxInvoicePaymentApi.Type) => {
  const { WriteOffs, ...fields } = value

  return FortnoxInvoicePayment.make(
    WriteOffs === undefined ? fields : { ...fields, WriteOffs: writeOffsFromApi(WriteOffs) }
  )
}

export class FortnoxSupplierInvoicePayment extends Schema.Class<FortnoxSupplierInvoicePayment>(
  'FortnoxSupplierInvoicePayment'
)({
  Number: FortnoxSupplierInvoicePaymentNumber,
  // The supplier invoice GivenNumber the payment belongs to, not the supplier's InvoiceNumber.
  InvoiceNumber: FortnoxGivenNumber,
  InvoiceSupplierName: NullableString,
  InvoiceSupplierNumber: NullableString,
  Information: NullableString,
  ...PaymentResponseFields
}) {}

const FortnoxSupplierInvoicePaymentApi = Schema.Struct({
  ...FortnoxSupplierInvoicePayment.fields,
  ...PaymentApiFields,
  Number: StringOrInt.pipe(Schema.decodeTo(FortnoxSupplierInvoicePaymentNumber)),
  InvoiceNumber: StringOrInt.pipe(Schema.decodeTo(FortnoxGivenNumber))
})

const supplierInvoicePaymentFromApi = (value: typeof FortnoxSupplierInvoicePaymentApi.Type) => {
  const { WriteOffs, ...fields } = value

  return FortnoxSupplierInvoicePayment.make(
    WriteOffs === undefined ? fields : { ...fields, WriteOffs: writeOffsFromApi(WriteOffs) }
  )
}

// Fortnox docs: `invoicenumber` is the only documented payment search field; no filters.
export class FortnoxInvoicePaymentSearch extends Schema.Class<FortnoxInvoicePaymentSearch>(
  'FortnoxInvoicePaymentSearch'
)({
  field: Schema.Literal('invoicenumber'),
  value: FortnoxDocumentNumber
}) {}

export class FortnoxSupplierInvoicePaymentSearch extends Schema.Class<FortnoxSupplierInvoicePaymentSearch>(
  'FortnoxSupplierInvoicePaymentSearch'
)({
  field: Schema.Literal('invoicenumber'),
  value: FortnoxGivenNumber
}) {}

export class FortnoxListInvoicePaymentsInput extends Schema.Class<FortnoxListInvoicePaymentsInput>(
  'FortnoxListInvoicePaymentsInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxInvoicePaymentSearch)
}) {}

export class FortnoxListSupplierInvoicePaymentsInput extends Schema.Class<FortnoxListSupplierInvoicePaymentsInput>(
  'FortnoxListSupplierInvoicePaymentsInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxSupplierInvoicePaymentSearch)
}) {}

export class FortnoxListInvoicePaymentsOutput extends Schema.Class<FortnoxListInvoicePaymentsOutput>(
  'FortnoxListInvoicePaymentsOutput'
)({
  invoicePayments: Schema.Chunk(FortnoxInvoicePayment),
  pagination: FortnoxPagination
}) {}

export class FortnoxListSupplierInvoicePaymentsOutput extends Schema.Class<FortnoxListSupplierInvoicePaymentsOutput>(
  'FortnoxListSupplierInvoicePaymentsOutput'
)({
  supplierInvoicePayments: Schema.Chunk(FortnoxSupplierInvoicePayment),
  pagination: FortnoxPagination
}) {}

export class FortnoxInvoicePaymentNumberInput extends Schema.Class<FortnoxInvoicePaymentNumberInput>(
  'FortnoxInvoicePaymentNumberInput'
)({
  paymentNumber: FortnoxInvoicePaymentNumber
}) {}

export class FortnoxSupplierInvoicePaymentNumberInput extends Schema.Class<FortnoxSupplierInvoicePaymentNumberInput>(
  'FortnoxSupplierInvoicePaymentNumberInput'
)({
  paymentNumber: FortnoxSupplierInvoicePaymentNumber
}) {}

export class FortnoxDeleteInvoicePaymentOutput extends Schema.Class<FortnoxDeleteInvoicePaymentOutput>(
  'FortnoxDeleteInvoicePaymentOutput'
)({
  paymentNumber: FortnoxInvoicePaymentNumber,
  deleted: Schema.Literal(true)
}) {}

export class FortnoxDeleteSupplierInvoicePaymentOutput extends Schema.Class<FortnoxDeleteSupplierInvoicePaymentOutput>(
  'FortnoxDeleteSupplierInvoicePaymentOutput'
)({
  paymentNumber: FortnoxSupplierInvoicePaymentNumber,
  deleted: Schema.Literal(true)
}) {}

// Fortnox docs: dates are YYYY-MM-DD; account numbers are 4-digit integers (1000-9999).
const PaymentDate = Schema.optional(NonEmptyString.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)))

const OptionalAccountNumber = Schema.optional(AccountNumber)

// Writable write-off fields per Fortnox docs; Currency and Description are read-only.
const WriteOffInputFields = {
  Amount: OptionalNumber,
  AccountNumber: OptionalAccountNumber,
  CostCenter: OptionalNonEmptyString,
  Project: OptionalNonEmptyString
}

export class FortnoxInvoicePaymentWriteOffInput extends Schema.Class<FortnoxInvoicePaymentWriteOffInput>(
  'FortnoxInvoicePaymentWriteOffInput'
)({
  ...WriteOffInputFields,
  TransactionInformation: OptionalString
}) {}

export class FortnoxSupplierInvoicePaymentWriteOffInput extends Schema.Class<FortnoxSupplierInvoicePaymentWriteOffInput>(
  'FortnoxSupplierInvoicePaymentWriteOffInput'
)(WriteOffInputFields) {}

// Writable fields per Fortnox docs. Booked, Currency, CurrencyUnit, Source, voucher fields, and
// the invoice/customer/supplier snapshot fields are read-only and are not inputs.
const PaymentMutationFields = {
  AmountCurrency: OptionalNumber,
  CurrencyRate: OptionalNumber,
  ModeOfPayment: OptionalNonEmptyString,
  PaymentDate
}

const InvoicePaymentMutationFields = {
  ...PaymentMutationFields,
  ModeOfPaymentAccount: OptionalAccountNumber
}

const SupplierInvoicePaymentMutationFields = {
  ...PaymentMutationFields,
  Information: OptionalString,
  InvoiceOCR: OptionalString
}

export class FortnoxCreateInvoicePaymentInput extends Schema.Class<FortnoxCreateInvoicePaymentInput>(
  'FortnoxCreateInvoicePaymentInput'
)({
  InvoiceNumber: FortnoxDocumentNumber,
  Amount: Schema.Finite,
  ...InvoicePaymentMutationFields,
  WriteOffs: Schema.optional(Schema.Array(FortnoxInvoicePaymentWriteOffInput))
}) {}

export class FortnoxUpdateInvoicePaymentInput extends Schema.Class<FortnoxUpdateInvoicePaymentInput>(
  'FortnoxUpdateInvoicePaymentInput'
)({
  Number: FortnoxInvoicePaymentNumber,
  Amount: OptionalNumber,
  ...InvoicePaymentMutationFields
}) {}

export class FortnoxCreateSupplierInvoicePaymentInput extends Schema.Class<FortnoxCreateSupplierInvoicePaymentInput>(
  'FortnoxCreateSupplierInvoicePaymentInput'
)({
  InvoiceNumber: FortnoxGivenNumber,
  Amount: Schema.Finite,
  ...SupplierInvoicePaymentMutationFields,
  WriteOffs: Schema.optional(Schema.Array(FortnoxSupplierInvoicePaymentWriteOffInput))
}) {}

export class FortnoxUpdateSupplierInvoicePaymentInput extends Schema.Class<FortnoxUpdateSupplierInvoicePaymentInput>(
  'FortnoxUpdateSupplierInvoicePaymentInput'
)({
  Number: FortnoxSupplierInvoicePaymentNumber,
  Amount: OptionalNumber,
  ...SupplierInvoicePaymentMutationFields
}) {}

const InvoicePaymentsResponse = Schema.Struct({
  InvoicePayments: Schema.Array(FortnoxInvoicePaymentApi),
  MetaInformation: FortnoxMetaInformation
})

const InvoicePaymentResponse = Schema.Struct({ InvoicePayment: FortnoxInvoicePaymentApi })

const SupplierInvoicePaymentsResponse = Schema.Struct({
  SupplierInvoicePayments: Schema.Array(FortnoxSupplierInvoicePaymentApi),
  MetaInformation: FortnoxMetaInformation
})

const SupplierInvoicePaymentResponse = Schema.Struct({
  SupplierInvoicePayment: FortnoxSupplierInvoicePaymentApi
})

const invoicePaymentPath = (paymentNumber: string) =>
  `invoicepayments/${encodeURIComponent(paymentNumber)}`

const supplierInvoicePaymentPath = (paymentNumber: string) =>
  `supplierinvoicepayments/${encodeURIComponent(paymentNumber)}`

const unbookedNote =
  'This does not bookkeep the payment: no voucher is created until the bookkeep action runs; check Booked in the response.'

const invoicePaymentFieldsNote =
  'Amount is in SEK; AmountCurrency is the amount in the invoice currency and is required when the invoice currency is not SEK. Booked, Currency, voucher, and invoice/customer fields are read-only. Unknown fields are rejected.'

const supplierInvoicePaymentFieldsNote =
  'Booked, Currency, voucher, and invoice/supplier fields are read-only. Unknown fields are rejected.'

export const fortnoxListInvoicePaymentsAction = defineAction({
  id: 'fortnox.list_invoice_payments',
  description:
    'List one page of Fortnox customer invoice payments, sorted by payment date. Search invoicenumber takes the customer invoice DocumentNumber. Repeat search/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListInvoicePaymentsInput,
  outputSchema: FortnoxListInvoicePaymentsOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      listPath('invoicepayments', input),
      InvoicePaymentsResponse,
      value =>
        FortnoxListInvoicePaymentsOutput.make({
          invoicePayments: Chunk.fromIterable(value.InvoicePayments.map(invoicePaymentFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetInvoicePaymentAction = defineAction({
  id: 'fortnox.get_invoice_payment',
  description:
    'Read a Fortnox customer invoice payment by its payment Number (not the invoice DocumentNumber).',
  access: 'read',
  inputSchema: FortnoxInvoicePaymentNumberInput,
  outputSchema: FortnoxInvoicePayment,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      invoicePaymentPath(input.paymentNumber),
      InvoicePaymentResponse,
      value => invoicePaymentFromApi(value.InvoicePayment)
    )
})

export const fortnoxCreateInvoicePaymentAction = defineAction({
  id: 'fortnox.create_invoice_payment',
  description: `Register a payment on a Fortnox customer invoice. InvoiceNumber is the invoice DocumentNumber; Amount is required. Fortnox assigns the payment Number. ${unbookedNote} ${invoicePaymentFieldsNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxCreateInvoicePaymentInput.fields),
  outputSchema: FortnoxInvoicePayment,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      'POST',
      'invoicepayments',
      { InvoicePayment: input },
      InvoicePaymentResponse,
      value => invoicePaymentFromApi(value.InvoicePayment)
    )
})

export const fortnoxUpdateInvoicePaymentAction = defineAction({
  id: 'fortnox.update_invoice_payment',
  description: `Update an unbooked Fortnox customer invoice payment by its payment Number. The invoice it belongs to cannot be changed here. ${unbookedNote} ${invoicePaymentFieldsNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateInvoicePaymentInput.fields),
  outputSchema: FortnoxInvoicePayment,
  execute: ({ integration, input }) => {
    const { Number: paymentNumber, ...payment } = input

    return writeFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      'PUT',
      invoicePaymentPath(paymentNumber),
      { InvoicePayment: payment },
      InvoicePaymentResponse,
      value => invoicePaymentFromApi(value.InvoicePayment)
    )
  }
})

export const fortnoxDeleteInvoicePaymentAction = defineAction({
  id: 'fortnox.delete_invoice_payment',
  description:
    'Permanently delete a Fortnox customer invoice payment by its payment Number. This cannot be undone.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxInvoicePaymentNumberInput.fields),
  outputSchema: FortnoxDeleteInvoicePaymentOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      invoicePaymentPath(input.paymentNumber),
      FortnoxDeleteInvoicePaymentOutput.make({
        paymentNumber: input.paymentNumber,
        deleted: true
      })
    )
})

export const fortnoxBookkeepInvoicePaymentAction = defineAction({
  id: 'fortnox.bookkeep_invoice_payment',
  description:
    'Bookkeep a Fortnox customer invoice payment by its payment Number: Fortnox posts it to the ledger as a voucher and marks it Booked. This cannot be undone: the Fortnox API has no action to unbook a payment. Returns the booked payment.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxInvoicePaymentNumberInput.fields),
  outputSchema: FortnoxInvoicePayment,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      'PUT',
      `${invoicePaymentPath(input.paymentNumber)}/bookkeep`,
      undefined,
      InvoicePaymentResponse,
      value => invoicePaymentFromApi(value.InvoicePayment)
    )
})

export const fortnoxListSupplierInvoicePaymentsAction = defineAction({
  id: 'fortnox.list_supplier_invoice_payments',
  description:
    "List one page of Fortnox supplier invoice payments. Search invoicenumber takes the supplier invoice GivenNumber, not the supplier's InvoiceNumber. Repeat search/limit with pagination.nextPage to continue.",
  access: 'read',
  inputSchema: FortnoxListSupplierInvoicePaymentsInput,
  outputSchema: FortnoxListSupplierInvoicePaymentsOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      listPath('supplierinvoicepayments', input),
      SupplierInvoicePaymentsResponse,
      value =>
        FortnoxListSupplierInvoicePaymentsOutput.make({
          supplierInvoicePayments: Chunk.fromIterable(
            value.SupplierInvoicePayments.map(supplierInvoicePaymentFromApi)
          ),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetSupplierInvoicePaymentAction = defineAction({
  id: 'fortnox.get_supplier_invoice_payment',
  description:
    'Read a Fortnox supplier invoice payment by its payment Number (not the supplier invoice GivenNumber). Its InvoiceNumber is the supplier invoice GivenNumber.',
  access: 'read',
  inputSchema: FortnoxSupplierInvoicePaymentNumberInput,
  outputSchema: FortnoxSupplierInvoicePayment,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      supplierInvoicePaymentPath(input.paymentNumber),
      SupplierInvoicePaymentResponse,
      value => supplierInvoicePaymentFromApi(value.SupplierInvoicePayment)
    )
})

export const fortnoxCreateSupplierInvoicePaymentAction = defineAction({
  id: 'fortnox.create_supplier_invoice_payment',
  description: `Register a payment on a Fortnox supplier invoice. InvoiceNumber is the supplier invoice GivenNumber (Fortnox's internal number), not the supplier's own InvoiceNumber; Amount is required. Fortnox assigns the payment Number. ${unbookedNote} ${supplierInvoicePaymentFieldsNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxCreateSupplierInvoicePaymentInput.fields),
  outputSchema: FortnoxSupplierInvoicePayment,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      'POST',
      'supplierinvoicepayments',
      { SupplierInvoicePayment: input },
      SupplierInvoicePaymentResponse,
      value => supplierInvoicePaymentFromApi(value.SupplierInvoicePayment)
    )
})

export const fortnoxUpdateSupplierInvoicePaymentAction = defineAction({
  id: 'fortnox.update_supplier_invoice_payment',
  description: `Update an unbooked Fortnox supplier invoice payment by its payment Number. The supplier invoice it belongs to cannot be changed here. ${unbookedNote} ${supplierInvoicePaymentFieldsNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateSupplierInvoicePaymentInput.fields),
  outputSchema: FortnoxSupplierInvoicePayment,
  execute: ({ integration, input }) => {
    const { Number: paymentNumber, ...payment } = input

    return writeFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      'PUT',
      supplierInvoicePaymentPath(paymentNumber),
      { SupplierInvoicePayment: payment },
      SupplierInvoicePaymentResponse,
      value => supplierInvoicePaymentFromApi(value.SupplierInvoicePayment)
    )
  }
})

export const fortnoxDeleteSupplierInvoicePaymentAction = defineAction({
  id: 'fortnox.delete_supplier_invoice_payment',
  description:
    'Permanently delete a Fortnox supplier invoice payment by its payment Number. This cannot be undone.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxSupplierInvoicePaymentNumberInput.fields),
  outputSchema: FortnoxDeleteSupplierInvoicePaymentOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      supplierInvoicePaymentPath(input.paymentNumber),
      FortnoxDeleteSupplierInvoicePaymentOutput.make({
        paymentNumber: input.paymentNumber,
        deleted: true
      })
    )
})

export const fortnoxBookkeepSupplierInvoicePaymentAction = defineAction({
  id: 'fortnox.bookkeep_supplier_invoice_payment',
  description:
    'Bookkeep a Fortnox supplier invoice payment by its payment Number: Fortnox posts it to the ledger as a voucher and marks it Booked. This cannot be undone: the Fortnox API has no action to unbook a payment. Returns the booked payment.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxSupplierInvoicePaymentNumberInput.fields),
  outputSchema: FortnoxSupplierInvoicePayment,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxPaymentOAuthCredentialSlot,
      'PUT',
      `${supplierInvoicePaymentPath(input.paymentNumber)}/bookkeep`,
      undefined,
      SupplierInvoicePaymentResponse,
      value => supplierInvoicePaymentFromApi(value.SupplierInvoicePayment)
    )
})

export const fortnoxPaymentActions = [
  fortnoxListInvoicePaymentsAction,
  fortnoxGetInvoicePaymentAction,
  fortnoxCreateInvoicePaymentAction,
  fortnoxUpdateInvoicePaymentAction,
  fortnoxDeleteInvoicePaymentAction,
  fortnoxBookkeepInvoicePaymentAction,
  fortnoxListSupplierInvoicePaymentsAction,
  fortnoxGetSupplierInvoicePaymentAction,
  fortnoxCreateSupplierInvoicePaymentAction,
  fortnoxUpdateSupplierInvoicePaymentAction,
  fortnoxDeleteSupplierInvoicePaymentAction,
  fortnoxBookkeepSupplierInvoicePaymentAction
] as const
