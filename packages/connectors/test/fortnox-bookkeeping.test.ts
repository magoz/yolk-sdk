import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { FileDescriptor, ToolCall } from '@yolk-sdk/agent/protocol'
import { resolveTools, type FileStoreApi } from '@yolk-sdk/agent/tools'
import {
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpError,
  ConnectorBinaryWriteHttpClient,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  defineConnector,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type {
  ActionResult,
  ConnectorBinaryHttpRequest,
  ConnectorBinaryHttpResponse,
  ConnectorBinaryWriteHttpRequest,
  ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  FortnoxAccount,
  FortnoxCombinedOAuthCredentialSlot,
  FortnoxConnector,
  FortnoxFinancialYear,
  FortnoxGetSieFileOutput,
  FortnoxListAccountsOutput,
  FortnoxListFinancialYearsOutput,
  FortnoxListVoucherFileConnectionsOutput,
  FortnoxListVoucherSeriesOutput,
  FortnoxListVouchersOutput,
  FortnoxSieFile,
  FortnoxVoucher,
  FortnoxVoucherFileConnection,
  fortnoxBookkeepingActions,
  fortnoxBookkeepingScope,
  fortnoxCreateVoucherAction,
  fortnoxCreateVoucherFileConnectionAction,
  fortnoxGetAccountAction,
  fortnoxGetFinancialYearAction,
  fortnoxGetSieFileAction,
  fortnoxGetVoucherAction,
  fortnoxListAccountsAction,
  fortnoxListFinancialYearsAction,
  fortnoxListVoucherFileConnectionsAction,
  fortnoxListVoucherSeriesAction,
  fortnoxListVouchersAction,
  fortnoxSieActions,
  fortnoxSieFileMaxBytes,
  fortnoxVoucherFileActions,
  uploadFortnoxArchiveFile
} from '@yolk-sdk/connectors/fortnox'

const integration = makeIntegration({
  connectorId: 'fortnox',
  credentialBindings: [
    makeCredentialBinding({ slotId: 'fortnox.oauth', credentialRef: 'host-fortnox-ref' })
  ]
})

const oauth = OAuthCredential.make({
  provider: 'fortnox',
  accessToken: 'test-access-token',
  expiresAt: 4_000_000_000_000
})

const isJson = Schema.is(Schema.Json)

const jsonText = (body: Schema.Json) => {
  if (!isJson(body)) throw new TypeError('JSON fixture requires a finite JSON value')

  return JSON.stringify(body)
}

const response = (body: Schema.Json, status = 200) =>
  ConnectorHttpResponse.make({ status, headers: {}, body: jsonText(body) })

const binary = (
  bytes: Uint8Array,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
  bodyComplete = true
): ConnectorBinaryHttpResponse => ({ status, headers, bytes, bodyComplete })

const ascii = (text: string) => new TextEncoder().encode(text)

const meta = (currentPage = 1, totalPages = 1, totalResources = 1) => ({
  '@CurrentPage': currentPage,
  '@TotalPages': totalPages,
  '@TotalResources': totalResources
})

type Responses = {
  readonly http?: ReadonlyArray<ConnectorHttpResponse>
  readonly read?: ReadonlyArray<ConnectorBinaryHttpResponse>
  readonly write?: ReadonlyArray<ConnectorBinaryHttpResponse>
}

const makeHarness = (responses: Responses = {}) => {
  const requests: Array<ConnectorHttpRequest> = []
  const reads: Array<ConnectorBinaryHttpRequest> = []
  const writes: Array<ConnectorBinaryWriteHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const next = <A>(list: ReadonlyArray<A> | undefined, index: number) => {
    const item = list?.at(index)

    return item === undefined
      ? Effect.die(new Error('Unexpected Fortnox request'))
      : Effect.succeed(item)
  }

  const base = Layer.mergeAll(
    Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: request => {
          expect(request.binding.credentialRef).toBe('host-fortnox-ref')
          expect(request.slot.id).toBe('fortnox.oauth')
          scopes.push(request.slot.requiredScopes)

          return Effect.succeed(oauth)
        }
      })
    ),
    Layer.succeed(
      ConnectorHttpClient,
      ConnectorHttpClient.of({
        request: request => {
          requests.push(request)

          return next(responses.http, requests.length - 1)
        }
      })
    )
  )

  const binaryPorts = Layer.mergeAll(
    Layer.succeed(ConnectorBinaryHttpClient, {
      request: request => {
        reads.push(request)

        return next(responses.read, reads.length - 1)
      }
    }),
    Layer.succeed(ConnectorBinaryWriteHttpClient, {
      request: request => {
        writes.push(request)

        return next(responses.write, writes.length - 1)
      }
    })
  )

  const layer = Layer.mergeAll(base, binaryPorts)
  const sent = () => requests.length + reads.length + writes.length

  return { layer, base, requests, reads, writes, scopes, sent }
}

const readHeaders = { authorization: 'Bearer test-access-token', accept: 'application/json' }

const writeHeaders = { ...readHeaders, 'content-type': 'application/json' }

const url = (path: string) => `https://api.fortnox.se/3/${path}`

