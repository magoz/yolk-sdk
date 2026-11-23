import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A populated account page of the first financial year, and its first account read back with its
 * balances.
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
export const fortnoxAccountBalancesListGetFixture: WireFixture = {
  id: 'fortnox.bookkeeping.account-balances-list-get.synthetic',
  caseId: 'fortnox.bookkeeping.account-balances-list-get',
  evidence: 'unverified',
  recordedAt: '2026-11-23',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Financial year list (limit 10), the account list of the first year (limit 10), and its first account by number in that year. Shaped from the Fortnox API reference (GET /3/accounts, /3/accounts/{Number}, Account) and the archived examples (single read `Project` as the number 0, `VATCode` null). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
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
        url: 'https://api.fortnox.se/3/accounts?limit=10&financialyear=2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Accounts":[{"@url":"https://api.fortnox.se/3/accounts/1930?financialyear=2","Active":true,"BalanceBroughtForward":15000,"BalanceCarriedForward":27874.5,"CostCenter":"","CostCenterSettings":"ALLOWED","Description":"Bank account (synthetic)","Number":1930,"Project":"","ProjectSettings":"ALLOWED","SRU":7281,"VATCode":null,"Year":2},{"@url":"https://api.fortnox.se/3/accounts/3001?financialyear=2","Active":true,"BalanceBroughtForward":0,"BalanceCarriedForward":-13000,"CostCenter":"","CostCenterSettings":"ALLOWED","Description":"Sales (synthetic)","Number":3001,"Project":"","ProjectSettings":"ALLOWED","SRU":7410,"VATCode":"MP1","Year":2},{"@url":"https://api.fortnox.se/3/accounts/6570?financialyear=2","Active":true,"BalanceBroughtForward":0,"BalanceCarriedForward":125.5,"CostCenter":"","CostCenterSettings":"ALLOWED","Description":"Bank fees (synthetic)","Number":6570,"Project":"","ProjectSettings":"ALLOWED","SRU":7513,"VATCode":null,"Year":2}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":3}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/accounts/1930?financialyear=2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Account":{"@url":"https://api.fortnox.se/3/accounts/1930?financialyear=2","Active":true,"BalanceBroughtForward":15000,"BalanceCarriedForward":27874.5,"CostCenter":"","CostCenterSettings":"ALLOWED","Description":"Bank account (synthetic)","Number":1930,"Project":0,"ProjectSettings":"ALLOWED","SRU":7281,"VATCode":null,"Year":2}}'
      }
    }
  ]
}
