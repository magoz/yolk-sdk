import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ApiKeyCredential,
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  ProviderFailure
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest, RuntimeCredential } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  FortnoxConnector,
  FortnoxCombinedOAuthCredentialSlot,
  FortnoxOAuthCredentialSlot,
  FortnoxInvoice,
  FortnoxSupplierInvoice,
  FortnoxListCustomersOutput,
  FortnoxListInvoicesOutput,
  FortnoxListSuppliersOutput,
  FortnoxListSupplierInvoicesOutput,
  FortnoxListSupplierInvoiceFilesOutput,
  fortnoxOAuthAuthorizeUrl,
  fortnoxOAuthTokenUrl
} from '@yolk-sdk/connectors/fortnox'
import {
  FortnoxInvoiceApi,
  FortnoxSupplierInvoiceApi,
  invoiceFromApi,
  supplierInvoiceFromApi
} from '../src/fortnox/wire.ts'

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

const response = (
  body: Schema.Json,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
) => {
  if (!isJson(body)) throw new TypeError('JSON fixture requires a finite JSON value')

  return ConnectorHttpResponse.make({ status, headers, body: JSON.stringify(body) })
}

const meta = (currentPage = 1, totalPages = 1, totalResources = 1) => ({
  '@CurrentPage': currentPage,
  '@TotalPages': totalPages,
  '@TotalResources': totalResources
})

const makeHarness = (
  responses: ReadonlyArray<ConnectorHttpResponse>,
  credential: RuntimeCredential = oauth
) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: request => {
          expect(request.binding.credentialRef).toBe('host-fortnox-ref')
          expect(request.slot.id).toBe('fortnox.oauth')
          scopes.push(request.slot.requiredScopes)

          return Effect.succeed(credential)
        }
      })
    ),
    Layer.succeed(
      ConnectorHttpClient,
      ConnectorHttpClient.of({
        request: request => {
          requests.push(request)
          const next = responses.at(requests.length - 1)

          return next === undefined
            ? Effect.die(new Error('Unexpected Fortnox HTTP request'))
            : Effect.succeed(next)
        }
      })
    )
  )

  return { layer, requests, scopes }
}

const invoke = (action: string, input: Schema.Json = {}) =>
  FortnoxConnector.invoke({ integration, action, input })

type FortnoxReadInput = {
  readonly customerNumber?: string
  readonly documentNumber?: string
  readonly supplierNumber?: string
  readonly givenNumber?: string
}

const reads: ReadonlyArray<{
  readonly action: string
  readonly input: FortnoxReadInput
  readonly path: string
  readonly scope: string
  readonly body: Schema.Json
  readonly expected: Schema.Json
}> = [
  {
    action: 'fortnox.get_company_information',
    input: {},
    path: 'companyinformation',
    scope: 'companyinformation',
    body: { CompanyInformation: { CompanyName: 'Example AB', OrganizationNumber: '000000-0000' } },
    expected: { CompanyName: 'Example AB' }
  },
  {
    action: 'fortnox.get_customer',
    input: { customerNumber: '001' },
    path: 'customers/001',
    scope: 'customer',
    body: {
      Customer: { CustomerNumber: '001', Name: 'Customer AB', EmailInvoice: 'invoices@example.com' }
    },
    expected: { CustomerNumber: '001', Name: 'Customer AB' }
  },
  {
    action: 'fortnox.get_invoice',
    input: { documentNumber: '002' },
    path: 'invoices/002',
    scope: 'invoice',
    body: {
      Invoice: {
        DocumentNumber: '002',
        CustomerNumber: '001',
        Total: 125.5,
        Balance: 0,
        Sent: false,
        Credit: '0'
      }
    },
    expected: { DocumentNumber: '002', Total: 125.5, Balance: 0, Sent: false }
  },
  {
    action: 'fortnox.get_supplier',
    input: { supplierNumber: '003' },
    path: 'suppliers/003',
    scope: 'supplier',
    body: { Supplier: { SupplierNumber: '003', Name: 'Supplier AB' } },
    expected: { SupplierNumber: '003', Name: 'Supplier AB' }
  },
  {
    action: 'fortnox.get_supplier_invoice',
    input: { givenNumber: '004' },
    path: 'supplierinvoices/004',
    scope: 'supplierinvoice',
    body: {
      SupplierInvoice: {
        GivenNumber: '004',
        SupplierNumber: '003',
        InvoiceNumber: 'INV-2026',
        Total: '125.50',
        Balance: '0.00',
        Credit: false
      }
    },
    expected: { GivenNumber: '004', InvoiceNumber: 'INV-2026', Total: '125.50', Balance: '0.00' }
  }
]

