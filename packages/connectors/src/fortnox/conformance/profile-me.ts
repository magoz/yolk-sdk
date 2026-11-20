import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The token user profile (`Me`).
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
export const fortnoxProfileMeFixture: WireFixture = {
  id: 'fortnox.profile.me.synthetic',
  caseId: 'fortnox.profile.me',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Profile read. Shaped from the Fortnox API reference (GET /3/me, Me). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/me',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Me":{"Id":"synthetic-user-1","Name":"Example User","Email":"user@example.test","Locale":"sv_SE","SysAdmin":true}}'
      }
    }
  ]
}
