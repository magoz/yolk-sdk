import { Chunk, Effect, SchemaTransformation } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { decodeInput, fileBytes } from '../transfer-internal.ts'
import {
  closedInput,
  NonEmptyString,
  NullableBoolean,
  NullableInt,
  NullableNumber,
  NullableString,
  OptionalBoolean,
  OptionalInt,
  OptionalNonEmptyString,
  OptionalNumber,
  OptionalString,
  PaginationFields,
  optionalMaxLength
} from './fields.ts'
import { FortnoxOfferOAuthCredentialSlot } from './oauth.ts'
import { FortnoxCustomerNumber, FortnoxDocumentNumber, FortnoxPagination } from './schemas.ts'
import {
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'
import { downloadFortnoxBytes } from './transfer.ts'
import { WireNullableAmountString, WireNullableNumber } from './wire.ts'

// Offers (Swedish "Offert") use their own DocumentNumber series. They reuse
// FortnoxDocumentNumber rather than a separate brand so the order/invoice numbers returned by the
// conversion actions feed the invoice actions directly; the action and field names say which
// series a number belongs to.

// Fortnox docs: every offer action needs the `offer` scope, which requires the Order license.
// There is deliberately no `print` action: GET /offers/{n}/print returns PDF bytes AND marks the
// offer Sent. The host-only `downloadFortnoxOfferPreview` (/preview, no side effect) plus
// `fortnox.mark_offer_sent` (/externalprint) cover it without hidden side effects.

export class FortnoxOfferRow extends Schema.Class<FortnoxOfferRow>('FortnoxOfferRow')({
  RowId: NullableInt,
  ArticleNumber: NullableString,
  AccountNumber: NullableInt,
  Description: NullableString,
  Quantity: NullableNumber,
  Unit: NullableString,
  Price: NullableNumber,
  Discount: NullableNumber,
  DiscountType: NullableString,
  VAT: NullableNumber,
  Total: NullableNumber,
  CostCenter: NullableString,
  Project: NullableString
}) {}

// Bounded view of EmailInformation: the recipients `fortnox.email_offer` sends to. EmailBody
// (up to 20000 characters) is left out.
export class FortnoxOfferEmailInformation extends Schema.Class<FortnoxOfferEmailInformation>(
  'FortnoxOfferEmailInformation'
)({
  EmailAddressFrom: NullableString,
  EmailAddressTo: NullableString,
  EmailAddressCC: NullableString,
  EmailAddressBCC: NullableString,
  EmailSubject: NullableString
}) {}

// Bounded read model. Cancelled, Sent, totals, OrderReference, and InvoiceReference are
// read-only and change only through the offer actions. A reference of "0" means none.
export class FortnoxOffer extends Schema.Class<FortnoxOffer>('FortnoxOffer')({
  DocumentNumber: FortnoxDocumentNumber,
  CustomerNumber: FortnoxCustomerNumber,
  CustomerName: NullableString,
  OfferDate: NullableString,
  ExpireDate: NullableString,
  DeliveryDate: NullableString,
  Currency: NullableString,
  CurrencyRate: NullableNumber,
  Total: NullableNumber,
  TotalVAT: NullableNumber,
  TotalToPay: NullableNumber,
  Net: NullableNumber,
  Gross: NullableNumber,
  VATIncluded: NullableBoolean,
  Cancelled: NullableBoolean,
  Sent: NullableBoolean,
  NotCompleted: NullableBoolean,
  OrderReference: NullableString,
  InvoiceReference: NullableString,
  OurReference: NullableString,
  YourReference: NullableString,
  Comments: NullableString,
  Remarks: NullableString,
  CostCenter: NullableString,
  Project: NullableString,
  EmailInformation: Schema.optional(Schema.NullOr(FortnoxOfferEmailInformation)),
  OfferRows: Schema.optional(Schema.Chunk(FortnoxOfferRow))
}) {}

// Fortnox docs examples send row Quantity as a string ("10.00"), list-row Project as 0 and
// single-offer Project as "", and OrderReference/InvoiceReference as 0 while OpenAPI types them
// as strings. Accept both at the wire only.
const FortnoxOfferRowApi = Schema.Struct({
  ...FortnoxOfferRow.fields,
  Quantity: WireNullableNumber,
  Price: WireNullableNumber,
  Discount: WireNullableNumber,
  VAT: WireNullableNumber,
  Total: WireNullableNumber,
  Project: WireNullableAmountString
})

const FortnoxOfferApi = Schema.Struct({
  ...FortnoxOffer.fields,
  CurrencyRate: WireNullableNumber,
  Total: WireNullableNumber,
  TotalVAT: WireNullableNumber,
  TotalToPay: WireNullableNumber,
  Net: WireNullableNumber,
  Gross: WireNullableNumber,
  OrderReference: WireNullableAmountString,
  InvoiceReference: WireNullableAmountString,
  Project: WireNullableAmountString,
  OfferRows: Schema.optional(Schema.Array(FortnoxOfferRowApi))
})

const offerFromApi = (value: typeof FortnoxOfferApi.Type) => {
  const { OfferRows, ...fields } = value

  return FortnoxOffer.make(
    (() => {
      type OfferFromApiFields = typeof fields & { OfferRows?: FortnoxOffer['OfferRows'] }

      const out: OfferFromApiFields = { ...fields }

      if (OfferRows !== undefined) {
        out.OfferRows = Chunk.fromIterable(OfferRows.map(row => FortnoxOfferRow.make(row)))
      }

      return out
    })()
  )
}

// Searchable offer fields per Fortnox docs (field table) and the OpenAPI query parameters.
export class FortnoxOfferSearch extends Schema.Class<FortnoxOfferSearch>('FortnoxOfferSearch')({
  field: Schema.Literals([
    'customername',
    'customernumber',
    'documentnumber',
    'offerdate',
    'ourreference',
    'yourreference',
    'costcenter',
    'project'
  ]),
  value: NonEmptyString
}) {}

export class FortnoxListOffersInput extends Schema.Class<FortnoxListOffersInput>(
  'FortnoxListOffersInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxOfferSearch),
  filter: Schema.optional(
    Schema.Literals([
      'cancelled',
      'expired',
      'completed',
      'notcompleted',
      'ordercreated',
      'ordernotcreated'
    ])
  ),
  fromDate: Schema.optional(NonEmptyString),
  toDate: Schema.optional(NonEmptyString)
}) {}

