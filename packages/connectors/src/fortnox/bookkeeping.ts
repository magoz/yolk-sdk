// Fortnox `bookkeeping` scope: financial years, accounts, voucher series, and vouchers. Sources:
// the Fortnox OpenAPI (https://api.fortnox.se/apidocs; schemas `fortnox_Bf_*`), the archived
// resource pages (developer.fortnox.se/documentation/resources/{financial-years,accounts,
// voucher-series,vouchers}), the parameters guide
// (https://www.fortnox.se/developer/guides-and-good-to-know/parameters: `financialyear` selects the
// financial year by Id), and the scopes guide (every resource here needs `bookkeeping`).
//
// The archived JSON examples do not match the OpenAPI types everywhere: voucher and account
// `Project` is `0` (a number) where OpenAPI types a string, financial year lists send
// `accountCharts` instead of `AccountChartType`, and `Comments`/`VATCode` are null. Responses
// therefore decode through wire schemas that accept each documented form; public types stay as
// below.
import { Chunk, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import { ActionResult } from '../result.ts'
import {
  AccountNumber,
  CalendarDate,
  closedInput,
  Identifier,
  NonEmptyString,
  NullableBoolean,
  NullableInt,
  NullableNumber,
  NullableString,
  PaginationFields
} from './fields.ts'
import { FortnoxBookkeepingOAuthCredentialSlot } from './oauth.ts'
import { FortnoxPagination } from './schemas.ts'
import {
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'
import {
  WireInt,
  WireNullableBoolean,
  WireNullableInt,
  WireNullableNumber,
  WireNullableReference
} from './wire.ts'

/** Id of a Fortnox financial year (`Year` on accounts and vouchers, `financialyear` query). */
export const FortnoxFinancialYearId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })
).pipe(Schema.brand('FortnoxFinancialYearId'))

export type FortnoxFinancialYearId = typeof FortnoxFinancialYearId.Type

/** Code of a voucher series (OpenAPI: 1-10 characters), e.g. `A`. */
export const FortnoxVoucherSeriesCode = Identifier.check(Schema.isMaxLength(10)).pipe(
  Schema.brand('FortnoxVoucherSeriesCode')
)

export type FortnoxVoucherSeriesCode = typeof FortnoxVoucherSeriesCode.Type

/** Number of a voucher within its series and financial year. */
export const FortnoxVoucherNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })
).pipe(Schema.brand('FortnoxVoucherNumber'))

export type FortnoxVoucherNumber = typeof FortnoxVoucherNumber.Type

// Financial years ------------------------------------------------------------------------------

export class FortnoxFinancialYear extends Schema.Class<FortnoxFinancialYear>(
  'FortnoxFinancialYear'
)({
  Id: FortnoxFinancialYearId,
  FromDate: Schema.String,
  ToDate: Schema.String,
  AccountChartType: NullableString,
  /** `ACCRUAL` or `CASH`. */
  AccountingMethod: NullableString
}) {}

export class FortnoxListFinancialYearsInput extends Schema.Class<FortnoxListFinancialYearsInput>(
  'FortnoxListFinancialYearsInput'
)({
  /** Only the financial year containing this date (`YYYY-MM-DD`). */
  date: Schema.optional(CalendarDate),
  page: PaginationFields.page,
  limit: PaginationFields.limit
}) {}

export class FortnoxListFinancialYearsOutput extends Schema.Class<FortnoxListFinancialYearsOutput>(
  'FortnoxListFinancialYearsOutput'
)({
  financialYears: Schema.Chunk(FortnoxFinancialYear),
  pagination: FortnoxPagination
}) {}

/** Exactly one of `id` or `date`. */
export const FortnoxGetFinancialYearInput = Schema.Struct({
  id: Schema.optional(FortnoxFinancialYearId),
  date: Schema.optional(CalendarDate)
}).check(
  Schema.makeFilter(input =>
    (input.id === undefined) === (input.date === undefined)
      ? 'Expected exactly one of id or date'
      : true
  )
)

export type FortnoxGetFinancialYearInput = typeof FortnoxGetFinancialYearInput.Type

const FinancialYearApi = Schema.Struct({
  Id: WireInt.pipe(Schema.decodeTo(FortnoxFinancialYearId)),
  FromDate: Schema.String,
  ToDate: Schema.String,
  AccountChartType: NullableString,
  // The archived list example names the chart type `accountCharts`.
  accountCharts: NullableString,
  AccountingMethod: NullableString
})

