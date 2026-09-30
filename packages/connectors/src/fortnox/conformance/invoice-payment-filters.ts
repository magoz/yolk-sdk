import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Invoice lists for `filter=unbooked`, `filter=unpaid`, and `filter=unpaidoverdue`: the unbooked
 * invoice with a positive balance, due 2026-09-15 (overdue on the 2026-09-29 test clock), is absent
 * from both payment-status lists.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a replacement in a gitignored
 * directory; see the script header for the manual scrub-and-promote step.
 */
export const fortnoxInvoicePaymentFiltersFixture: WireFixture = {
  id: 'fortnox.invoice.payment-filters-exclude-unbooked.synthetic',
  caseId: 'fortnox.invoice.payment-filters-exclude-unbooked',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Filtered invoice lists in request order. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices?filter=unbooked&limit=500&page=1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoices":[{"@url":"https://api.fortnox.se/3/invoices/105","Balance":1250,"Booked":false,"Cancelled":false,"CostCenter":"","Currency":"SEK","CurrencyRate":"1","CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"105","DueDate":"2026-09-15","ExternalInvoiceReference1":"","ExternalInvoiceReference2":"","FinalPayDate":null,"InvoiceDate":"2026-08-16","InvoiceType":"INVOICE","NoxFinans":false,"OCR":"","VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"WayOfDelivery":"","TermsOfPayment":"30","Project":"","Sent":false,"Total":1250}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices?filter=unpaid&limit=500&page=1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoices":[{"@url":"https://api.fortnox.se/3/invoices/102","Balance":3750,"Booked":true,"Cancelled":false,"CostCenter":"","Currency":"SEK","CurrencyRate":"1","CurrencyUnit":1,"CustomerName":"Example Trading AB","CustomerNumber":"1002","DocumentNumber":"102","DueDate":"2026-09-30","ExternalInvoiceReference1":"","ExternalInvoiceReference2":"","FinalPayDate":null,"InvoiceDate":"2026-08-31","InvoiceType":"INVOICE","NoxFinans":false,"OCR":"10250","VoucherNumber":13,"VoucherSeries":"B","VoucherYear":3,"WayOfDelivery":"","TermsOfPayment":"30","Project":"","Sent":true,"Total":3750}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices?filter=unpaidoverdue&limit=500&page=1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoices":[],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":0}}'
      }
    }
  ]
}
