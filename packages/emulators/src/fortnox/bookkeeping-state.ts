/**
 * Fortnox emulator bookkeeping resources (internal; part of the read-only state in
 * `src/fortnox/read-state.ts`, served by `src/fortnox/bookkeeping-api.ts`): financial years,
 * accounts per financial year, voucher series, vouchers with rows, voucher file connections, and
 * SIE files.
 *
 * Every shape is a minimal one named after the fields the connector's bookkeeping actions read
 * (`@yolk-sdk/connectors/fortnox`), and every default is synthetic. The bookkeeping read case
 * fixtures record what the routes answer for this default seed (`test/fortnox-conformance.test.ts`
 * requires the answers byte for byte), so a default here changes only together with its fixture.
 * No route writes them: voucher and voucher file connection creates are not emulated.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import * as Schema from 'effect/Schema'

const NonEmpty = Schema.String.check(Schema.isNonEmpty())

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const AccountNumber = Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9999 }))

const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))

const SeriesCode = NonEmpty.check(Schema.isPattern(/^(?!\.{1,2}$)[^/]{1,10}$/u))

export const FortnoxEmulatorFinancialYear = Schema.Struct({
  Id,
  FromDate: IsoDate,
  ToDate: IsoDate,
  AccountChartType: Schema.String,
  AccountingMethod: Schema.Literals(['ACCRUAL', 'CASH'])
})

export type FortnoxEmulatorFinancialYear = typeof FortnoxEmulatorFinancialYear.Type

/** An account of one financial year (`Year`), with its opening and closing balance there. */
export const FortnoxEmulatorAccount = Schema.Struct({
  Year: Id,
  Number: AccountNumber,
  Description: Schema.String,
  Active: Schema.Boolean,
  BalanceBroughtForward: Schema.Finite,
  BalanceCarriedForward: Schema.Finite,
  SRU: Schema.NullOr(Schema.Int),
  VATCode: Schema.NullOr(Schema.String)
})

export type FortnoxEmulatorAccount = typeof FortnoxEmulatorAccount.Type

export const FortnoxEmulatorVoucherSeries = Schema.Struct({
  Year: Id,
  Code: SeriesCode,
  Description: Schema.String,
  Manual: Schema.Boolean,
  NextVoucherNumber: Id
})

export type FortnoxEmulatorVoucherSeries = typeof FortnoxEmulatorVoucherSeries.Type

const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const FortnoxEmulatorVoucherRow = Schema.Struct({
  Account: AccountNumber,
  Debit: Amount,
  Credit: Amount,
  TransactionInformation: Schema.String
})

export type FortnoxEmulatorVoucherRow = typeof FortnoxEmulatorVoucherRow.Type

export const FortnoxEmulatorVoucher = Schema.Struct({
  Year: Id,
  VoucherSeries: SeriesCode,
  VoucherNumber: Id,
  Description: Schema.String,
  TransactionDate: IsoDate,
  ReferenceNumber: Schema.String,
  ReferenceType: Schema.String,
  CostCenter: Schema.String,
  VoucherRows: Schema.Array(FortnoxEmulatorVoucherRow).check(Schema.isMinLength(2))
})

export type FortnoxEmulatorVoucher = typeof FortnoxEmulatorVoucher.Type

