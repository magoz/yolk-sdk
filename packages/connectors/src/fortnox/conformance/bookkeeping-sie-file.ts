import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The type 1 SIE file of the first financial year (synthetic PC8 bytes with one IBM437 character,
 * stored as `bodyBase64`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) shaped from the Fortnox API reference
 * (https://api.fortnox.se/apidocs, GET /3/sie/{Type}) and SIE filformat 4C
 * (https://sie.se/format/), until a live recording replaces it. The SIE bytes were first rendered
 * by the Fortnox emulator's default seed. The fixture is the source of the emulator's bookkeeping
 * answers
 * (`@yolk-sdk/emulators/fortnox` must answer its requests byte for byte); change it only for a
 * cited spec or live-run reason.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxSieFileIbm437Fixture: WireFixture = {
  id: 'fortnox.bookkeeping.sie-file-ibm437.synthetic',
  caseId: 'fortnox.bookkeeping.sie-file-ibm437',
  evidence: 'unverified',
  recordedAt: '2026-11-23',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Financial year list (limit 10), then the type 1 SIE file of the first year through the binary port. Shaped from the Fortnox API reference (GET /3/sie/{Type}, application/octet-stream) and SIE filformat 4C (`#FLAGGA` first, `#FORMAT PC8`). Synthetic placeholder (bytes first rendered by the Fortnox emulator default seed); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/financialyears?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"FinancialYears":[{"@url":"https://api.fortnox.se/3/financialyears/2","Id":2,"FromDate":"2026-01-01","ToDate":"2026-12-31","accountCharts":"Bas 2026","AccountingMethod":"ACCRUAL"},{"@url":"https://api.fortnox.se/3/financialyears/1","Id":1,"FromDate":"2025-01-01","ToDate":"2025-12-31","accountCharts":"Bas 2025","AccountingMethod":"ACCRUAL"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/sie/1?financialyear=2',
        headers: {
          accept: 'application/octet-stream'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream'
        },
        bodyBase64:
          'I0ZMQUdHQSAwDQojUFJPR1JBTSAiU3ludGhldGljIiAxDQojRk9STUFUIFBDOA0KI0dFTiAyMDI2MDkyOQ0KI1NJRVRZUCAxDQojRk5BTU4gIkV4YW1wbGUgQUIgKHN5bnRoZXRpYykglCINCiNSQVIgMCAyMDI2MDEwMSAyMDI2MTIzMQ0KI0tPTlRPIDE5MzAgIkJhbmsgYWNjb3VudCAoc3ludGhldGljKSINCiNJQiAwIDE5MzAgMTUwMDAuMDANCiNVQiAwIDE5MzAgMjc4NzQuNTANCg=='
      }
    }
  ]
}
