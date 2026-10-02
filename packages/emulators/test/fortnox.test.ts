import { Effect, Layer, Predicate } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import { runConformance } from '@yolk-sdk/conformance/runner'
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  FortnoxCreateInvoiceInput,
  FortnoxCustomerNumber,
  FortnoxGetCustomerInput,
  FortnoxListInvoicesInput,
  fortnoxApiBaseUrl,
  fortnoxCreateInvoiceAction,
  fortnoxGetCustomerAction,
  fortnoxListInvoicesAction
} from '@yolk-sdk/connectors/fortnox'
import {
  FortnoxConformanceConfig,
  fortnoxConformanceCases,
  fortnoxConformanceFixtureSeeds,
  fortnoxConformanceIntegration,
  fortnoxInvoiceListPopulatedCase
} from '@yolk-sdk/connectors/fortnox/conformance'
import {
  FortnoxEmulatorInputInvalid,
  emulatorEvidenceHeader,
  fortnoxEmulatorErrorCodes,
  fortnoxEmulatorQuirks,
  fortnoxEmulatorRoutes,
  makeFortnoxEmulator,
  type FortnoxEmulator,
  type FortnoxEmulatorOptions,
  type FortnoxFault
} from '../src/fortnox.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = 'https://api.fortnox.se'

const token = 'synthetic-unit-test-token'

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

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
}

const call = (
  target: FortnoxEmulator,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers({ accept: 'application/json' })

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined) headers.set('content-type', 'application/json')

  return target.fetch(new Request(`${origin}${path}`, { method, headers, body }))
}

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

const jsonOf = async (response: Response): Promise<unknown> => response.json()

const documentNumbers = async (response: Response): Promise<unknown> => {
  const invoices = field(await jsonOf(response), 'Invoices')

  return Array.isArray(invoices) ? invoices.map(invoice => field(invoice, 'DocumentNumber')) : []
}

const errorCode = async (response: Response): Promise<unknown> =>
  field(field(await jsonOf(response), 'ErrorInformation'), 'code')

/** The real Fortnox connector, routed in process to `target`. */
const connectorLayer = (target: FortnoxEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(
        InProcessHttpClient.layer([
          EmulatorRoute.handler(new URL(fortnoxApiBaseUrl).origin, target.fetch)
        ])
      )
    ),
    staticCredentialResolverLayer(
      OAuthCredential.make({
        provider: 'fortnox',
        accessToken: token,
        expiresAt: 4_000_000_000_000
      })
    )
  )

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector route linked to Fortnox cases', () => {
    const caseIds = new Set(fortnoxConformanceCases.map(testCase => testCase.id))

    expect(fortnoxEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /3/companyinformation',
      'GET /3/customers',
      'GET /3/customers/{CustomerNumber}',
      'PUT /3/customers/{CustomerNumber}',
      'GET /3/invoices',
      'POST /3/invoices',
      'GET /3/invoices/{DocumentNumber}',
      'PUT /3/invoices/{DocumentNumber}',
      'GET /3/invoices/{DocumentNumber}/preview',
      'GET /3/invoices/{DocumentNumber}/email'
    ])
    expect(fortnoxEmulatorRoutes.filter(route => route.write).map(route => route.path)).toEqual([
      '/3/customers/{CustomerNumber}',
      '/3/invoices',
      '/3/invoices/{DocumentNumber}',
      '/3/invoices/{DocumentNumber}/email'
    ])

    for (const route of fortnoxEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    // Every case is followed by at least one route.
    expect(new Set(fortnoxEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })

  it('ties each quirk to a route that cites its case', () => {
    for (const quirk of fortnoxEmulatorQuirks) {
      const route = fortnoxEmulatorRoutes.find(
        candidate => `${candidate.method} ${candidate.path}` === quirk.route
      )

      expect(route, quirk.id).toBeDefined()

      if (quirk.caseId !== undefined) {
        expect(route?.caseIds, quirk.id).toContain(quirk.caseId)
      }
    }

    expect(fortnoxEmulatorQuirks.filter(quirk => quirk.caseId === undefined)).toHaveLength(1)
  })

  it.effect('has a handler behind every manifest route', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const route of fortnoxEmulatorRoutes) {
        const path = route.path
          .replace('{CustomerNumber}', '1001')
          .replace('{DocumentNumber}', '103')

        const body =
          route.method === 'GET'
            ? undefined
            : { [path.includes('customers') ? 'Customer' : 'Invoice']: { Comments: 'x' } }

        await call(target, route.method, path, { body })
      }

      expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
      expect(target.coverage().unknownRouteRequests).toBe(0)
      expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
    })
  )
})

