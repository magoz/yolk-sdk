import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorBinaryHttpClient,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  defineConnector,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type {
  ActionResultType,
  ConnectorAction,
  ConnectorBinaryHttpRequest,
  ConnectorBinaryHttpResponse,
  ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  downloadFortnoxOfferPreview,
  FortnoxCreateOfferInput,
  FortnoxCreateOrderFromOfferOutput,
  FortnoxListOffersOutput,
  FortnoxOffer,
  FortnoxOfferRowInput,
  fortnoxCancelOfferAction,
  fortnoxCreateInvoiceFromOfferAction,
  fortnoxCreateOfferAction,
  fortnoxCreateOrderFromOfferAction,
  fortnoxEmailOfferAction,
  fortnoxGetOfferAction,
  fortnoxListOffersAction,
  fortnoxMarkOfferSentAction,
  fortnoxOfferActions,
  fortnoxUpdateOfferAction
} from '../src/fortnox/offers.ts'
import { FortnoxCustomerNumber, FortnoxDocumentNumber } from '../src/fortnox/schemas.ts'

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

const makeHarness = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
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

          return Effect.succeed(oauth)
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

const jsonHeaders = {
  authorization: 'Bearer test-access-token',
  accept: 'application/json',
  'content-type': 'application/json'
}

const bodylessHeaders = { authorization: 'Bearer test-access-token', accept: 'application/json' }

// Shapes follow the Fortnox docs examples: list rows carry Project 0 and numeric totals, single
// offers carry string row quantities and numeric references.
const offerListItem = {
  '@url': 'https://api.fortnox.se/3/offers/7',
  Cancelled: false,
  Currency: 'SEK',
  CustomerName: 'Example AB',
  CustomerNumber: '1',
  DocumentNumber: '7',
  OfferDate: '2026-01-18',
  Project: 0,
  Sent: false,
  Total: '3738.50'
}

const offerRow = {
  AccountNumber: 3011,
  ArticleNumber: 'A-1',
  ContributionPercent: 100,
  CostCenter: '',
  Description: 'Example item',
  Discount: 0,
  DiscountType: 'PERCENT',
  HouseWork: false,
  Price: 299,
  Project: '',
  Quantity: '5.00',
  RowId: 11,
  Total: 1495,
  Unit: 'st',
  VAT: 25
}

const offer = {
  '@url': 'https://api.fortnox.se/3/offers/7',
  AdministrationFee: 0,
  Cancelled: false,
  Comments: '',
  Currency: 'SEK',
  CurrencyRate: 1,
  CustomerName: 'Example AB',
  CustomerNumber: '1',
  DeliveryDate: null,
  DocumentNumber: '7',
  EmailInformation: {
    EmailAddressFrom: null,
    EmailAddressTo: 'customer@example.test',
    EmailAddressCC: null,
    EmailAddressBCC: null,
    EmailSubject: 'Offert {no} bifogas',
    EmailBody: ' '
  },
  ExpireDate: '2026-02-18',
  Gross: 1495,
  InvoiceReference: 0,
  Net: 1495,
  NotCompleted: false,
  OfferDate: '2026-01-18',
  OfferRows: [offerRow],
  OrderReference: 0,
  OurReference: 'Example Seller',
  Project: '',
  Remarks: '',
  Sent: false,
  Total: 1869,
  TotalToPay: 1869,
  TotalVAT: 373.75,
  VATIncluded: false,
  YourReference: ''
}

type OfferAction = ConnectorAction<CredentialResolver | ConnectorHttpClient, unknown>

// `execute` is the dynamic wire boundary (agent tools and connector invoke use it).
const run = (
  action: OfferAction,
  input: unknown,
  layer: Layer.Layer<CredentialResolver | ConnectorHttpClient>
) => action.execute({ integration, input }).pipe(Effect.provide(layer))