export class FortnoxListOffersOutput extends Schema.Class<FortnoxListOffersOutput>(
  'FortnoxListOffersOutput'
)({
  offers: Schema.Chunk(FortnoxOffer),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetOfferInput extends Schema.Class<FortnoxGetOfferInput>(
  'FortnoxGetOfferInput'
)({
  documentNumber: FortnoxDocumentNumber
}) {}

/** Input of the offer lifecycle actions (convert, cancel, email, mark sent). */
export class FortnoxOfferActionInput extends Schema.Class<FortnoxOfferActionInput>(
  'FortnoxOfferActionInput'
)({
  documentNumber: FortnoxDocumentNumber
}) {}

// Writable OfferRow fields per Fortnox docs. RowId only selects which existing row a sent row
// updates (see the update note); read-only Total and Contribution* are not inputs.
export class FortnoxOfferRowInput extends Schema.Class<FortnoxOfferRowInput>(
  'FortnoxOfferRowInput'
)({
  RowId: OptionalInt,
  ArticleNumber: OptionalString,
  AccountNumber: OptionalInt,
  Description: optionalMaxLength(255),
  Quantity: OptionalNumber,
  Unit: optionalMaxLength(20),
  Price: OptionalNumber,
  VAT: OptionalNumber,
  Discount: OptionalNumber,
  DiscountType: Schema.optional(Schema.Literals(['AMOUNT', 'PERCENT'])),
  CostCenter: OptionalString,
  Project: OptionalString
}) {}

// Writable Offer fields per Fortnox docs. Cancelled, Sent, totals, OrderReference, and
// InvoiceReference are read-only and are not inputs.
const OfferMutationFields = {
  OfferDate: OptionalNonEmptyString,
  ExpireDate: OptionalNonEmptyString,
  DeliveryDate: OptionalNonEmptyString,
  Currency: OptionalString,
  VATIncluded: OptionalBoolean,
  OurReference: OptionalString,
  YourReference: optionalMaxLength(50),
  Comments: optionalMaxLength(1024),
  Remarks: OptionalString,
  CostCenter: OptionalString,
  Project: OptionalString,
  OfferRows: Schema.optional(Schema.Array(FortnoxOfferRowInput))
}

export class FortnoxCreateOfferInput extends Schema.Class<FortnoxCreateOfferInput>(
  'FortnoxCreateOfferInput'
)({
  CustomerNumber: FortnoxCustomerNumber,
  ...OfferMutationFields
}) {}

export class FortnoxUpdateOfferInput extends Schema.Class<FortnoxUpdateOfferInput>(
  'FortnoxUpdateOfferInput'
)({
  DocumentNumber: FortnoxDocumentNumber,
  CustomerNumber: Schema.optional(FortnoxCustomerNumber),
  ...OfferMutationFields
}) {}

export class FortnoxCreateOrderFromOfferOutput extends Schema.Class<FortnoxCreateOrderFromOfferOutput>(
  'FortnoxCreateOrderFromOfferOutput'
)({
  offerNumber: FortnoxDocumentNumber,
  orderNumber: Schema.NullOr(FortnoxDocumentNumber)
}) {}

export class FortnoxCreateInvoiceFromOfferOutput extends Schema.Class<FortnoxCreateInvoiceFromOfferOutput>(
  'FortnoxCreateInvoiceFromOfferOutput'
)({
  offerNumber: FortnoxDocumentNumber,
  invoiceNumber: Schema.NullOr(FortnoxDocumentNumber)
}) {}

const OffersResponse = Schema.Struct({
  Offers: Schema.Array(FortnoxOfferApi),
  MetaInformation: FortnoxMetaInformation
})

const OfferResponse = Schema.Struct({ Offer: FortnoxOfferApi })

// OpenAPI types the references as strings; docs examples send the number 0 for "none".
const NumericReference = Schema.Int.pipe(
  Schema.decodeTo(
    FortnoxDocumentNumber,
    SchemaTransformation.transform({ decode: String, encode: Number })
  )
)

const WireReference = Schema.optional(
  Schema.NullOr(Schema.Union([FortnoxDocumentNumber, NumericReference, Schema.Literal('')]))
)

const referenceFromApi = (value: FortnoxDocumentNumber | '' | null | undefined) =>
  value === undefined || value === null || value === '' || value === '0' ? null : value

// Fortnox OpenAPI (and the official Fortnox .NET SDK) answer createorder/createinvoice with the
// source offer (`{ Offer }`), whose OrderReference/InvoiceReference names the new document. Not
// observed live, so the new document's own envelope (`{ Order }` / `{ Invoice }`) is accepted too:
// an irreversible conversion must not report failure only because of the answer's shape.
const NewDocument = Schema.Struct({
  DocumentNumber: Schema.Union([FortnoxDocumentNumber, NumericReference])
})

const OfferOrderReferenceResponse = Schema.Union([
  Schema.Struct({
    Offer: Schema.Struct({ DocumentNumber: FortnoxDocumentNumber, OrderReference: WireReference })
  }),
  Schema.Struct({ Order: NewDocument })
])

const OfferInvoiceReferenceResponse = Schema.Union([
  Schema.Struct({
    Offer: Schema.Struct({ DocumentNumber: FortnoxDocumentNumber, InvoiceReference: WireReference })
  }),
  Schema.Struct({ Invoice: NewDocument })
])

const offerPath = (documentNumber: string, action?: string) =>
  action === undefined
    ? `offers/${encodeURIComponent(documentNumber)}`
    : `offers/${encodeURIComponent(documentNumber)}/${action}`

const fortnoxOfferReferencesNote =
  'Referenced CostCenter, Project, ArticleNumber, AccountNumber, Unit, and non-SEK Currency must already exist in the Fortnox company. Unknown fields are rejected.'

const fortnoxOfferRowsUpdateNote =
  'Sending OfferRows replaces the row list: existing rows not sent are deleted. If no sent row has RowId, rows are matched to existing rows in order; send every row that should remain. If any sent row has RowId, the row with that RowId is updated, rows without RowId are added, and a row to keep unchanged needs only { RowId }. RowIds are regenerated on every update; read the offer again before reusing RowIds.'

const fortnoxOfferConvertRecoveryNote =
  'If the result is unclear or the request fails without a Fortnox error, do not retry: read the offer with fortnox.get_offer and check'

export const fortnoxListOffersAction = defineAction({
  id: 'fortnox.list_offers',
  description:
    'List one page of Fortnox offers (quotes, Swedish "offert"). Repeat search/filter/date range/limit with pagination.nextPage to continue. List rows omit OfferRows; use fortnox.get_offer for rows.',
  access: 'read',
  inputSchema: FortnoxListOffersInput,
  outputSchema: FortnoxListOffersOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      listPath('offers', input),
      OffersResponse,
      value =>
        FortnoxListOffersOutput.make({
          offers: Chunk.fromIterable(value.Offers.map(offerFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetOfferAction = defineAction({
  id: 'fortnox.get_offer',
  description:
    'Read a Fortnox offer and its rows by DocumentNumber (the offer number). Does not send, print, or convert it. OrderReference/InvoiceReference "0" means no order/invoice was created.',
  access: 'read',
  inputSchema: FortnoxGetOfferInput,
  outputSchema: FortnoxOffer,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      offerPath(input.documentNumber),
      OfferResponse,
      value => offerFromApi(value.Offer)
    )
})

export const fortnoxCreateOfferAction = defineAction({
  id: 'fortnox.create_offer',
  description: `Create a Fortnox offer for an existing CustomerNumber. Fortnox assigns DocumentNumber. Does not send it. ${fortnoxOfferReferencesNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxCreateOfferInput.fields),
  outputSchema: FortnoxOffer,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      'POST',
      'offers',
      { Offer: input },
      OfferResponse,
      value => offerFromApi(value.Offer)
    )
})

export const fortnoxUpdateOfferAction = defineAction({
  id: 'fortnox.update_offer',
  description: `Update a Fortnox offer by DocumentNumber. Only provided fields change. Does not send it. ${fortnoxOfferRowsUpdateNote} ${fortnoxOfferReferencesNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateOfferInput.fields),
  outputSchema: FortnoxOffer,
  execute: ({ integration, input }) => {
    const { DocumentNumber, ...offer } = input

    return writeFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      'PUT',
      offerPath(DocumentNumber),
      { Offer: offer },
      OfferResponse,
      value => offerFromApi(value.Offer)
    )
  }
})

export const fortnoxCreateOrderFromOfferAction = defineAction({
  id: 'fortnox.create_order_from_offer',
  description: `Convert a Fortnox offer (by offer DocumentNumber) into a new order. This cannot be undone: the order is created and the offer keeps its OrderReference. Returns the offer number and the new order number (null if Fortnox did not report one). ${fortnoxOfferConvertRecoveryNote} OrderReference.`,
  access: 'destructive',
  inputSchema: closedInput(FortnoxOfferActionInput.fields),
  outputSchema: FortnoxCreateOrderFromOfferOutput,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      'PUT',
      offerPath(input.documentNumber, 'createorder'),
      undefined,
      OfferOrderReferenceResponse,
      value =>
        'Order' in value
          ? FortnoxCreateOrderFromOfferOutput.make({
              offerNumber: input.documentNumber,
              orderNumber: value.Order.DocumentNumber
            })
          : FortnoxCreateOrderFromOfferOutput.make({
              offerNumber: value.Offer.DocumentNumber,
              orderNumber: referenceFromApi(value.Offer.OrderReference)
            })
    )
})

export const fortnoxCreateInvoiceFromOfferAction = defineAction({
  id: 'fortnox.create_invoice_from_offer',
  description: `Convert a Fortnox offer (by offer DocumentNumber) into a new customer invoice. This cannot be undone: the invoice is created and the offer keeps its InvoiceReference. Returns the offer number and the new invoice DocumentNumber (null if Fortnox did not report one). ${fortnoxOfferConvertRecoveryNote} InvoiceReference.`,
  access: 'destructive',
  inputSchema: closedInput(FortnoxOfferActionInput.fields),
  outputSchema: FortnoxCreateInvoiceFromOfferOutput,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      'PUT',
      offerPath(input.documentNumber, 'createinvoice'),
      undefined,
      OfferInvoiceReferenceResponse,
      value =>
        'Invoice' in value
          ? FortnoxCreateInvoiceFromOfferOutput.make({
              offerNumber: input.documentNumber,
              invoiceNumber: value.Invoice.DocumentNumber
            })
          : FortnoxCreateInvoiceFromOfferOutput.make({
              offerNumber: value.Offer.DocumentNumber,
              invoiceNumber: referenceFromApi(value.Offer.InvoiceReference)
            })
    )
})

export const fortnoxCancelOfferAction = defineAction({
  id: 'fortnox.cancel_offer',
  description:
    'Cancel a Fortnox offer by DocumentNumber. This cannot be undone: the Fortnox API has no action to restore a cancelled offer.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxOfferActionInput.fields),
  outputSchema: FortnoxOffer,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      'PUT',
      offerPath(input.documentNumber, 'cancel'),
      undefined,
      OfferResponse,
      value => offerFromApi(value.Offer)
    )
})

export const fortnoxEmailOfferAction = defineAction({
  id: 'fortnox.email_offer',
  description:
    "Email a Fortnox offer as a PDF to the customer, using the offer's stored EmailInformation (read it first with fortnox.get_offer; this action takes no recipient). This cannot be undone: the email cannot be unsent, and Fortnox marks the offer Sent. Do not repeat the call after an unclear result; read the offer instead.",
  access: 'destructive',
  inputSchema: closedInput(FortnoxOfferActionInput.fields),
  outputSchema: FortnoxOffer,
  // Fortnox only offers GET for this side-effecting endpoint. Host HTTP adapters must not retry
  // or follow redirects for it (connector requests never ask for retries).
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      offerPath(input.documentNumber, 'email'),
      OfferResponse,
      value => offerFromApi(value.Offer)
    )
})

export const fortnoxMarkOfferSentAction = defineAction({
  id: 'fortnox.mark_offer_sent',
  description:
    'Mark a Fortnox offer as Sent (sent outside Fortnox) without generating or sending any document. This cannot be undone: the Fortnox API has no action to clear Sent.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxOfferActionInput.fields),
  outputSchema: FortnoxOffer,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      'PUT',
      offerPath(input.documentNumber, 'externalprint'),
      undefined,
      OfferResponse,
      value => offerFromApi(value.Offer)
    )
})

export const fortnoxOfferActions = [
  fortnoxListOffersAction,
  fortnoxGetOfferAction,
  fortnoxCreateOfferAction,
  fortnoxUpdateOfferAction,
  fortnoxCreateOrderFromOfferAction,
  fortnoxCreateInvoiceFromOfferAction,
  fortnoxCancelOfferAction,
  fortnoxEmailOfferAction,
  fortnoxMarkOfferSentAction
] as const

const FortnoxOfferPreviewInput = Schema.Struct({ documentNumber: FortnoxDocumentNumber })

/**
 * Host-only: the generated offer PDF from GET /offers/{DocumentNumber}/preview. Unlike /print,
 * /preview does not mark the offer Sent (Fortnox docs). Not an action.
 */
export const downloadFortnoxOfferPreview = (
  integration: ConnectorIntegration,
  input: { readonly documentNumber: FortnoxDocumentNumber },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const target = yield* decodeInput(FortnoxOfferPreviewInput, input)

    const response = yield* downloadFortnoxBytes(
      integration,
      FortnoxOfferOAuthCredentialSlot,
      offerPath(target.documentNumber, 'preview'),
      budget,
      'pdf'
    )

    return {
      ...fileBytes(response.bytes),
      source: { id: target.documentNumber, generatedPreview: true }
    }
  })