describe('fail closed', () => {
  it.effect('answers unknown routes and methods with a 404 ErrorInformation and ledgers them', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const [method, path] of [
        ['GET', '/3/articles'],
        ['DELETE', '/3/customers/1001'],
        ['POST', '/3/invoices/103/email'],
        ['GET', '/v1/chat/completions'],
        ['GET', '/3/invoices/103/print']
      ] as const) {
        const response = await call(target, method, path)

        expect(response.status, `${method} ${path}`).toBe(404)
        expect(response.headers.get(emulatorEvidenceHeader)).toBeNull()
        expect(await errorCode(response)).toBe(fortnoxEmulatorErrorCodes.unknownRoute)
      }

      expect(target.ledger.entries().map(entry => entry.evidence)).toEqual(
        Array.from({ length: 5 }, () => 'unknown-route')
      )
      expect(target.coverage().unknownRouteRequests).toBe(5)
    })
  )

  it.effect('rejects unsupported query parameters and filters instead of ignoring them', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const path of [
        '/3/invoices?lastmodified=2026-09-01',
        '/3/invoices?filter=overdue',
        '/3/invoices?fromdate=yesterday',
        '/3/customers?sortby=name',
        '/3/customers?filter=all'
      ]) {
        const response = await call(target, 'GET', path)

        expect(response.status, path).toBe(400)
      }

      const lastModified = await call(target, 'GET', '/3/customers?lastmodified=2026-09-01')

      expect(await jsonOf(lastModified)).toEqual({
        ErrorInformation: {
          error: 1,
          message: expect.stringContaining('does not track modification times'),
          code: fortnoxEmulatorErrorCodes.unsupportedQuery
        }
      })
    })
  )

  it.effect('rejects unknown query keys on every other route before the handler runs', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      for (const [method, path, body] of [
        ['GET', '/3/invoices/104/email?unexpected=1', undefined],
        ['GET', '/3/companyinformation?unexpected=1', undefined],
        ['GET', '/3/customers/1001?unexpected=1', undefined],
        ['PUT', '/3/customers/1001?unexpected=1', { Customer: { Comments: 'changed' } }],
        ['POST', '/3/invoices?unexpected=1', { Invoice: { CustomerNumber: '1001' } }],
        ['GET', '/3/invoices/103?unexpected=1', undefined],
        ['PUT', '/3/invoices/103?unexpected=1', { Invoice: { Comments: 'changed' } }],
        ['GET', '/3/invoices/103/preview?unexpected=1', undefined]
      ] as const) {
        const response = await call(target, method, path, { body })

        expect(response.status, `${method} ${path}`).toBe(400)
        expect(await errorCode(response)).toBe(fortnoxEmulatorErrorCodes.unsupportedQuery)
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      }

      // The email route wrote nothing: no Sent flag, no outbox entry.
      expect(target.snapshot()).toEqual(before)
      expect(
        target.snapshot().invoices.find(invoice => invoice.DocumentNumber === '104')?.Sent
      ).toBe(false)
      expect(target.snapshot().outbox).toEqual([])
    })
  )

  it.effect('answers 503 after close', () =>
    Effect.promise(async () => {
      const target = await makeFortnoxEmulator()

      await target.close()
      await target.close()

      expect((await call(target, 'GET', '/3/invoices')).status).toBe(503)
    })
  )
})

describe('authorization', () => {
  it.effect('needs a non-empty bearer credential and never stores it', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const authorization of [null, 'Bearer ', 'Basic abc']) {
        const response = await call(target, 'GET', '/3/companyinformation', { authorization })

        expect(response.status).toBe(401)
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
        expect(await errorCode(response)).toBe(fortnoxEmulatorErrorCodes.unauthorized)
      }

      const ok = await call(target, 'PUT', '/3/customers/1001', {
        body: { Customer: { Comments: 'Synthetic update.' } }
      })

      expect(ok.status).toBe(200)

      const everything = JSON.stringify([
        target.ledger.entries(),
        target.snapshot(),
        await jsonOf(await target.fetch(new Request(`${origin}/_emulate/state`)))
      ])

      expect(everything).not.toContain(token)
      expect(everything.toLowerCase()).not.toContain('bearer')
    })
  )
})

