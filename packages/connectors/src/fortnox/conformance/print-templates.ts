import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The invoice print templates (no `type`) and the offer print templates, without `MetaInformation`.
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
export const fortnoxPrintTemplatesUnpaginatedFixture: WireFixture = {
  id: 'fortnox.print-templates.unpaginated.synthetic',
  caseId: 'fortnox.print-templates.unpaginated',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Print template lists (invoice, then offer). Shaped from the Fortnox API reference (GET /3/printtemplates, PrintTemplate). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/printtemplates',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"PrintTemplates":[{"Template":"invoice-standard","Name":"Standard invoice (synthetic)"},{"Template":"invoice-reminder","Name":"Reminder (synthetic)"}]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/printtemplates?type=offer',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"PrintTemplates":[{"Template":"offer-standard","Name":"Standard offer (synthetic)"}]}'
      }
    }
  ]
}