const lists: ReadonlyArray<{
  readonly action: string
  readonly resource: string
  readonly key: string
  readonly scope: string
  readonly item: Schema.Json
}> = [
  {
    action: 'fortnox.list_customers',
    resource: 'customers',
    key: 'Customers',
    scope: 'customer',
    item: { CustomerNumber: '001', Name: 'Customer AB' }
  },
  {
    action: 'fortnox.list_invoices',
    resource: 'invoices',
    key: 'Invoices',
    scope: 'invoice',
    item: { DocumentNumber: '002', CustomerNumber: '001', Total: 125.5 }
  },
  {
    action: 'fortnox.list_suppliers',
    resource: 'suppliers',
    key: 'Suppliers',
    scope: 'supplier',
    item: { SupplierNumber: '003', Name: 'Supplier AB' }
  },
  {
    action: 'fortnox.list_supplier_invoices',
    resource: 'supplierinvoices',
    key: 'SupplierInvoices',
    scope: 'supplierinvoice',
    item: { GivenNumber: '004', SupplierNumber: '003', Total: '125.50' }
  }
]

const FortnoxListOutput = Schema.Union([
  FortnoxListCustomersOutput,
  FortnoxListInvoicesOutput,
  FortnoxListSuppliersOutput,
  FortnoxListSupplierInvoicesOutput
])

const decodeListOutput = Schema.decodeUnknownEffect(FortnoxListOutput)

const listItems = (output: typeof FortnoxListOutput.Type) => {
  if ('customers' in output) return Chunk.toReadonlyArray(output.customers)

  if ('invoices' in output) return Chunk.toReadonlyArray(output.invoices)

  if ('suppliers' in output) return Chunk.toReadonlyArray(output.suppliers)

  return Chunk.toReadonlyArray(output.supplierInvoices)
}