const successValue = <S extends Schema.Top>(result: ActionResult<unknown>, schema: S) => {
  if (!Predicate.isTagged(result, 'Success')) throw new Error('Expected a success result')
  const is = Schema.is(schema)

  if (!is(result.value)) throw new Error('Success value does not match the output schema')

  return result.value
}

const failureOf = (result: ActionResult<unknown>) => {
  if (!Predicate.isTagged(result, 'Failure')) throw new Error('Expected a failure result')

  return result.error
}

const BookkeepingConnector = defineConnector({
  id: 'fortnox',
  description: 'Fortnox bookkeeping actions under test.',
  actions: [...fortnoxBookkeepingActions, ...fortnoxVoucherFileActions, ...fortnoxSieActions]
})

const run = (harness: ReturnType<typeof makeHarness>, actionId: string, input: unknown) =>
  BookkeepingConnector.invoke({ integration, action: actionId, input }).pipe(
    Effect.provide(harness.layer)
  )

// Archived voucher example (developer.fortnox.se/documentation/resources/vouchers): Project is the
// number 0, Comments null, CostCenter "", row amounts JSON numbers.
const voucherBody = {
  '@url': 'https://api.fortnox.se/3/vouchers/A/7?financialyear=4',
  Comments: null,
  CostCenter: '',
  Description: 'Bankavgift',
  Project: 0,
  ReferenceNumber: '',
  ReferenceType: 'MANUAL',
  TransactionDate: '2026-11-20',
  VoucherNumber: 7,
  VoucherRows: [
    {
      Account: 6570,
      CostCenter: '',
      Credit: 0,
      Debit: 125.5,
      Description: 'Bankkostnader',
      Project: '',
      Removed: false,
      TransactionInformation: 'November fee'
    },
    {
      Account: 1930,
      CostCenter: '',
      Credit: 125.5,
      Debit: 0,
      Description: 'Företagskonto',
      Project: '',
      Removed: false,
      TransactionInformation: ''
    }
  ],
  VoucherSeries: 'A',
  Year: 4
}

const voucherInput = {
  financialYearId: 4,
  VoucherSeries: 'A',
  TransactionDate: '2026-11-20',
  Description: 'Bankavgift',
  VoucherRows: [
    { Account: 6570, Debit: 125.5, TransactionInformation: 'November fee' },
    { Account: 1930, Credit: 125.5 }
  ]
}