export const FortnoxEmulatorVoucherFileConnection = Schema.Struct({
  FileId: NonEmpty.check(Schema.isPattern(/^[^\s/\\?#]+$/u)),
  Name: Schema.String,
  VoucherYear: Id,
  VoucherSeries: SeriesCode,
  VoucherNumber: Id
})

export type FortnoxEmulatorVoucherFileConnection = typeof FortnoxEmulatorVoucherFileConnection.Type

/** One SIE file (`Type` 1-4) of one financial year, as canonical standard base64 bytes. */
export const FortnoxEmulatorSieFile = Schema.Struct({
  Year: Id,
  Type: Schema.Literals([1, 2, 3, 4]),
  ContentBase64: Schema.String
})

export type FortnoxEmulatorSieFile = typeof FortnoxEmulatorSieFile.Type

/** The bookkeeping parts of the read-only state schema (spread into it). */
export const fortnoxBookkeepingStateFields = {
  financialYears: Schema.Array(FortnoxEmulatorFinancialYear),
  accounts: Schema.Array(FortnoxEmulatorAccount),
  voucherSeries: Schema.Array(FortnoxEmulatorVoucherSeries),
  vouchers: Schema.Array(FortnoxEmulatorVoucher),
  voucherFileConnections: Schema.Array(FortnoxEmulatorVoucherFileConnection),
  sieFiles: Schema.Array(FortnoxEmulatorSieFile)
}

const FortnoxBookkeepingEntities = Schema.Struct(fortnoxBookkeepingStateFields)

export type FortnoxBookkeepingEntities = typeof FortnoxBookkeepingEntities.Type

// Defaults (synthetic) ---------------------------------------------------------------------------

/** IBM437 bytes as base64 (ASCII plus `\x94`, IBM437 `o` with diaeresis). */
const ibm437Base64 = (parts: ReadonlyArray<string | number>) =>
  btoa(parts.map(part => (Predicate.isNumber(part) ? String.fromCharCode(part) : part)).join(''))

const sie1 = ibm437Base64([
  '#FLAGGA 0\r\n',
  '#PROGRAM "Synthetic" 1\r\n',
  '#FORMAT PC8\r\n',
  '#SIETYP 1\r\n',
  '#FNAMN "Example AB (synthetic) ',
  0x94,
  '"\r\n',
  '#RAR 0 20260101 20261231\r\n',
  '#KONTO 1930 "Bank account (synthetic)"\r\n',
  '#IB 0 1930 15000.00\r\n',
  '#UB 0 1930 27374.50\r\n'
])

const year2025 = 1

const year2026 = 2

export const defaultBookkeepingEntities: FortnoxBookkeepingEntities = {
  financialYears: [
    {
      Id: year2025,
      FromDate: '2025-01-01',
      ToDate: '2025-12-31',
      AccountChartType: 'Bas 2025',
      AccountingMethod: 'ACCRUAL'
    },
    {
      Id: year2026,
      FromDate: '2026-01-01',
      ToDate: '2026-12-31',
      AccountChartType: 'Bas 2026',
      AccountingMethod: 'ACCRUAL'
    }
  ],
  accounts: [
    ...[year2025, year2026].flatMap(Year => [
      {
        Year,
        Number: 1930,
        Description: 'Bank account (synthetic)',
        Active: true,
        BalanceBroughtForward: Year === year2026 ? 15000 : 9000,
        BalanceCarriedForward: Year === year2026 ? 27374.5 : 15000,
        SRU: 7281,
        VATCode: null
      },
      {
        Year,
        Number: 3001,
        Description: 'Sales (synthetic)',
        Active: true,
        BalanceBroughtForward: 0,
        BalanceCarriedForward: Year === year2026 ? -12500 : -6000,
        SRU: 7410,
        VATCode: 'MP1'
      },
      {
        Year,
        Number: 6570,
        Description: 'Bank fees (synthetic)',
        Active: true,
        BalanceBroughtForward: 0,
        BalanceCarriedForward: Year === year2026 ? 125.5 : 0,
        SRU: 7513,
        VATCode: null
      }
    ])
  ],
  voucherSeries: [year2025, year2026].flatMap(Year => [
    {
      Year,
      Code: 'A',
      Description: 'Accounting (synthetic)',
      Manual: true,
      NextVoucherNumber: Year === year2026 ? 3 : 1
    },
    {
      Year,
      Code: 'B',
      Description: 'Customer invoices (synthetic)',
      Manual: false,
      NextVoucherNumber: 1
    }
  ]),
  vouchers: [
    {
      Year: year2026,
      VoucherSeries: 'A',
      VoucherNumber: 1,
      Description: 'Bank fee (synthetic)',
      TransactionDate: '2026-09-01',
      ReferenceNumber: '',
      ReferenceType: 'MANUAL',
      CostCenter: '',
      VoucherRows: [
        { Account: 6570, Debit: 125.5, Credit: 0, TransactionInformation: 'Fee (synthetic)' },
        { Account: 1930, Debit: 0, Credit: 125.5, TransactionInformation: '' }
      ]
    },
    {
      Year: year2026,
      VoucherSeries: 'A',
      VoucherNumber: 2,
      Description: 'Sale (synthetic)',
      TransactionDate: '2026-09-15',
      ReferenceNumber: '',
      ReferenceType: 'MANUAL',
      CostCenter: '',
      VoucherRows: [
        { Account: 1930, Debit: 12500, Credit: 0, TransactionInformation: '' },
        { Account: 3001, Debit: 0, Credit: 12500, TransactionInformation: 'Sale (synthetic)' }
      ]
    }
  ],
  voucherFileConnections: [
    {
      FileId: '00000000-0000-4000-8000-0000000000a1',
      Name: 'receipt.pdf',
      VoucherYear: year2026,
      VoucherSeries: 'A',
      VoucherNumber: 1
    }
  ],
  sieFiles: [{ Year: year2026, Type: 1, ContentBase64: sie1 }]
}

/** The `empty-company` bookkeeping: its years, chart, and series stay; no vouchers or files. */
export const emptyCompanyBookkeepingEntities: FortnoxBookkeepingEntities = {
  ...defaultBookkeepingEntities,
  vouchers: [],
  voucherFileConnections: []
}

// Integrity --------------------------------------------------------------------------------------

const firstRepeated = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

const canonicalBase64 = (value: string): boolean =>
  value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && btoa(atob(value)) === value

const toOre = (value: number) => Math.round(value * 100)

/** Integrity problems of the bookkeeping parts (duplicates, dangling references), or `undefined`. */
export const bookkeepingProblem = (entities: FortnoxBookkeepingEntities): string | undefined => {
  const years = entities.financialYears.map(year => year.Id)

  const yearOf = (owner: string, year: number) =>
    years.includes(year) ? undefined : `${owner} references missing financial year ${year}`

  const accountKeys = entities.accounts.map(account => `${account.Year}/${account.Number}`)
  const seriesKeys = entities.voucherSeries.map(series => `${series.Year}/${series.Code}`)

  const voucherKey = (year: number, series: string, number: number) => `${year}/${series}/${number}`

  const voucherKeys = entities.vouchers.map(voucher =>
    voucherKey(voucher.Year, voucher.VoucherSeries, voucher.VoucherNumber)
  )

  const repeated = (label: string, values: ReadonlyArray<string>) => {
    const value = firstRepeated(values)

    return value === undefined ? undefined : `duplicate ${label} ${value}`
  }

  const problems: ReadonlyArray<string | undefined> = [
    repeated(
      'financial year Id',
      years.map(year => String(year))
    ),
    repeated('account', accountKeys),
    repeated('voucher series', seriesKeys),
    repeated('voucher', voucherKeys),
    repeated(
      'voucher file connection FileId',
      entities.voucherFileConnections.map(connection => connection.FileId)
    ),
    repeated(
      'SIE file',
      entities.sieFiles.map(file => `${file.Year}/${file.Type}`)
    ),
    ...entities.accounts.map(account => yearOf(`account ${account.Number}`, account.Year)),
    ...entities.voucherSeries.map(series => yearOf(`voucher series ${series.Code}`, series.Year)),
    ...entities.vouchers.flatMap(voucher => {
      const owner = `voucher ${voucherKey(voucher.Year, voucher.VoucherSeries, voucher.VoucherNumber)}`
      const debit = voucher.VoucherRows.reduce((total, row) => total + toOre(row.Debit), 0)
      const credit = voucher.VoucherRows.reduce((total, row) => total + toOre(row.Credit), 0)

      return [
        seriesKeys.includes(`${voucher.Year}/${voucher.VoucherSeries}`)
          ? undefined
          : `${owner} references missing voucher series ${voucher.VoucherSeries}`,
        debit === credit ? undefined : `${owner} does not balance`,
        ...voucher.VoucherRows.map(row =>
          accountKeys.includes(`${voucher.Year}/${row.Account}`)
            ? undefined
            : `${owner} references missing account ${row.Account}`
        )
      ]
    }),
    ...entities.voucherFileConnections.map(connection =>
      voucherKeys.includes(
        voucherKey(connection.VoucherYear, connection.VoucherSeries, connection.VoucherNumber)
      )
        ? undefined
        : `voucher file connection ${connection.FileId} references a missing voucher`
    ),
    ...entities.sieFiles.flatMap(file => [
      yearOf(`SIE file ${file.Type}`, file.Year),
      canonicalBase64(file.ContentBase64)
        ? undefined
        : `SIE file ${file.Year}/${file.Type} ContentBase64 is not canonical standard base64`
    ])
  ]

  return problems.find(problem => problem !== undefined)
}

/** The bookkeeping parts in the order the routes list them. */
export const sortBookkeeping = (
  entities: FortnoxBookkeepingEntities
): FortnoxBookkeepingEntities => ({
  // The archived financial year list example lists the newest year first.
  financialYears: [...entities.financialYears].sort((left, right) => right.Id - left.Id),
  accounts: [...entities.accounts].sort(
    (left, right) => left.Year - right.Year || left.Number - right.Number
  ),
  voucherSeries: [...entities.voucherSeries].sort(
    (left, right) => left.Year - right.Year || left.Code.localeCompare(right.Code)
  ),
  vouchers: [...entities.vouchers].sort(
    (left, right) =>
      left.Year - right.Year ||
      left.VoucherSeries.localeCompare(right.VoucherSeries) ||
      left.VoucherNumber - right.VoucherNumber
  ),
  voucherFileConnections: entities.voucherFileConnections,
  sieFiles: entities.sieFiles
})