describe('Fortnox connector', () => {
  it('rejects non-finite JSON fixture bodies before stringify', () => {
    expect(() => response(Infinity)).toThrow('JSON fixture requires a finite JSON value')
    expect(() => response({ n: Infinity })).toThrow('JSON fixture requires a finite JSON value')
  })

  it('exports reads and customer/invoice writes with shared resource-scoped OAuth bindings', () => {
    expect(FortnoxConnector.id).toBe('fortnox')
    expect(FortnoxConnector.actions.map(action => action.id).sort()).toEqual(
      [
        ...reads.map(item => item.action),
        ...lists.map(item => item.action),
        'fortnox.list_supplier_invoice_files',
        'fortnox.create_customer',
        'fortnox.update_customer',
        'fortnox.create_invoice',
        'fortnox.update_invoice'
      ].sort()
    )
    expect(
      FortnoxConnector.actions
        .filter(action => action.id.includes('create_') || action.id.includes('update_'))
        .every(action => action.access === 'write')
    ).toBe(true)
    expect(
      FortnoxConnector.actions
        .filter(action => !action.id.includes('create_') && !action.id.includes('update_'))
        .every(action => action.access === 'read')
    ).toBe(true)
    expect(FortnoxOAuthCredentialSlot).toMatchObject({ id: 'fortnox.oauth', kind: 'oauth' })
    expect(FortnoxCombinedOAuthCredentialSlot.requiredScopes).toEqual([
      'companyinformation',
      'customer',
      'invoice',
      'supplier',
      'supplierinvoice'
    ])
    expect(fortnoxOAuthAuthorizeUrl).toBe('https://apps.fortnox.se/oauth-v1/auth')
    expect(fortnoxOAuthTokenUrl).toBe('https://apps.fortnox.se/oauth-v1/token')
  })

  it.effect('adapts all actions to agent tools with object input schemas and access metadata', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(FortnoxConnector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools).toHaveLength(14)

      for (const tool of toolSet.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
        const access = toolSet.metadata.find(item => item.name === tool.name)?.access
        expect(access).toBe(
          tool.name.includes('create_customer') ||
            tool.name.includes('update_customer') ||
            tool.name.includes('create_invoice') ||
            tool.name.includes('update_invoice')
            ? 'write'
            : 'read'
        )
      }

      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  for (const item of reads) {
    it.effect(`${item.action} unwraps the response and uses only its resource scope`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([response(item.body)])
        const result = yield* invoke(item.action, item.input).pipe(Effect.provide(harness.layer))
        const expectedResultFields = { value: item.expected }
        expect(result._tag).toBe('Success')
        expect(result).toMatchObject(expectedResultFields)
        expect(harness.requests).toHaveLength(1)
        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: `https://api.fortnox.se/3/${item.path}`,
          headers: { authorization: 'Bearer test-access-token', accept: 'application/json' }
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([[item.scope]])
      })
    )
  }

  it.effect('creates and updates customers with write metadata and Fortnox envelopes', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ Customer: { CustomerNumber: '001', Name: 'Created AB' } }),
        response({ Customer: { CustomerNumber: '001', Name: 'Updated AB' } })
      ])

      const created = yield* invoke('fortnox.create_customer', {
        Name: 'Created AB',
        Email: 'created@example.com'
      }).pipe(Effect.provide(harness.layer))

      const updated = yield* invoke('fortnox.update_customer', {
        CustomerNumber: '001',
        Name: 'Updated AB',
        Email: 'updated@example.com'
      }).pipe(Effect.provide(harness.layer))

      expect(created).toMatchObject({ value: { CustomerNumber: '001', Name: 'Created AB' } })
      expect(updated).toMatchObject({ value: { CustomerNumber: '001', Name: 'Updated AB' } })

      expect(harness.requests).toHaveLength(2)
      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.fortnox.se/3/customers',
        headers: {
          authorization: 'Bearer test-access-token',
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ Customer: { Name: 'Created AB', Email: 'created@example.com' } })
      })

      expect(harness.requests[1]).toMatchObject({
        method: 'PUT',
        url: 'https://api.fortnox.se/3/customers/001',
        headers: {
          authorization: 'Bearer test-access-token',
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ Customer: { Name: 'Updated AB', Email: 'updated@example.com' } })
      })

      expect(harness.scopes).toEqual([['customer'], ['customer']])
    })
  )

  it.effect('creates and updates invoices with numeric money and runtime Chunk rows', () =>
    Effect.gen(function* () {
      const row = { ArticleNumber: 'A-1', Price: 12.5, DeliveredQuantity: '2.00' }

      const invoice = {
        DocumentNumber: '002',
        CustomerNumber: '001',
        InvoiceRows: [row]
      }

      const harness = makeHarness([response({ Invoice: invoice }), response({ Invoice: invoice })])

      const created = yield* invoke('fortnox.create_invoice', {
        CustomerNumber: '001',
        InvoiceRows: [row]
      }).pipe(Effect.provide(harness.layer))

      const updated = yield* invoke('fortnox.update_invoice', {
        DocumentNumber: '002',
        CustomerNumber: '001',
        InvoiceRows: [row]
      }).pipe(Effect.provide(harness.layer))

      expect(created).toMatchObject({ value: { DocumentNumber: '002' } })
      expect(updated).toMatchObject({ value: { DocumentNumber: '002' } })

      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.fortnox.se/3/invoices',
        headers: { accept: 'application/json', 'content-type': 'application/json' }
      })
      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
        Invoice: { CustomerNumber: '001', InvoiceRows: [row] }
      })

      expect(harness.requests[1]).toMatchObject({
        method: 'PUT',
        url: 'https://api.fortnox.se/3/invoices/002',
        headers: { accept: 'application/json', 'content-type': 'application/json' }
      })
      expect(JSON.parse(harness.requests[1]?.body ?? '')).toEqual({
        Invoice: { CustomerNumber: '001', InvoiceRows: [row] }
      })

      expect(harness.scopes).toEqual([['invoice'], ['invoice']])

      if (!Predicate.isTagged(created, 'Success') || !Predicate.isTagged(updated, 'Success'))
        throw new Error('Expected invoice successes')

      const createdInvoice = yield* Schema.decodeUnknownEffect(FortnoxInvoice)(created.value)
      const updatedInvoice = yield* Schema.decodeUnknownEffect(FortnoxInvoice)(updated.value)

      expect(Chunk.toReadonlyArray(createdInvoice.InvoiceRows ?? Chunk.empty())).toEqual([row])
      expect(Chunk.toReadonlyArray(updatedInvoice.InvoiceRows ?? Chunk.empty())).toEqual([row])
    })
  )

  for (const item of lists) {
    it.effect(`${item.action} returns one page, a next page, then an empty final page`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ [item.key]: [item.item], MetaInformation: meta(2, 3, 5) }),
          response({ [item.key]: [], MetaInformation: meta(3, 3, 5) })
        ])

        const result = yield* invoke(item.action, {
          page: 2,
          limit: 2,
          lastModified: '2026-01-01 12:00'
        }).pipe(Effect.provide(harness.layer))

        expect(result._tag).toBe('Success')
        expect(result).toMatchObject({
          value: { pagination: { currentPage: 2, totalPages: 3, totalResources: 5, nextPage: 3 } }
        })

        if (!Predicate.isTagged(result, 'Success')) throw new Error('Expected list success')
        const items = yield* decodeListOutput(result.value).pipe(Effect.map(listItems))
        expect(items).toMatchObject([item.item])

        const last = yield* invoke(item.action, {
          page: 3,
          limit: 2,
          lastModified: '2026-01-01 12:00'
        }).pipe(Effect.provide(harness.layer))

        if (!Predicate.isTagged(last, 'Success')) throw new Error('Expected final page success')
        expect(last.value).toMatchObject({ pagination: { currentPage: 3 } })
        expect(last.value).not.toHaveProperty('pagination.nextPage')
        expect(yield* decodeListOutput(last.value).pipe(Effect.map(listItems))).toEqual([])
        expect(harness.requests[0]?.url).toBe(
          `https://api.fortnox.se/3/${item.resource}?page=2&limit=2&lastmodified=2026-01-01+12%3A00`
        )
        expect(harness.scopes).toEqual([[item.scope], [item.scope]])
        expect(harness.requests.every(request => request.method === 'GET')).toBe(true)
      })
    )
    it.effect(
      `${item.action} accepts an empty account and leaves pagination defaults to Fortnox`,
      () =>
        Effect.gen(function* () {
          const harness = makeHarness([
            response({ [item.key]: [], MetaInformation: meta(1, 0, 0) })
          ])

          const result = yield* invoke(item.action).pipe(Effect.provide(harness.layer))
          expect(result._tag).toBe('Success')
          expect(result).toMatchObject({ value: { pagination: { totalResources: 0 } } })
          expect(result).not.toHaveProperty('value.pagination.nextPage')
          expect(harness.requests[0]?.url).toBe(`https://api.fortnox.se/3/${item.resource}`)
        })
    )
  }

  it.effect('encodes one resource search field and global filters without query injection', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Invoices: [], MetaInformation: meta(1, 0, 0) })])
      yield* invoke('fortnox.list_invoices', {
        search: { field: 'customername', value: 'A & B/Å?limit=500' },
        filter: 'unpaid',
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
        limit: 500,
        lastModified: '2026-01-01 00:00'
      }).pipe(Effect.provide(harness.layer))
      const request = harness.requests[0]

      if (!request) throw new Error('Expected request')
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        customername: 'A & B/Å?limit=500',
        filter: 'unpaid',
        fromdate: '2026-01-01',
        todate: '2026-12-31',
        limit: '500',
        lastmodified: '2026-01-01 00:00'
      })
    })
  )

  it.effect('encodes path identifiers rather than following provider URLs', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ Customer: { CustomerNumber: 'a/b?#%', Name: 'Test' } })
      ])

      yield* invoke('fortnox.get_customer', { customerNumber: 'a/b?#%' }).pipe(
        Effect.provide(harness.layer)
      )
      expect(harness.requests[0]?.url).toBe('https://api.fortnox.se/3/customers/a%2Fb%3F%23%25')
    })
  )

  it.effect('preserves invoice money types and nullable row fields in runtime Chunks', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          Invoice: {
            DocumentNumber: '2',
            CustomerNumber: '1',
            Total: 100.25,
            InvoiceRows: [
              { RowId: 1, DeliveredQuantity: '2.00', Price: 50.125, Total: null, CostCenter: null }
            ]
          }
        }),
        response({
          SupplierInvoice: {
            GivenNumber: '4',
            SupplierNumber: '3',
            Total: '100.2500',
            Balance: '0.00',
            SupplierInvoiceRows: [{ Debit: 100.25, Credit: 0, Total: null, CostCenter: null }]
          }
        })
      ])

      const invoice = yield* invoke('fortnox.get_invoice', { documentNumber: '2' }).pipe(
        Effect.provide(harness.layer)
      )

      const supplier = yield* invoke('fortnox.get_supplier_invoice', { givenNumber: '4' }).pipe(
        Effect.provide(harness.layer)
      )

      if (!Predicate.isTagged(invoice, 'Success') || !Predicate.isTagged(supplier, 'Success'))
        throw new Error('Expected invoice successes')
      const i = yield* Schema.decodeUnknownEffect(FortnoxInvoice)(invoice.value)
      const s = yield* Schema.decodeUnknownEffect(FortnoxSupplierInvoice)(supplier.value)
      expect(i.Total).toBe(100.25)
      expect(s.Total).toBe('100.2500')
      expect(Chunk.toReadonlyArray(i.InvoiceRows ?? Chunk.empty())).toMatchObject([
        { DeliveredQuantity: '2.00', Total: null, CostCenter: null }
      ])
      expect(Chunk.toReadonlyArray(s.SupplierInvoiceRows ?? Chunk.empty())).toMatchObject([
        { Debit: 100.25, Credit: 0, Total: null }
      ])
    })
  )

  it.effect('omits invoice and supplier invoice rows when the API omits them', () =>
    Effect.gen(function* () {
      const invoiceValue = yield* Schema.decodeUnknownEffect(FortnoxInvoiceApi)({
        DocumentNumber: '2',
        CustomerNumber: '1'
      })

      const supplierValue = yield* Schema.decodeUnknownEffect(FortnoxSupplierInvoiceApi)({
        GivenNumber: '4',
        SupplierNumber: '3',
        Total: '100.2500',
        Balance: '0.00'
      })

      const invoice = invoiceFromApi(invoiceValue)
      const supplier = supplierInvoiceFromApi(supplierValue)

      expect(Object.hasOwn(invoice, 'InvoiceRows')).toBe(false)
      expect(Object.hasOwn(supplier, 'SupplierInvoiceRows')).toBe(false)
      expect(JSON.stringify(invoice)).not.toContain('InvoiceRows')
      expect(JSON.stringify(supplier)).not.toContain('SupplierInvoiceRows')
    })
  )

  const invalidInputs: ReadonlyArray<{
    readonly action: string
    readonly input: Schema.Json
  }> = [
    { action: 'fortnox.get_customer', input: {} },
    ...['', ' ', '.', '..', '\r\n', '\uD800'].map(customerNumber => ({
      action: 'fortnox.get_customer',
      input: { customerNumber }
    })),
    { action: 'fortnox.get_invoice', input: { documentNumber: null } },
    { action: 'fortnox.get_supplier', input: { supplierNumber: 123 } },
    { action: 'fortnox.get_supplier_invoice', input: { givenNumber: 'INV-123' } },
    { action: 'fortnox.get_supplier_invoice', input: { givenNumber: '../2' } },
    { action: 'fortnox.get_supplier_invoice', input: { givenNumber: '4\n' } },
    ...[0, -1, 1.5, '2', null].map(page => ({ action: 'fortnox.list_invoices', input: { page } })),
    ...[0, 501, 1.5].map(limit => ({ action: 'fortnox.list_customers', input: { limit } })),
    { action: 'fortnox.list_invoices', input: { filter: 'pendingpayment' } },
    { action: 'fortnox.list_customers', input: { search: { field: 'limit', value: '5' } } },
    { action: 'fortnox.list_suppliers', input: { search: { field: 'name', value: '' } } },
    { action: 'fortnox.create_customer', input: {} },
    { action: 'fortnox.create_customer', input: { Name: '' } },
    { action: 'fortnox.update_customer', input: { Name: 'Missing number' } },
    { action: 'fortnox.update_customer', input: { CustomerNumber: '' } },
    { action: 'fortnox.update_customer', input: { CustomerNumber: '001', Name: '' } },
    { action: 'fortnox.create_invoice', input: {} },
    { action: 'fortnox.update_invoice', input: { Total: 10 } },
    { action: 'fortnox.update_invoice', input: { DocumentNumber: '' } }
  ]

  for (const [index, item] of invalidInputs.entries()) {
    it.effect(`rejects invalid input ${index} before credential resolution or HTTP`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const result = yield* invoke(item.action, item.input).pipe(
          Effect.provide(harness.layer),
          Effect.result
        )

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )
  }

  for (const [status, code] of [
    [400, 'fortnox_request_failed'],
    [401, 'fortnox_unauthorized'],
    [403, 'fortnox_forbidden'],
    [404, 'fortnox_not_found'],
    [429, 'fortnox_rate_limited'],
    [503, 'fortnox_request_failed']
  ] as const) {
    it.effect(`returns HTTP ${status} as a value-level provider failure without retrying`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response(
            { ErrorInformation: { Code: 2000003, Error: 1, Message: 'Provider detail' } },
            status,
            { 'Retry-After': '5' }
          )
        ])

        const result = yield* invoke('fortnox.get_company_information').pipe(
          Effect.provide(harness.layer)
        )

        const expectedResultFields = {
          error: {
            code,
            status,
            message: 'Provider detail',
            retryAfterMs: 5000,
            underlying: { providerCode: 2000003 }
          }
        }

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject(expectedResultFields)
        expect(harness.requests).toHaveLength(1)
      })
    )
  }

  it.effect('retains lowercase error details from the official responses guide', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response(
          {
            ErrorInformation: { error: 1, message: 'Kan inte hitta kontot.', code: 2000423 }
          },
          404
        )
      ])

      const result = yield* invoke('fortnox.get_company_information').pipe(
        Effect.provide(harness.layer)
      )

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({
        error: {
          code: 'fortnox_not_found',
          message: 'Kan inte hitta kontot.',
          underlying: { providerCode: 2000423 }
        }
      })
    })
  )

  for (const body of [
    '<html>Unavailable</html>',
    '{}',
    '{"ErrorInformation":{"Code":"bad","Message":null}}'
  ]) {
    it.effect('keeps malformed provider error bodies as failures without exposing raw bodies', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          ConnectorHttpResponse.make({ status: 502, body, headers: { 'retry-after': 'invalid' } })
        ])

        const result = yield* invoke('fortnox.get_company_information').pipe(
          Effect.provide(harness.layer)
        )

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({
          error: { code: 'fortnox_request_failed', message: 'Fortnox request failed (HTTP 502)' }
        })
        expect(result).not.toHaveProperty('error.underlying')
        expect(result).not.toHaveProperty('error.retryAfterMs')
      })
    )
  }

  for (const body of [
    'not json',
    '{}',
    '{"Customers":[]}',
    '{"Customers":[{"Name":"Missing number"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":1}}',
    '{"Customers":[],"MetaInformation":{"@CurrentPage":0,"@TotalPages":1,"@TotalResources":1}}'
  ]) {
    it.effect('rejects malformed success data rather than fabricating an empty result', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          ConnectorHttpResponse.make({ status: 200, body, headers: {} })
        ])

        const result = yield* invoke('fortnox.list_customers').pipe(
          Effect.provide(harness.layer),
          Effect.result
        )

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      })
    )
  }

  it.effect('fails missing bindings before resolving credentials or making HTTP calls', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const result = yield* FortnoxConnector.invoke({
        integration: makeIntegration({ connectorId: 'fortnox' }),
        action: 'fortnox.get_company_information',
        input: {}
      }).pipe(Effect.provide(harness.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: { cause: 'credential_binding_missing' } })
      expect(harness.scopes).toHaveLength(0)
      expect(harness.requests).toHaveLength(0)
    })
  )

  for (const credential of [
    ApiKeyCredential.make({ key: 'not-oauth' }),
    OAuthCredential.make({ ...oauth, provider: 'google' }),
    OAuthCredential.make({ ...oauth, accessToken: '' }),
    OAuthCredential.make({ ...oauth, accessToken: 'a\r\nb' })
  ]) {
    it.effect('rejects wrong credential kinds, providers, or unsafe tokens without HTTP', () =>
      Effect.gen(function* () {
        const harness = makeHarness([], credential)

        const result = yield* invoke('fortnox.get_company_information').pipe(
          Effect.provide(harness.layer),
          Effect.result
        )

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'credential_invalid' } })
        expect(harness.requests).toHaveLength(0)
      })
    )
  }

  it.effect('preserves host transport errors in the typed Effect channel', () =>
    Effect.gen(function* () {
      const error = new ConnectorError({
        cause: 'transport_failed',
        message: 'Host transport failed'
      })

      const credentialLayer = Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({ resolve: () => Effect.succeed(oauth) })
      )

      const httpLayer = Layer.succeed(
        ConnectorHttpClient,
        ConnectorHttpClient.of({ request: () => Effect.fail(error) })
      )

      const result = yield* invoke('fortnox.get_company_information').pipe(
        Effect.provide(Layer.mergeAll(credentialLayer, httpLayer)),
        Effect.result
      )

      const expectedResultFields = { failure: error }
      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject(expectedResultFields)
    })
  )
})