describe('Fortnox bookkeeping actions', () => {
  it('exports the actions with their access metadata in stable order', () => {
    expect(
      [...fortnoxBookkeepingActions, ...fortnoxVoucherFileActions, ...fortnoxSieActions].map(
        action => [action.id, action.access]
      )
    ).toEqual([
      ['fortnox.list_financial_years', 'read'],
      ['fortnox.get_financial_year', 'read'],
      ['fortnox.list_accounts', 'read'],
      ['fortnox.get_account', 'read'],
      ['fortnox.list_voucher_series', 'read'],
      ['fortnox.list_vouchers', 'read'],
      ['fortnox.get_voucher', 'read'],
      ['fortnox.create_voucher', 'destructive'],
      ['fortnox.list_voucher_file_connections', 'read'],
      ['fortnox.create_voucher_file_connection', 'write'],
      ['fortnox.get_sie_file', 'read']
    ])
    expect(fortnoxCreateVoucherAction.description).toContain('no way to delete or change a voucher')
    expect(
      FortnoxConnector.actions.filter(action =>
        [...fortnoxBookkeepingActions, ...fortnoxVoucherFileActions, ...fortnoxSieActions].some(
          added => added.id === action.id
        )
      )
    ).toHaveLength(11)
  })

  it('keeps bookkeeping out of the combined consent slot', () => {
    expect(fortnoxBookkeepingScope).toBe('bookkeeping')
    expect(FortnoxCombinedOAuthCredentialSlot.requiredScopes).not.toContain('bookkeeping')
  })

  it.effect('lists financial years by date and reads the archived accountCharts alias', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({
            MetaInformation: meta(1, 1, 1),
            FinancialYears: [
              {
                '@url': 'https://api.fortnox.se/3/financialyears/4',
                Id: 4,
                FromDate: '2026-01-01',
                ToDate: '2026-12-31',
                accountCharts: 'Bas 2026',
                AccountingMethod: 'ACCRUAL'
              }
            ]
          })
        ]
      })

      const result = yield* run(harness, fortnoxListFinancialYearsAction.id, {
        date: '2026-06-30',
        limit: 5
      })

      const output = successValue(result, FortnoxListFinancialYearsOutput)

      expect(Chunk.toReadonlyArray(output.financialYears)).toEqual([
        FortnoxFinancialYear.make({
          Id: FortnoxFinancialYear.fields.Id.make(4),
          FromDate: '2026-01-01',
          ToDate: '2026-12-31',
          AccountChartType: 'Bas 2026',
          AccountingMethod: 'ACCRUAL'
        })
      ])
      expect(output.pagination.nextPage).toBeUndefined()
      expect(harness.requests).toEqual([
        expect.objectContaining({
          method: 'GET',
          url: url('financialyears?limit=5&date=2026-06-30'),
          headers: readHeaders
        })
      ])
      expect(harness.scopes).toEqual([['bookkeeping']])
    })
  )

  it.effect('reads a financial year by id or by the date it contains', () =>
    Effect.gen(function* () {
      const year = { Id: '3', FromDate: '2025-01-01', ToDate: '2025-12-31', AccountChartType: null }

      const harness = makeHarness({
        http: [
          response({ FinancialYear: year }),
          response({ FinancialYears: [year], MetaInformation: meta() })
        ]
      })

      const byId = successValue(
        yield* run(harness, fortnoxGetFinancialYearAction.id, { id: 3 }),
        FortnoxFinancialYear
      )

      const byDate = successValue(
        yield* run(harness, fortnoxGetFinancialYearAction.id, { date: '2025-03-01' }),
        FortnoxFinancialYear
      )

      expect(byId.Id).toBe(3)
      expect(byDate).toEqual(byId)
      expect(harness.requests.map(request => request.url)).toEqual([
        url('financialyears/3'),
        url('financialyears?date=2025-03-01')
      ])
    })
  )

  it.effect('fails not_found when no financial year contains the date', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [response({ FinancialYears: [], MetaInformation: meta(1, 0, 0) })]
      })

      const failure = failureOf(
        yield* run(harness, fortnoxGetFinancialYearAction.id, { date: '2001-01-01' })
      )

      expect(failure.code).toBe('fortnox_not_found')
      expect(failure.message).toContain('2001-01-01')
    })
  )

  it.effect('refuses an ambiguous date answer and inputs without exactly one key', () =>
    Effect.gen(function* () {
      const year = (Id: number) => ({ Id, FromDate: '2025-01-01', ToDate: '2025-12-31' })

      const harness = makeHarness({
        http: [response({ FinancialYears: [year(1), year(2)], MetaInformation: meta(1, 1, 2) })]
      })

      const ambiguous = yield* run(harness, fortnoxGetFinancialYearAction.id, {
        date: '2025-05-05'
      }).pipe(Effect.flip)

      expect(ambiguous.cause).toBe('validation_failed')

      for (const input of [{}, { id: 1, date: '2025-01-01' }, { date: '2025-02-30' }]) {
        const error = yield* run(harness, fortnoxGetFinancialYearAction.id, input).pipe(Effect.flip)

        expect(error.cause).toBe('validation_failed')
      }

      expect(harness.sent()).toBe(1)
    })
  )

  it.effect('lists accounts per financial year with opening and closing balances', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({
            MetaInformation: meta(1, 13, 1210),
            Accounts: [
              {
                '@url': 'https://api.fortnox.se/3/accounts/1930?financialyear=4',
                Active: true,
                BalanceBroughtForward: 15000,
                BalanceCarriedForward: '18250.75',
                CostCenter: '',
                CostCenterSettings: 'ALLOWED',
                Description: 'Företagskonto',
                Number: '1930',
                Project: 0,
                ProjectSettings: 'ALLOWED',
                QuantitySettings: 0,
                SRU: 7281,
                TransactionInformation: '',
                TransactionInformationSettings: 0,
                VATCode: null,
                Year: 4
              }
            ]
          })
        ]
      })

      const output = successValue(
        yield* run(harness, fortnoxListAccountsAction.id, {
          financialYearId: 4,
          page: 1,
          limit: 100
        }),
        FortnoxListAccountsOutput
      )

      expect(Chunk.toReadonlyArray(output.accounts)).toEqual([
        FortnoxAccount.make({
          Number: 1930,
          Description: 'Företagskonto',
          Active: true,
          BalanceBroughtForward: 15000,
          BalanceCarriedForward: 18250.75,
          CostCenter: '',
          CostCenterSettings: 'ALLOWED',
          Project: '0',
          ProjectSettings: 'ALLOWED',
          SRU: 7281,
          TransactionInformation: '',
          VATCode: null,
          Year: 4
        })
      ])
      expect(output.pagination.nextPage).toBe(2)
      expect(harness.requests[0]?.url).toBe(url('accounts?page=1&limit=100&financialyear=4'))
    })
  )

  it.effect('reads one account in a financial year or the current one', () =>
    Effect.gen(function* () {
      const account = {
        Number: 2440,
        Description: 'Leverantörsskulder',
        BalanceBroughtForward: -50
      }

      const harness = makeHarness({
        http: [response({ Account: account }), response({ Account: account })]
      })

      const first = successValue(
        yield* run(harness, fortnoxGetAccountAction.id, {
          accountNumber: 2440,
          financialYearId: 2
        }),
        FortnoxAccount
      )

      yield* run(harness, fortnoxGetAccountAction.id, { accountNumber: 2440 })

      expect(first.BalanceBroughtForward).toBe(-50)
      expect(harness.requests.map(request => request.url)).toEqual([
        url('accounts/2440?financialyear=2'),
        url('accounts/2440')
      ])

      const invalid = yield* run(harness, fortnoxGetAccountAction.id, {
        accountNumber: 999
      }).pipe(Effect.flip)

      expect(invalid.cause).toBe('validation_failed')
      expect(harness.sent()).toBe(2)
    })
  )

  it.effect('lists voucher series', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({
            MetaInformation: meta(1, 1, 2),
            VoucherSeriesCollection: [
              {
                '@url': 'https://api.fortnox.se/3/voucherseries/A',
                Code: 'A',
                Description: 'Redovisning',
                Manual: true,
                NextVoucherNumber: 8,
                Year: 4
              },
              { Code: 'L', Description: 'Kontantfaktura', Manual: 'false', Year: '4' }
            ]
          })
        ]
      })

      const output = successValue(
        yield* run(harness, fortnoxListVoucherSeriesAction.id, { financialYearId: 4 }),
        FortnoxListVoucherSeriesOutput
      )

      expect(
        Chunk.toReadonlyArray(output.voucherSeries).map(series => [
          series.Code,
          series.Manual,
          series.Year
        ])
      ).toEqual([
        ['A', true, 4],
        ['L', false, 4]
      ])
      expect(harness.requests[0]?.url).toBe(url('voucherseries?financialyear=4'))
    })
  )

  it.effect('lists a populated voucher page and one series through the sublist path', () =>
    Effect.gen(function* () {
      const listed = () =>
        response({
          MetaInformation: meta(1, 2, 120),
          Vouchers: [
            {
              '@url': 'https://api.fortnox.se/3/vouchers/B/25?financialyear=4',
              Description: 'Kundfaktura Exempel AB (36)',
              ReferenceNumber: 36,
              ReferenceType: 'INVOICE',
              TransactionDate: '2026-06-10',
              VoucherNumber: '25',
              VoucherSeries: 'B',
              Year: 4
            },
            {
              '@url': 'https://api.fortnox.se/3/vouchers/B/26?financialyear=4',
              ReferenceNumber: '48',
              ReferenceType: 'INVOICE',
              VoucherNumber: 26,
              VoucherSeries: 'B',
              Year: 4
            }
          ]
        })

      const harness = makeHarness({ http: [listed(), listed()] })

      const all = successValue(
        yield* run(harness, fortnoxListVouchersAction.id, {
          financialYearId: 4,
          fromDate: '2026-06-01',
          toDate: '2026-06-30',
          costCenter: 'CC1',
          limit: 50
        }),
        FortnoxListVouchersOutput
      )

      yield* run(harness, fortnoxListVouchersAction.id, { voucherSeries: 'B', page: 2 })

      const rows = Chunk.toReadonlyArray(all.vouchers)

      expect(rows.map(voucher => [voucher.VoucherSeries, voucher.VoucherNumber])).toEqual([
        ['B', 25],
        ['B', 26]
      ])
      expect(rows[0]?.ReferenceNumber).toBe('36')
      expect(rows[0]?.VoucherRows).toBeUndefined()
      expect(all.pagination.nextPage).toBe(2)
      expect(harness.requests.map(request => request.url)).toEqual([
        url(
          'vouchers?limit=50&fromdate=2026-06-01&todate=2026-06-30&financialyear=4&costcenter=CC1'
        ),
        url('vouchers/sublist/B?page=2')
      ])
    })
  )

  it.effect('reads a voucher with rows by series, number, and financial year', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ http: [response({ Voucher: voucherBody })] })

      const voucher = successValue(
        yield* run(harness, fortnoxGetVoucherAction.id, {
          voucherSeries: 'A',
          voucherNumber: 7,
          financialYearId: 4
        }),
        FortnoxVoucher
      )

      expect(voucher.Project).toBe('0')
      expect(voucher.Comments).toBeNull()
      expect(
        Chunk.toReadonlyArray(voucher.VoucherRows ?? Chunk.empty()).map(row => [
          row.Account,
          row.Debit,
          row.Credit,
          row.Description,
          row.TransactionInformation
        ])
      ).toEqual([
        [6570, 125.5, 0, 'Bankkostnader', 'November fee'],
        [1930, 0, 125.5, 'Företagskonto', '']
      ])
      expect(harness.requests[0]?.url).toBe(url('vouchers/A/7?financialyear=4'))

      const missingYear = yield* run(harness, fortnoxGetVoucherAction.id, {
        voucherSeries: 'A',
        voucherNumber: 7
      }).pipe(Effect.flip)

      expect(missingYear.cause).toBe('validation_failed')
      expect(harness.sent()).toBe(1)
    })
  )

  it.effect('creates a balanced voucher in the given financial year', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ http: [response({ Voucher: voucherBody }, 201)] })

      const voucher = successValue(
        yield* run(harness, fortnoxCreateVoucherAction.id, voucherInput),
        FortnoxVoucher
      )

      expect([voucher.VoucherSeries, voucher.VoucherNumber, voucher.Year]).toEqual(['A', 7, 4])
      expect(harness.requests).toEqual([
        expect.objectContaining({
          method: 'POST',
          url: url('vouchers?financialyear=4'),
          headers: writeHeaders
        })
      ])
      expect(harness.requests[0]?.body).toBe(
        jsonText({
          Voucher: {
            VoucherSeries: 'A',
            TransactionDate: '2026-11-20',
            Description: 'Bankavgift',
            VoucherRows: [
              { Account: 6570, Debit: 125.5, Credit: 0, TransactionInformation: 'November fee' },
              { Account: 1930, Debit: 0, Credit: 125.5 }
            ]
          }
        })
      )
      expect(harness.scopes).toEqual([['bookkeeping']])
    })
  )

  it.effect('refuses unbalanced, malformed, or open voucher input before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const rows = voucherInput.VoucherRows

      const invalid = [
        // Unbalanced by one öre.
        { ...voucherInput, VoucherRows: [rows[0], { Account: 1930, Credit: 125.49 }] },
        // A row with both sides, and a row with neither.
        {
          ...voucherInput,
          VoucherRows: [{ Account: 6570, Debit: 10, Credit: 10 }, { Account: 1930 }]
        },
        // Three decimals.
        {
          ...voucherInput,
          VoucherRows: [
            { Account: 6570, Debit: 1.005 },
            { Account: 1930, Credit: 1.005 }
          ]
        },
        // Not exactly a two-decimal amount.
        {
          ...voucherInput,
          VoucherRows: [
            { Account: 6570, Debit: 1.000000001 },
            { Account: 1930, Credit: 1 }
          ]
        },
        // Every amount is valid, but the sums differ by one öre past 2^53 öre.
        {
          ...voucherInput,
          VoucherRows: [
            ...Array.from({ length: 100 }, () => ({ Account: 6570, Debit: 999_999_999_999 })),
            ...Array.from({ length: 100 }, () => ({ Account: 1930, Credit: 999_999_999_999 })),
            { Account: 1930, Credit: 0.01 }
          ]
        },
        // Negative amount.
        {
          ...voucherInput,
          VoucherRows: [
            { Account: 6570, Debit: -5 },
            { Account: 1930, Credit: -5 }
          ]
        },
        // One row.
        { ...voucherInput, VoucherRows: [{ Account: 6570, Debit: 0 }] },
        // Row Description is the read-only account name; the row text is TransactionInformation.
        {
          ...voucherInput,
          VoucherRows: [{ ...rows[0], Description: 'text' }, rows[1]]
        },
        // Unknown top-level key, missing financial year, invalid date, empty description.
        { ...voucherInput, VoucherNumber: 9 },
        { ...voucherInput, financialYearId: undefined },
        { ...voucherInput, TransactionDate: '2026-11-31' },
        { ...voucherInput, Description: ' ' }
      ]

      for (const input of invalid) {
        const error = yield* run(harness, fortnoxCreateVoucherAction.id, input).pipe(Effect.flip)

        expect(error.cause, JSON.stringify(input)).toBe('validation_failed')
      }

      expect(harness.sent()).toBe(0)
    })
  )

  it.effect('checks the balance on the typed path too', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const decoded = yield* Schema.decodeUnknownEffect(fortnoxCreateVoucherAction.inputSchema)(
        voucherInput
      )

      const [debit, credit] = decoded.VoucherRows

      if (debit === undefined || credit === undefined) throw new Error('Expected two rows')

      const error = yield* fortnoxCreateVoucherAction
        .executeTyped({
          integration,
          input: { ...decoded, VoucherRows: [debit, { ...credit, Credit: 1 }] }
        })
        .pipe(Effect.provide(harness.layer), Effect.flip)

      expect(error.cause).toBe('validation_failed')
      expect(harness.sent()).toBe(0)
    })
  )

  it.effect('fails when Fortnox books the voucher in another year or series', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({ Voucher: { ...voucherBody, Year: 5 } }, 201),
          response({ Voucher: { ...voucherBody, VoucherSeries: 'B' } }, 201),
          response({ Voucher: voucherBody }, 201)
        ]
      })

      const failure = failureOf(yield* run(harness, fortnoxCreateVoucherAction.id, voucherInput))

      const otherSeries = failureOf(
        yield* run(harness, fortnoxCreateVoucherAction.id, voucherInput)
      )

      // Series codes compare case-insensitively, as Fortnox searches do.
      const lowerCase = yield* run(harness, fortnoxCreateVoucherAction.id, {
        ...voucherInput,
        VoucherSeries: 'a'
      })

      expect(otherSeries).toMatchObject({
        code: 'fortnox_voucher_mismatch',
        underlying: { voucherSeries: 'B', financialYearId: 4 }
      })
      expect(Predicate.isTagged(lowerCase, 'Success')).toBe(true)

      expect(failure).toMatchObject({
        code: 'fortnox_voucher_mismatch',
        underlying: { voucherSeries: 'A', voucherNumber: 7, financialYearId: 5 }
      })
      expect(failure.message).toContain('do not create it again')
    })
  )

  it.effect('reports a Fortnox voucher rejection as a provider failure', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response(
            { ErrorInformation: { error: 1, message: 'Kontot är inte aktivt.', code: 2000883 } },
            400
          )
        ]
      })

      const failure = failureOf(yield* run(harness, fortnoxCreateVoucherAction.id, voucherInput))

      expect(failure).toMatchObject({
        code: 'fortnox_request_failed',
        status: 400,
        message: 'Kontot är inte aktivt.',
        underlying: { providerCode: 2000883 }
      })
      expect(harness.requests).toHaveLength(1)
    })
  )
})

