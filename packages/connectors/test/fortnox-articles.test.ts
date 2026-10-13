import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools, toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  defineConnector,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  FortnoxArticle,
  FortnoxArticleNumber,
  FortnoxCreateArticleInput,
  FortnoxListArticlesOutput,
  fortnoxArticleActions,
  fortnoxCreateArticleAction,
  fortnoxDeleteArticleAction,
  fortnoxGetArticleAction,
  fortnoxListArticlesAction,
  fortnoxUpdateArticleAction
} from '../src/fortnox/articles.ts'

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

const ArticlesConnector = defineConnector({ id: 'fortnox', actions: [...fortnoxArticleActions] })

const ToolParameterProperties = Schema.Struct({
  properties: Schema.Record(Schema.String, Schema.Unknown)
})

// Synthetic single-article read: JSON numbers, as Fortnox sends them on GET /articles/{id}.
const article = {
  '@url': 'https://api.fortnox.example.test/3/articles/A-100',
  ArticleNumber: 'A-100',
  Description: 'Example service',
  Active: true,
  Type: 'SERVICE',
  Unit: 'st',
  EAN: '',
  VAT: 25,
  SalesPrice: 100,
  PurchasePrice: 40.5,
  QuantityInStock: 0,
  ReservedQuantity: 2,
  DisposableQuantity: -2,
  StockValue: 0,
  StockWarning: null,
  SalesAccount: 3001,
  Housework: false,
  HouseworkType: null,
  Weight: null,
  Expired: false
}

