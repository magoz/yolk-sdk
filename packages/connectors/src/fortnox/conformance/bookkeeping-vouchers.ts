import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A populated voucher page of the first financial year, its voucher series, the first voucher’s
 * series list, the first voucher with its rows, and its file connections (which also name another
 * series’ voucher with the same number).
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
export const fortnoxVoucherListGetBalancedFixture: WireFixture = {
  id: 'fortnox.bookkeeping.voucher-list-get-balanced.synthetic',
  caseId: 'fortnox.bookkeeping.voucher-list-get-balanced',
  evidence: 'unverified',
  recordedAt: '2026-11-23',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Financial year list (limit 10), the voucher list of the first year (limit 10), its voucher series (limit 500), the first voucher’s series list (limit 10), the first voucher by series, number, and year, and its voucher file connections. Shaped from the Fortnox API reference (GET /3/vouchers, /3/vouchers/{VoucherSeries}/{VoucherNumber}, /3/voucherseries, /3/voucherfileconnections) and the archived examples (single read `Comments` null and `Project` 0; series list rows without `NextVoucherNumber`; connection `VoucherNumber` a string). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
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
        url: 'https://api.fortnox.se/3/vouchers?limit=10&financialyear=2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Vouchers":[{"@url":"https://api.fortnox.se/3/vouchers/A/1?financialyear=2","Description":"Bank fee (synthetic)","ReferenceNumber":"","ReferenceType":"MANUAL","TransactionDate":"2026-09-01","VoucherNumber":1,"VoucherSeries":"A","Year":2},{"@url":"https://api.fortnox.se/3/vouchers/A/2?financialyear=2","Description":"Sale (synthetic)","ReferenceNumber":"","ReferenceType":"MANUAL","TransactionDate":"2026-09-15","VoucherNumber":2,"VoucherSeries":"A","Year":2},{"@url":"https://api.fortnox.se/3/vouchers/B/1?financialyear=2","Description":"Customer invoice (synthetic)","ReferenceNumber":"101","ReferenceType":"INVOICE","TransactionDate":"2026-09-20","VoucherNumber":1,"VoucherSeries":"B","Year":2}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":3}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/voucherseries?limit=500&financialyear=2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"VoucherSeriesCollection":[{"@url":"https://api.fortnox.se/3/voucherseries/A?financialyear=2","Code":"A","Description":"Accounting (synthetic)","Manual":true,"Year":2},{"@url":"https://api.fortnox.se/3/voucherseries/B?financialyear=2","Code":"B","Description":"Customer invoices (synthetic)","Manual":false,"Year":2}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/vouchers/sublist/A?limit=10&financialyear=2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Vouchers":[{"@url":"https://api.fortnox.se/3/vouchers/A/1?financialyear=2","Description":"Bank fee (synthetic)","ReferenceNumber":"","ReferenceType":"MANUAL","TransactionDate":"2026-09-01","VoucherNumber":1,"VoucherSeries":"A","Year":2},{"@url":"https://api.fortnox.se/3/vouchers/A/2?financialyear=2","Description":"Sale (synthetic)","ReferenceNumber":"","ReferenceType":"MANUAL","TransactionDate":"2026-09-15","VoucherNumber":2,"VoucherSeries":"A","Year":2}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/vouchers/A/1?financialyear=2',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Voucher":{"@url":"https://api.fortnox.se/3/vouchers/A/1?financialyear=2","Comments":null,"CostCenter":"","Description":"Bank fee (synthetic)","Project":0,"ReferenceNumber":"","ReferenceType":"MANUAL","TransactionDate":"2026-09-01","VoucherNumber":1,"VoucherRows":[{"Account":6570,"CostCenter":"","Credit":0,"Debit":125.5,"Description":"Bank fees (synthetic)","Project":"","Removed":false,"TransactionInformation":"Fee (synthetic)"},{"Account":1930,"CostCenter":"","Credit":125.5,"Debit":0,"Description":"Bank account (synthetic)","Project":"","Removed":false,"TransactionInformation":""}],"VoucherSeries":"A","Year":2}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/voucherfileconnections?vouchernumber=1&financialyear=2&page=1&limit=500',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"VoucherFileConnections":[{"@url":"https://api.fortnox.se/3/voucherfileconnections/00000000-0000-4000-8000-0000000000a1","FileId":"00000000-0000-4000-8000-0000000000a1","Name":"receipt.pdf","VoucherDescription":"Bank fee (synthetic)","VoucherNumber":"1","VoucherSeries":"A","VoucherYear":2},{"@url":"https://api.fortnox.se/3/voucherfileconnections/00000000-0000-4000-8000-0000000000b1","FileId":"00000000-0000-4000-8000-0000000000b1","Name":"invoice-101.pdf","VoucherDescription":"Customer invoice (synthetic)","VoucherNumber":"1","VoucherSeries":"B","VoucherYear":2}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":2}}'
      }
    }
  ]
}
