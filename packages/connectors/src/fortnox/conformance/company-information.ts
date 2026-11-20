import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Company information (`CompanyInformation`).
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
export const fortnoxCompanyInformationFixture: WireFixture = {
  id: 'fortnox.company.information-decodes.synthetic',
  caseId: 'fortnox.company.information-decodes',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Company information read. Shaped from the Fortnox API reference (GET /3/companyinformation, CompanyInformation). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/companyinformation',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"CompanyInformation":{"CompanyName":"Example AB","OrganizationNumber":"000000-0002","DatabaseNumber":100001,"Address":"Exempelgatan 10","City":"Exempelstad","ZipCode":"000 02","CountryCode":"SE","VisitAddress":"Exempelgatan 10","VisitCity":"Exempelstad","VisitZipCode":"000 02","VisitCountryCode":"SE"}}'
      }
    }
  ]
}
