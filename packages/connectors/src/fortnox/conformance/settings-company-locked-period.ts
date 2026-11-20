import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Company settings and the locked period.
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
export const fortnoxSettingsCompanyAndLockedPeriodFixture: WireFixture = {
  id: 'fortnox.settings.company-and-locked-period.synthetic',
  caseId: 'fortnox.settings.company-and-locked-period',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Company settings, then the locked period. Shaped from the Fortnox API reference (GET /3/settings/company, CompanySettings; GET /3/settings/lockedperiod, LockedPeriod). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/settings/company',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"CompanySettings":{"Name":"Example AB","OrganizationNumber":"000000-0002","Address":"Exempelgatan 10","ZipCode":"000 02","City":"Exempelstad","Country":"Sverige","CountryCode":"SE","VisitName":"Example AB","VisitAddress":"Exempelgatan 10","VisitZipCode":"000 02","VisitCity":"Exempelstad","VisitCountry":"Sverige","VisitCountryCode":"SE","Email":"info@example.test","Phone1":"","Phone2":"","WWW":"https://example.test","BG":"","PG":"","IBAN":"","BIC":"","VATNumber":"","TaxEnabled":true,"Domicile":"Exempelstad","BranchCode":""}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/settings/lockedperiod',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"LockedPeriod":{"EndDate":"2026-06-30"}}'
      }
    }
  ]
}
