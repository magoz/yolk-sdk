/**
 * Fortnox emulator bookkeeping routes (internal; part of the route table in `src/fortnox/api.ts`):
 * every `GET` the connector's financial year, account, voucher series, voucher, voucher file
 * connection, and SIE file actions send. No route here writes; voucher and voucher file connection
 * creates (`POST /3/vouchers`, `POST /3/voucherfileconnections`) and the archive upload are not
 * emulated and fail closed with the wrapper's 404 `ErrorInformation`.
 *
 * Each route cites the bookkeeping read cases whose synthetic fixtures are the source of its wire
 * shape: bodies shaped from the Fortnox OpenAPI spec (`fortnox_Bf_*`,
 * `fortnox_Da_VoucherFileConnection*`) and the archived resource pages' JSON examples, rendered by
 * the default seed and checked against them. They keep the archived examples' forms the OpenAPI
 * types do not list (financial year list rows name the chart type `accountCharts`; single account
 * and voucher reads send `Project` as the number `0`; voucher file connections send
 * `VoucherNumber` as a string). `financialyear` selects the year by `Id`; omitted, the year
 * containing the emulator's today, as Fortnox uses the current financial year. Every route is
 * `unverified`.
 *
 * @experimental
 */
import type { FortnoxEmulatorAccount, FortnoxEmulatorVoucher } from './bookkeeping-state.ts'
import {
  base64Bytes,
  connectorRoute,
  dateRange,
  invalidField,
  isIsoDate,
  jsonResponse,
  paginate,
  resourceNotFound,
  resourceUrl,
  today,
  type FortnoxApiEnv,
  type FortnoxApiRoute,
  type RouteHandler
} from './route-kit.ts'
import type { FortnoxEmulatorState } from './state.ts'

// The read conformance cases each route follows (`@yolk-sdk/connectors/fortnox/conformance`).
const financialYearCase = 'fortnox.bookkeeping.financial-year-by-id-and-date'

const accountCase = 'fortnox.bookkeeping.account-balances-list-get'

const voucherCase = 'fortnox.bookkeeping.voucher-list-get-balanced'

const sieCase = 'fortnox.bookkeeping.sie-file-ibm437'

const pageKeys: ReadonlyArray<string> = ['page', 'limit']

const param = (params: Readonly<Record<string, string>>, name: string): string => params[name] ?? ''

/** `@url` of a per-year resource: its path plus `?financialyear={Id}`, as the archived examples. */
const yearUrl = (env: FortnoxApiEnv, year: number, ...segments: ReadonlyArray<string>) =>
  `${resourceUrl(env, ...segments)}?financialyear=${year}`

/** The `financialyear` query Id, or the year containing today; a 400 when there is none. */
const selectedYear = (
  state: FortnoxEmulatorState,
  query: URLSearchParams,
  env: FortnoxApiEnv
): number | Response => {
  const raw = query.get('financialyear')

  if (raw === null) {
    const date = today(env)
    const current = state.financialYears.find(year => year.FromDate <= date && date <= year.ToDate)

    return current === undefined
      ? invalidField('no financial year contains today; pass financialyear.')
      : current.Id
  }

  const id = Number(raw)

  return /^\d+$/.test(raw) && state.financialYears.some(year => year.Id === id)
    ? id
    : invalidField(`unknown financial year ${raw}.`)
}

const paged = <A>(
  envelope: string,
  items: ReadonlyArray<A>,
  query: URLSearchParams,
  render: (item: A) => unknown
): Response => {
  const page = paginate(items, query)

  if (page instanceof Response) return page

  return jsonResponse(200, { [envelope]: page.items.map(render), MetaInformation: page.meta })
}

// Financial years --------------------------------------------------------------------------------

const listFinancialYears: RouteHandler = (state, { query }, env) => {
  const date = query.get('date')

  if (date !== null && !isIsoDate(date)) {
    return invalidField('query parameter date must be a YYYY-MM-DD date.')
  }

  return paged(
    'FinancialYears',
    state.financialYears.filter(
      year => date === null || (year.FromDate <= date && date <= year.ToDate)
    ),
    query,
    year => ({
      '@url': resourceUrl(env, 'financialyears', String(year.Id)),
      Id: year.Id,
      FromDate: year.FromDate,
      ToDate: year.ToDate,
      // The archived list example names the chart type `accountCharts`.
      accountCharts: year.AccountChartType,
      AccountingMethod: year.AccountingMethod
    })
  )
}

const getFinancialYear: RouteHandler = (state, { params }, env) => {
  const year = state.financialYears.find(item => String(item.Id) === param(params, 'Id'))

  return year === undefined
    ? resourceNotFound('financial year')
    : jsonResponse(200, {
        FinancialYear: { '@url': resourceUrl(env, 'financialyears', String(year.Id)), ...year }
      })
}