describe('customers', () => {
  it.effect('keeps stored values for empty strings and omitted fields', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const response = await call(target, 'PUT', '/3/customers/1001', {
        body: { Customer: { Comments: '', City: 'Ny stad', Phone1: '' } }
      })

      const customer = field(await jsonOf(response), 'Customer')

      expect(response.status).toBe(200)
      expect(field(customer, 'Comments')).toBe('Synthetic note: invoice monthly by email.')
      expect(field(customer, 'City')).toBe('Ny stad')
      expect(field(customer, 'Name')).toBe('Example Customer AB')
    })
  )

  it.effect('rejects the read-only Country, unknown fields, and wrong types atomically', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      const country = await call(target, 'PUT', '/3/customers/1001', {
        body: { Customer: { Comments: 'changed', Country: 'Norge' } }
      })

      expect(country.status).toBe(400)
      expect(await jsonOf(country)).toEqual({
        ErrorInformation: {
          error: 1,
          message: 'Synthetic: Country is read-only; set CountryCode instead.',
          code: fortnoxEmulatorErrorCodes.readOnlyField
        }
      })

      for (const body of [
        { Customer: { Comments: 'changed', Phone: '123' } },
        { Customer: { Active: 'yes' } },
        { Customer: { CustomerNumber: '2002' } },
        { Customer: { CountryCode: 'XX' } },
        { Invoice: {} },
        { Customer: { Comments: 'x' }, Extra: true }
      ]) {
        expect((await call(target, 'PUT', '/3/customers/1001', { body })).status).toBe(400)
      }

      expect(target.snapshot()).toEqual(before)

      const moved = field(
        await jsonOf(
          await call(target, 'PUT', '/3/customers/1001', {
            body: { Customer: { CountryCode: 'NO' } }
          })
        ),
        'Customer'
      )

      expect([field(moved, 'CountryCode'), field(moved, 'Country')]).toEqual(['NO', 'Norge'])
      expect(
        (await call(target, 'PUT', '/3/customers/99999', { body: { Customer: {} } })).status
      ).toBe(404)
    })
  )

  it.effect('rejects customer values the emulator does not support, atomically', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      for (const fields of [
        { Comments: 'changed', Currency: 'USD' },
        { CostCenter: 'CC1' },
        { TermsOfPayment: 'K' },
        { TermsOfPayment: '366' },
        { TermsOfPayment: '999999999' },
        { TermsOfPayment: '9007199254740992' },
        { TermsOfPayment: '-1' },
        { TermsOfPayment: '1.5' },
        { TermsOfPayment: '030' },
        { Comments: 'changed', VATType: 'EXPORT' },
        { VATType: 'bogus' },
        { Type: 'FOO' }
      ]) {
        const response = await call(target, 'PUT', '/3/customers/1001', {
          body: { Customer: fields }
        })

        expect(response.status, JSON.stringify(fields)).toBe(400)
        expect(await errorCode(response)).toBe(fortnoxEmulatorErrorCodes.invalidField)
      }

      expect(target.snapshot()).toEqual(before)

      // The emulated values (and empty strings, which keep the stored value) still apply.
      const kept = await call(target, 'PUT', '/3/customers/1001', {
        body: {
          Customer: {
            Currency: 'SEK',
            CostCenter: '',
            TermsOfPayment: '10',
            VATType: '',
            Type: 'PRIVATE'
          }
        }
      })

      const customer = field(await jsonOf(kept), 'Customer')

      expect(kept.status).toBe(200)
      expect([
        field(customer, 'TermsOfPayment'),
        field(customer, 'VATType'),
        field(customer, 'Type')
      ]).toEqual(['10', 'SEVAT', 'PRIVATE'])

      for (const fields of [
        { TermsOfPayment: '0', VATType: 'SEVAT', Type: 'COMPANY' },
        { TermsOfPayment: '365' }
      ]) {
        const response = await call(target, 'PUT', '/3/customers/1001', {
          body: { Customer: fields }
        })

        expect(response.status, JSON.stringify(fields)).toBe(200)
      }
    })
  )

  it.effect('lists customers with search, filter, and list-only Phone rows', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const listed = await jsonOf(await call(target, 'GET', '/3/customers?name=trading'))
      const customers = field(listed, 'Customers')

      expect(
        Array.isArray(customers) ? customers.map(row => field(row, 'CustomerNumber')) : []
      ).toEqual(['1002'])
      expect(Array.isArray(customers) ? Object.keys(customers[0] ?? {}) : []).toContain('Phone')
      expect(field(listed, 'MetaInformation')).toEqual({
        '@CurrentPage': 1,
        '@TotalPages': 1,
        '@TotalResources': 1
      })

      const inactive = await jsonOf(await call(target, 'GET', '/3/customers?filter=inactive'))

      expect(field(inactive, 'Customers')).toEqual([])
    })
  )
})

