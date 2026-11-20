import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of supplier invoice payments (limit 10) with numeric-string voucher fields, then the
 * first payment read back.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) shaped from the Fortnox API reference
 * (https://api.fortnox.se/apidocs, OpenAPI 3.0.3) and the JSON examples of the archived resource
 * pages (developer.fortnox.se/documentation/resources, Wayback Machine, 2022-08), until a live
 * recording replaces it. The bodies were first rendered by the Fortnox emulator's default seed
 * (which fixed their key order, `@url` links, and extra fields), then checked against that
 * reference: every field name is in the OpenAPI schema; where its types and the examples disagree
 * (numeric strings in article list rows, payments, and mode of payment list rows) and for
 * `MetaInformation` (which the OpenAPI list wrappers omit), the fixture follows the examples and
 * the connector's decoders. The fixture is the source of the emulator's read answers
 * (`@yolk-sdk/emulators/fortnox` must answer its requests byte for byte); change it only for a
 * cited spec or live-run reason.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxSupplierInvoicePaymentReadFixture: WireFixture = {
  id: 'fortnox.payment.supplier-payment-wire-numbers.synthetic',
  caseId: 'fortnox.payment.supplier-payment-wire-numbers',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Supplier invoice payment list (limit 10), then the first payment. Shaped from the Fortnox API reference (GET /3/supplierinvoicepayments, /3/supplierinvoicepayments/{Number}, SupplierInvoicePayment) and its examples (numeric-string voucher fields). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/supplierinvoicepayments?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"SupplierInvoicePayments":[{"@url":"https://api.fortnox.se/3/supplierinvoicepayments/1","Number":"1","InvoiceNumber":"1","Amount":500,"AmountCurrency":500,"Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"Booked":false,"Information":"","InvoiceDueDate":"2026-09-30","InvoiceOCR":"","InvoiceSupplierName":"Example Supplier AB","InvoiceSupplierNumber":"1","InvoiceTotal":500,"ModeOfPayment":"BG","PaymentDate":"2026-09-25","VoucherNumber":"2","VoucherSeries":"D","VoucherYear":"3"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/supplierinvoicepayments/1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"SupplierInvoicePayment":{"@url":"https://api.fortnox.se/3/supplierinvoicepayments/1","Number":"1","InvoiceNumber":"1","Amount":500,"AmountCurrency":500,"Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"Booked":false,"Information":"","InvoiceDueDate":"2026-09-30","InvoiceOCR":"","InvoiceSupplierName":"Example Supplier AB","InvoiceSupplierNumber":"1","InvoiceTotal":500,"ModeOfPayment":"BG","PaymentDate":"2026-09-25","VoucherNumber":"2","VoucherSeries":"D","VoucherYear":"3"}}'
      }
    }
  ]
}