// Accounts ---------------------------------------------------------------------------------------

const accountRow = (env: FortnoxApiEnv, account: FortnoxEmulatorAccount) => ({
  '@url': yearUrl(env, account.Year, 'accounts', String(account.Number)),
  Active: account.Active,
  BalanceBroughtForward: account.BalanceBroughtForward,
  BalanceCarriedForward: account.BalanceCarriedForward,
  CostCenter: '',
  CostCenterSettings: 'ALLOWED',
  Description: account.Description,
  Number: account.Number,
  Project: '',
  ProjectSettings: 'ALLOWED',
  SRU: account.SRU,
  VATCode: account.VATCode,
  Year: account.Year
})

const listAccounts: RouteHandler = (state, { query }, env) => {
  const year = selectedYear(state, query, env)

  if (year instanceof Response) return year

  return paged(
    'Accounts',
    state.accounts.filter(account => account.Year === year),
    query,
    account => accountRow(env, account)
  )
}

const getAccount: RouteHandler = (state, { params, query }, env) => {
  const year = selectedYear(state, query, env)

  if (year instanceof Response) return year

  const account = state.accounts.find(
    item => item.Year === year && String(item.Number) === param(params, 'Number')
  )

  // The archived single-account example sends `Project` as the number 0.
  return account === undefined
    ? resourceNotFound('account')
    : jsonResponse(200, { Account: { ...accountRow(env, account), Project: 0 } })
}

// Voucher series ---------------------------------------------------------------------------------

const listVoucherSeries: RouteHandler = (state, { query }, env) => {
  const year = selectedYear(state, query, env)

  if (year instanceof Response) return year

  return paged(
    'VoucherSeriesCollection',
    state.voucherSeries.filter(series => series.Year === year),
    query,
    series => ({
      '@url': yearUrl(env, series.Year, 'voucherseries', series.Code),
      Code: series.Code,
      Description: series.Description,
      Manual: series.Manual,
      NextVoucherNumber: series.NextVoucherNumber,
      Year: series.Year
    })
  )
}

// Vouchers ---------------------------------------------------------------------------------------

const voucherUrl = (env: FortnoxApiEnv, voucher: FortnoxEmulatorVoucher) =>
  yearUrl(env, voucher.Year, 'vouchers', voucher.VoucherSeries, String(voucher.VoucherNumber))

const voucherListQueryKeys: ReadonlyArray<string> = [
  ...pageKeys,
  'financialyear',
  'fromdate',
  'todate',
  'costcenter'
]

const listVouchersIn =
  (series: (params: Readonly<Record<string, string>>) => string | undefined): RouteHandler =>
  (state, { params, query }, env) => {
    const year = selectedYear(state, query, env)

    if (year instanceof Response) return year

    const range = dateRange(query)

    if (range instanceof Response) return range

    const code = series(params)
    const costCenter = query.get('costcenter')

    return paged(
      'Vouchers',
      state.vouchers.filter(
        voucher =>
          voucher.Year === year &&
          (code === undefined || voucher.VoucherSeries === code) &&
          (costCenter === null || voucher.CostCenter === costCenter) &&
          (range.from === null || voucher.TransactionDate >= range.from) &&
          (range.to === null || voucher.TransactionDate <= range.to)
      ),
      query,
      voucher => ({
        '@url': voucherUrl(env, voucher),
        Description: voucher.Description,
        ReferenceNumber: voucher.ReferenceNumber,
        ReferenceType: voucher.ReferenceType,
        TransactionDate: voucher.TransactionDate,
        VoucherNumber: voucher.VoucherNumber,
        VoucherSeries: voucher.VoucherSeries,
        Year: voucher.Year
      })
    )
  }

const accountName = (state: FortnoxEmulatorState, year: number, number: number): string =>
  state.accounts.find(account => account.Year === year && account.Number === number)?.Description ??
  ''

const getVoucher: RouteHandler = (state, { params, query }, env) => {
  const year = selectedYear(state, query, env)

  if (year instanceof Response) return year

  const voucher = state.vouchers.find(
    item =>
      item.Year === year &&
      item.VoucherSeries === param(params, 'VoucherSeries') &&
      String(item.VoucherNumber) === param(params, 'VoucherNumber')
  )

  // The archived single-voucher example: `Comments` null, `Project` the number 0, rows carrying
  // the account name as `Description`.
  return voucher === undefined
    ? resourceNotFound('voucher')
    : jsonResponse(200, {
        Voucher: {
          '@url': voucherUrl(env, voucher),
          Comments: null,
          CostCenter: voucher.CostCenter,
          Description: voucher.Description,
          Project: 0,
          ReferenceNumber: voucher.ReferenceNumber,
          ReferenceType: voucher.ReferenceType,
          TransactionDate: voucher.TransactionDate,
          VoucherNumber: voucher.VoucherNumber,
          VoucherRows: voucher.VoucherRows.map(row => ({
            Account: row.Account,
            CostCenter: '',
            Credit: row.Credit,
            Debit: row.Debit,
            Description: accountName(state, voucher.Year, row.Account),
            Project: '',
            Removed: false,
            TransactionInformation: row.TransactionInformation
          })),
          VoucherSeries: voucher.VoucherSeries,
          Year: voucher.Year
        }
      })
}