describe('Fortnox article actions', () => {
  it('exports list/get/create/update/delete in order with their access', () => {
    expect(fortnoxArticleActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.list_articles', 'read'],
      ['fortnox.get_article', 'read'],
      ['fortnox.create_article', 'write'],
      ['fortnox.update_article', 'write'],
      ['fortnox.delete_article', 'destructive']
    ])
    expect(fortnoxDeleteArticleAction.description).toContain('cannot be undone')
  })

  it('lowers every article action output schema to JSON Schema', () => {
    for (const action of fortnoxArticleActions) {
      expect(toolJsonSchemaFromSchema(action.outputSchema), action.id).toBeDefined()
    }
  })

  it.effect(
    'adapts article actions to agent tools; writes are closed and omit read-only fields',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const toolSet = yield* resolveTools(
          [makeConnectorToolModule(ArticlesConnector, { integration, layer: harness.layer })],
          {}
        )

        expect(toolSet.tools).toHaveLength(5)

        for (const name of ['fortnox.create_article', 'fortnox.update_article']) {
          const parameters = toolSet.tools.find(tool => tool.name === name)?.parameters

          expect(parameters).toMatchObject({ type: 'object', additionalProperties: false })

          const { properties } =
            yield* Schema.decodeUnknownEffect(ToolParameterProperties)(parameters)

          const keys = Object.keys(properties)

          expect(keys).toEqual(expect.arrayContaining(['ArticleNumber', 'Description', 'Type']))

          for (const readOnly of [
            'SalesPrice',
            'DisposableQuantity',
            'ReservedQuantity',
            'StockValue',
            'SupplierName',
            'QuantityInStock'
          ]) {
            expect(keys).not.toContain(readOnly)
          }
        }

        expect(harness.requests).toHaveLength(0)
      })
  )

  it.effect('lists one page with search, filter, and numeric-string list rows', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          Articles: [
            {
              '@url': 'https://api.fortnox.example.test/3/articles/A-100',
              ArticleNumber: 'A-100',
              Description: 'Example service',
              DisposableQuantity: '-2',
              EAN: '',
              Housework: false,
              PurchasePrice: '40.5',
              QuantityInStock: '0',
              ReservedQuantity: '2',
              SalesPrice: 100,
              StockPlace: '',
              StockValue: '0',
              Unit: null,
              VAT: '25',
              WebshopArticle: false
            }
          ],
          MetaInformation: meta(2, 3, 11)
        })
      ])

      const result = yield* fortnoxListArticlesAction
        .execute({
          integration,
          input: {
            page: 2,
            limit: 5,
            lastModified: '2026-01-01 00:00',
            search: { field: 'description', value: 'Example service' },
            filter: 'active'
          }
        })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests).toHaveLength(1)
      expect(harness.requests[0]).toMatchObject({ method: 'GET', headers: readHeaders })
      expect(harness.requests[0]?.body).toBeUndefined()

      const url = new URL(harness.requests[0]?.url ?? '')

      expect(`${url.origin}${url.pathname}`).toBe('https://api.fortnox.se/3/articles')
      expect(Object.fromEntries(url.searchParams)).toEqual({
        page: '2',
        limit: '5',
        lastmodified: '2026-01-01 00:00',
        description: 'Example service',
        filter: 'active'
      })
      expect(harness.scopes).toEqual([['article']])

      if (!Predicate.isTagged(result, 'Success')) return expect.unreachable('expected Success')

      const output = yield* Schema.decodeUnknownEffect(Schema.toType(FortnoxListArticlesOutput))(
        result.value
      )

      expect(output.pagination).toMatchObject({
        currentPage: 2,
        totalPages: 3,
        totalResources: 11,
        nextPage: 3
      })

      const [row] = Chunk.toReadonlyArray(output.articles)

      expect(row).toBeInstanceOf(FortnoxArticle)
      expect(row).toMatchObject({
        ArticleNumber: 'A-100',
        Description: 'Example service',
        DisposableQuantity: -2,
        PurchasePrice: 40.5,
        QuantityInStock: 0,
        ReservedQuantity: 2,
        SalesPrice: 100,
        StockValue: 0,
        VAT: 25,
        Unit: null
      })
    })
  )

  it.effect('omits nextPage on the final page and sends no query without input', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Articles: [], MetaInformation: meta(1, 1, 0) })])

      const result = yield* fortnoxListArticlesAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]?.url).toBe('https://api.fortnox.se/3/articles')
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { pagination: { currentPage: 1, totalPages: 1, totalResources: 0 } }
      })
      expect(result).not.toHaveProperty(['value', 'pagination', 'nextPage'])
    })
  )

  it.effect('fails list decoding without MetaInformation instead of assuming a final page', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Articles: [article] })])

      const result = yield* fortnoxListArticlesAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(harness.layer), Effect.result)

      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  it.effect('rejects undocumented search fields, filters, and sorting before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      for (const input of [
        { search: { field: 'webshop', value: 'true' } },
        { search: { field: 'unit', value: 'st' } },
        { search: { field: 'description', value: '' } },
        { filter: 'expired' },
        { limit: 501 },
        { page: 0 }
      ]) {
        const result = yield* fortnoxListArticlesAction
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result, JSON.stringify(input)).toMatchObject({
          failure: { cause: 'validation_failed' }
        })
      }

      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('gets one article by encoded ArticleNumber', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Article: { ...article, ArticleNumber: 'A/1 B' } })])

      const result = yield* fortnoxGetArticleAction
        .execute({ integration, input: { articleNumber: 'A/1 B' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: 'https://api.fortnox.se/3/articles/A%2F1%20B',
        headers: readHeaders
      })
      expect(harness.scopes).toEqual([['article']])
      expect(result).toMatchObject({
        _tag: 'Success',
        value: {
          ArticleNumber: 'A/1 B',
          Description: 'Example service',
          Type: 'SERVICE',
          SalesPrice: 100,
          DisposableQuantity: -2,
          SalesAccount: 3001,
          StockWarning: null,
          Weight: null
        }
      })
      expect(result).not.toHaveProperty(['value', '@url'])
    })
  )

  it.effect('rejects unsafe or empty ArticleNumber values before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      for (const articleNumber of ['', ' ', '.', '..', ' A-100', 'A\n100']) {
        const got = yield* fortnoxGetArticleAction
          .execute({ integration, input: { articleNumber } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const deleted = yield* fortnoxDeleteArticleAction
          .execute({ integration, input: { articleNumber } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const updated = yield* fortnoxUpdateArticleAction
          .execute({ integration, input: { ArticleNumber: articleNumber, Active: false } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        for (const result of [got, deleted, updated]) {
          expect(result, JSON.stringify(articleNumber)).toMatchObject({
            failure: { cause: 'validation_failed' }
          })
        }
      }

      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('creates an article with only the supplied writable fields', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Article: article }, 201)])

      const input = {
        Description: 'Example service',
        Type: 'SERVICE',
        Unit: 'st',
        VAT: 25,
        PurchasePrice: 40.5,
        SalesAccount: 3001,
        Housework: true,
        HouseworkType: 'CLEANING',
        Weight: 0,
        Active: true
      }

      const result = yield* fortnoxCreateArticleAction
        .execute({ integration, input })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.fortnox.se/3/articles',
        headers: writeHeaders
      })
      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({ Article: input })
      expect(harness.scopes).toEqual([['article']])
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { ArticleNumber: 'A-100', SalesPrice: 100 }
      })
    })
  )

  it.effect('sends a caller-chosen ArticleNumber on typed create', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Article: article }, 201)])

      yield* fortnoxCreateArticleAction
        .executeTyped({
          integration,
          input: FortnoxCreateArticleInput.make({
            ArticleNumber: FortnoxArticleNumber.make('A-100'),
            Description: 'Example service'
          })
        })
        .pipe(Effect.provide(harness.layer))

      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
        Article: { ArticleNumber: 'A-100', Description: 'Example service' }
      })
    })
  )

  it.effect('rejects invalid create inputs before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      for (const input of [
        {},
        { Description: '' },
        { Description: 'x'.repeat(201) },
        { Description: 'Example service', SalesPrice: 100 },
        { Description: 'Example service', DisposableQuantity: 1 },
        { Description: 'Example service', SupplierName: 'Example AB' },
        { Description: 'Example service', QuantityInStock: 5 },
        { Description: 'Example service', Unknown: 'value' },
        { Description: 'Example service', Unit: null },
        { Description: 'Example service', Type: 'GOODS' },
        { Description: 'Example service', HouseworkType: 'UNKNOWN' },
        { Description: 'Example service', SalesAccount: 3001.5 },
        { Description: 'Example service', Weight: -1 },
        { Description: 'Example service', Weight: 100_000_000 },
        { Description: 'Example service', EAN: '1'.repeat(31) },
        { Description: 'Example service', ArticleNumber: 'A'.repeat(51) },
        { Description: 'Example service', ArticleNumber: '..' },
        { Description: 'Example service', VAT: Number.NaN }
      ]) {
        const result = yield* fortnoxCreateArticleAction
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result, JSON.stringify(input)).toMatchObject({
          failure: { cause: 'validation_failed' }
        })
      }

      // Class instances with extra own keys model callers bypassing the static input type.
      const typed = Object.assign(FortnoxCreateArticleInput.make({ Description: 'Example' }), {
        SalesPrice: 100
      })

      const typedResult = yield* fortnoxCreateArticleAction
        .executeTyped({ integration, input: typed })
        .pipe(Effect.provide(harness.layer), Effect.result)

      expect(typedResult).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('updates by ArticleNumber in the URL and strips it from the body', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Article: { ...article, Active: false } })])

      const result = yield* fortnoxUpdateArticleAction
        .execute({
          integration,
          input: { ArticleNumber: 'A-100', Active: false, Note: 'Example note' }
        })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'PUT',
        url: 'https://api.fortnox.se/3/articles/A-100',
        headers: writeHeaders
      })
      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
        Article: { Active: false, Note: 'Example note' }
      })
      expect(harness.scopes).toEqual([['article']])
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { ArticleNumber: 'A-100', Active: false }
      })
    })
  )

  it.effect('rejects update inputs without ArticleNumber or with read-only fields', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      for (const input of [
        { Active: false },
        { ArticleNumber: 'A-100', SalesPrice: 100 },
        { ArticleNumber: 'A-100', StockValue: 0 },
        { ArticleNumber: 'A-100', Description: '' },
        { ArticleNumber: 'A-100', Note: null },
        { ArticleNumber: 'A-100', Extra: true }
      ]) {
        const result = yield* fortnoxUpdateArticleAction
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result, JSON.stringify(input)).toMatchObject({
          failure: { cause: 'validation_failed' }
        })
      }

      expect(harness.requests).toHaveLength(0)
    })
  )

  it.effect('deletes on 204 without decoding the empty body', () =>
    Effect.gen(function* () {
      const harness = makeHarness([empty(204)])

      const result = yield* fortnoxDeleteArticleAction
        .execute({ integration, input: { articleNumber: 'A/1' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'DELETE',
        url: 'https://api.fortnox.se/3/articles/A%2F1',
        headers: readHeaders
      })
      expect(harness.requests[0]?.body).toBeUndefined()
      expect(harness.requests[0]?.headers).not.toHaveProperty('content-type')
      expect(harness.scopes).toEqual([['article']])
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { articleNumber: 'A/1', deleted: true }
      })
    })
  )

  it.effect('maps non-2xx answers to provider failures with codes', () =>
    Effect.gen(function* () {
      const notFound = response(
        { ErrorInformation: { error: 1, message: 'Kan inte hitta artikeln.', code: 2000428 } },
        404
      )

      const harness = makeHarness([
        notFound,
        notFound,
        response({ ErrorInformation: { message: 'Ogiltigt värde.', code: 2000310 } }, 400),
        empty(403),
        empty(429)
      ])

      const got = yield* fortnoxGetArticleAction
        .execute({ integration, input: { articleNumber: 'A-404' } })
        .pipe(Effect.provide(harness.layer))

      const deleted = yield* fortnoxDeleteArticleAction
        .execute({ integration, input: { articleNumber: 'A-404' } })
        .pipe(Effect.provide(harness.layer))

      const created = yield* fortnoxCreateArticleAction
        .execute({ integration, input: { Description: 'Example service' } })
        .pipe(Effect.provide(harness.layer))

      const updated = yield* fortnoxUpdateArticleAction
        .execute({ integration, input: { ArticleNumber: 'A-100', Active: true } })
        .pipe(Effect.provide(harness.layer))

      const listed = yield* fortnoxListArticlesAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(harness.layer))

      expect(got).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'fortnox_not_found',
          status: 404,
          message: 'Kan inte hitta artikeln.',
          underlying: { providerCode: 2000428 }
        }
      })
      expect(deleted).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_not_found', status: 404 }
      })
      expect(created).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_request_failed', status: 400, message: 'Ogiltigt värde.' }
      })
      expect(updated).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_forbidden', status: 403 }
      })
      expect(listed).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_rate_limited', status: 429 }
      })
    })
  )
})
