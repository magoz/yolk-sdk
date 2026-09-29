import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Generated invoice preview PDF (a tiny synthetic PDF with a binary comment line, stored as
 * `bodyBase64`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * Regenerate with `pnpm conformance:fortnox --live --account <label> --record` (see the
 * script for the required flags).
 */
export const fortnoxInvoicePreviewPdfFixture: WireFixture = {
  id: 'fortnox.invoice.preview-pdf.synthetic',
  caseId: 'fortnox.invoice.preview-pdf',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Invoice preview download through the binary port. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/102/preview'
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/pdf'
        },
        bodyBase64:
          'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFtdIC9Db3VudCAwID4+CmVuZG9iagp0cmFpbGVyCjw8IC9Sb290IDEgMCBSID4+CiUlRU9GCg=='
      }
    }
  ]
}
