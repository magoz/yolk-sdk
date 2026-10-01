import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The invoice read that confirms the email recipient, then the invoice email send answered with the
 * invoice envelope.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxInvoiceSendEmailFixture: WireFixture = {
  id: 'fortnox.invoice.send-email.synthetic',
  caseId: 'fortnox.invoice.send-email',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Invoice read (recipient check), then the invoice email send. Email delivery is not part of the wire and is not established for test companies. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/104',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/104","Balance":625,"Booked":true,"Cancelled":false,"Currency":"SEK","CurrencyRate":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"104","DueDate":"2026-10-31","EmailInformation":{"EmailAddressFrom":"invoices@example.test","EmailAddressTo":"billing@example.test","EmailAddressCC":"","EmailAddressBCC":"","EmailSubject":"Invoice {no} from Example AB","EmailBody":"Synthetic invoice email body."},"InvoiceDate":"2026-09-30","InvoiceType":"INVOICE","Sent":false,"Total":625,"TotalVAT":125}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/104/email',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/104","Balance":625,"Booked":true,"Cancelled":false,"Currency":"SEK","CurrencyRate":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"104","DueDate":"2026-10-31","EmailInformation":{"EmailAddressFrom":"invoices@example.test","EmailAddressTo":"billing@example.test","EmailSubject":"Invoice {no} from Example AB","EmailBody":"Synthetic invoice email body."},"InvoiceDate":"2026-09-30","InvoiceType":"INVOICE","Sent":true,"Total":625,"TotalVAT":125}}'
      }
    }
  ]
}