it.effect(
  'discovers supplier files by internal GivenNumber with explicit pagination and connectfile consent',
  () =>
    Effect.gen(function* () {
      const h = makeHarness([
        response({
          SupplierInvoiceFileConnections: [
            {
              FileId: 'file-id',
              Name: 'invoice.pdf',
              SupplierInvoiceNumber: '42',
              '@url': 'https://secret.example/'
            }
          ],
          MetaInformation: meta(2, 3, 11)
        })
      ])

      const result = yield* invoke('fortnox.list_supplier_invoice_files', {
        givenNumber: '42',
        page: 2,
        limit: 5
      }).pipe(Effect.provide(h.layer))

      expect(h.requests[0]?.url).toBe(
        'https://api.fortnox.se/3/supplierinvoicefileconnections?supplierinvoicenumber=42&page=2&limit=5'
      )
      expect(h.scopes).toEqual([['connectfile']])

      if (!Predicate.isTagged(result, 'Success')) return yield* Effect.die('Expected metadata')

      const value = yield* Schema.decodeUnknownEffect(FortnoxListSupplierInvoiceFilesOutput)(
        result.value
      )

      expect(value.pagination.nextPage).toBe(3)
      expect(Chunk.toReadonlyArray(value.files)).toMatchObject([
        { fileId: 'file-id', givenNumber: '42' }
      ])
      expect(JSON.stringify(value)).not.toContain('secret.example')
    })
)

