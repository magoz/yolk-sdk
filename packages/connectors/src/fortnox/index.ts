import { fortnoxListSupplierInvoiceFilesAction } from './files.ts'

export * from './files.ts'

import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
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
import { FortnoxMetaInformation, listPath, paginationFromApi, readFortnox } from './shared.ts'
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

const InvoicesResponse = Schema.Struct({
  Invoices: Schema.Array(FortnoxInvoiceApi),
  MetaInformation: FortnoxMetaInformation
})

const SuppliersResponse = Schema.Struct({
  Suppliers: Schema.Array(FortnoxSupplier),
  MetaInformation: FortnoxMetaInformation
})

const SupplierInvoicesResponse = Schema.Struct({
  SupplierInvoices: Schema.Array(FortnoxSupplierInvoiceApi),
  MetaInformation: FortnoxMetaInformation
})

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
      Schema.Struct({ Customer: FortnoxCustomer }),
      value => value.Customer
    )
})

export const fortnoxListInvoicesAction = defineAction({
  id: 'fortnox.list_invoices',
  description:
    'List one page of Fortnox customer invoices. Repeat search/filter/date range/limit with pagination.nextPage to continue.',
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
      Schema.Struct({ Invoice: FortnoxInvoiceApi }),
      value => invoiceFromApi(value.Invoice)
    )
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
    'Read-only Fortnox company, customer, invoice, supplier, and supplier-invoice actions.',
  actions: [
    fortnoxListSupplierInvoiceFilesAction,
    fortnoxGetCompanyInformationAction,
    fortnoxListCustomersAction,
    fortnoxGetCustomerAction,
    fortnoxListInvoicesAction,
    fortnoxGetInvoiceAction,
    fortnoxListSuppliersAction,
    fortnoxGetSupplierAction,
    fortnoxListSupplierInvoicesAction,
    fortnoxGetSupplierInvoiceAction
  ]
})
