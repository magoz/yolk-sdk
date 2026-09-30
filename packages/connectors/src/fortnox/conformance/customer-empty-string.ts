import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Customer `Comments` updates: write a marker, send `""` (the marker stays), then restore and
 * verify the original value.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a replacement in a gitignored
 * directory; see the script header for the manual scrub-and-promote step.
 */
export const fortnoxCustomerEmptyStringFixture: WireFixture = {
  id: 'fortnox.customer.empty-string-keeps-value.synthetic',
  caseId: 'fortnox.customer.empty-string-keeps-value',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Customer read, marker update and read-back, empty-string update and read-back, then the restore update and its read-back, in request order. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
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
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"Synthetic note: invoice monthly by email.","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/customers/1001',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Customer: {
            Comments: 'yolk-conformance marker: safe to restore'
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"yolk-conformance marker: safe to restore","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
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
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"yolk-conformance marker: safe to restore","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/customers/1001',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Customer: {
            Comments: ''
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"yolk-conformance marker: safe to restore","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
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
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"yolk-conformance marker: safe to restore","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/customers/1001',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Customer: {
            Comments: 'Synthetic note: invoice monthly by email.'
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"Synthetic note: invoice monthly by email.","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
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
        body: '{"Customer":{"@url":"https://api.fortnox.se/3/customers/1001","Active":true,"Address1":"Exempelgatan 1","Address2":"","City":"Exempelstad","Comments":"Synthetic note: invoice monthly by email.","CostCenter":"","Country":"Sverige","CountryCode":"SE","Currency":"SEK","CustomerNumber":"1001","Email":"billing@example.test","EmailInvoice":"billing@example.test","Name":"Example Customer AB","OrganisationNumber":"000000-0000","OurReference":"","Phone1":"","Phone2":"","TermsOfPayment":"30","Type":"COMPANY","VATNumber":"","VATType":"SEVAT","YourReference":"","ZipCode":"000 00"}}'
      }
    }
  ]
}
