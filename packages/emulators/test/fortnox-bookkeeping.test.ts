import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  fortnoxApiBaseUrl,
  fortnoxBookkeepingActions,
  fortnoxSieActions,
  fortnoxVoucherFileActions
} from '@yolk-sdk/connectors/fortnox'
import { fortnoxConformanceIntegration } from '@yolk-sdk/connectors/fortnox/conformance'
import {
  emulatorEvidenceHeader,
  fortnoxEmulatorErrorCodes,
  fortnoxEmulatorRoutes,
  makeFortnoxEmulator,
  type FortnoxEmulator,
  type FortnoxEmulatorOptions
} from '../src/fortnox.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = 'https://api.fortnox.se'

const token = 'synthetic-unit-test-token'

// 2026-09-29 lies in financial year 2 (2026) of the default seed.
const now = Date.parse('2026-09-29T12:00:00.000Z')

const open: Array<FortnoxEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: FortnoxEmulatorOptions = {}): Promise<FortnoxEmulator> => {
  const created = await makeFortnoxEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

const call = (target: FortnoxEmulator, method: string, path: string) =>
  target.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    })
  )

const json = async (target: FortnoxEmulator, path: string): Promise<unknown> => {
  const response = await call(target, 'GET', path)

  expect(response.status, path).toBe(200)

  return response.json()
}

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined

const rows = async (target: FortnoxEmulator, path: string, envelope: string) => {
  const list = field(await json(target, path), envelope)

  return Array.isArray(list) ? list : []
}

const errorCode = async (response: Response) =>
  field(field(await response.json(), 'ErrorInformation'), 'code')

