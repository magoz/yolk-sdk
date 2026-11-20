import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of customers (limit 10) with `MetaInformation`, then the first customer read back.
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
export const fortnoxCustomerListMatchesGetFixture: WireFixture = {
  id: 'fortnox.customer.list-matches-get.synthetic',
  caseId: 'fortnox.customer.list-matches-get',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Customer list (limit 10), then the first customer. Shaped from the Fortnox API reference (GET /3/customers, CustomerListItem; GET /3/customers/{CustomerNumber}, Customer). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/customers?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Customers":[{"@url":"https://api.fortnox.se/3/customers/1001","Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","CustomerNumber":"1001","Email":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","Phone":"","ZipCode":"000 00"},{"@url":"https://api.fortnox.se/3/customers/1002","Address1":"Exempelvägen 2","Address2":"","City":"Exempelstad","CustomerNumber":"1002","Email":"accounts@example.test","Name":"Example Trading AB","OrganisationNumber":"000000-0001","Phone":"","ZipCode":"000 01"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/customers/1001',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","CustomerNumber":"1001","Name":"Example Customer AB","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"Synthetic note: invoice monthly by email.","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","Email":"billing@example.test","EmailInvoice":"billing@example.test","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
      }
    }
  ]
}
