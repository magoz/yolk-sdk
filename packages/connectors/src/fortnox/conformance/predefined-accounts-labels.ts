import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Predefined accounts, the first one read back, and the labels, without `MetaInformation`.
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
export const fortnoxPredefinedAccountsAndLabelsFixture: WireFixture = {
  id: 'fortnox.settings.predefined-accounts-and-labels.synthetic',
  caseId: 'fortnox.settings.predefined-accounts-and-labels',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Predefined account list, the first account, then the label list. Shaped from the Fortnox API reference (GET /3/predefinedaccounts, /3/predefinedaccounts/{name}, PreDefinedAccount; GET /3/labels, Label). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/predefinedaccounts',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"PreDefinedAccounts":[{"Name":"BG","Account":1930},{"Name":"OUTVAT_MP1","Account":2611},{"Name":"SALES","Account":3001},{"Name":"SALES2","Account":3041}]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/predefinedaccounts/BG',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"PreDefinedAccount":{"Name":"BG","Account":1930}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/labels',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Labels":[{"Id":1,"Description":"Priority (synthetic)"},{"Id":2,"Description":"Follow up (synthetic)"}]}'
      }
    }
  ]
}