describe('bookkeeping routes', () => {
  it('lists ten GET routes after the read-only resources, each citing a bookkeeping case', () => {
    const routes = fortnoxEmulatorRoutes.slice(44)

    expect(routes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /3/financialyears',
      'GET /3/financialyears/{Id}',
      'GET /3/accounts',
      'GET /3/accounts/{Number}',
      'GET /3/voucherseries',
      'GET /3/vouchers',
      'GET /3/vouchers/sublist/{VoucherSeries}',
      'GET /3/vouchers/{VoucherSeries}/{VoucherNumber}',
      'GET /3/voucherfileconnections',
      'GET /3/sie/{Type}'
    ])
    expect(
      routes.every(
        route =>
          !route.write &&
          route.evidence === 'unverified' &&
          route.caseIds.length === 1 &&
          route.caseIds.every(caseId => caseId.startsWith('fortnox.bookkeeping.'))
      )
    ).toBe(true)
  })

  it.effect('selects the financial year by Id, by date, or as the one containing today', () =>
    Effect.promise(async () => {
      const target = await emulator()

      expect(
        (await rows(target, '/3/financialyears', 'FinancialYears')).map(row => field(row, 'Id'))
      ).toEqual([2, 1])
      expect(
        (await rows(target, '/3/financialyears?date=2025-07-01', 'FinancialYears')).map(row =>
          field(row, 'Id')
        )
      ).toEqual([1])
      expect(await rows(target, '/3/financialyears?date=2001-01-01', 'FinancialYears')).toEqual([])

      // Without financialyear the year containing today (2026, Id 2) applies; past the seeded
      // years, the newest one.
      const later = await emulator({ now: () => Date.parse('2031-01-01T00:00:00.000Z') })

      expect((await rows(later, '/3/accounts', 'Accounts')).map(row => field(row, 'Year'))).toEqual(
        [2, 2, 2]
      )

      // Without financialyear the year containing today (2026, Id 2) applies.
      expect(
        (await rows(target, '/3/accounts', 'Accounts')).map(row => field(row, 'Year'))
      ).toEqual([2, 2, 2])
      expect(
        field(field(await json(target, '/3/accounts/1930?financialyear=1'), 'Account'), 'Year')
      ).toBe(1)

      for (const path of [
        '/3/financialyears?date=2026-02-30',
        '/3/accounts?financialyear=9',
        '/3/vouchers?financialyear=x',
        '/3/vouchers?fromdate=2026-13-01',
        '/3/sie/5?financialyear=2'
      ]) {
        const response = await call(target, 'GET', path)

        expect(response.status, path).toBe(400)
      }

      const missing = await call(target, 'GET', '/3/vouchers/A/9?financialyear=2')

      expect(missing.status).toBe(404)
      expect(await errorCode(missing)).toBe(fortnoxEmulatorErrorCodes.resourceNotFound)
    })
  )

  it.effect('filters vouchers by series, dates, and cost center', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const numbers = async (path: string) =>
        (await rows(target, path, 'Vouchers')).map(row => field(row, 'VoucherNumber'))

      expect(await numbers('/3/vouchers?financialyear=2')).toEqual([1, 2, 1])
      expect(await numbers('/3/vouchers/sublist/A?financialyear=2')).toEqual([1, 2])
      expect(await numbers('/3/vouchers/sublist/B?financialyear=2')).toEqual([1])
      expect(await numbers('/3/vouchers?financialyear=2&fromdate=2026-09-10')).toEqual([2, 1])
      expect(await numbers('/3/vouchers?financialyear=2&todate=2026-09-10')).toEqual([1])
      // Fortnox searches match substrings, ignoring case.
      expect(await numbers('/3/vouchers?financialyear=2&costcenter=cc')).toEqual([1])
      expect(await numbers('/3/vouchers?financialyear=1')).toEqual([])
    })
  )

  it.effect('filters voucher file connections and serves SIE bytes untouched', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const fileIds = async (query: string) =>
        (await rows(target, `/3/voucherfileconnections?${query}`, 'VoucherFileConnections')).map(
          row => field(row, 'FileId')
        )

      expect(await fileIds('vouchernumber=2&financialyear=2')).toEqual([])
      // One resource-specific filter, a substring match: number 1 names A/1 and B/1.
      expect(await fileIds('vouchernumber=1&financialyear=2')).toEqual([
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000b1'
      ])
      expect(await fileIds('voucherseries=b')).toEqual(['00000000-0000-4000-8000-0000000000b1'])
      expect(
        (await call(target, 'GET', '/3/voucherfileconnections?voucherseries=A&vouchernumber=1'))
          .status
      ).toBe(400)

      const sie = await call(target, 'GET', '/3/sie/1?financialyear=2')
      const bytes = new Uint8Array(await sie.arrayBuffer())

      expect(sie.headers.get('content-type')).toBe('application/octet-stream')
      expect(sie.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(new TextDecoder().decode(bytes.subarray(0, 7))).toBe('#FLAGGA')
      expect(bytes.includes(0x94)).toBe(true)
      expect((await call(target, 'GET', '/3/sie/4?financialyear=2')).status).toBe(404)
    })
  )

  it.effect('does not emulate voucher or file connection creates', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const path of ['/3/vouchers?financialyear=2', '/3/voucherfileconnections']) {
        const response = await call(target, 'POST', path)

        expect(response.status, path).toBe(404)
        expect(await errorCode(response)).toBe(fortnoxEmulatorErrorCodes.unknownRoute)
      }
    })
  )

  it.effect('refuses inconsistent bookkeeping seeds; an empty company keeps its years', () =>
    Effect.promise(async () => {
      const year = {
        Id: 1,
        FromDate: '2026-01-01',
        ToDate: '2026-12-31',
        AccountChartType: 'Bas',
        AccountingMethod: 'ACCRUAL'
      }

      const account = {
        Year: 1,
        Number: 1930,
        Description: 'Bank',
        Active: true,
        BalanceBroughtForward: 0,
        BalanceCarriedForward: 0,
        SRU: null,
        VATCode: null
      }

      const voucher = (Credit: number) => ({
        Year: 1,
        VoucherSeries: 'A',
        VoucherNumber: 1,
        Description: 'x',
        TransactionDate: '2026-01-01',
        ReferenceNumber: '',
        ReferenceType: 'MANUAL',
        CostCenter: '',
        VoucherRows: [
          { Account: 1930, Debit: 1, Credit: 0, TransactionInformation: '' },
          { Account: 1930, Debit: 0, Credit, TransactionInformation: '' }
        ]
      })

      const series = { Year: 1, Code: 'A', Description: 'a', Manual: true, NextVoucherNumber: 2 }

      const base = {
        financialYears: [year],
        accounts: [account],
        voucherSeries: [series],
        voucherFileConnections: [],
        sieFiles: []
      }

      // A balanced voucher seeds.
      // Seeds go through JSON, as a host sends them.
      const asSeed = (seed: unknown) => JSON.parse(JSON.stringify(seed))

      await emulator({ seed: asSeed({ ...base, vouchers: [voucher(1)] }) })

      for (const seed of [
        { ...base, vouchers: [voucher(0.99)] },
        { ...base, vouchers: [voucher(1)], accounts: [] },
        { ...base, vouchers: [voucher(1)], voucherSeries: [] },
        { ...base, financialYears: [], vouchers: [] },
        { ...base, vouchers: [], sieFiles: [{ Year: 1, Type: 1, ContentBase64: 'not base64' }] },
        {
          ...base,
          vouchers: [],
          voucherFileConnections: [
            { FileId: 'f1', Name: 'x', VoucherYear: 1, VoucherSeries: 'A', VoucherNumber: 1 }
          ]
        }
      ]) {
        await expect(
          makeFortnoxEmulator({ seed: asSeed(seed) }),
          JSON.stringify(seed)
        ).rejects.toThrow('Invalid Fortnox emulator seed')
      }

      const empty = await emulator({ seed: { profile: 'empty-company' } })

      expect(await rows(empty, '/3/vouchers?financialyear=2', 'Vouchers')).toEqual([])
      expect(await rows(empty, '/3/financialyears', 'FinancialYears')).toHaveLength(2)
    })
  )

  it.effect('answers the real bookkeeping actions in process', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      const layer = Layer.mergeAll(
        connectorHttpClientsFromEffectHttpClientLayer.pipe(
          Layer.provide(
            InProcessHttpClient.layer([
              EmulatorRoute.handler(new URL(fortnoxApiBaseUrl).origin, target.fetch)
            ])
          )
        ),
        staticCredentialResolverLayer(
          OAuthCredential.make({ provider: 'fortnox', accessToken: token, expiresAt: 4e12 })
        )
      )

      const actions = [
        ...fortnoxBookkeepingActions,
        ...fortnoxVoucherFileActions,
        ...fortnoxSieActions
      ]

      const invoke = (id: string, input: unknown) => {
        const action = actions.find(candidate => candidate.id === id)

        if (action === undefined) throw new Error(`no action ${id}`)

        return action
          .execute({ integration: fortnoxConformanceIntegration, input })
          .pipe(Effect.provide(layer))
      }

      for (const [id, input] of [
        ['fortnox.list_financial_years', {}],
        ['fortnox.get_financial_year', { date: '2026-03-01' }],
        ['fortnox.list_accounts', {}],
        ['fortnox.get_account', { accountNumber: 6570, financialYearId: 2 }],
        ['fortnox.list_voucher_series', { financialYearId: 1 }],
        ['fortnox.list_vouchers', { voucherSeries: 'A', fromDate: '2026-09-02' }],
        ['fortnox.get_voucher', { voucherSeries: 'A', voucherNumber: 2, financialYearId: 2 }],
        [
          'fortnox.list_voucher_file_connections',
          { voucherSeries: 'A', voucherNumber: 1, financialYearId: 2 }
        ],
        ['fortnox.get_sie_file', { sieType: 1, financialYearId: 2 }]
      ] as const) {
        const result = yield* invoke(id, input)

        expect(Predicate.isTagged(result, 'Success'), id).toBe(true)
      }
    })
  )
})