describe('invoices', () => {
  it.effect('lists rows with a numeric-string CurrencyRate and paginates', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const page = await jsonOf(await call(target, 'GET', '/3/invoices?limit=2&page=2'))
      const invoices = field(page, 'Invoices')

      expect(
        Array.isArray(invoices) ? invoices.map(row => field(row, 'DocumentNumber')) : []
      ).toEqual(['103', '104'])
      expect(Array.isArray(invoices) ? field(invoices[0], 'CurrencyRate') : undefined).toBe('1')
      expect(field(page, 'MetaInformation')).toEqual({
        '@CurrentPage': 2,
        '@TotalPages': 3,
        '@TotalResources': 5
      })

      const beyond = await jsonOf(await call(target, 'GET', '/3/invoices?limit=2&page=9'))

      expect(field(beyond, 'Invoices')).toEqual([])

      for (const query of ['limit=0', 'limit=501', 'limit=abc', 'page=0']) {
        expect((await call(target, 'GET', `/3/invoices?${query}`)).status, query).toBe(400)
      }

      const single = field(await jsonOf(await call(target, 'GET', '/3/invoices/103')), 'Invoice')

      expect(field(single, 'CurrencyRate')).toBe(1)
      expect((await call(target, 'GET', '/3/invoices/999')).status).toBe(404)
    })
  )

  it.effect('payment filters consider booked invoices only; unpaidoverdue follows the clock', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const listed = (filter: string) =>
        call(target, 'GET', `/3/invoices?filter=${filter}`).then(documentNumbers)

      expect(await listed('unbooked')).toEqual(['103', '105'])
      expect(await listed('unpaid')).toEqual(['102', '104'])
      expect(await listed('unpaidoverdue')).toEqual([])
      expect(await listed('fullypaid')).toEqual(['101'])
      expect(await listed('cancelled')).toEqual([])

      const later = await emulator({ now: () => Date.parse('2026-10-05T00:00:00.000Z') })

      expect(
        await call(later, 'GET', '/3/invoices?filter=unpaidoverdue').then(documentNumbers)
      ).toEqual(['102'])
    })
  )

  it.effect(
    'positional rows keep an omitted discount; RowId rows update, add, and fail closed',
    () =>
      Effect.promise(async () => {
        const target = await emulator()

        const put = (body: unknown) => call(target, 'PUT', '/3/invoices/103', { body })

        const omitted = field(
          await jsonOf(await put({ Invoice: { InvoiceRows: [{ Price: 600 }] } })),
          'Invoice'
        )

        const rows = field(omitted, 'InvoiceRows')

        // One row sent: the list is replaced; row 1 keeps Discount 5 and the other fields.
        expect(
          Array.isArray(rows)
            ? rows.map(row => [field(row, 'RowId'), field(row, 'Discount'), field(row, 'Total')])
            : []
        ).toEqual([[7, 5, 1140]])
        expect([
          field(omitted, 'Net'),
          field(omitted, 'TotalVAT'),
          field(omitted, 'Total')
        ]).toEqual([1140, 285, 1425])

        const byRowId = field(
          await jsonOf(
            await put({
              Invoice: {
                InvoiceRows: [
                  { RowId: 7, Discount: 0 },
                  { Description: 'Added (synthetic)', Price: 100 }
                ]
              }
            })
          ),
          'Invoice'
        )

        const updatedRows = field(byRowId, 'InvoiceRows')

        expect(
          Array.isArray(updatedRows)
            ? updatedRows.map(row => [
                field(row, 'RowId'),
                field(row, 'Description'),
                field(row, 'Total')
              ])
            : []
        ).toEqual([
          [8, 'Consulting hours (synthetic)', 1200],
          [9, 'Added (synthetic)', 100]
        ])

        expect((await put({ Invoice: { InvoiceRows: [{ RowId: 1 }] } })).status).toBe(400)
        expect((await put({ Invoice: { InvoiceRows: [{ VATCode: 'MP1' }] } })).status).toBe(400)
        expect((await put({ Invoice: { InvoiceRows: [{ ArticleNumber: 'A-1' }] } })).status).toBe(
          400
        )
        expect((await put({ Invoice: { Total: 1 } })).status).toBe(400)
        expect((await put({ Invoice: { CustomerNumber: '99999' } })).status).toBe(400)
        expect(
          (await call(target, 'PUT', '/3/invoices/101', { body: { Invoice: { Comments: 'x' } } }))
            .status
        ).toBe(400)
      })
  )

  it.effect(
    'creates invoices and rejects unknown customers with the fixture ErrorInformation',
    () =>
      Effect.promise(async () => {
        const target = await emulator()

        const rejected = await call(target, 'POST', '/3/invoices', {
          body: { Invoice: { CustomerNumber: '99999', Comments: 'probe' } }
        })

        expect(rejected.status).toBe(400)
        expect(await jsonOf(rejected)).toEqual({
          ErrorInformation: {
            error: 1,
            message: 'Synthetic placeholder: customer not found.',
            code: 2000433
          }
        })

        const created = await call(target, 'POST', '/3/invoices', {
          body: {
            Invoice: {
              CustomerNumber: '1002',
              InvoiceRows: [
                { Description: 'New work (synthetic)', DeliveredQuantity: '3', Price: 200 }
              ]
            }
          }
        })

        const invoice = field(await jsonOf(created), 'Invoice')

        expect(created.status).toBe(201)
        expect([
          field(invoice, 'DocumentNumber'),
          field(invoice, 'CustomerName'),
          field(invoice, 'InvoiceDate'),
          field(invoice, 'DueDate'),
          field(invoice, 'Total'),
          field(invoice, 'Booked')
        ]).toEqual(['106', 'Example Trading AB', '2026-09-29', '2026-10-29', 750, false])
        expect((await call(target, 'POST', '/3/invoices', { body: { Invoice: {} } })).status).toBe(
          400
        )
      })
  )

  it.effect('validates the inherited customer currency before creating an invoice', () =>
    Effect.promise(async () => {
      const target = await emulator({
        seed: {
          customers: [{ CustomerNumber: '1', Name: 'Euro AB', Currency: 'EUR' }],
          invoices: []
        }
      })

      const before = target.snapshot()

      for (const invoice of [{ CustomerNumber: '1' }, { CustomerNumber: '1', Currency: 'EUR' }]) {
        const response = await call(target, 'POST', '/3/invoices', { body: { Invoice: invoice } })

        expect(response.status, JSON.stringify(invoice)).toBe(400)
        expect(field(field(await jsonOf(response), 'ErrorInformation'), 'message')).toContain(
          'Currency EUR'
        )
      }

      expect(target.snapshot()).toEqual(before)
    })
  )

  it.effect('validates the inherited VAT type and payment terms before creating an invoice', () =>
    Effect.promise(async () => {
      const target = await emulator({
        seed: {
          customers: [
            { CustomerNumber: '1', Name: 'Export AB', VATType: 'EXPORT' },
            { CustomerNumber: '2', Name: 'Cash AB', TermsOfPayment: 'K' },
            { CustomerNumber: '3', Name: 'Far AB', TermsOfPayment: '999999999' },
            { CustomerNumber: '4', Name: 'Unsafe AB', TermsOfPayment: '9007199254740992' },
            { CustomerNumber: '5', Name: 'Late AB', TermsOfPayment: '30' }
          ],
          invoices: []
        }
      })

      const before = target.snapshot()

      for (const [invoice, message] of [
        [{ CustomerNumber: '1' }, 'VATType EXPORT'],
        [{ CustomerNumber: '2' }, 'TermsOfPayment K'],
        [{ CustomerNumber: '2', DueDate: '2026-12-31' }, 'TermsOfPayment K'],
        [{ CustomerNumber: '3' }, 'TermsOfPayment 999999999'],
        [{ CustomerNumber: '4' }, 'TermsOfPayment 9007199254740992'],
        [{ CustomerNumber: '5', InvoiceDate: '9999-12-31' }, 'not a representable']
      ] as const) {
        const response = await call(target, 'POST', '/3/invoices', { body: { Invoice: invoice } })

        expect(response.status, JSON.stringify(invoice)).toBe(400)
        expect(await errorCode(response.clone())).toBe(fortnoxEmulatorErrorCodes.invalidField)
        expect(field(field(await jsonOf(response), 'ErrorInformation'), 'message')).toContain(
          message
        )
      }

      expect(target.snapshot()).toEqual(before)

      const created = await call(target, 'POST', '/3/invoices', {
        body: { Invoice: { CustomerNumber: '5', InvoiceDate: '2026-12-15' } }
      })

      expect(created.status).toBe(201)
      expect(field(field(await jsonOf(created), 'Invoice'), 'DueDate')).toBe('2027-01-14')
    })
  )

  it.effect('previews a synthetic PDF and emails into the outbox without delivering', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const preview = await call(target, 'GET', '/3/invoices/103/preview')
      const bytes = new Uint8Array(await preview.arrayBuffer())

      expect(preview.headers.get('content-type')).toBe('application/pdf')
      expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-')
      expect(new TextDecoder().decode(bytes)).toContain('%%EOF')
      // Unlike /print, the preview does not mark the invoice Sent.
      expect(
        target.snapshot().invoices.find(invoice => invoice.DocumentNumber === '103')?.Sent
      ).toBe(false)
      expect((await call(target, 'GET', '/3/invoices/999/preview')).status).toBe(404)

      const sent = field(
        await jsonOf(await call(target, 'GET', '/3/invoices/104/email')),
        'Invoice'
      )

      expect(field(sent, 'Sent')).toBe(true)
      const email = field(sent, 'EmailInformation')

      // As in the email fixture response, empty copy addresses are left out.
      expect(Predicate.isObject(email) ? Object.keys(email) : []).not.toContain('EmailAddressCC')
      expect(target.snapshot().outbox.map(entry => entry.DocumentNumber)).toEqual(['104'])

      const noRecipient = await emulator({
        seed: {
          customers: [{ CustomerNumber: '1', Name: 'No Email AB' }],
          invoices: [{ DocumentNumber: '1', CustomerNumber: '1' }]
        }
      })

      expect((await call(noRecipient, 'GET', '/3/invoices/1/email')).status).toBe(400)
      expect(noRecipient.snapshot().outbox).toEqual([])
    })
  )

  it.effect('rejects invalid JSON bodies', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const response = await call(target, 'PUT', '/3/customers/1001', { rawBody: '{not json' })

      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe(fortnoxEmulatorErrorCodes.invalidBody)
    })
  )
})

