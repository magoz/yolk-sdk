import { Chunk, Effect, Layer } from 'effect'
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
  OAuthCredential
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
  fortnoxOAuthAuthorizeUrl,
  fortnoxOAuthTokenUrl
} from '@yolk-sdk/connectors/fortnox'

const integration = makeIntegration({
  connectorId: 'fortnox',
  credentialBindings: [
    makeCredentialBinding({ slotId: 'fortnox.oauth', credentialRef: 'host-fortnox-ref' })
  ]
})
const oauth = OAuthCredential.make({
  _tag: 'OAuthCredential',
  provider: 'fortnox',
  accessToken: 'test-access-token',
  expiresAt: 4_000_000_000_000
})
const response = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) =>
  ConnectorHttpResponse.make({ status, headers, body: JSON.stringify(body) })
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
const invoke = (action: string, input: unknown = {}) =>
  FortnoxConnector.invoke({ integration, action, input })

const reads = [
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
const lists = [
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

const decodeListItems = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Union([
      FortnoxListCustomersOutput,
      FortnoxListInvoicesOutput,
      FortnoxListSuppliersOutput,
      FortnoxListSupplierInvoicesOutput
    ])
  )(value).pipe(
    Effect.map(output => {
      if ('customers' in output) return Chunk.toReadonlyArray(output.customers)
      if ('invoices' in output) return Chunk.toReadonlyArray(output.invoices)
      if ('suppliers' in output) return Chunk.toReadonlyArray(output.suppliers)
      return Chunk.toReadonlyArray(output.supplierInvoices)
    })
  )

describe('Fortnox connector', () => {
  it('exports only nine reads and shared resource-scoped OAuth bindings', () => {
    expect(FortnoxConnector.id).toBe('fortnox')
    expect(FortnoxConnector.actions.map(action => action.id).sort()).toEqual(
      [...reads, ...lists].map(item => item.action).sort()
    )
    expect(FortnoxConnector.actions.every(action => action.access === 'read')).toBe(true)
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

  it.effect('adapts all actions to read-only agent tools with object input schemas', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])
      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(FortnoxConnector, { integration, layer: harness.layer })],
        {}
      )
      expect(toolSet.tools).toHaveLength(9)
      for (const tool of toolSet.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
        expect(toolSet.metadata.find(item => item.name === tool.name)?.access).toBe('read')
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
        expect(result).toMatchObject({ _tag: 'Success', value: item.expected })
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
        expect(result).toMatchObject({
          _tag: 'Success',
          value: { pagination: { currentPage: 2, totalPages: 3, totalResources: 5, nextPage: 3 } }
        })
        if (result._tag !== 'Success') throw new Error('Expected list success')
        const items = yield* decodeListItems(result.value)
        expect(items).toMatchObject([item.item])
        const last = yield* invoke(item.action, {
          page: 3,
          limit: 2,
          lastModified: '2026-01-01 12:00'
        }).pipe(Effect.provide(harness.layer))
        if (last._tag !== 'Success') throw new Error('Expected final page success')
        expect(last.value).toMatchObject({ pagination: { currentPage: 3 } })
        expect(last.value).not.toHaveProperty('pagination.nextPage')
        expect(yield* decodeListItems(last.value)).toEqual([])
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
          expect(result).toMatchObject({
            _tag: 'Success',
            value: { pagination: { totalResources: 0 } }
          })
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
      if (invoice._tag !== 'Success' || supplier._tag !== 'Success')
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

  const invalidInputs = [
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
    { action: 'fortnox.list_suppliers', input: { search: { field: 'name', value: '' } } }
  ]
  for (const [index, item] of invalidInputs.entries()) {
    it.effect(`rejects invalid input ${index} before credential resolution or HTTP`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([])
        const result = yield* invoke(item.action, item.input).pipe(
          Effect.provide(harness.layer),
          Effect.result
        )
        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
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
        expect(result).toMatchObject({
          _tag: 'Failure',
          error: {
            code,
            status,
            message: 'Provider detail',
            retryAfterMs: 5000,
            underlying: { providerCode: 2000003 }
          }
        })
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
      expect(result).toMatchObject({
        _tag: 'Failure',
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
        expect(result).toMatchObject({
          _tag: 'Failure',
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
        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
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
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { cause: 'credential_binding_missing' }
      })
      expect(harness.scopes).toHaveLength(0)
      expect(harness.requests).toHaveLength(0)
    })
  )

  for (const credential of [
    ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: 'not-oauth' }),
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
        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'credential_invalid' } })
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
      expect(result).toMatchObject({ _tag: 'Failure', failure: error })
    })
  )
})
