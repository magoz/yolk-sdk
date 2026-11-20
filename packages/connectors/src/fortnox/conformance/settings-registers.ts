import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Each of the five settings registers (limit 10), then its first entry read back.
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
export const fortnoxSettingsRegistersFixture: WireFixture = {
  id: 'fortnox.settings.registers-list-matches-get.synthetic',
  caseId: 'fortnox.settings.registers-list-matches-get',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Modes of payment, terms of payment, terms of delivery, ways of delivery, and units: each list (limit 10), then its first entry, in request order. Shaped from the Fortnox API reference (GET /3/modesofpayments, /3/termsofpayments, /3/termsofdeliveries, /3/wayofdeliveries, /3/units, and their /{Code} reads) and its examples (a mode of payment AccountNumber as a string in list rows). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/modesofpayments?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"ModesOfPayments":[{"@url":"https://api.fortnox.se/3/modesofpayments/BG","Code":"BG","Description":"Bankgiro (synthetic)","AccountNumber":"1930"},{"@url":"https://api.fortnox.se/3/modesofpayments/KONT","Code":"KONT","Description":"Cash (synthetic)","AccountNumber":"1910"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/modesofpayments/BG',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"ModeOfPayment":{"@url":"https://api.fortnox.se/3/modesofpayments/BG","Code":"BG","Description":"Bankgiro (synthetic)","AccountNumber":1930}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/termsofpayments?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"TermsOfPayments":[{"@url":"https://api.fortnox.se/3/termsofpayments/10","Code":"10","Description":"10 days (synthetic)"},{"@url":"https://api.fortnox.se/3/termsofpayments/30","Code":"30","Description":"30 days (synthetic)"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/termsofpayments/10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"TermsOfPayment":{"@url":"https://api.fortnox.se/3/termsofpayments/10","Code":"10","Description":"10 days (synthetic)"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/termsofdeliveries?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"TermsOfDeliveries":[{"@url":"https://api.fortnox.se/3/termsofdeliveries/EXW","Code":"EXW","Description":"Ex works (synthetic)","DescriptionEnglish":"Ex works"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/termsofdeliveries/EXW',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"TermsOfDelivery":{"@url":"https://api.fortnox.se/3/termsofdeliveries/EXW","Code":"EXW","Description":"Ex works (synthetic)","DescriptionEnglish":"Ex works"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/wayofdeliveries?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"WayOfDeliveries":[{"@url":"https://api.fortnox.se/3/wayofdeliveries/P","Code":"P","Description":"Post (synthetic)","DescriptionEnglish":"Mail"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/wayofdeliveries/P',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"WayOfDelivery":{"@url":"https://api.fortnox.se/3/wayofdeliveries/P","Code":"P","Description":"Post (synthetic)","DescriptionEnglish":"Mail"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/units?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Units":[{"@url":"https://api.fortnox.se/3/units/h","Code":"h","Description":"Hour (synthetic)","CodeEnglish":"h"},{"@url":"https://api.fortnox.se/3/units/st","Code":"st","Description":"Piece (synthetic)","CodeEnglish":"pcs"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/units/h',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Unit":{"@url":"https://api.fortnox.se/3/units/h","Code":"h","Description":"Hour (synthetic)","CodeEnglish":"h"}}'
      }
    }
  ]
}