describe('faults', () => {
  it.effect('a route handler that throws answers a tagged 500 ErrorInformation, ledgered', () =>
    Effect.promise(async () => {
      // The unpaidoverdue filter reads the clock inside the handler; the wrapper never does.
      const target = await emulator({
        now: () => {
          throw new Error('synthetic clock failure')
        }
      })

      const before = target.snapshot()

      // The core's own error handler (which logs) is never reached.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let logged = 0

      const failed = await call(target, 'GET', '/3/invoices?filter=unpaidoverdue').finally(() => {
        logged = consoleError.mock.calls.length
        consoleError.mockRestore()
      })

      expect(logged).toBe(0)
      expect(failed.status).toBe(500)
      expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(failed.headers.get('x-emulator-handler-failed')).toBeNull()
      expect(await errorCode(failed)).toBe(fortnoxEmulatorErrorCodes.upstreamError)
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          path: '/3/invoices',
          status: 500,
          evidence: 'unverified',
          responseError: 'the route handler failed'
        })
      ])
      expect(target.snapshot()).toEqual(before)
      expect((await call(target, 'GET', '/3/invoices')).status).toBe(200)
    })
  )

  it.effect('a write handler that throws partway writes nothing', () =>
    Effect.promise(async () => {
      // Sending an invoice by email marks it Sent, then reads the clock for the outbox entry.
      const target = await emulator({
        now: () => {
          throw new Error('synthetic clock failure')
        }
      })

      const before = target.snapshot()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const failed = await call(target, 'GET', '/3/invoices/104/email').finally(() =>
        consoleError.mockRestore()
      )

      expect(failed.status).toBe(500)
      expect(await errorCode(failed)).toBe(fortnoxEmulatorErrorCodes.upstreamError)
      expect(target.ledger.entries()).toEqual([
        expect.objectContaining({
          path: '/3/invoices/104/email',
          status: 500,
          responseError: 'the route handler failed'
        })
      ])
      // Neither the Sent flag nor the outbox entry (nor any counter) reached the state.
      expect(target.snapshot()).toEqual(before)
    })
  )

  it.effect('answer matching requests by method and path, with a count, before any write', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 500,
        match: { method: 'PUT', path: '/3/customers/*' },
        count: 1
      })

      const faulted = await call(target, 'PUT', '/3/customers/1001', {
        body: { Customer: { Comments: 'x' } }
      })

      expect(faulted.status).toBe(500)
      expect(faulted.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await errorCode(faulted)).toBe(fortnoxEmulatorErrorCodes.upstreamError)
      expect(target.snapshot()).toEqual(before)
      expect((await call(target, 'GET', '/3/customers/1001')).status).toBe(200)
      expect(target.faults.list()).toEqual([expect.objectContaining({ remaining: 0, applied: 1 })])
      expect(target.ledger.entries().map(entry => entry.fault)).toEqual(['status', undefined])
      expect(() => target.faults.add({ kind: 'status', status: 99 })).toThrow(
        FortnoxEmulatorInputInvalid
      )
    })
  )

  it.effect(
    'rejects bodiless, redirecting, and framing faults through the JS API and the control plane',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const kept = target.faults.add({ kind: 'status', status: 503, count: 2 })

        const invalid: ReadonlyArray<FortnoxFault> = [
          { kind: 'status', status: 204 },
          { kind: 'status', status: 205 },
          { kind: 'status', status: 101 },
          { kind: 'status', status: 304 },
          { kind: 'status', status: 302, headers: { location: 'https://example.test/' } },
          { kind: 'status', status: 500, headers: { Location: 'https://example.test/' } },
          { kind: 'status', status: 500, headers: { 'content-length': '1' } },
          { kind: 'status', status: 500, headers: { 'Transfer-Encoding': 'chunked' } },
          { kind: 'status', status: 500, headers: { 'bad name': 'x' } },
          { kind: 'status', status: 500, headers: { 'x-synthetic': 'line\nbreak' } }
        ]

        const control = (body: unknown) =>
          target.fetch(
            new Request(`${origin}/_emulate/faults`, { method: 'POST', body: JSON.stringify(body) })
          )

        for (const fault of invalid) {
          expect(() => target.faults.add(fault), JSON.stringify(fault)).toThrow(
            FortnoxEmulatorInputInvalid
          )
          expect((await control(fault)).status, JSON.stringify(fault)).toBe(400)
        }

        // A list with one invalid fault adds none of them.
        expect(
          (
            await control({
              faults: [
                { kind: 'status', status: 500 },
                { kind: 'status', status: 500, headers: { connection: 'close' } }
              ]
            })
          ).status
        ).toBe(400)
        expect(target.faults.list()).toEqual([kept])
      })
  )

  it.effect(
    'a fault response that cannot be built answers a tagged, ledgered 500 and is not consumed',
    () =>
      Effect.promise(async () => {
        const target = await emulator()

        target.faults.add({ kind: 'status', status: 503, count: 1 })

        const RealResponse = globalThis.Response

        // Stands in for any fault response the emulator cannot build.
        class UnbuildableResponse extends RealResponse {
          constructor(bodyInit?: BodyInit | null, init?: ResponseInit) {
            if (init?.status === 503) {
              throw new TypeError('synthetic: cannot build a 503 response')
            }

            super(bodyInit, init)
          }
        }

        vi.stubGlobal('Response', UnbuildableResponse)

        const failed = await call(target, 'GET', '/3/invoices').finally(() => vi.unstubAllGlobals())

        expect(failed.status).toBe(500)
        expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
        expect(await errorCode(failed)).toBe(fortnoxEmulatorErrorCodes.upstreamError)
        expect(target.ledger.entries()).toEqual([
          expect.objectContaining({
            path: '/3/invoices',
            status: 500,
            evidence: 'unverified',
            responseError: expect.any(String)
          })
        ])
        expect(target.ledger.entries()[0]?.fault).toBeUndefined()
        // The fault's answer, not the route, failed.
        expect(target.ledger.entries()[0]?.responseError).toBe(
          'the emulator could not build or produce the response'
        )
        expect(target.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })

        // Once its response can be built, the kept fault applies.
        expect((await call(target, 'GET', '/3/invoices')).status).toBe(503)
        expect(target.faults.list()[0]).toMatchObject({ remaining: 0, applied: 1 })
      })
  )

  it.effect(
    'a 429 with retry-after reaches the connector as fortnox_rate_limited with retryAfterMs',
    () =>
      Effect.gen(function* () {
        const target = yield* Effect.promise(() => emulator())

        target.faults.add({
          kind: 'status',
          status: 429,
          headers: { 'retry-after': '2' },
          match: { path: '/3/invoices' }
        })

        const result = yield* fortnoxListInvoicesAction
          .executeTyped({
            integration: fortnoxConformanceIntegration,
            input: FortnoxListInvoicesInput.make({ limit: 10 })
          })
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                connectorHttpClientsFromEffectHttpClientLayer.pipe(
                  Layer.provide(
                    InProcessHttpClient.layer([
                      EmulatorRoute.handler(new URL(fortnoxApiBaseUrl).origin, target.fetch)
                    ])
                  )
                ),
                staticCredentialResolverLayer(
                  OAuthCredential.make({
                    provider: 'fortnox',
                    accessToken: token,
                    expiresAt: 4_000_000_000_000
                  })
                )
              )
            )
          )

        expect(Predicate.isTagged(result, 'Failure')).toBe(true)

        if (Predicate.isTagged(result, 'Failure')) {
          expect(result.error).toMatchObject({
            code: 'fortnox_rate_limited',
            status: 429,
            retryAfterMs: 2000
          })
        }
      })
  )

  it.effect(
    'a request the route refuses uses up no fault; the next valid one gets it and writes nothing',
    () =>
      Effect.gen(function* () {
        const target = yield* Effect.promise(() => emulator())
        const seeds = fortnoxConformanceFixtureSeeds
        const missing = seeds.missingCustomerNumber ?? FortnoxCustomerNumber.make('99999')
        const customerNumber = seeds.customerNumber ?? FortnoxCustomerNumber.make('1001')
        const layer = connectorLayer(target)
        const before = target.snapshot()

        // Matches every request.
        target.faults.add({ kind: 'status', status: 503, count: 1 })

        // An unknown id: the provider's 404 ErrorInformation.
        const notFound = yield* fortnoxGetCustomerAction
          .executeTyped({
            integration: fortnoxConformanceIntegration,
            input: FortnoxGetCustomerInput.make({ customerNumber: missing })
          })
          .pipe(Effect.provide(layer))

        // A write the state refuses: an invoice for an unknown customer (the rejection fixture's
        // 400 ErrorInformation).
        const rejected = yield* fortnoxCreateInvoiceAction
          .executeTyped({
            integration: fortnoxConformanceIntegration,
            input: FortnoxCreateInvoiceInput.make({ CustomerNumber: missing })
          })
          .pipe(Effect.provide(layer))

        expect(notFound).toMatchObject({
          _tag: 'Failure',
          error: {
            code: 'fortnox_not_found',
            status: 404,
            underlying: { providerCode: fortnoxEmulatorErrorCodes.customerNotFound }
          }
        })
        expect(rejected).toMatchObject({
          _tag: 'Failure',
          error: {
            status: 400,
            underlying: { providerCode: fortnoxEmulatorErrorCodes.invoiceCustomerNotFound }
          }
        })
        expect(target.faults.list()).toEqual([
          expect.objectContaining({ remaining: 1, applied: 0 })
        ])
        expect(target.snapshot()).toEqual(before)

        // The next valid request gets the fault, and its write (a new invoice, which would also
        // advance the document and row counters) is not committed.
        const create = fortnoxCreateInvoiceAction
          .executeTyped({
            integration: fortnoxConformanceIntegration,
            input: FortnoxCreateInvoiceInput.make({ CustomerNumber: customerNumber })
          })
          .pipe(Effect.provide(layer))

        const faulted = yield* create

        expect(faulted).toMatchObject({ _tag: 'Failure', error: { status: 503 } })
        expect(target.faults.list()).toEqual([
          expect.objectContaining({ remaining: 0, applied: 1 })
        ])
        expect(target.snapshot()).toEqual(before)

        // The fault is used up: the same write now commits, under the unchanged counters.
        expect(yield* create).toMatchObject({ _tag: 'Success' })
        expect(target.snapshot().invoices).toHaveLength(before.invoices.length + 1)
        expect(target.snapshot().invoices.map(invoice => invoice.DocumentNumber)).toContain(
          String(before.counters.nextDocumentNumber)
        )

        expect(
          target.ledger.entries().map(({ method, path, route, status, evidence, fault }) => ({
            method,
            path,
            route,
            status,
            evidence,
            fault
          }))
        ).toEqual([
          {
            method: 'GET',
            path: `/3/customers/${missing}`,
            route: '/3/customers/{CustomerNumber}',
            status: 404,
            evidence: 'unverified',
            fault: undefined
          },
          {
            method: 'POST',
            path: '/3/invoices',
            route: '/3/invoices',
            status: 400,
            evidence: 'unverified',
            fault: undefined
          },
          {
            method: 'POST',
            path: '/3/invoices',
            route: '/3/invoices',
            status: 503,
            evidence: 'unverified',
            fault: 'status'
          },
          {
            method: 'POST',
            path: '/3/invoices',
            route: '/3/invoices',
            status: 201,
            evidence: 'unverified',
            fault: undefined
          }
        ])
      })
  )

  it.effect('a refusal before or inside the route never uses up a fault (direct requests)', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      target.faults.add({ kind: 'status', status: 503 })

      const refusals: ReadonlyArray<readonly [string, string, CallOptions, number]> = [
        // Unknown ids: the provider's 404.
        ['GET', '/3/invoices/999', {}, 404],
        ['PUT', '/3/customers/99999', { body: { Customer: { Comments: 'x' } } }, 404],
        ['GET', '/3/invoices/999/email', {}, 404],
        // Invalid state: a booked invoice cannot be updated.
        ['PUT', '/3/invoices/101', { body: { Invoice: { Comments: 'x' } } }, 400],
        // A value the route does not emulate, and a query parameter it does not emulate.
        ['PUT', '/3/customers/1001', { body: { Customer: { Currency: 'EUR' } } }, 400],
        ['GET', '/3/invoices?lastmodified=2026-01-01', {}, 400]
      ]

      for (const [method, path, options, status] of refusals) {
        expect((await call(target, method, path, options)).status, `${method} ${path}`).toBe(status)
      }

      expect(target.faults.list()).toEqual([expect.objectContaining({ applied: 0 })])
      expect(target.snapshot()).toEqual(before)
      expect(target.ledger.entries().map(entry => entry.fault)).toEqual(
        refusals.map(() => undefined)
      )

      // An unlimited fault answers every valid request after them, and none of them writes.
      expect((await call(target, 'GET', '/3/invoices')).status).toBe(503)
      expect(
        (await call(target, 'PUT', '/3/customers/1001', { body: { Customer: { Comments: 'x' } } }))
          .status
      ).toBe(503)
      expect((await call(target, 'GET', '/3/invoices/104/email')).status).toBe(503)
      expect(target.faults.list()).toEqual([expect.objectContaining({ applied: 3 })])
      expect(target.snapshot()).toEqual(before)
    })
  )
})

