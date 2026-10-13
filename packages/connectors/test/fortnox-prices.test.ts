import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import {
  FortnoxCreatePriceInput,
  FortnoxCreatePriceListInput,
  FortnoxListPriceListsOutput,
  FortnoxListPricesOutput,
  FortnoxPriceListCode,
  FortnoxUpdatePriceInput,
  fortnoxCreatePriceAction,
  fortnoxCreatePriceListAction,
  fortnoxDeletePriceAction,
  fortnoxGetPriceAction,
  fortnoxGetPriceListAction,
  fortnoxListPriceListsAction,
  fortnoxListPricesAction,
  fortnoxPriceActions,
  fortnoxUpdatePriceAction,
  fortnoxUpdatePriceListAction
} from '../src/fortnox/prices.ts'

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

const response = (body: Schema.Json, status = 200) => {
  if (!isJson(body)) throw new TypeError('JSON fixture requires a finite JSON value')

  return ConnectorHttpResponse.make({ status, headers: {}, body: JSON.stringify(body) })
}

const empty = (status: number) => ConnectorHttpResponse.make({ status, headers: {}, body: '' })

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

const readHeaders = { authorization: 'Bearer test-access-token', accept: 'application/json' }

const writeHeaders = { ...readHeaders, 'content-type': 'application/json' }

const base = 'https://api.fortnox.se/3'

const priceList = {
  '@url': `${base}/pricelists/A`,
  Code: 'A',
  Description: 'Example list',
  Comments: '',
  PreSelected: true
}

const price = {
  '@url': `${base}/prices/A/ART-1/2.5`,
  ArticleNumber: 'ART-1',
  Date: '2026-01-02 10:00:00',
  FromQuantity: 2.5,
  Percent: 10,
  Price: 99.5,
  PriceList: 'A'
}