const success = <S extends Schema.ConstraintDecoder<unknown>>(
  result: ActionResultType<unknown>,
  schema: S
) =>
  Effect.gen(function* () {
    if (!Predicate.isTagged(result, 'Success'))
      throw new Error(`Expected success, got ${JSON.stringify(result)}`)

    return yield* Schema.decodeUnknownEffect(schema)(result.value)
  })

describe('Fortnox offers', () => {
  it('rejects non-finite JSON fixture bodies before stringify', () => {
    expect(() => response(Infinity)).toThrow('JSON fixture requires a finite JSON value')
  })

  it('exports offer actions in stable order with declared access', () => {
    expect(fortnoxOfferActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.list_offers', 'read'],
      ['fortnox.get_offer', 'read'],
      ['fortnox.create_offer', 'write'],
      ['fortnox.update_offer', 'write'],
      ['fortnox.create_order_from_offer', 'destructive'],
      ['fortnox.create_invoice_from_offer', 'destructive'],
      ['fortnox.cancel_offer', 'destructive'],
      ['fortnox.email_offer', 'destructive'],
      ['fortnox.mark_offer_sent', 'destructive']
    ])

    for (const action of fortnoxOfferActions) {
      if (action.access === 'destructive') expect(action.description).toContain('cannot be undone')
    }

    expect(fortnoxOfferActions.map(action => action.id)).not.toContain('fortnox.print_offer')
  })

  it.effect('lowers every input and output schema to agent tools', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const connector = defineConnector({
        id: 'fortnox',
        description: 'Fortnox offers.',
        actions: fortnoxOfferActions
      })

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(connector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools).toHaveLength(fortnoxOfferActions.length)

      for (const tool of toolSet.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
      }

      const create = toolSet.tools.find(tool => tool.name === 'fortnox.create_offer')
      expect(create?.parameters).toMatchObject({ type: 'object', additionalProperties: false })

      const keys = Object.keys(
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) })
        )(create?.parameters).pipe(Effect.map(value => value.properties))
      )

      expect(keys).toEqual(expect.arrayContaining(['CustomerNumber', 'OfferRows']))

      for (const readOnly of ['Cancelled', 'Sent', 'Total', 'OrderReference', 'InvoiceReference'])
        expect(keys).not.toContain(readOnly)

      expect(harness.requests).toHaveLength(0)
    })
  )

  it.effect('list_offers sends pagination, one search field, filter, and dates', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ Offers: [offerListItem], MetaInformation: meta(2, 3, 5) })
      ])

      const result = yield* run(
        fortnoxListOffersAction,
        {
          page: 2,
          limit: 2,
          lastModified: '2026-01-01 12:00',
          search: { field: 'customername', value: 'A & B/Å?limit=500' },
          filter: 'ordernotcreated',
          fromDate: '2026-01-01',
          toDate: '2026-12-31'
        },
        harness.layer
      )

      const request = harness.requests[0]

      if (request === undefined) throw new Error('Expected request')
      expect(request).toMatchObject({ method: 'GET', headers: bodylessHeaders })
      expect(request.body).toBeUndefined()
      expect(request.url.startsWith('https://api.fortnox.se/3/offers?')).toBe(true)
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        page: '2',
        limit: '2',
        lastmodified: '2026-01-01 12:00',
        customername: 'A & B/Å?limit=500',
        filter: 'ordernotcreated',
        fromdate: '2026-01-01',
        todate: '2026-12-31'
      })
      expect(harness.scopes).toEqual([['offer']])

      const output = yield* success(result, FortnoxListOffersOutput)
      expect(output.pagination).toEqual({
        currentPage: 2,
        totalPages: 3,
        totalResources: 5,
        nextPage: 3
      })
      const [item] = Chunk.toReadonlyArray(output.offers)
      expect(item).toMatchObject({
        DocumentNumber: '7',
        CustomerNumber: '1',
        Total: 3738.5,
        Project: '0',
        Sent: false
      })
      expect(item?.OfferRows).toBeUndefined()
    })
  )

  it.effect('list_offers without input sends no query and decodes an empty page', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Offers: [], MetaInformation: meta(1, 0, 0) })])
      const result = yield* run(fortnoxListOffersAction, {}, harness.layer)
      const output = yield* success(result, FortnoxListOffersOutput)

      expect(harness.requests[0]?.url).toBe('https://api.fortnox.se/3/offers')
      expect(Chunk.toReadonlyArray(output.offers)).toEqual([])
      expect(output.pagination.nextPage).toBeUndefined()
    })
  )

  for (const body of [
    '{"Offers":[]}',
    '{"Offers":[{"DocumentNumber":"7"}],"MetaInformation":{}}'
  ]) {
    it.effect('list_offers fails instead of assuming a final page or inventing a customer', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          ConnectorHttpResponse.make({ status: 200, body, headers: {} })
        ])

        const result = yield* run(fortnoxListOffersAction, {}, harness.layer).pipe(Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      })
    )
  }

  it.effect('get_offer encodes the offer number and decodes rows, amounts, and email info', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ Offer: offer }),
        response({ Offer: { ...offer, DocumentNumber: 'a/b?#%' } })
      ])

      const result = yield* run(fortnoxGetOfferAction, { documentNumber: '7' }, harness.layer)

      yield* run(fortnoxGetOfferAction, { documentNumber: 'a/b?#%' }, harness.layer)

      expect(harness.requests.map(request => [request.method, request.url])).toEqual([
        ['GET', 'https://api.fortnox.se/3/offers/7'],
        ['GET', 'https://api.fortnox.se/3/offers/a%2Fb%3F%23%25']
      ])
      expect(harness.scopes).toEqual([['offer'], ['offer']])

      const output = yield* success(result, FortnoxOffer)
      expect(output).toMatchObject({
        DocumentNumber: '7',
        CustomerNumber: '1',
        Total: 1869,
        TotalVAT: 373.75,
        DeliveryDate: null,
        OrderReference: '0',
        InvoiceReference: '0',
        EmailInformation: { EmailAddressTo: 'customer@example.test', EmailAddressFrom: null }
      })
      expect(output.EmailInformation).not.toHaveProperty('EmailBody')
      expect(Chunk.toReadonlyArray(output.OfferRows ?? Chunk.empty())).toEqual([
        expect.objectContaining({
          RowId: 11,
          AccountNumber: 3011,
          Quantity: 5,
          Price: 299,
          DiscountType: 'PERCENT',
          Project: ''
        })
      ])
    })
  )

  it.effect('create_offer posts only the provided writable fields', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Offer: offer }, 201)])

      const input = {
        CustomerNumber: '1',
        OfferDate: '2026-01-18',
        ExpireDate: '2026-02-18',
        YourReference: 'Example Buyer',
        OfferRows: [
          {
            ArticleNumber: 'A-1',
            Quantity: 5,
            Price: 299,
            Discount: 10,
            DiscountType: 'PERCENT',
            AccountNumber: 3011,
            VAT: 25
          }
        ]
      }

      const result = yield* run(fortnoxCreateOfferAction, input, harness.layer)

      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.fortnox.se/3/offers',
        headers: jsonHeaders
      })
      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({ Offer: input })
      expect(harness.scopes).toEqual([['offer']])
      expect(yield* success(result, FortnoxOffer)).toMatchObject({ DocumentNumber: '7' })
    })
  )

  it.effect('create_offer accepts typed input built from the exported classes', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Offer: offer }, 201)])

      yield* fortnoxCreateOfferAction
        .executeTyped({
          integration,
          input: FortnoxCreateOfferInput.make({
            CustomerNumber: FortnoxCustomerNumber.make('1'),
            OfferRows: [FortnoxOfferRowInput.make({ Description: 'Example item', Quantity: 1 })]
          })
        })
        .pipe(Effect.provide(harness.layer))

      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
        Offer: { CustomerNumber: '1', OfferRows: [{ Description: 'Example item', Quantity: 1 }] }
      })
    })
  )

  it.effect('update_offer binds DocumentNumber into the URL and sends RowId rows', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Offer: offer })])

      const result = yield* run(
        fortnoxUpdateOfferAction,
        {
          DocumentNumber: '7',
          Comments: 'Updated',
          OfferRows: [{ RowId: 11 }, { Description: 'Added row', Quantity: 2 }]
        },
        harness.layer
      )

      expect(harness.requests[0]).toMatchObject({
        method: 'PUT',
        url: 'https://api.fortnox.se/3/offers/7',
        headers: jsonHeaders
      })
      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
        Offer: {
          Comments: 'Updated',
          OfferRows: [{ RowId: 11 }, { Description: 'Added row', Quantity: 2 }]
        }
      })
      expect(result._tag).toBe('Success')
    })
  )

  const conversions = [
    {
      action: fortnoxCreateOrderFromOfferAction,
      path: 'createorder',
      key: 'OrderReference',
      envelope: 'Order',
      output: 'orderNumber'
    },
    {
      action: fortnoxCreateInvoiceFromOfferAction,
      path: 'createinvoice',
      key: 'InvoiceReference',
      envelope: 'Invoice',
      output: 'invoiceNumber'
    }
  ] as const

  for (const item of conversions) {
    it.effect(`${item.action.id} PUTs ${item.path} without a body and returns both numbers`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ Offer: { ...offer, [item.key]: 12 } }),
          response({ Offer: { ...offer, [item.key]: '13' } }),
          response({ Offer: { ...offer, [item.key]: 0 } }),
          response({ Offer: { ...offer, [item.key]: '0' } }),
          response({ Offer: { DocumentNumber: '7' } })
        ])

        const outputs: Array<unknown> = []

        for (let index = 0; index < 5; index++) {
          const result = yield* run(item.action, { documentNumber: '7' }, harness.layer)

          if (!Predicate.isTagged(result, 'Success')) throw new Error('Expected success')
          outputs.push(result.value)
        }

        expect(outputs).toEqual([
          { offerNumber: '7', [item.output]: '12' },
          { offerNumber: '7', [item.output]: '13' },
          { offerNumber: '7', [item.output]: null },
          { offerNumber: '7', [item.output]: null },
          { offerNumber: '7', [item.output]: null }
        ])

        for (const request of harness.requests) {
          expect(request).toMatchObject({
            method: 'PUT',
            url: `https://api.fortnox.se/3/offers/7/${item.path}`,
            headers: bodylessHeaders
          })
          expect(request.headers).not.toHaveProperty('content-type')
          expect(request.body).toBeUndefined()
        }

        expect(harness.scopes).toEqual(Array.from({ length: 5 }, () => ['offer']))
      })
    )

    it.effect(`${item.action.id} also accepts the new document's own envelope`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ [item.envelope]: { DocumentNumber: '21', CustomerNumber: '1' } }),
          response({ [item.envelope]: { DocumentNumber: 22 } })
        ])

        const first = yield* run(item.action, { documentNumber: '7' }, harness.layer)
        const second = yield* run(item.action, { documentNumber: '7' }, harness.layer)

        expect(first).toMatchObject({ value: { offerNumber: '7', [item.output]: '21' } })
        expect(second).toMatchObject({ value: { offerNumber: '7', [item.output]: '22' } })
      })
    )
  }

  it.effect('create_order_from_offer output decodes with its public schema', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Offer: { ...offer, OrderReference: '12' } })])

      const result = yield* run(
        fortnoxCreateOrderFromOfferAction,
        { documentNumber: '7' },
        harness.layer
      )

      expect(yield* success(result, FortnoxCreateOrderFromOfferOutput)).toEqual(
        FortnoxCreateOrderFromOfferOutput.make({
          offerNumber: FortnoxDocumentNumber.make('7'),
          orderNumber: FortnoxDocumentNumber.make('12')
        })
      )
    })
  )

  const lifecycle = [
    { action: fortnoxCancelOfferAction, method: 'PUT', path: 'cancel' },
    { action: fortnoxMarkOfferSentAction, method: 'PUT', path: 'externalprint' },
    { action: fortnoxEmailOfferAction, method: 'GET', path: 'email' }
  ] as const

  for (const item of lifecycle) {
    it.effect(`${item.action.id} sends ${item.method} ${item.path} without a body`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ Offer: { ...offer, Cancelled: item.path === 'cancel', Sent: true } })
        ])

        const result = yield* run(item.action, { documentNumber: 'a/b' }, harness.layer)

        expect(harness.requests).toHaveLength(1)
        expect(harness.requests[0]).toMatchObject({
          method: item.method,
          url: `https://api.fortnox.se/3/offers/a%2Fb/${item.path}`,
          headers: bodylessHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([['offer']])
        expect(yield* success(result, FortnoxOffer)).toMatchObject({
          DocumentNumber: '7',
          Sent: true,
          Cancelled: item.path === 'cancel'
        })
      })
    )
  }

  const invalidInputs: ReadonlyArray<{
    readonly action: OfferAction
    readonly input: unknown
  }> = [
    { action: fortnoxGetOfferAction, input: { documentNumber: '' } },
    { action: fortnoxGetOfferAction, input: { documentNumber: '..' } },
    { action: fortnoxCreateOfferAction, input: {} },
    { action: fortnoxCreateOfferAction, input: { CustomerNumber: '1', Cancelled: true } },
    { action: fortnoxCreateOfferAction, input: { CustomerNumber: '1', Sent: true } },
    { action: fortnoxCreateOfferAction, input: { CustomerNumber: '1', Total: 10 } },
    { action: fortnoxCreateOfferAction, input: { CustomerNumber: '1', OrderReference: '2' } },
    { action: fortnoxCreateOfferAction, input: { CustomerNumber: '1', Comments: null } },
    {
      action: fortnoxCreateOfferAction,
      input: { CustomerNumber: '1', OfferRows: [{ DiscountType: 'FIXED' }] }
    },
    {
      action: fortnoxCreateOfferAction,
      input: { CustomerNumber: '1', OfferRows: [{ Total: 10 }] }
    },
    {
      action: fortnoxCreateOfferAction,
      input: { CustomerNumber: '1', OfferRows: [{ Price: null }] }
    },
    { action: fortnoxUpdateOfferAction, input: { Comments: 'Missing number' } },
    { action: fortnoxUpdateOfferAction, input: { DocumentNumber: '.', Comments: 'x' } },
    { action: fortnoxCreateOrderFromOfferAction, input: {} },
    { action: fortnoxCreateOrderFromOfferAction, input: { documentNumber: '..' } },
    { action: fortnoxCreateInvoiceFromOfferAction, input: { documentNumber: '7', extra: true } },
    { action: fortnoxCancelOfferAction, input: { documentNumber: '7', reason: 'x' } },
    {
      action: fortnoxEmailOfferAction,
      input: { documentNumber: '7', EmailAddressTo: 'other@example.test' }
    },
    { action: fortnoxMarkOfferSentAction, input: { documentNumber: null } }
  ]

  for (const [index, item] of invalidInputs.entries()) {
    it.effect(`${item.action.id} rejects invalid input ${index} before credentials or HTTP`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const result = yield* run(item.action, item.input, harness.layer).pipe(Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )
  }

  it.effect('maps non-2xx answers to value-level provider failures', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ ErrorInformation: { Code: 2000434, Message: 'Offer not found' } }, 404),
        response({ ErrorInformation: { code: 2000123, message: 'Already converted' } }, 400)
      ])

      const missing = yield* run(fortnoxGetOfferAction, { documentNumber: '99' }, harness.layer)

      const rejected = yield* run(
        fortnoxCreateOrderFromOfferAction,
        { documentNumber: '7' },
        harness.layer
      )

      expect(missing).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'fortnox_not_found',
          status: 404,
          message: 'Offer not found',
          underlying: { providerCode: 2000434 }
        }
      })
      expect(rejected).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_request_failed', status: 400, message: 'Already converted' }
      })
    })
  )
})