it.effect('keeps Fortnox pagination and provider-failure omission, zero retry, and key order', () =>
  Effect.gen(function* () {
    const present = yield* invoke('fortnox.list_customers', { page: 2 }).pipe(
      Effect.provide(
        makeHarness([
          response({
            Customers: [{ CustomerNumber: '001', Name: 'Acme' }],
            MetaInformation: meta(2, 3, 5)
          })
        ]).layer
      )
    )

    const last = yield* invoke('fortnox.list_customers', { page: 3 }).pipe(
      Effect.provide(
        makeHarness([
          response({
            Customers: [],
            MetaInformation: meta(3, 3, 5)
          })
        ]).layer
      )
    )

    const emptyAccount = yield* invoke('fortnox.list_customers').pipe(
      Effect.provide(
        makeHarness([
          response({
            Customers: [],
            MetaInformation: meta(1, 0, 0)
          })
        ]).layer
      )
    )

    const rateLimited = yield* invoke('fortnox.get_company_information').pipe(
      Effect.provide(
        makeHarness([
          response(
            { ErrorInformation: { Code: 2000003, Error: 1, Message: 'Provider detail' } },
            429,
            { 'Retry-After': '5' }
          )
        ]).layer
      )
    )

    const zeroRetry = yield* invoke('fortnox.get_company_information').pipe(
      Effect.provide(
        makeHarness([
          response(
            { ErrorInformation: { Code: 2000003, Error: 1, Message: 'Provider detail' } },
            429,
            { 'Retry-After': '0' }
          )
        ]).layer
      )
    )

    const lowercase = yield* invoke('fortnox.get_company_information').pipe(
      Effect.provide(
        makeHarness([
          response(
            {
              ErrorInformation: { error: 1, message: 'Kan inte hitta kontot.', code: 2000423 }
            },
            404
          )
        ]).layer
      )
    )

    const malformed = yield* invoke('fortnox.get_company_information').pipe(
      Effect.provide(
        makeHarness([
          ConnectorHttpResponse.make({
            status: 502,
            body: '<html>Unavailable</html>',
            headers: { 'retry-after': 'invalid' }
          })
        ]).layer
      )
    )

    expect(present._tag).toBe('Success')
    expect(JSON.stringify(present)).toBe(
      '{"_tag":"Success","value":{"customers":{"_id":"Chunk","values":[{"CustomerNumber":"001","Name":"Acme"}]},"pagination":{"currentPage":2,"totalPages":3,"totalResources":5,"nextPage":3}}}'
    )
    expect(last).not.toHaveProperty('value.pagination.nextPage')
    expect(JSON.stringify(last)).toBe(
      '{"_tag":"Success","value":{"customers":{"_id":"Chunk","values":[]},"pagination":{"currentPage":3,"totalPages":3,"totalResources":5}}}'
    )
    expect(emptyAccount).not.toHaveProperty('value.pagination.nextPage')
    expect(JSON.stringify(emptyAccount)).toBe(
      '{"_tag":"Success","value":{"customers":{"_id":"Chunk","values":[]},"pagination":{"currentPage":1,"totalPages":0,"totalResources":0}}}'
    )

    if (
      !Predicate.isTagged(rateLimited, 'Failure') ||
      !Predicate.isTagged(zeroRetry, 'Failure') ||
      !Predicate.isTagged(lowercase, 'Failure') ||
      !Predicate.isTagged(malformed, 'Failure')
    ) {
      throw new Error('Expected Fortnox provider failures')
    }

    expect(rateLimited.error).toBeInstanceOf(ProviderFailure)
    expect(JSON.stringify(rateLimited)).toBe(
      '{"_tag":"Failure","error":{"code":"fortnox_rate_limited","message":"Provider detail","status":429,"retryAfterMs":5000,"underlying":{"providerCode":2000003}}}'
    )
    expect(Object.keys(rateLimited.error)).toEqual([
      'code',
      'message',
      'status',
      'retryAfterMs',
      'underlying'
    ])

    expect(JSON.stringify(zeroRetry)).toBe(
      '{"_tag":"Failure","error":{"code":"fortnox_rate_limited","message":"Provider detail","status":429,"retryAfterMs":0,"underlying":{"providerCode":2000003}}}'
    )
    expect(lowercase.error).toBeInstanceOf(ProviderFailure)
    expect(lowercase).not.toHaveProperty('error.retryAfterMs')
    expect(JSON.stringify(lowercase)).toBe(
      '{"_tag":"Failure","error":{"code":"fortnox_not_found","message":"Kan inte hitta kontot.","status":404,"underlying":{"providerCode":2000423}}}'
    )
    expect(malformed.error).toBeInstanceOf(ProviderFailure)
    expect(malformed).not.toHaveProperty('error.underlying')
    expect(malformed).not.toHaveProperty('error.retryAfterMs')
    expect(JSON.stringify(malformed)).toBe(
      '{"_tag":"Failure","error":{"code":"fortnox_request_failed","message":"Fortnox request failed (HTTP 502)","status":502}}'
    )
    expect(Object.keys(malformed.error)).toEqual(['code', 'message', 'status'])
  })
)