const financialYearFromApi = ({ accountCharts, ...year }: typeof FinancialYearApi.Type) =>
  FortnoxFinancialYear.make({
    ...year,
    AccountChartType: year.AccountChartType ?? accountCharts
  })

const FinancialYearsResponse = Schema.Struct({
  FinancialYears: Schema.Array(FinancialYearApi),
  MetaInformation: FortnoxMetaInformation
})

const FinancialYearResponse = Schema.Struct({ FinancialYear: FinancialYearApi })

// Accounts -------------------------------------------------------------------------------------

// Bounded read model. Omitted: OpeningQuantities, QuantitySettings, QuantityUnit, and
// TransactionInformationSettings (OpenAPI types the two settings as integers in lists and as
// ALLOWED/MANDATORY/NOTALLOWED in single reads).
export class FortnoxAccount extends Schema.Class<FortnoxAccount>('FortnoxAccount')({
  Number: AccountNumber,
  Description: NullableString,
  Active: NullableBoolean,
  /** Opening balance (ingående balans) of the account in the financial year. */
  BalanceBroughtForward: NullableNumber,
  /** Closing balance (utgående balans) of the account in the financial year; read-only. */
  BalanceCarriedForward: NullableNumber,
  CostCenter: NullableString,
  CostCenterSettings: NullableString,
  Project: NullableString,
  ProjectSettings: NullableString,
  SRU: NullableInt,
  TransactionInformation: NullableString,
  VATCode: NullableString,
  /** Id of the financial year the balances belong to. */
  Year: NullableInt
}) {}

const AccountApi = Schema.Struct({
  ...FortnoxAccount.fields,
  Number: WireInt.pipe(Schema.decodeTo(AccountNumber)),
  Active: WireNullableBoolean,
  BalanceBroughtForward: WireNullableNumber,
  BalanceCarriedForward: WireNullableNumber,
  CostCenter: WireNullableReference,
  Project: WireNullableReference,
  SRU: WireNullableInt,
  VATCode: WireNullableReference,
  Year: WireNullableInt
})

const accountFromApi = (value: typeof AccountApi.Type) => FortnoxAccount.make(value)

export class FortnoxListAccountsInput extends Schema.Class<FortnoxListAccountsInput>(
  'FortnoxListAccountsInput'
)({
  /** Financial year whose balances to read; omitted, Fortnox uses the current financial year. */
  financialYearId: Schema.optional(FortnoxFinancialYearId),
  ...PaginationFields
}) {}