// Voucher file connections -----------------------------------------------------------------------

const listVoucherFileConnections: RouteHandler = (state, { query }, env) => {
  const series = query.get('voucherseries')
  const number = query.get('vouchernumber')
  const voucherYear = query.get('voucheryear')
  const raw = query.get('financialyear')
  const financialYear = raw === null ? null : selectedYear(state, query, env)

  if (financialYear instanceof Response) return financialYear

  return paged(
    'VoucherFileConnections',
    state.voucherFileConnections.filter(
      connection =>
        (series === null || connection.VoucherSeries === series) &&
        (number === null || String(connection.VoucherNumber) === number) &&
        (voucherYear === null || String(connection.VoucherYear) === voucherYear) &&
        (financialYear === null || connection.VoucherYear === financialYear)
    ),
    query,
    connection => ({
      '@url': resourceUrl(env, 'voucherfileconnections', connection.FileId),
      FileId: connection.FileId,
      Name: connection.Name,
      VoucherDescription:
        state.vouchers.find(
          voucher =>
            voucher.Year === connection.VoucherYear &&
            voucher.VoucherSeries === connection.VoucherSeries &&
            voucher.VoucherNumber === connection.VoucherNumber
        )?.Description ?? '',
      // The archived examples send VoucherNumber as a string.
      VoucherNumber: String(connection.VoucherNumber),
      VoucherSeries: connection.VoucherSeries,
      VoucherYear: connection.VoucherYear
    })
  )
}

// SIE files --------------------------------------------------------------------------------------

const getSieFile: RouteHandler = (state, { params, query }, env) => {
  const type = param(params, 'Type')

  if (!/^[1-4]$/.test(type)) return invalidField('SIE type must be 1, 2, 3, or 4.')

  const year = selectedYear(state, query, env)

  if (year instanceof Response) return year

  const file = state.sieFiles.find(item => item.Year === year && String(item.Type) === type)

  return file === undefined
    ? resourceNotFound('SIE file')
    : new Response(base64Bytes(file.ContentBase64), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
}

// Route table ------------------------------------------------------------------------------------

/**
 * The bookkeeping routes, in manifest order. `GET /vouchers/sublist/{VoucherSeries}` comes before
 * `GET /vouchers/{VoucherSeries}/{VoucherNumber}`, which also matches a sublist path: the route
 * matcher takes the first matching route.
 */
export const fortnoxBookkeepingRoutes: ReadonlyArray<FortnoxApiRoute> = [
  connectorRoute('GET', '/financialyears', false, [financialYearCase], listFinancialYears, [
    ...pageKeys,
    'date'
  ]),
  connectorRoute('GET', '/financialyears/{Id}', false, [financialYearCase], getFinancialYear),
  connectorRoute('GET', '/accounts', false, [accountCase], listAccounts, [
    ...pageKeys,
    'financialyear'
  ]),
  connectorRoute('GET', '/accounts/{Number}', false, [accountCase], getAccount, ['financialyear']),
  connectorRoute('GET', '/voucherseries', false, [voucherCase], listVoucherSeries, [
    ...pageKeys,
    'financialyear'
  ]),
  connectorRoute(
    'GET',
    '/vouchers',
    false,
    [voucherCase],
    listVouchersIn(() => undefined),
    voucherListQueryKeys
  ),
  connectorRoute(
    'GET',
    '/vouchers/sublist/{VoucherSeries}',
    false,
    [voucherCase],
    listVouchersIn(params => param(params, 'VoucherSeries')),
    voucherListQueryKeys
  ),
  connectorRoute(
    'GET',
    '/vouchers/{VoucherSeries}/{VoucherNumber}',
    false,
    [voucherCase],
    getVoucher,
    ['financialyear']
  ),
  connectorRoute(
    'GET',
    '/voucherfileconnections',
    false,
    [voucherCase],
    listVoucherFileConnections,
    [...pageKeys, 'financialyear', 'voucherseries', 'vouchernumber', 'voucheryear']
  ),
  connectorRoute('GET', '/sie/{Type}', false, [sieCase], getSieFile, ['financialyear'])
]
