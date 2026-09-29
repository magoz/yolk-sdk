import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A missing customer (404) and a rejected invoice create for it, both with lowercase
 * `ErrorInformation` fields as in the responses guide.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * Regenerate with `pnpm conformance:fortnox --live --account <label> --record` (see the
 * script for the required flags).
 */
export const fortnoxWriteRejectionFixture: WireFixture = {
  id: 'fortnox.write.rejection-error-information.synthetic',
  caseId: 'fortnox.write.rejection-error-information',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Customer lookup (404) then the rejected invoice create (400), in request order. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/customers/99999',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"ErrorInformation":{"error":1,"message":"Synthetic placeholder: customer not found.","code":2000204}}'
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.fortnox.se/3/invoices',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Invoice: {
            CustomerNumber: '99999',
            Comments: 'yolk-conformance probe: expected to be rejected'
          }
        }
      },
      response: {
        status: 400,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"ErrorInformation":{"error":1,"message":"Synthetic placeholder: customer not found.","code":2000433}}'
      }
    }
  ]
}