describe('Fortnox voucher file connections', () => {
  const connection = (VoucherNumber: string | number) => ({
    '@url': 'https://api.fortnox.se/3/voucherfileconnections/951209e2-211d-4dfc-9d4c-5c426122dc46',
    FileId: '951209e2-211d-4dfc-9d4c-5c426122dc46',
    Name: 'kvitto.pdf',
    VoucherDescription: 'Bankavgift',
    VoucherNumber,
    VoucherSeries: 'A'
  })

  const inYear = (VoucherNumber: string | number, VoucherYear: number) => ({
    ...connection(VoucherNumber),
    VoucherYear
  })

  const listInput = { voucherSeries: 'A', voucherNumber: 7, financialYearId: 4 }

  const listUrl = (page: number) =>
    url(`voucherfileconnections?vouchernumber=7&financialyear=4&page=${page}&limit=500`)

  it.effect('lists the files of exactly one voucher across every page', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({
            MetaInformation: meta(1, 2, 4),
            // Substring matches, other series, and other years are left out; series ignore case.
            VoucherFileConnections: [
              inYear('7', 4),
              inYear('17', 4),
              { ...inYear('7', 4), VoucherSeries: 'B' },
              inYear('7', 3)
            ]
          }),
          response({
            MetaInformation: meta(2, 2, 4),
            VoucherFileConnections: [{ ...inYear(7, 4), VoucherSeries: 'a' }]
          }),
          response({ MetaInformation: meta(1, 1, 0), VoucherFileConnections: [] })
        ]
      })

      const output = successValue(
        yield* run(harness, fortnoxListVoucherFileConnectionsAction.id, listInput),
        FortnoxListVoucherFileConnectionsOutput
      )

      expect(
        Chunk.toReadonlyArray(output.connections).map(item => [
          item.VoucherNumber,
          item.VoucherYear
        ])
      ).toEqual([
        [7, 4],
        [7, 4]
      ])
      expect(harness.requests.map(request => request.url)).toEqual([listUrl(1), listUrl(2)])
      expect(harness.scopes).toEqual([['connectfile'], ['connectfile']])

      const empty = successValue(
        yield* run(harness, fortnoxListVoucherFileConnectionsAction.id, listInput),
        FortnoxListVoucherFileConnectionsOutput
      )

      expect(Chunk.size(empty.connections)).toBe(0)
      expect(harness.requests).toHaveLength(3)
    })
  )

  it.effect('fails closed without pagination metadata', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ http: [response({ VoucherFileConnections: [] })] })

      const error = yield* run(harness, fortnoxListVoucherFileConnectionsAction.id, listInput).pipe(
        Effect.flip
      )

      expect(error.cause).toBe('validation_failed')
    })
  )

  it.effect('fails closed on a matching row without a year and past the page cap', () =>
    Effect.gen(function* () {
      const manyPages = Array.from({ length: 10 }, (_, index) =>
        response({ MetaInformation: meta(index + 1, 11, 5500), VoucherFileConnections: [] })
      )

      const harness = makeHarness({
        http: [
          response({ MetaInformation: meta(), VoucherFileConnections: [connection(7)] }),
          ...manyPages
        ]
      })

      const noYear = yield* run(
        harness,
        fortnoxListVoucherFileConnectionsAction.id,
        listInput
      ).pipe(Effect.flip)

      const tooMany = yield* run(
        harness,
        fortnoxListVoucherFileConnectionsAction.id,
        listInput
      ).pipe(Effect.flip)

      expect(noYear.cause).toBe('validation_failed')
      expect(noYear.message).toContain('without VoucherYear')
      expect(tooMany.cause).toBe('validation_failed')
      expect(harness.requests).toHaveLength(11)
    })
  )

  it.effect('attaches an archive file to a voucher', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [response({ VoucherFileConnection: inYear('7', 4) }, 201)]
      })

      const created = successValue(
        yield* run(harness, fortnoxCreateVoucherFileConnectionAction.id, {
          FileId: '951209e2-211d-4dfc-9d4c-5c426122dc46',
          VoucherSeries: 'A',
          VoucherNumber: 7,
          VoucherYear: 4
        }),
        FortnoxVoucherFileConnection
      )

      expect(created.VoucherNumber).toBe(7)
      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: url('voucherfileconnections?financialyear=4'),
        headers: writeHeaders
      })
      expect(harness.requests[0]?.body).toBe(
        jsonText({
          VoucherFileConnection: {
            FileId: '951209e2-211d-4dfc-9d4c-5c426122dc46',
            VoucherNumber: '7',
            VoucherSeries: 'A',
            VoucherYear: 4
          }
        })
      )

      for (const input of [
        { FileId: '../x', VoucherSeries: 'A', VoucherNumber: 7, VoucherYear: 4 },
        { FileId: 'f1', VoucherSeries: 'A', VoucherNumber: 7 },
        { FileId: 'f1', VoucherSeries: 'A', VoucherNumber: 7, VoucherYear: 4, Name: 'x.pdf' }
      ]) {
        const error = yield* run(harness, fortnoxCreateVoucherFileConnectionAction.id, input).pipe(
          Effect.flip
        )

        expect(error.cause).toBe('validation_failed')
      }

      expect(harness.sent()).toBe(1)
    })
  )

  it.effect('fails when the answer does not prove the requested connection', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({ VoucherFileConnection: inYear('7', 3) }, 201),
          response({ VoucherFileConnection: connection('7') }, 201),
          response({ VoucherFileConnection: { ...inYear('7', 4), FileId: 'other' } }, 201),
          response({ VoucherFileConnection: inYear('7', 4) }, 201)
        ]
      })

      const input = {
        FileId: '951209e2-211d-4dfc-9d4c-5c426122dc46',
        VoucherSeries: 'A',
        VoucherNumber: 7,
        VoucherYear: 4
      }

      const otherYear = failureOf(
        yield* run(harness, fortnoxCreateVoucherFileConnectionAction.id, input)
      )

      const noYear = failureOf(
        yield* run(harness, fortnoxCreateVoucherFileConnectionAction.id, input)
      )

      const otherFile = failureOf(
        yield* run(harness, fortnoxCreateVoucherFileConnectionAction.id, input)
      )

      expect(otherYear).toMatchObject({
        code: 'fortnox_voucher_mismatch',
        underlying: { voucherSeries: 'A', voucherNumber: 7, financialYearId: 3 }
      })
      expect(otherYear.message).toContain('do not create it again')
      expect(noYear).toMatchObject({
        code: 'fortnox_voucher_mismatch',
        underlying: { financialYearId: null }
      })
      expect(otherFile).toMatchObject({
        code: 'fortnox_voucher_mismatch',
        underlying: { fileId: 'other' }
      })

      // Series codes compare case-insensitively, as Fortnox searches do.
      const lowerCase = yield* run(harness, fortnoxCreateVoucherFileConnectionAction.id, {
        ...input,
        VoucherSeries: 'a'
      })

      expect(Predicate.isTagged(lowerCase, 'Success')).toBe(true)
    })
  )
})

