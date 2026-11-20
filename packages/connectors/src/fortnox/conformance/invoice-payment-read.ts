import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of invoice payments (limit 10) with numeric-string voucher fields, then the first
 * payment read back.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) shaped from the Fortnox API reference
 * (https://api.fortnox.se/apidocs, OpenAPI 3.0.3) and the JSON examples of the archived resource
 * pages (developer.fortnox.se/documentation/resources, Wayback Machine, 2022-08), with the values
 * of the Fortnox emulator default seed, until a live recording replaces it. Every field name is in
 * the OpenAPI schema; where its types and the examples disagree (numeric strings in article list
 * rows, payments, and mode of payment list rows) and for `MetaInformation` (which the OpenAPI list
 * wrappers omit), the fixture follows the examples and the connector's decoders.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxInvoicePaymentReadFixture: WireFixture = {
  id: 'fortnox.payment.invoice-payment-wire-numbers.synthetic',
  caseId: 'fortnox.payment.invoice-payment-wire-numbers',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Invoice payment list (limit 10), then the first payment. Shaped from the Fortnox API reference (GET /3/invoicepayments, /3/invoicepayments/{Number}, InvoicePayment) and its examples (numeric-string voucher fields). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoicepayments?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"InvoicePayments":[{"@url":"https://api.fortnox.se/3/invoicepayments/1","Amount":1250,"AmountCurrency":1250,"Booked":true,"Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"InvoiceCustomerName":"Example Customer AB","InvoiceCustomerNumber":"1001","InvoiceDueDate":"2026-09-30","InvoiceNumber":"101","InvoiceOCR":"10151","InvoiceTotal":1250,"ModeOfPayment":"BG","ModeOfPaymentAccount":"1930","Number":"1","PaymentDate":"2026-09-20","VoucherNumber":"1","VoucherSeries":"C","VoucherYear":"3"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoicepayments/1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"InvoicePayment":{"@url":"https://api.fortnox.se/3/invoicepayments/1","Amount":1250,"AmountCurrency":1250,"Booked":true,"Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"InvoiceCustomerName":"Example Customer AB","InvoiceCustomerNumber":"1001","InvoiceDueDate":"2026-09-30","InvoiceNumber":"101","InvoiceOCR":"10151","InvoiceTotal":1250,"ModeOfPayment":"BG","ModeOfPaymentAccount":"1930","Number":"1","PaymentDate":"2026-09-20","VoucherNumber":"1","VoucherSeries":"C","VoucherYear":"3"}}'
      }
    }
  ]
}
