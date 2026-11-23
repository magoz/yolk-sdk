import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The financial year list, then its first (newest) year read back by Id and by its FromDate.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) shaped from the Fortnox API reference
 * (https://api.fortnox.se/apidocs) and the JSON examples of the archived resource pages
 * (developer.fortnox.se/documentation/resources, Wayback Machine), until a live recording
 * replaces it. The bodies were first rendered by the Fortnox emulator's default seed, then checked
 * against that reference. The fixture is the source of the emulator's bookkeeping answers
 * (`@yolk-sdk/emulators/fortnox` must answer its requests byte for byte); change it only for a
 * cited spec or live-run reason.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxFinancialYearByIdAndDateFixture: WireFixture = {
  id: 'fortnox.bookkeeping.financial-year-by-id-and-date.synthetic',
  caseId: 'fortnox.bookkeeping.financial-year-by-id-and-date',
  evidence: 'unverified',
  recordedAt: '2026-11-23',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Financial year list (limit 10), the first year by Id, and the list filtered by that year’s FromDate. Shaped from the Fortnox API reference (GET /3/financialyears, /3/financialyears/{Id}, FinancialYear) and the archived list example (newest year first, `accountCharts`). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
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
        url: 'https://api.fortnox.se/3/financialyears/2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"FinancialYear":{"@url":"https://api.fortnox.se/3/financialyears/2","Id":2,"FromDate":"2026-01-01","ToDate":"2026-12-31","AccountChartType":"Bas 2026","AccountingMethod":"ACCRUAL"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/financialyears?date=2026-01-01',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"FinancialYears":[{"@url":"https://api.fortnox.se/3/financialyears/2","Id":2,"FromDate":"2026-01-01","ToDate":"2026-12-31","accountCharts":"Bas 2026","AccountingMethod":"ACCRUAL"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}'
      }
    }
  ]
}