describe('Fortnox archive upload', () => {
  const budget = { maxBytes: 64, maxMetadataBytes: 4096, maxErrorBodyBytes: 256 }

  it.effect('uploads one file to the archive root or a folder with the archive scope', () =>
    Effect.gen(function* () {
      const bytes = ascii('%PDF-1.7 kvitto')

      const uploaded = (Size: number | string) =>
        binary(
          ascii(
            JSON.stringify({
              File: {
                '@url': 'https://api.fortnox.se/3/archive/0df13d88-0686-49c8-987d-b9e384dedd7a',
                Id: '0df13d88-0686-49c8-987d-b9e384dedd7a',
                Name: 'kvitto.pdf',
                Path: 'root',
                Size
              }
            })
          ),
          201
        )

      const harness = makeHarness({ write: [uploaded(bytes.byteLength), uploaded('15')] })

      const file = yield* uploadFortnoxArchiveFile(
        integration,
        { fileName: 'kvitto.pdf', contentType: 'application/pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer))

      yield* uploadFortnoxArchiveFile(
        integration,
        { folderId: 'd8b06758-6c73-40c0-8e26-9fa1437cfe7b', fileName: 'kvitto.pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer))

      expect(file).toMatchObject({ Id: '0df13d88-0686-49c8-987d-b9e384dedd7a', Size: 15 })
      expect(harness.writes.map(write => write.url)).toEqual([
        url('archive'),
        url('archive?folderid=d8b06758-6c73-40c0-8e26-9fa1437cfe7b')
      ])
      expect(harness.writes[0]?.headers['content-type']).toBe(
        'multipart/form-data; boundary=yolk-fortnox-archive-00000000'
      )
      expect(harness.writes[0]).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        successStatuses: [200, 201]
      })
      expect(harness.scopes).toEqual([['archive'], ['archive']])
    })
  )

  it.effect('refuses unsafe names and size mismatches', () =>
    Effect.gen(function* () {
      const bytes = ascii('data')

      const harness = makeHarness({
        write: [binary(ascii(JSON.stringify({ File: { Id: 'f1', Size: 5 } })), 201)]
      })

      const unsafe = yield* uploadFortnoxArchiveFile(
        integration,
        { fileName: 'a/b.pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer), Effect.flip)

      const mismatch = yield* uploadFortnoxArchiveFile(
        integration,
        { fileName: 'b.pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer), Effect.flip)

      expect(unsafe.code).toBe('invalid_input')
      expect(mismatch.code).toBe('invalid_metadata')
      expect(harness.writes).toHaveLength(1)
    })
  )
})

describe('Fortnox SIE file', () => {
  // `#FLAGGA 0`, `#FORMAT PC8`, and a company name with IBM437 å (0x86), ä (0x84), ö (0x94).
  const sieBytes = Uint8Array.from([
    ...ascii('#FLAGGA 0\r\n#FORMAT PC8\r\n#SIETYP 4\r\n#FNAMN "Exempel '),
    0x86,
    0x84,
    0x94,
    ...ascii(' AB"\r\n')
  ])

  const sieBase64 = globalThis.btoa(String.fromCharCode(...sieBytes))

  it.effect('returns the untouched IBM437 bytes through the binary port', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ read: [binary(sieBytes)] })

      const output = successValue(
        yield* run(harness, fortnoxGetSieFileAction.id, { sieType: 4, financialYearId: 4 }),
        FortnoxGetSieFileOutput
      )

      expect(output).toEqual(
        FortnoxGetSieFileOutput.make({
          sieType: 4,
          financialYearId: FortnoxGetSieFileOutput.fields.financialYearId.make(4),
          fileName: 'fortnox-sie4-year-4.se',
          mimeType: 'text/plain',
          encoding: 'IBM437',
          byteLength: sieBytes.byteLength,
          contentBase64: sieBase64
        })
      )
      expect(harness.reads).toEqual([
        {
          method: 'GET',
          url: url('sie/4?financialyear=4'),
          headers: {
            authorization: 'Bearer test-access-token',
            accept: 'application/octet-stream'
          },
          redirect: 'manual',
          credentials: 'omit',
          maxBytes: fortnoxSieFileMaxBytes,
          maxErrorBodyBytes: 64 * 1024
        }
      ])
      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toEqual([['bookkeeping']])
    })
  )

  it.effect('needs the host binary port', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const error = yield* BookkeepingConnector.invoke({
        integration,
        action: fortnoxGetSieFileAction.id,
        input: { sieType: 1, financialYearId: 4 }
      }).pipe(Effect.provide(harness.base), Effect.flip)

      expect(error.cause).toBe('validation_failed')
      expect(error.message).toContain('ConnectorBinaryHttpClient')
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('maps error answers, oversize files, and non-SIE bodies', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        read: [
          binary(ascii('{"ErrorInformation":{"code":2000588,"message":"Felaktigt år"}}'), 400),
          binary(ascii('{"Voucher":{}}')),
          binary(ascii('#FLAGGA 0'), 200, {}, false),
          binary(new Uint8Array(), 302, { location: 'https://example.test/' })
        ]
      })

      const input = { sieType: 2, financialYearId: 99 }
      const rejected = failureOf(yield* run(harness, fortnoxGetSieFileAction.id, input))
      const notSie = yield* run(harness, fortnoxGetSieFileAction.id, input).pipe(Effect.flip)
      const partial = yield* run(harness, fortnoxGetSieFileAction.id, input).pipe(Effect.flip)
      const redirected = failureOf(yield* run(harness, fortnoxGetSieFileAction.id, input))

      expect(rejected).toMatchObject({
        code: 'fortnox_request_failed',
        status: 400,
        message: 'Felaktigt år',
        underlying: { providerCode: 2000588 }
      })
      expect(notSie.cause).toBe('validation_failed')
      expect(partial.cause).toBe('validation_failed')
      expect(redirected).toMatchObject({ code: 'fortnox_request_failed', status: 302 })

      const invalidType = yield* run(harness, fortnoxGetSieFileAction.id, {
        sieType: 5,
        financialYearId: 4
      }).pipe(Effect.flip)

      expect(invalidType.cause).toBe('validation_failed')
      expect(harness.reads).toHaveLength(4)
    })
  )

  it.effect('reports a file over the cap as a failure the model can act on', () =>
    Effect.gen(function* () {
      const tooLarge = Layer.mergeAll(
        makeHarness().base,
        Layer.succeed(ConnectorBinaryHttpClient, {
          request: () => Effect.fail(new ConnectorBinaryHttpError({ code: 'response_too_large' }))
        })
      )

      const result = yield* BookkeepingConnector.invoke({
        integration,
        action: fortnoxGetSieFileAction.id,
        input: { sieType: 4, financialYearId: 4 }
      }).pipe(Effect.provide(tooLarge))

      expect(failureOf(result).code).toBe('fortnox_response_too_large')
    })
  )

  it.effect('returns the file as a file field to agents, never its text', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ read: [binary(sieBytes)] })

      const store: FileStoreApi = {
        put: ({ bytes, name, mimeType }) => {
          expect(bytes).toEqual(sieBytes)

          return Effect.succeed(
            FileDescriptor.make({ fileId: 'file_1', name, mimeType, size: bytes.length })
          )
        },
        head: () => Effect.die(new Error('unused')),
        read: () => Effect.die(new Error('unused')),
        signRead: () => Effect.die(new Error('unused'))
      }

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(BookkeepingConnector, { integration, layer: harness.layer })],
        {},
        { files: { store } }
      )

      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'fortnox.get_sie_file',
          params: { sieType: 4, financialYearId: 4 }
        })
      )

      expect(fortnoxGetSieFileAction.fileOutput?.schema).toBe(FortnoxSieFile)
      expect(result.structuredContent).toEqual({
        value: {
          sieType: 4,
          financialYearId: 4,
          fileName: 'fortnox-sie4-year-4.se',
          mimeType: 'text/plain',
          encoding: 'IBM437',
          byteLength: sieBytes.byteLength
        },
        files: [
          {
            fileId: 'file_1',
            name: 'fortnox-sie4-year-4.se',
            mimeType: 'text/plain',
            size: sieBytes.byteLength
          }
        ]
      })
      expect(JSON.stringify(result)).not.toContain(sieBase64)
      expect(JSON.stringify(result)).not.toContain('FLAGGA')
    })
  )
})