describe('downloadFortnoxOfferPreview', () => {
  const budget = { maxBytes: 64, maxMetadataBytes: 2000, maxErrorBodyBytes: 32 }

  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

  const binary = (body: Uint8Array, status = 200): ConnectorBinaryHttpResponse => ({
    bytes: body,
    status,
    headers: { 'content-type': 'application/octet-stream' },
    bodyComplete: true
  })

  const host = (responses: ReadonlyArray<ConnectorBinaryHttpResponse>) => {
    const requests: Array<ConnectorBinaryHttpRequest> = []
    const scopes: Array<ReadonlyArray<string> | undefined> = []

    return {
      requests,
      scopes,
      layer: Layer.mergeAll(
        Layer.succeed(CredentialResolver, {
          resolve: request => {
            scopes.push(request.slot.requiredScopes)

            return Effect.succeed(oauth)
          }
        }),
        Layer.succeed(ConnectorBinaryHttpClient, {
          request: request => {
            const next = responses[requests.length] ?? binary(new Uint8Array(), 500)
            requests.push(request)

            return Effect.succeed(next)
          }
        })
      )
    }
  }

  it.effect('downloads the generated PDF from /preview with the offer scope', () =>
    Effect.gen(function* () {
      const h = host([binary(pdfBytes)])

      const result = yield* downloadFortnoxOfferPreview(
        integration,
        { documentNumber: FortnoxDocumentNumber.make('a/b') },
        budget
      ).pipe(Effect.provide(h.layer))

      expect(result).toEqual({
        bytes: pdfBytes,
        byteLength: pdfBytes.byteLength,
        source: { id: 'a/b', generatedPreview: true }
      })
      expect(h.requests.map(request => request.url)).toEqual([
        'https://api.fortnox.se/3/offers/a%2Fb/preview'
      ])
      expect(h.requests[0]?.headers).toEqual({ authorization: 'Bearer test-access-token' })
      expect(h.scopes).toEqual([['offer']])
    })
  )

  it.effect('rejects non-PDF bodies and failed statuses', () =>
    Effect.gen(function* () {
      const h = host([
        binary(new TextEncoder().encode('{"ErrorInformation":{}}')),
        binary(pdfBytes, 404)
      ])

      const notPdf = yield* downloadFortnoxOfferPreview(
        integration,
        { documentNumber: FortnoxDocumentNumber.make('7') },
        budget
      ).pipe(Effect.provide(h.layer), Effect.result)

      const missing = yield* downloadFortnoxOfferPreview(
        integration,
        { documentNumber: FortnoxDocumentNumber.make('7') },
        budget
      ).pipe(Effect.provide(h.layer), Effect.result)

      expect(notPdf).toMatchObject({ _tag: 'Failure', failure: { code: 'invalid_metadata' } })
      expect(missing).toMatchObject({ _tag: 'Failure', failure: { status: 404 } })
    })
  )

  it.effect('rejects invalid offer numbers before credentials or HTTP', () =>
    Effect.gen(function* () {
      const h = host([])

      for (const documentNumber of ['', '..', ' 7']) {
        const result = yield* downloadFortnoxOfferPreview(
          integration,
          // Runtime input from an untyped host boundary.
          Object.assign({ documentNumber: FortnoxDocumentNumber.make('7') }, { documentNumber }),
          budget
        ).pipe(Effect.provide(h.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { code: 'invalid_input' } })
      }

      expect(h.requests).toHaveLength(0)
      expect(h.scopes).toHaveLength(0)
    })
  )
})
