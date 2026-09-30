import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of a populated invoice list: rows with JSON-number totals and a numeric-string
 * `CurrencyRate`, plus `MetaInformation`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a replacement in a gitignored
 * directory; see the script header for the manual scrub-and-promote step.
 */
export const fortnoxInvoiceListPopulatedFixture: WireFixture = {
  id: 'fortnox.invoice.list-populated.synthetic',
  caseId: 'fortnox.invoice.list-populated',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Invoice list (limit 10) on a populated company. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoices":[{"@url":"https://api.fortnox.se/3/invoices/101","Balance":0,"Booked":true,"Cancelled":false,"CostCenter":"","Currency":"SEK","CurrencyRate":"1","CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"101","DueDate":"2026-09-30","ExternalInvoiceReference1":"","ExternalInvoiceReference2":"","FinalPayDate":"2026-09-20","InvoiceDate":"2026-08-31","InvoiceType":"INVOICE","NoxFinans":false,"OCR":"10151","VoucherNumber":12,"VoucherSeries":"B","VoucherYear":3,"WayOfDelivery":"","TermsOfPayment":"30","Project":"","Sent":true,"Total":1250},{"@url":"https://api.fortnox.se/3/invoices/102","Balance":3750,"Booked":true,"Cancelled":false,"CostCenter":"","Currency":"SEK","CurrencyRate":"1","CurrencyUnit":1,"CustomerName":"Example Trading AB","CustomerNumber":"1002","DocumentNumber":"102","DueDate":"2026-09-30","ExternalInvoiceReference1":"","ExternalInvoiceReference2":"","FinalPayDate":null,"InvoiceDate":"2026-08-31","InvoiceType":"INVOICE","NoxFinans":false,"OCR":"10250","VoucherNumber":13,"VoucherSeries":"B","VoucherYear":3,"WayOfDelivery":"","TermsOfPayment":"30","Project":"","Sent":true,"Total":3750},{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1563,"Booked":false,"Cancelled":false,"CostCenter":"","Currency":"SEK","CurrencyRate":"1","CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-09-30","ExternalInvoiceReference1":"","ExternalInvoiceReference2":"","FinalPayDate":null,"InvoiceDate":"2026-08-31","InvoiceType":"INVOICE","NoxFinans":false,"OCR":"","VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"WayOfDelivery":"","TermsOfPayment":"30","Project":"","Sent":false,"Total":1563}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":3}}'
      }
    }
  ]
}
