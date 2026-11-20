import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of cost centers (limit 10), then the first cost center read back.
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
export const fortnoxCostCenterListMatchesGetFixture: WireFixture = {
  id: 'fortnox.cost-center.list-matches-get.synthetic',
  caseId: 'fortnox.cost-center.list-matches-get',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Cost center list (limit 10), then the first cost center. Shaped from the Fortnox API reference (GET /3/costcenters, /3/costcenters/{Code}, CostCenter). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/costcenters?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"CostCenters":[{"@url":"https://api.fortnox.se/3/costcenters/CC1","Code":"CC1","Description":"Sales (synthetic)","Note":"","Active":true},{"@url":"https://api.fortnox.se/3/costcenters/CC2","Code":"CC2","Description":"Support (synthetic)","Note":"Synthetic note.","Active":true},{"@url":"https://api.fortnox.se/3/costcenters/CC9","Code":"CC9","Description":"Closed unit (synthetic)","Note":"","Active":false}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":3}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/costcenters/CC1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"CostCenter":{"@url":"https://api.fortnox.se/3/costcenters/CC1","Code":"CC1","Description":"Sales (synthetic)","Note":"","Active":true}}'
      }
    }
  ]
}