export class FortnoxListAccountsOutput extends Schema.Class<FortnoxListAccountsOutput>(
  'FortnoxListAccountsOutput'
)({
  accounts: Schema.Chunk(FortnoxAccount),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetAccountInput extends Schema.Class<FortnoxGetAccountInput>(
  'FortnoxGetAccountInput'
)({
  accountNumber: AccountNumber,
  financialYearId: Schema.optional(FortnoxFinancialYearId)
}) {}

const AccountsResponse = Schema.Struct({
  Accounts: Schema.Array(AccountApi),
  MetaInformation: FortnoxMetaInformation
})

const AccountResponse = Schema.Struct({ Account: AccountApi })

// Voucher series -------------------------------------------------------------------------------

// Bounded read model. Omitted: Approver.
export class FortnoxVoucherSeries extends Schema.Class<FortnoxVoucherSeries>(
  'FortnoxVoucherSeries'
)({
  Code: FortnoxVoucherSeriesCode,
  Description: NullableString,
  /** Whether vouchers are registered manually in this series. */
  Manual: NullableBoolean,
  NextVoucherNumber: NullableInt,
  Year: NullableInt
}) {}

const VoucherSeriesApi = Schema.Struct({
  ...FortnoxVoucherSeries.fields,
  Manual: WireNullableBoolean,
  NextVoucherNumber: WireNullableInt,
  Year: WireNullableInt
})

export class FortnoxListVoucherSeriesInput extends Schema.Class<FortnoxListVoucherSeriesInput>(
  'FortnoxListVoucherSeriesInput'
)({
  financialYearId: Schema.optional(FortnoxFinancialYearId),
  ...PaginationFields
}) {}

export class FortnoxListVoucherSeriesOutput extends Schema.Class<FortnoxListVoucherSeriesOutput>(
  'FortnoxListVoucherSeriesOutput'
)({
  voucherSeries: Schema.Chunk(FortnoxVoucherSeries),
  pagination: FortnoxPagination
}) {}

const VoucherSeriesListResponse = Schema.Struct({
  VoucherSeriesCollection: Schema.Array(VoucherSeriesApi),
  MetaInformation: FortnoxMetaInformation
})

// Vouchers -------------------------------------------------------------------------------------

export class FortnoxVoucherRow extends Schema.Class<FortnoxVoucherRow>('FortnoxVoucherRow')({
  Account: AccountNumber,
  Debit: NullableNumber,
  Credit: NullableNumber,
  /** The account's name, set by Fortnox (read-only). */
  Description: NullableString,
  /** The row text. */
  TransactionInformation: NullableString,
  CostCenter: NullableString,
  Project: NullableString,
  Quantity: NullableNumber,
  /** Whether the row is marked as removed (struck through) in Fortnox. */
  Removed: NullableBoolean
}) {}

// A voucher is unique by VoucherSeries, VoucherNumber, and Year (the financial year Id); Fortnox
// returns all three wherever vouchers are used.
export class FortnoxVoucher extends Schema.Class<FortnoxVoucher>('FortnoxVoucher')({
  VoucherSeries: FortnoxVoucherSeriesCode,
  VoucherNumber: FortnoxVoucherNumber,
  Year: FortnoxFinancialYearId,
  Description: NullableString,
  Comments: NullableString,
  TransactionDate: NullableString,
  CostCenter: NullableString,
  Project: NullableString,
  ReferenceNumber: NullableString,
  /** INVOICE, SUPPLIERINVOICE, INVOICEPAYMENT, SUPPLIERPAYMENT, MANUAL, CASHINVOICE, ACCRUAL. */
  ReferenceType: NullableString,
  /** 0 not for approval, 1 not ready for approval, 2 not approved, 3 approved. */
  ApprovalState: NullableInt,
  /** Present on single reads; list rows usually leave them out. */
  VoucherRows: Schema.optional(Schema.Chunk(FortnoxVoucherRow))
}) {}

const VoucherRowApi = Schema.Struct({
  ...FortnoxVoucherRow.fields,
  Account: WireInt.pipe(Schema.decodeTo(AccountNumber)),
  Debit: WireNullableNumber,
  Credit: WireNullableNumber,
  CostCenter: WireNullableReference,
  Project: WireNullableReference,
  Quantity: WireNullableNumber,
  Removed: WireNullableBoolean
})

const VoucherApi = Schema.Struct({
  ...FortnoxVoucher.fields,
  VoucherNumber: WireInt.pipe(Schema.decodeTo(FortnoxVoucherNumber)),
  Year: WireInt.pipe(Schema.decodeTo(FortnoxFinancialYearId)),
  CostCenter: WireNullableReference,
  Project: WireNullableReference,
  ReferenceNumber: WireNullableReference,
  ApprovalState: WireNullableInt,
  VoucherRows: Schema.optional(Schema.Array(VoucherRowApi))
})

const voucherFromApi = (value: typeof VoucherApi.Type) => {
  const { VoucherRows, ...fields } = value

  return FortnoxVoucher.make(
    VoucherRows === undefined
      ? fields
      : {
          ...fields,
          VoucherRows: Chunk.fromIterable(VoucherRows.map(row => FortnoxVoucherRow.make(row)))
        }
  )
}

export class FortnoxListVouchersInput extends Schema.Class<FortnoxListVouchersInput>(
  'FortnoxListVouchersInput'
)({
  /** Omitted, Fortnox uses the current financial year. */
  financialYearId: Schema.optional(FortnoxFinancialYearId),
  /** Only vouchers of this series. */
  voucherSeries: Schema.optional(FortnoxVoucherSeriesCode),
  /** Only vouchers with a TransactionDate on or after this date (`YYYY-MM-DD`). */
  fromDate: Schema.optional(CalendarDate),
  /** Only vouchers with a TransactionDate on or before this date (`YYYY-MM-DD`). */
  toDate: Schema.optional(CalendarDate),
  /** Fortnox's cost center search (a substring match, so codes containing it may match too). */
  costCenter: Schema.optional(NonEmptyString),
  ...PaginationFields
}) {}

export class FortnoxListVouchersOutput extends Schema.Class<FortnoxListVouchersOutput>(
  'FortnoxListVouchersOutput'
)({
  vouchers: Schema.Chunk(FortnoxVoucher),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetVoucherInput extends Schema.Class<FortnoxGetVoucherInput>(
  'FortnoxGetVoucherInput'
)({
  voucherSeries: FortnoxVoucherSeriesCode,
  voucherNumber: FortnoxVoucherNumber,
  financialYearId: FortnoxFinancialYearId
}) {}

const VouchersResponse = Schema.Struct({
  Vouchers: Schema.Array(VoucherApi),
  MetaInformation: FortnoxMetaInformation
})

const VoucherResponse = Schema.Struct({ Voucher: VoucherApi })

// Voucher amounts: archived docs say "float, 14 digits (incl. decimals)". The connector accepts
// whole öre below 10^12: an amount is exactly the double nearest to some two-decimal number, so
// `Math.round(value * 100)` recovers its öre exactly and the balance check below is exact.
const maxVoucherAmount = 1_000_000_000_000

const hasAtMostTwoDecimals = (value: number) => Math.round(value * 100) / 100 === value

const VoucherAmount = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(maxVoucherAmount),
  Schema.makeFilter(value =>
    hasAtMostTwoDecimals(value) ? true : 'Expected an amount with at most two decimals'
  )
)

const VoucherRowInputFields = {
  /** An existing, active four-digit account. */
  Account: AccountNumber,
  Debit: Schema.optional(VoucherAmount),
  Credit: Schema.optional(VoucherAmount),
  TransactionInformation: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
  CostCenter: Schema.optional(NonEmptyString),
  Project: Schema.optional(NonEmptyString)
}

const isPositive = (value: number | undefined) => value !== undefined && value > 0

/** A voucher row to create: exactly one of Debit or Credit is positive. */
export const FortnoxVoucherRowInput = Schema.Struct(VoucherRowInputFields).check(
  Schema.makeFilter(row =>
    isPositive(row.Debit) === isPositive(row.Credit)
      ? 'Expected exactly one of Debit or Credit to be positive'
      : true
  )
)

export type FortnoxVoucherRowInput = typeof FortnoxVoucherRowInput.Type

// Each amount is below 10^14 öre, but a sum of many rows can pass 2^53, so totals are BigInts.
const toOre = (value: number | undefined) => BigInt(Math.round((value ?? 0) * 100))

// BigInt(...) rather than literals: the docs app type-checks this source with an older target.
const zero = BigInt(0)

const hundred = BigInt(100)

const rowTotals = (rows: ReadonlyArray<FortnoxVoucherRowInput>) =>
  rows.reduce(
    (totals, row) => ({
      debit: totals.debit + toOre(row.Debit),
      credit: totals.credit + toOre(row.Credit)
    }),
    { debit: zero, credit: zero }
  )

// Totals are sums of nonnegative amounts.
const kronor = (ore: bigint) => `${ore / hundred}.${String(ore % hundred).padStart(2, '0')}`

const FortnoxCreateVoucherFields = {
  /** Financial year to book in (the `financialyear` query); TransactionDate must fall inside it. */
  financialYearId: FortnoxFinancialYearId,
  VoucherSeries: FortnoxVoucherSeriesCode,
  TransactionDate: CalendarDate,
  Description: NonEmptyString.check(Schema.isMaxLength(200)),
  Comments: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  CostCenter: Schema.optional(NonEmptyString),
  Project: Schema.optional(NonEmptyString),
  VoucherRows: Schema.Array(FortnoxVoucherRowInput).check(Schema.isMinLength(2))
}

/**
 * Create-voucher input: unknown keys fail (at every depth), and total Debit must equal total
 * Credit (compared in whole öre) before any request.
 */
export const FortnoxCreateVoucherInput = closedInput(FortnoxCreateVoucherFields).check(
  Schema.makeFilter(input => {
    const totals = rowTotals(input.VoucherRows)

    return totals.debit === totals.credit
      ? true
      : `Expected total Debit (${kronor(totals.debit)}) to equal total Credit (${kronor(totals.credit)})`
  })
)

export type FortnoxCreateVoucherInput = typeof FortnoxCreateVoucherInput.Type

const financialYearQuery = (financialYearId: number | undefined) =>
  financialYearId === undefined ? undefined : String(financialYearId)

// Actions --------------------------------------------------------------------------------------

export const fortnoxListFinancialYearsAction = defineAction({
  id: 'fortnox.list_financial_years',
  description:
    'List one page of Fortnox financial years (räkenskapsår): Id, FromDate, ToDate, AccountingMethod. The Id is the financialYearId other bookkeeping actions take. Optional date returns only the year containing that date. Repeat date/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListFinancialYearsInput,
  outputSchema: FortnoxListFinancialYearsOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      listPath('financialyears', { page: input.page, limit: input.limit }, { date: input.date }),
      FinancialYearsResponse,
      value =>
        FortnoxListFinancialYearsOutput.make({
          financialYears: Chunk.fromIterable(value.FinancialYears.map(financialYearFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetFinancialYearAction = defineAction({
  id: 'fortnox.get_financial_year',
  description:
    'Read one Fortnox financial year by its id, or the financial year containing a date (YYYY-MM-DD). Pass exactly one of id or date. A date outside every financial year fails with fortnox_not_found.',
  access: 'read',
  inputSchema: FortnoxGetFinancialYearInput,
  outputSchema: FortnoxFinancialYear,
  execute: ({ integration, input }) => {
    if (input.date === undefined) {
      return readFortnox(
        integration,
        FortnoxBookkeepingOAuthCredentialSlot,
        `financialyears/${encodeURIComponent(String(input.id))}`,
        FinancialYearResponse,
        value => financialYearFromApi(value.FinancialYear)
      )
    }

    const date = input.date

    return readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      listPath('financialyears', {}, { date }),
      FinancialYearsResponse,
      value => value.FinancialYears
    ).pipe(
      Effect.flatMap(result => {
        if (Predicate.isTagged(result, 'Failure')) return Effect.succeed(result)

        const [first, ...rest] = result.value

        if (first === undefined) {
          return Effect.succeed(
            ActionResult.failure({
              code: 'fortnox_not_found',
              message: `No Fortnox financial year contains ${date}`
            })
          )
        }

        if (rest.length > 0) {
          return Effect.fail(
            new ConnectorError({
              cause: 'validation_failed',
              message: `Fortnox returned ${rest.length + 1} financial years containing one date`,
              connectorId: integration.connectorId,
              actionId: 'fortnox.get_financial_year'
            })
          )
        }

        return Effect.succeed(ActionResult.success(financialYearFromApi(first)))
      })
    )
  }
})

export const fortnoxListAccountsAction = defineAction({
  id: 'fortnox.list_accounts',
  description:
    'List one page of the Fortnox chart of accounts (kontoplan) for a financial year, sorted by account number, with each account’s opening balance (BalanceBroughtForward) and closing balance (BalanceCarriedForward) in that year. Omit financialYearId for the current financial year. Fortnox exposes no per-period balances here; export SIE type 2 or higher (fortnox.get_sie_file) for monthly balances. Repeat financialYearId/lastModified/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListAccountsInput,
  outputSchema: FortnoxListAccountsOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      listPath('accounts', input, { financialyear: financialYearQuery(input.financialYearId) }),
      AccountsResponse,
      value =>
        FortnoxListAccountsOutput.make({
          accounts: Chunk.fromIterable(value.Accounts.map(accountFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetAccountAction = defineAction({
  id: 'fortnox.get_account',
  description:
    'Read one Fortnox account by its four-digit accountNumber, with its opening (BalanceBroughtForward) and closing (BalanceCarriedForward) balance in the financial year. Omit financialYearId for the current financial year.',
  access: 'read',
  inputSchema: FortnoxGetAccountInput,
  outputSchema: FortnoxAccount,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      listPath(
        `accounts/${encodeURIComponent(String(input.accountNumber))}`,
        {},
        { financialyear: financialYearQuery(input.financialYearId) }
      ),
      AccountResponse,
      value => accountFromApi(value.Account)
    )
})

export const fortnoxListVoucherSeriesAction = defineAction({
  id: 'fortnox.list_voucher_series',
  description:
    'List one page of Fortnox voucher series (verifikationsserier) for a financial year: Code, Description, Manual, NextVoucherNumber. Omit financialYearId for the current financial year. Repeat financialYearId/lastModified/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListVoucherSeriesInput,
  outputSchema: FortnoxListVoucherSeriesOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      listPath('voucherseries', input, {
        financialyear: financialYearQuery(input.financialYearId)
      }),
      VoucherSeriesListResponse,
      value =>
        FortnoxListVoucherSeriesOutput.make({
          voucherSeries: Chunk.fromIterable(
            value.VoucherSeriesCollection.map(series => FortnoxVoucherSeries.make(series))
          ),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxListVouchersAction = defineAction({
  id: 'fortnox.list_vouchers',
  description:
    'List one page of Fortnox vouchers (verifikationer) in a financial year, sorted by series and number. A voucher is identified by VoucherSeries, VoucherNumber, and Year (the financial year Id). Filters: voucherSeries, fromDate/toDate (TransactionDate, YYYY-MM-DD), costCenter (Fortnox substring search), lastModified. Omit financialYearId for the current financial year. List rows usually omit VoucherRows; read a voucher with fortnox.get_voucher for its rows. Repeat the filters with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListVouchersInput,
  outputSchema: FortnoxListVouchersOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      // Fortnox lists one series under /vouchers/sublist/{VoucherSeries}.
      listPath(
        input.voucherSeries === undefined
          ? 'vouchers'
          : `vouchers/sublist/${encodeURIComponent(input.voucherSeries)}`,
        input,
        {
          financialyear: financialYearQuery(input.financialYearId),
          costcenter: input.costCenter
        }
      ),
      VouchersResponse,
      value =>
        FortnoxListVouchersOutput.make({
          vouchers: Chunk.fromIterable(value.Vouchers.map(voucherFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetVoucherAction = defineAction({
  id: 'fortnox.get_voucher',
  description:
    'Read one Fortnox voucher with its rows by voucherSeries, voucherNumber, and financialYearId (all three identify it: numbers restart every financial year). Row Description is the account name; TransactionInformation is the row text.',
  access: 'read',
  inputSchema: FortnoxGetVoucherInput,
  outputSchema: FortnoxVoucher,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      listPath(
        `vouchers/${encodeURIComponent(input.voucherSeries)}/${encodeURIComponent(String(input.voucherNumber))}`,
        {},
        { financialyear: String(input.financialYearId) }
      ),
      VoucherResponse,
      value => voucherFromApi(value.Voucher)
    )
})

export const fortnoxCreateVoucherAction = defineAction({
  id: 'fortnox.create_voucher',
  description:
    'Create and book a Fortnox voucher (verifikation) in VoucherSeries of financial year financialYearId. Fortnox books it immediately and assigns VoucherNumber; the Fortnox API documents no way to delete or change a voucher and this connector has none, so a mistake needs a new correcting voucher. TransactionDate (YYYY-MM-DD) must fall inside the financial year and after any locked period. Each row: Account (an existing active four-digit account), exactly one of Debit or Credit (positive, at most two decimals), optional TransactionInformation (row text, max 100 characters), CostCenter, and Project (existing codes). At least two rows; total Debit must equal total Credit (checked before sending). Description max 200, Comments max 1000 characters. Unknown fields are rejected. Never retried: after a transport failure or an unreadable answer the voucher may still have been booked, so list vouchers before trying again. If Fortnox answers with a voucher in another series or financial year than requested, the action fails with fortnox_voucher_mismatch: that voucher is booked, do not create it again.',
  access: 'destructive',
  inputSchema: FortnoxCreateVoucherInput,
  outputSchema: FortnoxVoucher,
  execute: ({ integration, input }) => {
    const { financialYearId, VoucherRows, ...voucher } = input

    return writeFortnox(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot,
      'POST',
      `vouchers?financialyear=${encodeURIComponent(String(financialYearId))}`,
      {
        Voucher: {
          ...voucher,
          // The archived create example sends both sides on every row; the unused side is 0.
          VoucherRows: VoucherRows.map(({ Account, Debit, Credit, ...row }) => ({
            Account,
            Debit: Debit ?? 0,
            Credit: Credit ?? 0,
            ...row
          }))
        }
      },
      VoucherResponse,
      value => voucherFromApi(value.Voucher)
    ).pipe(
      Effect.map(result =>
        Predicate.isTagged(result, 'Success') &&
        (result.value.Year !== financialYearId ||
          result.value.VoucherSeries.toUpperCase() !== input.VoucherSeries.toUpperCase())
          ? ActionResult.failure({
              code: 'fortnox_voucher_mismatch',
              message: `Fortnox booked voucher ${result.value.VoucherSeries} ${result.value.VoucherNumber} in financial year ${result.value.Year}, not in series ${input.VoucherSeries} of financial year ${financialYearId}. It is booked: do not create it again.`,
              underlying: {
                voucherSeries: result.value.VoucherSeries,
                voucherNumber: result.value.VoucherNumber,
                financialYearId: result.value.Year
              }
            })
          : result
      )
    )
  }
})

export const fortnoxBookkeepingActions = [
  fortnoxListFinancialYearsAction,
  fortnoxGetFinancialYearAction,
  fortnoxListAccountsAction,
  fortnoxGetAccountAction,
  fortnoxListVoucherSeriesAction,
  fortnoxListVouchersAction,
  fortnoxGetVoucherAction,
  fortnoxCreateVoucherAction
] as const
