import { fortnoxArticleActions } from './articles.ts'
import { fortnoxCostCenterActions } from './cost-centers.ts'
import { fortnoxListSupplierInvoiceFilesAction } from './files.ts'
import { fortnoxInboxActions } from './inbox.ts'
import { fortnoxOfferActions } from './offers.ts'
import { fortnoxPaymentActions } from './payments.ts'
import { fortnoxPriceActions } from './prices.ts'
import { fortnoxPrintActions } from './print-templates.ts'
import { fortnoxProfileActions } from './profile.ts'
import { fortnoxSettingsRegisterActions } from './settings-registers.ts'
import { fortnoxSettingsActions } from './settings.ts'

export * from './articles.ts'

export * from './cost-centers.ts'

export * from './files.ts'

export * from './inbox.ts'

export * from './offers.ts'

export * from './payments.ts'

export * from './prices.ts'

export * from './print-templates.ts'

export * from './profile.ts'

export * from './settings-registers.ts'

export * from './settings.ts'

import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { closedInput } from './fields.ts'
import {
  fortnoxConnectorId,
  FortnoxCompanyInformationOAuthCredentialSlot,
  FortnoxCustomerOAuthCredentialSlot,
  FortnoxInvoiceOAuthCredentialSlot,
  FortnoxSupplierOAuthCredentialSlot,
  FortnoxSupplierInvoiceOAuthCredentialSlot
} from './oauth.ts'
import {
  FortnoxCompanyInformation,
  FortnoxCustomer,
  FortnoxInvoice,
  FortnoxSupplier,
  FortnoxSupplierInvoice,
  FortnoxGetCompanyInformationInput,
  FortnoxGetCustomerInput,
  FortnoxGetInvoiceInput,
  FortnoxCreateCustomerInput,
  FortnoxUpdateCustomerInput,
  FortnoxCreateInvoiceInput,
  FortnoxUpdateInvoiceInput,
  FortnoxGetSupplierInput,
  FortnoxGetSupplierInvoiceInput,
  FortnoxListCustomersInput,
  FortnoxListCustomersOutput,
  FortnoxListInvoicesInput,
  FortnoxListInvoicesOutput,
  FortnoxListSuppliersInput,
  FortnoxListSuppliersOutput,
  FortnoxListSupplierInvoicesInput,
  FortnoxListSupplierInvoicesOutput
} from './schemas.ts'
import {
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'
import {
  FortnoxInvoiceApi,
  FortnoxSupplierInvoiceApi,
  invoiceFromApi,
  supplierInvoiceFromApi
} from './wire.ts'

export * from './oauth.ts'

export * from './schemas.ts'

export { fortnoxApiBaseUrl } from './shared.ts'

const CustomersResponse = Schema.Struct({
  Customers: Schema.Array(FortnoxCustomer),
  MetaInformation: FortnoxMetaInformation
})

const CustomerResponse = Schema.Struct({ Customer: FortnoxCustomer })

const InvoicesResponse = Schema.Struct({
  Invoices: Schema.Array(FortnoxInvoiceApi),
  MetaInformation: FortnoxMetaInformation
})

const InvoiceResponse = Schema.Struct({ Invoice: FortnoxInvoiceApi })

const SuppliersResponse = Schema.Struct({
  Suppliers: Schema.Array(FortnoxSupplier),
  MetaInformation: FortnoxMetaInformation
})

const SupplierInvoicesResponse = Schema.Struct({
  SupplierInvoices: Schema.Array(FortnoxSupplierInvoiceApi),
  MetaInformation: FortnoxMetaInformation
})

// Customer writes reject unknown keys (including Fortnox's read-only `Country` and list-only
// `Phone`) through `closedInput` instead of stripping them.
const fortnoxCustomerContactFieldsNote =
  'Country is read-only and derived from CountryCode; set CountryCode. Customers use Phone1/Phone2, not Phone. Unknown fields are rejected.'

const fortnoxInvoiceReferencesNote =
  'Referenced CostCenter, Project, ArticleNumber, AccountNumber, and non-SEK Currency must already exist in the Fortnox company.'

const fortnoxInvoiceRowsUpdateNote =
  'Sending InvoiceRows replaces the row list: existing rows not sent are deleted. If no sent row has RowId, rows are matched to existing rows by position, and fields omitted on a matched row keep their previous value (for example Discount/DiscountType), so send every row that should remain with all pricing fields, including Discount 0 when no discount is intended. If any sent row has RowId, rows with a matching RowId are updated and rows without RowId are added. RowIds are regenerated on every update; read the invoice again before reusing RowIds.'

export const fortnoxGetCompanyInformationAction = defineAction({
  id: 'fortnox.get_company_information',
  description:
    'Read company information for the Fortnox account associated with the host credential.',
  access: 'read',
  inputSchema: FortnoxGetCompanyInformationInput,
  outputSchema: FortnoxCompanyInformation,
  execute: ({ integration }) =>
    readFortnox(
      integration,
      FortnoxCompanyInformationOAuthCredentialSlot,
      'companyinformation',
      Schema.Struct({ CompanyInformation: FortnoxCompanyInformation }),
      value => value.CompanyInformation
    )
})

export const fortnoxListCustomersAction = defineAction({
  id: 'fortnox.list_customers',
  description:
    'List one page of Fortnox customers. Repeat search/filter/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListCustomersInput,
  outputSchema: FortnoxListCustomersOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxCustomerOAuthCredentialSlot,
      listPath('customers', input),
      CustomersResponse,
      value =>
        FortnoxListCustomersOutput.make({
          customers: Chunk.fromIterable(value.Customers),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetCustomerAction = defineAction({
  id: 'fortnox.get_customer',
  description: 'Read a Fortnox customer by CustomerNumber.',
  access: 'read',
  inputSchema: FortnoxGetCustomerInput,
  outputSchema: FortnoxCustomer,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxCustomerOAuthCredentialSlot,
      `customers/${encodeURIComponent(input.customerNumber)}`,
      CustomerResponse,
      value => value.Customer
    )
})

export const fortnoxCreateCustomerAction = defineAction({
  id: 'fortnox.create_customer',
  description: `Create a Fortnox customer. Fortnox assigns CustomerNumber. ${fortnoxCustomerContactFieldsNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxCreateCustomerInput.fields),
  outputSchema: FortnoxCustomer,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxCustomerOAuthCredentialSlot,
      'POST',
      'customers',
      { Customer: input },
      CustomerResponse,
      value => value.Customer
    )
})

export const fortnoxUpdateCustomerAction = defineAction({
  id: 'fortnox.update_customer',
  description: `Update a Fortnox customer by CustomerNumber. Only provided fields change; omitted fields keep their stored value. An empty string does not clear a stored value. ${fortnoxCustomerContactFieldsNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateCustomerInput.fields),
  outputSchema: FortnoxCustomer,
  execute: ({ integration, input }) => {
    const { CustomerNumber, ...customer } = input

    return writeFortnox(
      integration,
      FortnoxCustomerOAuthCredentialSlot,
      'PUT',
      `customers/${encodeURIComponent(CustomerNumber)}`,
      { Customer: customer },
      CustomerResponse,
      value => value.Customer
    )
  }
})

export const fortnoxListInvoicesAction = defineAction({
  id: 'fortnox.list_invoices',
  description:
    'List one page of Fortnox customer invoices. Repeat search/filter/date range/limit with pagination.nextPage to continue. Observed behavior (not stated in Fortnox API docs): payment-status filters unpaid, unpaidoverdue, and fullypaid do not include unbooked invoices; use filter unbooked for those. An empty payment-status result does not mean nothing is outstanding.',
  access: 'read',
  inputSchema: FortnoxListInvoicesInput,
  outputSchema: FortnoxListInvoicesOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxInvoiceOAuthCredentialSlot,
      listPath('invoices', input),
      InvoicesResponse,
      value =>
        FortnoxListInvoicesOutput.make({
          invoices: Chunk.fromIterable(value.Invoices.map(invoiceFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetInvoiceAction = defineAction({
  id: 'fortnox.get_invoice',
  description:
    'Read a Fortnox customer invoice and available invoice rows by DocumentNumber. Does not send or book it.',
  access: 'read',
  inputSchema: FortnoxGetInvoiceInput,
  outputSchema: FortnoxInvoice,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxInvoiceOAuthCredentialSlot,
      `invoices/${encodeURIComponent(input.documentNumber)}`,
      InvoiceResponse,
      value => invoiceFromApi(value.Invoice)
    )
})

export const fortnoxCreateInvoiceAction = defineAction({
  id: 'fortnox.create_invoice',
  description: `Create a Fortnox customer invoice. Fortnox assigns DocumentNumber. ${fortnoxInvoiceReferencesNote}`,
  access: 'write',
  inputSchema: FortnoxCreateInvoiceInput,
  outputSchema: FortnoxInvoice,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxInvoiceOAuthCredentialSlot,
      'POST',
      'invoices',
      { Invoice: input },
      InvoiceResponse,
      value => invoiceFromApi(value.Invoice)
    )
})

export const fortnoxUpdateInvoiceAction = defineAction({
  id: 'fortnox.update_invoice',
  description: `Update a Fortnox customer invoice by DocumentNumber. Does not send or book it. ${fortnoxInvoiceRowsUpdateNote} ${fortnoxInvoiceReferencesNote}`,
  access: 'write',
  inputSchema: FortnoxUpdateInvoiceInput,
  outputSchema: FortnoxInvoice,
  execute: ({ integration, input }) => {
    const { DocumentNumber, ...invoice } = input

    return writeFortnox(
      integration,
      FortnoxInvoiceOAuthCredentialSlot,
      'PUT',
      `invoices/${encodeURIComponent(DocumentNumber)}`,
      { Invoice: invoice },
      InvoiceResponse,
      value => invoiceFromApi(value.Invoice)
    )
  }
})

export const fortnoxListSuppliersAction = defineAction({
  id: 'fortnox.list_suppliers',
  description:
    'List one page of Fortnox suppliers. Repeat search/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListSuppliersInput,
  outputSchema: FortnoxListSuppliersOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxSupplierOAuthCredentialSlot,
      listPath('suppliers', input),
      SuppliersResponse,
      value =>
        FortnoxListSuppliersOutput.make({
          suppliers: Chunk.fromIterable(value.Suppliers),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetSupplierAction = defineAction({
  id: 'fortnox.get_supplier',
  description: 'Read a Fortnox supplier by SupplierNumber.',
  access: 'read',
  inputSchema: FortnoxGetSupplierInput,
  outputSchema: FortnoxSupplier,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxSupplierOAuthCredentialSlot,
      `suppliers/${encodeURIComponent(input.supplierNumber)}`,
      Schema.Struct({ Supplier: FortnoxSupplier }),
      value => value.Supplier
    )
})

export const fortnoxListSupplierInvoicesAction = defineAction({
  id: 'fortnox.list_supplier_invoices',
  description:
    'List one page of Fortnox supplier invoices. Repeat search/filter/date range/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListSupplierInvoicesInput,
  outputSchema: FortnoxListSupplierInvoicesOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxSupplierInvoiceOAuthCredentialSlot,
      listPath('supplierinvoices', input),
      SupplierInvoicesResponse,
      value =>
        FortnoxListSupplierInvoicesOutput.make({
          supplierInvoices: Chunk.fromIterable(value.SupplierInvoices.map(supplierInvoiceFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetSupplierInvoiceAction = defineAction({
  id: 'fortnox.get_supplier_invoice',
  description:
    'Read a Fortnox supplier invoice and available rows by GivenNumber (not the supplier InvoiceNumber). Does not book or pay it.',
  access: 'read',
  inputSchema: FortnoxGetSupplierInvoiceInput,
  outputSchema: FortnoxSupplierInvoice,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxSupplierInvoiceOAuthCredentialSlot,
      `supplierinvoices/${encodeURIComponent(input.givenNumber)}`,
      Schema.Struct({ SupplierInvoice: FortnoxSupplierInvoiceApi }),
      value => supplierInvoiceFromApi(value.SupplierInvoice)
    )
})

export const FortnoxConnector = defineConnector({
  id: fortnoxConnectorId,
  description:
    'Fortnox company, customer, invoice, supplier, supplier-invoice, article, price, cost-center, payment, offer, print-template, inbox, settings, and profile actions. Destructive actions (delete, bookkeep, cancel, convert, email, mark sent) are marked destructive.',
  actions: [
    fortnoxListSupplierInvoiceFilesAction,
    fortnoxGetCompanyInformationAction,
    fortnoxListCustomersAction,
    fortnoxGetCustomerAction,
    fortnoxCreateCustomerAction,
    fortnoxUpdateCustomerAction,
    fortnoxListInvoicesAction,
    fortnoxGetInvoiceAction,
    fortnoxCreateInvoiceAction,
    fortnoxUpdateInvoiceAction,
    fortnoxListSuppliersAction,
    fortnoxGetSupplierAction,
    fortnoxListSupplierInvoicesAction,
    fortnoxGetSupplierInvoiceAction,
    ...fortnoxArticleActions,
    ...fortnoxPriceActions,
    ...fortnoxCostCenterActions,
    ...fortnoxPaymentActions,
    ...fortnoxOfferActions,
    ...fortnoxPrintActions,
    ...fortnoxInboxActions,
    ...fortnoxSettingsActions,
    ...fortnoxSettingsRegisterActions,
    ...fortnoxProfileActions
  ]
})