describe('Fortnox price actions', () => {
  it('exports every price action in stable order with access metadata', () => {
    expect(fortnoxPriceActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.list_price_lists', 'read'],
      ['fortnox.get_price_list', 'read'],
      ['fortnox.create_price_list', 'write'],
      ['fortnox.update_price_list', 'write'],
      ['fortnox.list_prices', 'read'],
      ['fortnox.get_price', 'read'],
      ['fortnox.create_price', 'write'],
      ['fortnox.update_price', 'write'],
      ['fortnox.delete_price', 'destructive']
    ])
  })

  it('lowers every input and output schema to JSON Schema', () => {
    for (const action of fortnoxPriceActions) {
      expect(toolJsonSchemaFromSchema(action.inputSchema)).toMatchObject({ type: 'object' })
      expect(toolJsonSchemaFromSchema(action.outputSchema)).toMatchObject({ type: 'object' })
    }
  })

  it.effect('lists price lists with pagination and a search field', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          PriceLists: [priceList, { Code: 'B', Description: null, PreSelected: false }],
          MetaInformation: meta(1, 2, 3)
        })
      ])

      const result = yield* fortnoxListPriceListsAction
        .execute({
          integration,
          input: { page: 1, limit: 2, search: { field: 'code', value: 'A' } }
        })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests).toEqual([
        {
          method: 'GET',
          url: `${base}/pricelists?page=1&limit=2&code=A`,
          headers: readHeaders,
          body: undefined
        }
      ])
      expect(harness.scopes).toEqual([['price']])
      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          pagination: { currentPage: 1, totalPages: 2, totalResources: 3, nextPage: 2 }
        }
      })

      if (
        !Predicate.isTagged(result, 'Success') ||
        !(result.value instanceof FortnoxListPriceListsOutput)
      )
        throw new Error('Expected list success')

      expect(Chunk.toReadonlyArray(result.value.priceLists)).toMatchObject([
        { Code: 'A', Description: 'Example list', Comments: '', PreSelected: true },
        { Code: 'B', Description: null, PreSelected: false }
      ])
    })
  )

  it.effect('reads a price list by URL-encoded Code', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ PriceList: { ...priceList, Code: 'A B/1' } })])

      const result = yield* fortnoxGetPriceListAction
        .execute({ integration, input: { code: 'A B/1' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: `${base}/pricelists/A%20B%2F1`,
        headers: readHeaders
      })
      expect(harness.scopes).toEqual([['price']])
      expect(result).toMatchObject({ _tag: 'Success', value: { Code: 'A B/1' } })
    })
  )

  it.effect('creates a price list with Code in the body and updates it without Code', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ PriceList: { ...priceList, Code: 'EX', PreSelected: false } }, 201),
        response({ PriceList: { ...priceList, Code: 'EX', Description: 'Renamed' } })
      ])

      const created = yield* fortnoxCreatePriceListAction
        .execute({
          integration,
          input: { Code: 'EX', Description: 'Example AB list', Comments: 'Synthetic' }
        })
        .pipe(Effect.provide(harness.layer))

      const updated = yield* fortnoxUpdatePriceListAction
        .execute({ integration, input: { Code: 'EX', Description: 'Renamed' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests).toEqual([
        {
          method: 'POST',
          url: `${base}/pricelists`,
          headers: writeHeaders,
          body: JSON.stringify({
            PriceList: { Code: 'EX', Description: 'Example AB list', Comments: 'Synthetic' }
          })
        },
        {
          method: 'PUT',
          url: `${base}/pricelists/EX`,
          headers: writeHeaders,
          body: JSON.stringify({ PriceList: { Description: 'Renamed' } })
        }
      ])
      expect(harness.scopes).toEqual([['price'], ['price']])
      expect(created).toMatchObject({ _tag: 'Success', value: { Code: 'EX', PreSelected: false } })
      expect(updated).toMatchObject({ _tag: 'Success', value: { Description: 'Renamed' } })
    })
  )

  it.effect('lists the prices of an article in a price list', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          Prices: [
            { ArticleNumber: 'ART/1', FromQuantity: 0, PriceList: 'A', Price: 10 },
            { ArticleNumber: 'ART/1', FromQuantity: 5, PriceList: 'A', Price: 8 }
          ],
          MetaInformation: meta(2, 2, 7)
        })
      ])

      const result = yield* fortnoxListPricesAction
        .execute({
          integration,
          input: { priceList: 'A', articleNumber: 'ART/1', page: 2, limit: 5 }
        })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: `${base}/prices/sublist/A/ART%2F1?page=2&limit=5`,
        headers: readHeaders
      })
      expect(harness.scopes).toEqual([['price']])
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { pagination: { currentPage: 2, totalPages: 2, totalResources: 7 } }
      })
      expect(result).not.toHaveProperty('value.pagination.nextPage')

      if (
        !Predicate.isTagged(result, 'Success') ||
        !(result.value instanceof FortnoxListPricesOutput)
      )
        throw new Error('Expected list success')

      expect(Chunk.toReadonlyArray(result.value.prices)).toMatchObject([
        { ArticleNumber: 'ART/1', FromQuantity: 0, Price: 10 },
        { ArticleNumber: 'ART/1', FromQuantity: 5, Price: 8 }
      ])
    })
  )

  for (const [fromQuantity, segment] of [
    [0, '0'],
    [10, '10'],
    [2.5, '2.5']
  ] as const) {
    it.effect(`reads a price with FromQuantity ${segment} in canonical form`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ Price: { ...price, FromQuantity: fromQuantity } })])

        const result = yield* fortnoxGetPriceAction
          .execute({ integration, input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity } })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: `${base}/prices/A/ART-1/${segment}`,
          headers: readHeaders
        })
        expect(result).toMatchObject({
          _tag: 'Success',
          value: {
            PriceList: 'A',
            ArticleNumber: 'ART-1',
            FromQuantity: fromQuantity,
            Price: 99.5,
            Percent: 10,
            Date: '2026-01-02 10:00:00'
          }
        })
      })
    )
  }

  it.effect('creates a price and updates it by its composite key', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ Price: price }, 201),
        response({ Price: { ...price, Price: 129 } })
      ])

      const created = yield* fortnoxCreatePriceAction
        .execute({
          integration,
          input: { PriceList: 'A', ArticleNumber: 'ART-1', FromQuantity: 2.5, Price: 99.5 }
        })
        .pipe(Effect.provide(harness.layer))

      const updated = yield* fortnoxUpdatePriceAction
        .execute({
          integration,
          input: { PriceList: 'A', ArticleNumber: 'ART-1', FromQuantity: 2.5, Price: 129 }
        })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests).toEqual([
        {
          method: 'POST',
          url: `${base}/prices`,
          headers: writeHeaders,
          body: JSON.stringify({
            Price: { PriceList: 'A', ArticleNumber: 'ART-1', FromQuantity: 2.5, Price: 99.5 }
          })
        },
        {
          method: 'PUT',
          url: `${base}/prices/A/ART-1/2.5`,
          headers: writeHeaders,
          body: JSON.stringify({ Price: { Price: 129 } })
        }
      ])
      expect(harness.scopes).toEqual([['price'], ['price']])
      expect(created).toMatchObject({ _tag: 'Success', value: { Price: 99.5 } })
      expect(updated).toMatchObject({ _tag: 'Success', value: { Price: 129 } })
    })
  )

  for (const status of [204, 200]) {
    it.effect(`deletes a price on HTTP ${status} without decoding a body`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([empty(status)])

        const result = yield* fortnoxDeletePriceAction
          .execute({
            integration,
            input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 10 }
          })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests).toEqual([
          {
            method: 'DELETE',
            url: `${base}/prices/A/ART-1/10`,
            headers: readHeaders,
            body: undefined
          }
        ])
        expect(harness.scopes).toEqual([['price']])
        expect(result).toMatchObject({
          _tag: 'Success',
          value: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 10, deleted: true }
        })
      })
    )
  }

  for (const [status, code] of [
    [400, 'fortnox_request_failed'],
    [404, 'fortnox_not_found'],
    [429, 'fortnox_rate_limited']
  ] as const) {
    it.effect(`returns delete HTTP ${status} as a ${code} failure`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ ErrorInformation: { error: 1, message: 'Example error', code: 2000 } }, status)
        ])

        const result = yield* fortnoxDeletePriceAction
          .execute({
            integration,
            input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 0 }
          })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests).toHaveLength(1)
        expect(result).toMatchObject({
          _tag: 'Failure',
          error: { code, status, message: 'Example error', underlying: { providerCode: 2000 } }
        })
      })
    )
  }

  it.effect('returns a missing price as fortnox_not_found', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ ErrorInformation: { Code: 2000430, Message: 'Not found' } }, 404)
      ])

      const result = yield* fortnoxGetPriceAction
        .execute({
          integration,
          input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 1 }
        })
        .pipe(Effect.provide(harness.layer))

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_not_found', status: 404 }
      })
    })
  )

  const priceKey = { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 0 }

  const { PriceList: _omitted, ...priceWithoutList } = price

  const malformed: ReadonlyArray<{
    readonly action: (typeof fortnoxPriceActions)[number]
    readonly input: Schema.Json
    readonly body: Schema.Json
  }> = [
    // Missing MetaInformation must fail, never be read as a final page.
    { action: fortnoxListPriceListsAction, input: {}, body: { PriceLists: [priceList] } },
    {
      action: fortnoxListPricesAction,
      input: { priceList: 'A', articleNumber: 'ART-1' },
      body: { Prices: [price] }
    },
    {
      action: fortnoxGetPriceAction,
      input: priceKey,
      body: { Price: { ...price, FromQuantity: -1 } }
    },
    { action: fortnoxGetPriceAction, input: priceKey, body: { Price: priceWithoutList } }
  ]

  for (const [index, { action, input, body }] of malformed.entries()) {
    it.effect(`${action.id} rejects malformed success body ${index}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([response(body)])

        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      })
    )
  }

  const invalidInputs: ReadonlyArray<{
    readonly action: (typeof fortnoxPriceActions)[number]
    readonly input: unknown
  }> = [
    {
      action: fortnoxListPriceListsAction,
      input: { search: { field: 'description', value: 'x' } }
    },
    { action: fortnoxListPriceListsAction, input: { limit: 501 } },
    { action: fortnoxGetPriceListAction, input: { code: '' } },
    { action: fortnoxGetPriceListAction, input: { code: '..' } },
    { action: fortnoxCreatePriceListAction, input: { Description: 'Missing code' } },
    { action: fortnoxCreatePriceListAction, input: { Code: 'EX' } },
    { action: fortnoxCreatePriceListAction, input: { Code: 'EX', Description: 'x'.repeat(51) } },
    { action: fortnoxCreatePriceListAction, input: { Code: 'X'.repeat(101), Description: 'Ex' } },
    {
      action: fortnoxCreatePriceListAction,
      input: { Code: 'EX', Description: 'Ex', PreSelected: true }
    },
    {
      action: fortnoxCreatePriceListAction,
      input: { Code: 'EX', Description: 'Ex', Comments: null }
    },
    { action: fortnoxUpdatePriceListAction, input: { Description: 'Missing code' } },
    { action: fortnoxUpdatePriceListAction, input: { Code: 'EX', Unknown: 'value' } },
    { action: fortnoxListPricesAction, input: { priceList: 'A' } },
    { action: fortnoxListPricesAction, input: { priceList: 'A', articleNumber: '.' } },
    { action: fortnoxGetPriceAction, input: { priceList: 'A', articleNumber: 'ART-1' } },
    {
      action: fortnoxGetPriceAction,
      input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: -1 }
    },
    {
      action: fortnoxGetPriceAction,
      input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: '10' }
    },
    {
      action: fortnoxGetPriceAction,
      input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 1e21 }
    },
    {
      action: fortnoxGetPriceAction,
      input: { priceList: 'A', articleNumber: 'ART-1', fromQuantity: 1e-7 }
    },
    { action: fortnoxCreatePriceAction, input: { PriceList: 'A', ArticleNumber: 'ART-1' } },
    {
      action: fortnoxCreatePriceAction,
      input: { PriceList: 'A', ArticleNumber: 'ART-1', FromQuantity: 0, Price: null }
    },
    {
      action: fortnoxCreatePriceAction,
      input: { PriceList: 'A', ArticleNumber: 'ART-1', FromQuantity: 0, Date: '2026-01-02' }
    },
    {
      action: fortnoxUpdatePriceAction,
      input: { PriceList: 'A', ArticleNumber: 'ART-1', Price: 1 }
    },
    {
      action: fortnoxUpdatePriceAction,
      input: { PriceList: 'A', ArticleNumber: 'ART-1', FromQuantity: 0, Unknown: 1 }
    },
    { action: fortnoxDeletePriceAction, input: { priceList: 'A', articleNumber: 'ART-1' } },
    {
      action: fortnoxDeletePriceAction,
      input: { priceList: '', articleNumber: 'ART-1', fromQuantity: 0 }
    }
  ]

  for (const [index, item] of invalidInputs.entries()) {
    it.effect(`${item.action.id} rejects invalid input ${index} before credentials or HTTP`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const result = yield* item.action
          .execute({ integration, input: item.input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )
  }

  it.effect('rejects unknown keys on typed price and price list writes', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const code = FortnoxPriceListCode.make('A')

      const articleNumber = FortnoxCreatePriceInput.fields.ArticleNumber.make('ART-1')

      // Class instances with extra own keys model callers bypassing the static input type.
      const results = [
        yield* fortnoxCreatePriceListAction
          .executeTyped({
            integration,
            input: Object.assign(
              FortnoxCreatePriceListInput.make({ Code: code, Description: 'Example' }),
              { PreSelected: true }
            )
          })
          .pipe(Effect.provide(harness.layer), Effect.result),
        yield* fortnoxCreatePriceAction
          .executeTyped({
            integration,
            input: Object.assign(
              FortnoxCreatePriceInput.make({
                PriceList: code,
                ArticleNumber: articleNumber,
                FromQuantity: 0
              }),
              { Date: '2026-01-02' }
            )
          })
          .pipe(Effect.provide(harness.layer), Effect.result),
        yield* fortnoxUpdatePriceAction
          .executeTyped({
            integration,
            input: Object.assign(
              FortnoxUpdatePriceInput.make({
                PriceList: code,
                ArticleNumber: articleNumber,
                FromQuantity: 0
              }),
              { Unknown: 1 }
            )
          })
          .pipe(Effect.provide(harness.layer), Effect.result)
      ]

      for (const result of results) {
        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      }

      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )
})
