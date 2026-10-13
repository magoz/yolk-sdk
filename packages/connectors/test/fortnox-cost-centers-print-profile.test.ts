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
  FortnoxCostCenter,
  FortnoxCostCenterCode,
  FortnoxCreateCostCenterInput,
  FortnoxListCostCentersOutput,
  fortnoxCostCenterActions,
  fortnoxCreateCostCenterAction,
  fortnoxDeleteCostCenterAction,
  fortnoxGetCostCenterAction,
  fortnoxListCostCentersAction,
  fortnoxUpdateCostCenterAction
} from '../src/fortnox/cost-centers.ts'
import {
  FortnoxListPrintTemplatesOutput,
  FortnoxPrintTemplate,
  fortnoxListPrintTemplatesAction,
  fortnoxPrintActions
} from '../src/fortnox/print-templates.ts'
import {
  FortnoxProfile,
  fortnoxGetProfileAction,
  fortnoxProfileActions
} from '../src/fortnox/profile.ts'

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

const ToolParameterProperties = Schema.Struct({
  properties: Schema.Record(Schema.String, Schema.Unknown)
})

const allActions = [...fortnoxCostCenterActions, ...fortnoxPrintActions, ...fortnoxProfileActions]

const TestConnector = defineConnector({ id: 'fortnox', actions: allActions })

// Synthetic cost center, shaped like the Fortnox docs example (Note null, @url present).
const costCenter = {
  '@url': 'https://api.fortnox.example.test/3/costcenters/K1',
  Code: 'K1',
  Description: 'Example AB store',
  Note: null,
  Active: true
}

