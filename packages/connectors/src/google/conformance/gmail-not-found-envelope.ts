import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailNotFound, gmailSyntheticApi } from './synthetic.ts'

/**
 * `gmail.get_message` of an id the practice mailbox never holds: HTTP 404 with the Google JSON
 * error envelope.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailNotFoundEnvelopeFixture: WireFixture = {
  id: 'google.gmail.not-found-envelope.synthetic',
  caseId: 'google.gmail.not-found-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'A message lookup for an id the mailbox never holds, answered 404 with the Google error envelope. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `${gmailSyntheticApi}/messages/ffffffffffffffff?format=minimal`
      },
      response: gmailNotFound
    }
  ]
}