describe('seeds, profiles, and the control plane', () => {
  it.effect('default seed carries the conformance seed identities', () =>
    Effect.promise(async () => {
      const state = (await emulator()).snapshot()

      const invoice = (documentNumber: string | undefined) =>
        state.invoices.find(candidate => candidate.DocumentNumber === documentNumber)

      expect(state.customers.map(customer => customer.CustomerNumber)).toContain(
        fortnoxConformanceFixtureSeeds.customerNumber
      )
      expect(state.customers.map(customer => customer.CustomerNumber)).not.toContain(
        fortnoxConformanceFixtureSeeds.missingCustomerNumber
      )
      expect(invoice(fortnoxConformanceFixtureSeeds.discountInvoiceDocumentNumber)?.Booked).toBe(
        false
      )
      expect(invoice(fortnoxConformanceFixtureSeeds.previewInvoiceDocumentNumber)).toBeDefined()
      expect(
        invoice(fortnoxConformanceFixtureSeeds.emailInvoiceDocumentNumber)?.EmailInformation
          .EmailAddressTo
      ).toBe(fortnoxConformanceFixtureSeeds.emailRecipient)
      expect(state.counters).toEqual({ nextRowId: 7, nextDocumentNumber: 106 })
    })
  )

  it.effect('profiles vary the account: an empty company fails the list precondition', () =>
    Effect.gen(function* () {
      const empty = yield* Effect.promise(() => emulator({ seed: { profile: 'empty-company' } }))

      expect(yield* Effect.promise(() => call(empty, 'GET', '/3/invoices').then(jsonOf))).toEqual({
        Invoices: [],
        MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 0 }
      })

      yield* TestClock.setTime(now)

      const report = yield* runConformance([fortnoxInvoiceListPopulatedCase], {
        target: { kind: 'in-process' },
        layer: () =>
          Layer.mergeAll(
            connectorHttpClientsFromEffectHttpClientLayer.pipe(
              Layer.provide(InProcessHttpClient.layer([EmulatorRoute.handler(origin, empty.fetch)]))
            ),
            staticCredentialResolverLayer(
              OAuthCredential.make({
                provider: 'fortnox',
                accessToken: token,
                expiresAt: 4_000_000_000_000
              })
            ),
            Layer.succeed(FortnoxConformanceConfig, fortnoxConformanceFixtureSeeds)
          )
      })

      expect(report.results[0]?.status).toBe('failed')
      expect(report.results[0]?.failure?.message).toContain('precondition')

      const unbookedOnly = yield* Effect.promise(() =>
        emulator({ seed: { profile: 'no-booked-invoices' } })
      )

      expect(
        yield* Effect.promise(() =>
          call(unbookedOnly, 'GET', '/3/invoices?filter=unpaid').then(documentNumbers)
        )
      ).toEqual([])
      expect(
        yield* Effect.promise(() =>
          call(unbookedOnly, 'GET', '/3/invoices?filter=unbooked').then(documentNumbers)
        )
      ).toEqual(['101', '102', '103', '104', '105'])
    })
  )

  it.effect('rejects invalid seeds and options', () =>
    Effect.promise(async () => {
      await expect(
        makeFortnoxEmulator({
          seed: { invoices: [{ DocumentNumber: '1', CustomerNumber: '404' }] }
        })
      ).rejects.toBeInstanceOf(FortnoxEmulatorInputInvalid)
      await expect(
        makeFortnoxEmulator({
          seed: {
            customers: [
              { CustomerNumber: '1', Name: 'A' },
              { CustomerNumber: '1', Name: 'B' }
            ]
          }
        })
      ).rejects.toThrow('duplicate CustomerNumber 1')
      await expect(
        makeFortnoxEmulator({ baseUrl: 'https://api.fortnox.se/3' })
      ).rejects.toBeInstanceOf(FortnoxEmulatorInputInvalid)

      const target = await emulator()

      await expect(
        target.seed({ invoices: [{ DocumentNumber: '1', CustomerNumber: '404' }] })
      ).rejects.toBeInstanceOf(FortnoxEmulatorInputInvalid)
    })
  )

  it.effect(
    'reset restores the seed and clears the ledger and faults; seed sets a new baseline',
    () =>
      Effect.promise(async () => {
        const target = await emulator()
        const seeded = target.snapshot()

        await call(target, 'PUT', '/3/customers/1001', {
          body: { Customer: { Comments: 'changed' } }
        })
        await call(target, 'GET', '/3/invoices/104/email')
        target.faults.add({ kind: 'status', status: 503 })

        expect(target.snapshot()).not.toEqual(seeded)

        await target.reset()

        expect(target.snapshot()).toEqual(seeded)
        expect(target.ledger.entries()).toEqual([])
        expect(target.faults.list()).toEqual([])

        await target.seed({ profile: 'empty-company' })
        await call(target, 'GET', '/3/invoices')
        await target.reset()

        expect(target.snapshot().invoices).toEqual([])
      })
  )

  it.effect('serves ledger, faults, reset, state, seed, and coverage under /_emulate', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const control = (method: string, path: string, body?: unknown) =>
        target.fetch(
          new Request(`${origin}/_emulate/${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body)
          })
        )

      expect(
        (await control('POST', 'faults', { faults: [{ kind: 'status', status: 429, count: 1 }] }))
          .status
      ).toBe(201)
      expect((await call(target, 'GET', '/3/invoices')).status).toBe(429)
      expect(field(await jsonOf(await control('GET', 'ledger')), 'entries')).toEqual([
        expect.objectContaining({
          method: 'GET',
          path: '/3/invoices',
          status: 429,
          fault: 'status'
        })
      ])
      expect(await jsonOf(await control('GET', 'coverage'))).toMatchObject({
        unknownRouteRequests: 0
      })
      expect(await jsonOf(await control('DELETE', 'ledger'))).toEqual({ cleared: 1 })
      expect(await jsonOf(await control('DELETE', 'faults'))).toEqual({ cleared: 1 })
      expect(
        (await control('POST', 'faults', { kind: 'status', status: 429, extra: 1 })).status
      ).toBe(400)

      expect(await jsonOf(await control('POST', 'seed', { profile: 'empty-company' }))).toEqual({
        seeded: true,
        customers: 0,
        invoices: 0
      })
      expect(
        field(field(await jsonOf(await control('GET', 'state')), 'state'), 'customers')
      ).toEqual([])
      expect((await control('POST', 'seed', { profile: 'nope' })).status).toBe(400)
      expect(await jsonOf(await control('POST', 'reset'))).toEqual({ reset: true })
      expect(target.snapshot().customers).toEqual([])

      expect((await control('GET', 'reset')).status).toBe(405)
      expect((await control('GET', 'nope')).status).toBe(404)
    })
  )
})