describe('Fortnox cost center, print template, and profile actions', () => {
  it('exports actions in order with their access', () => {
    expect(allActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.list_cost_centers', 'read'],
      ['fortnox.get_cost_center', 'read'],
      ['fortnox.create_cost_center', 'write'],
      ['fortnox.update_cost_center', 'write'],
      ['fortnox.delete_cost_center', 'destructive'],
      ['fortnox.list_print_templates', 'read'],
      ['fortnox.get_profile', 'read']
    ])
    expect(fortnoxDeleteCostCenterAction.description).toContain('cannot be undone')
    expect(fortnoxDeleteCostCenterAction.description).toContain('Active false')
  })

  it('lowers every output schema to JSON Schema', () => {
    for (const action of allActions) {
      expect(toolJsonSchemaFromSchema(action.outputSchema), action.id).toBeDefined()
    }
  })

  it.effect('adapts the actions to agent tools; writes and lists are closed', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(TestConnector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools).toHaveLength(7)

      for (const name of ['fortnox.create_cost_center', 'fortnox.update_cost_center']) {
        const parameters = toolSet.tools.find(tool => tool.name === name)?.parameters

        expect(parameters).toMatchObject({ type: 'object', additionalProperties: false })

        const { properties } =
          yield* Schema.decodeUnknownEffect(ToolParameterProperties)(parameters)

        expect(Object.keys(properties).toSorted()).toEqual([
          'Active',
          'Code',
          'Description',
          'Note'
        ])
      }

      for (const name of ['fortnox.list_cost_centers', 'fortnox.list_print_templates']) {
        expect(toolSet.tools.find(tool => tool.name === name)?.parameters).toMatchObject({
          type: 'object',
          additionalProperties: false
        })
      }

      expect(harness.requests).toHaveLength(0)
    })
  )

  describe('cost centers', () => {
    it.effect('lists one page with lastModified and pagination', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({
            MetaInformation: meta(2, 3, 11),
            CostCenters: [costCenter, { ...costCenter, Code: 'K2', Active: false }]
          })
        ])

        const result = yield* fortnoxListCostCentersAction
          .execute({
            integration,
            input: { page: 2, limit: 5, lastModified: '2026-01-01 00:00' }
          })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests).toHaveLength(1)
        expect(harness.requests[0]).toMatchObject({ method: 'GET', headers: readHeaders })
        expect(harness.requests[0]?.body).toBeUndefined()

        const url = new URL(harness.requests[0]?.url ?? '')

        expect(`${url.origin}${url.pathname}`).toBe('https://api.fortnox.se/3/costcenters')
        expect(Object.fromEntries(url.searchParams)).toEqual({
          page: '2',
          limit: '5',
          lastmodified: '2026-01-01 00:00'
        })
        expect(harness.scopes).toEqual([['costcenter']])

        if (!Predicate.isTagged(result, 'Success')) return expect.unreachable('expected Success')

        const output = yield* Schema.decodeUnknownEffect(
          Schema.toType(FortnoxListCostCentersOutput)
        )(result.value)

        expect(output.pagination).toMatchObject({
          currentPage: 2,
          totalPages: 3,
          totalResources: 11,
          nextPage: 3
        })

        const rows = Chunk.toReadonlyArray(output.costCenters)

        expect(rows).toHaveLength(2)
        expect(rows[0]).toBeInstanceOf(FortnoxCostCenter)
        expect(rows[0]).toMatchObject({
          Code: 'K1',
          Description: 'Example AB store',
          Note: null,
          Active: true
        })
        expect(rows[1]).toMatchObject({ Code: 'K2', Active: false })
      })
    )

    it.effect('sends no query without input and omits nextPage on the final page', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenters: [], MetaInformation: meta(1, 1, 0) })])

        const result = yield* fortnoxListCostCentersAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]?.url).toBe('https://api.fortnox.se/3/costcenters')
        expect(result).toMatchObject({
          _tag: 'Success',
          value: { pagination: { currentPage: 1, totalPages: 1, totalResources: 0 } }
        })
        expect(result).not.toHaveProperty(['value', 'pagination', 'nextPage'])
      })
    )

    it.effect('fails list decoding without MetaInformation instead of assuming a final page', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenters: [costCenter] })])

        const result = yield* fortnoxListCostCentersAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      })
    )

    it.effect('rejects bad pagination before any request', () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        for (const input of [{ limit: 501 }, { page: 0 }, { lastModified: null }]) {
          const result = yield* fortnoxListCostCentersAction
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

    it.effect('gets one cost center by encoded Code', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenter: { ...costCenter, Code: 'K/1 B' } })])

        const result = yield* fortnoxGetCostCenterAction
          .execute({ integration, input: { code: 'K/1 B' } })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: 'https://api.fortnox.se/3/costcenters/K%2F1%20B',
          headers: readHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([['costcenter']])
        expect(result).toMatchObject({
          _tag: 'Success',
          value: { Code: 'K/1 B', Description: 'Example AB store', Note: null, Active: true }
        })
      })
    )

    it.effect('rejects unsafe or empty Code values before any request', () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        for (const code of ['', ' ', '.', '..', 'K\n1']) {
          const got = yield* fortnoxGetCostCenterAction
            .execute({ integration, input: { code } })
            .pipe(Effect.provide(harness.layer), Effect.result)

          const deleted = yield* fortnoxDeleteCostCenterAction
            .execute({ integration, input: { code } })
            .pipe(Effect.provide(harness.layer), Effect.result)

          const updated = yield* fortnoxUpdateCostCenterAction
            .execute({ integration, input: { Code: code, Active: false } })
            .pipe(Effect.provide(harness.layer), Effect.result)

          for (const result of [got, deleted, updated]) {
            expect(result, JSON.stringify(code)).toMatchObject({
              failure: { cause: 'validation_failed' }
            })
          }
        }

        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )

    it.effect('rejects a response without Code rather than fabricating an identity', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenter: { Description: 'Example AB' } })])

        const result = yield* fortnoxGetCostCenterAction
          .execute({ integration, input: { code: 'K1' } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      })
    )

    it.effect('creates a cost center with only the supplied fields', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenter: costCenter }, 201)])

        const result = yield* fortnoxCreateCostCenterAction
          .execute({ integration, input: { Code: 'K1', Description: 'Example AB store' } })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'POST',
          url: 'https://api.fortnox.se/3/costcenters',
          headers: writeHeaders
        })
        expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
          CostCenter: { Code: 'K1', Description: 'Example AB store' }
        })
        expect(harness.scopes).toEqual([['costcenter']])
        expect(result).toMatchObject({ _tag: 'Success', value: { Code: 'K1', Active: true } })
      })
    )

    it.effect('sends every writable field on typed create', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenter: costCenter }, 201)])

        const input = FortnoxCreateCostCenterInput.make({
          Code: FortnoxCostCenterCode.make('K1'),
          Description: 'Example AB store',
          Note: 'Example note',
          Active: false
        })

        const result = yield* fortnoxCreateCostCenterAction
          .executeTyped({ integration, input })
          .pipe(Effect.provide(harness.layer))

        expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
          CostCenter: {
            Code: 'K1',
            Description: 'Example AB store',
            Note: 'Example note',
            Active: false
          }
        })
        expect(result).toMatchObject({ _tag: 'Success' })
      })
    )

    it.effect('rejects invalid create inputs before any request', () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        for (const input of [
          {},
          { Code: 'K1' },
          { Description: 'Example AB store' },
          { Code: 'K1', Description: '' },
          { Code: 'K1234567', Description: 'Example AB store' },
          { Code: '', Description: 'Example AB store' },
          { Code: '..', Description: 'Example AB store' },
          { Code: 'K1', Description: 'Example AB store', Note: null },
          { Code: 'K1', Description: 'Example AB store', Active: 'yes' },
          { Code: 'K1', Description: 'Example AB store', Unknown: 'value' },
          { Code: 'K1', Description: 'Example AB store', '@url': 'https://example.test' }
        ]) {
          const result = yield* fortnoxCreateCostCenterAction
            .execute({ integration, input })
            .pipe(Effect.provide(harness.layer), Effect.result)

          expect(result, JSON.stringify(input)).toMatchObject({
            failure: { cause: 'validation_failed' }
          })
        }

        // A Class instance with an extra own key models a caller bypassing the static type.
        const typed = Object.assign(
          FortnoxCreateCostCenterInput.make({
            Code: FortnoxCostCenterCode.make('K1'),
            Description: 'Example AB store'
          }),
          { Unknown: 'value' }
        )

        const typedResult = yield* fortnoxCreateCostCenterAction
          .executeTyped({ integration, input: typed })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(typedResult).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )

    it.effect('updates by Code in the URL and strips it from the body', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ CostCenter: { ...costCenter, Active: false } })])

        const result = yield* fortnoxUpdateCostCenterAction
          .execute({
            integration,
            input: { Code: 'K/1', Active: false, Note: 'Example note' }
          })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'PUT',
          url: 'https://api.fortnox.se/3/costcenters/K%2F1',
          headers: writeHeaders
        })
        expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
          CostCenter: { Active: false, Note: 'Example note' }
        })
        expect(harness.scopes).toEqual([['costcenter']])
        expect(result).toMatchObject({ _tag: 'Success', value: { Code: 'K1', Active: false } })
      })
    )

    it.effect('rejects update inputs without Code, with nulls, or with unknown keys', () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        for (const input of [
          { Active: false },
          { Code: 'K1', Description: '' },
          { Code: 'K1', Note: null },
          { Code: 'K1', Active: null },
          { Code: 'K1', NewCode: 'K2' },
          { code: 'K1', Active: false }
        ]) {
          const result = yield* fortnoxUpdateCostCenterAction
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

        const result = yield* fortnoxDeleteCostCenterAction
          .execute({ integration, input: { code: 'K/1' } })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'DELETE',
          url: 'https://api.fortnox.se/3/costcenters/K%2F1',
          headers: readHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.requests[0]?.headers).not.toHaveProperty('content-type')
        expect(harness.scopes).toEqual([['costcenter']])
        expect(result).toMatchObject({ _tag: 'Success', value: { code: 'K/1', deleted: true } })
      })
    )

    it.effect('maps non-2xx answers to provider failures with codes', () =>
      Effect.gen(function* () {
        const notFound = response(
          {
            ErrorInformation: {
              error: 1,
              message: 'Kan inte hitta kostnadsstället.',
              code: 2000001
            }
          },
          404
        )

        const harness = makeHarness([
          notFound,
          notFound,
          response({ ErrorInformation: { message: 'Ogiltigt värde.', code: 2000310 } }, 400),
          empty(403),
          empty(429)
        ])

        const got = yield* fortnoxGetCostCenterAction
          .execute({ integration, input: { code: 'K404' } })
          .pipe(Effect.provide(harness.layer))

        const deleted = yield* fortnoxDeleteCostCenterAction
          .execute({ integration, input: { code: 'K404' } })
          .pipe(Effect.provide(harness.layer))

        const created = yield* fortnoxCreateCostCenterAction
          .execute({ integration, input: { Code: 'K1', Description: 'Example AB store' } })
          .pipe(Effect.provide(harness.layer))

        const updated = yield* fortnoxUpdateCostCenterAction
          .execute({ integration, input: { Code: 'K1', Active: true } })
          .pipe(Effect.provide(harness.layer))

        const listed = yield* fortnoxListCostCentersAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(got).toMatchObject({
          _tag: 'Failure',
          error: {
            code: 'fortnox_not_found',
            status: 404,
            message: 'Kan inte hitta kostnadsstället.',
            underlying: { providerCode: 2000001 }
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
        expect(harness.requests).toHaveLength(5)
      })
    )
  })

  describe('print templates', () => {
    it.effect('lists templates for a type without pagination metadata', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({
            PrintTemplates: [
              { Template: 'st', Name: 'Example template' },
              { Template: 'ps', Name: null }
            ]
          })
        ])

        const result = yield* fortnoxListPrintTemplatesAction
          .execute({ integration, input: { type: 'order' } })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: 'https://api.fortnox.se/3/printtemplates?type=order',
          headers: readHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([['print']])

        if (!Predicate.isTagged(result, 'Success')) return expect.unreachable('expected Success')

        const output = yield* Schema.decodeUnknownEffect(
          Schema.toType(FortnoxListPrintTemplatesOutput)
        )(result.value)

        const rows = Chunk.toReadonlyArray(output.printTemplates)

        expect(rows[0]).toBeInstanceOf(FortnoxPrintTemplate)
        expect(rows.map(row => ({ Template: row.Template, Name: row.Name }))).toEqual([
          { Template: 'st', Name: 'Example template' },
          { Template: 'ps', Name: null }
        ])
        expect(output).not.toHaveProperty('pagination')
      })
    )

    it.effect('sends no query when type is omitted (Fortnox defaults to invoice)', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ PrintTemplates: [] })])

        const result = yield* fortnoxListPrintTemplatesAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]?.url).toBe('https://api.fortnox.se/3/printtemplates')
        expect(result).toMatchObject({ _tag: 'Success' })
      })
    )

    it.effect('rejects undocumented types before any request', () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        for (const input of [{ type: 'contract' }, { type: 'Invoice' }, { type: null }]) {
          const result = yield* fortnoxListPrintTemplatesAction
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

    it.effect('rejects malformed success bodies and maps provider failures', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ PrintTemplates: [{ Name: 'Missing template code' }] }),
          response({ Templates: [] }),
          response({ ErrorInformation: { message: 'Saknar behörighet.', code: 2000663 } }, 403)
        ])

        const missingCode = yield* fortnoxListPrintTemplatesAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const wrongEnvelope = yield* fortnoxListPrintTemplatesAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const forbidden = yield* fortnoxListPrintTemplatesAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(missingCode).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(wrongEnvelope).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(forbidden).toMatchObject({
          _tag: 'Failure',
          error: {
            code: 'fortnox_forbidden',
            status: 403,
            message: 'Saknar behörighet.',
            underlying: { providerCode: 2000663 }
          }
        })
      })
    )
  })

  describe('profile', () => {
    it.effect('reads the Me resource with the profile scope', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({
            Me: {
              Email: 'user@example.test',
              Id: 'example-user-1',
              Locale: 'sv_SE',
              Name: 'Example User',
              SysAdmin: false
            }
          })
        ])

        const result = yield* fortnoxGetProfileAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: 'https://api.fortnox.se/3/me',
          headers: readHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([['profile']])

        if (!Predicate.isTagged(result, 'Success')) return expect.unreachable('expected Success')

        expect(result.value).toBeInstanceOf(FortnoxProfile)
        expect(result.value).toMatchObject({
          Email: 'user@example.test',
          Id: 'example-user-1',
          Locale: 'sv_SE',
          Name: 'Example User',
          SysAdmin: false
        })
      })
    )

    it.effect('accepts omitted and null fields and keeps null', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response({ Me: { Email: null, Name: 'Example User' } })])

        const result = yield* fortnoxGetProfileAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(result).toMatchObject({
          _tag: 'Success',
          value: { Email: null, Name: 'Example User' }
        })
        expect(result).not.toHaveProperty(['value', 'Id'])
      })
    )

    it.effect('rejects a body without the Me envelope and maps provider failures', () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ Name: 'Example User' }),
          response({ Me: { SysAdmin: 'yes' } }),
          response({ ErrorInformation: { message: 'Ogiltig token.', code: 2000310 } }, 401)
        ])

        const unwrapped = yield* fortnoxGetProfileAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const badType = yield* fortnoxGetProfileAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const unauthorized = yield* fortnoxGetProfileAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect(unwrapped).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(badType).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(unauthorized).toMatchObject({
          _tag: 'Failure',
          error: { code: 'fortnox_unauthorized', status: 401, message: 'Ogiltig token.' }
        })
      })
    )
  })
})
