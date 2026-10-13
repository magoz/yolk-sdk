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
import type { ActionResult, ConnectorHttpRequest } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  FortnoxCompanySettings,
  FortnoxCreateLabelInput,
  FortnoxDeleteLabelOutput,
  FortnoxLabel,
  FortnoxListLabelsOutput,
  FortnoxListPredefinedAccountsOutput,
  FortnoxLockedPeriod,
  FortnoxPredefinedAccount,
  fortnoxCreateLabelAction,
  fortnoxDeleteLabelAction,
  fortnoxGetCompanySettingsAction,
  fortnoxGetLockedPeriodAction,
  fortnoxGetPredefinedAccountAction,
  fortnoxListLabelsAction,
  fortnoxListPredefinedAccountsAction,
  fortnoxSettingsActions,
  fortnoxUpdateLabelAction,
  fortnoxUpdatePredefinedAccountAction
} from '../src/fortnox/settings.ts'

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

const rawResponse = (body: string, status = 200) =>
  ConnectorHttpResponse.make({ status, headers: {}, body })

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

const url = (path: string) => `https://api.fortnox.se/3/${path}`

const successValue = <S extends Schema.Top>(result: ActionResult<unknown>, schema: S) => {
  if (!Predicate.isTagged(result, 'Success')) throw new Error('Expected a success result')
  const is = Schema.is(schema)

  if (!is(result.value)) throw new Error('Success value does not match the output schema')

  return result.value
}

const SettingsConnector = defineConnector({
  id: 'fortnox',
  description: 'Fortnox settings actions under test.',
  actions: [...fortnoxSettingsActions]
})

describe('Fortnox settings actions', () => {
  it('exports the settings actions with their access metadata in stable order', () => {
    expect(fortnoxSettingsActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.get_company_settings', 'read'],
      ['fortnox.get_locked_period', 'read'],
      ['fortnox.list_predefined_accounts', 'read'],
      ['fortnox.get_predefined_account', 'read'],
      ['fortnox.update_predefined_account', 'write'],
      ['fortnox.list_labels', 'read'],
      ['fortnox.create_label', 'write'],
      ['fortnox.update_label', 'write'],
      ['fortnox.delete_label', 'destructive']
    ])
    expect(fortnoxDeleteLabelAction.description).toContain('Cannot be undone')
    expect(fortnoxUpdatePredefinedAccountAction.description).toContain('by default')
  })

  it.effect('adapts every settings action to an agent tool with lowerable schemas', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(SettingsConnector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools).toHaveLength(fortnoxSettingsActions.length)

      for (const tool of toolSet.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
      }

      for (const action of fortnoxSettingsActions) {
        expect(toolJsonSchemaFromSchema(action.outputSchema)).toMatchObject({ type: 'object' })
        const access = toolSet.metadata.find(item => item.name.endsWith(action.id.slice(8)))
        expect(access?.access).toBe(action.access)
      }

      expect(harness.requests).toHaveLength(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect(
    'get_company_settings unwraps CompanySettings and preserves null and empty values',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({
            CompanySettings: {
              Name: 'Example AB',
              OrganizationNumber: '000000-0000',
              Address: 'Example Street 1',
              ZipCode: '000 00',
              City: 'Example City',
              CountryCode: 'SE',
              Email: 'info@example.test',
              BG: '',
              PG: null,
              TaxEnabled: false,
              DatabaseNumber: 1,
              Fax: ''
            }
          })
        ])

        const result = yield* fortnoxGetCompanySettingsAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        const value = successValue(result, FortnoxCompanySettings)

        expect({ ...value }).toEqual({
          Name: 'Example AB',
          OrganizationNumber: '000000-0000',
          Address: 'Example Street 1',
          ZipCode: '000 00',
          City: 'Example City',
          CountryCode: 'SE',
          Email: 'info@example.test',
          BG: '',
          PG: null,
          TaxEnabled: false
        })
        expect(harness.requests).toHaveLength(1)
        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: url('settings/company'),
          headers: readHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([['settings']])
      })
  )

  for (const [label, body, expected] of [
    ['a locked date', { LockedPeriod: { EndDate: '2026-01-31' } }, { EndDate: '2026-01-31' }],
    ['no date', { LockedPeriod: {} }, {}],
    ['a null date', { LockedPeriod: { EndDate: null } }, { EndDate: null }]
  ] as const) {
    it.effect(`get_locked_period decodes ${label}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([response(body)])

        const result = yield* fortnoxGetLockedPeriodAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        expect({ ...successValue(result, FortnoxLockedPeriod) }).toEqual(expected)
        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: url('settings/lockedperiod'),
          headers: readHeaders
        })
        expect(harness.scopes).toEqual([['settings']])
      })
    )
  }

  for (const [label, extra] of [
    ['without MetaInformation', {}],
    ['with single-page MetaInformation', { MetaInformation: meta(1, 1, 2) }]
  ] as const) {
    it.effect(`list_predefined_accounts returns every account ${label}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({
            PreDefinedAccounts: [
              {
                '@url': 'https://api.fortnox.se/3/predefinedaccounts/SALES',
                Name: 'SALES',
                Account: 3001
              },
              { Name: 'SALES2', Account: 3041 }
            ],
            ...extra
          })
        ])

        const result = yield* fortnoxListPredefinedAccountsAction
          .execute({ integration, input: {} })
          .pipe(Effect.provide(harness.layer))

        const value = successValue(result, FortnoxListPredefinedAccountsOutput)

        expect(Chunk.toReadonlyArray(value.predefinedAccounts).map(item => ({ ...item }))).toEqual([
          { Name: 'SALES', Account: 3001 },
          { Name: 'SALES2', Account: 3041 }
        ])
        expect(harness.requests[0]).toMatchObject({
          method: 'GET',
          url: url('predefinedaccounts'),
          headers: readHeaders
        })
        expect(harness.scopes).toEqual([['settings']])
      })
    )
  }

  it.effect('get_predefined_account reads one account by upper-case Name', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ PreDefinedAccount: { Name: 'SALES_25_SE', Account: 3001 } })
      ])

      const result = yield* fortnoxGetPredefinedAccountAction
        .execute({ integration, input: { name: 'SALES_25_SE' } })
        .pipe(Effect.provide(harness.layer))

      expect({ ...successValue(result, FortnoxPredefinedAccount) }).toEqual({
        Name: 'SALES_25_SE',
        Account: 3001
      })
      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: url('predefinedaccounts/SALES_25_SE'),
        headers: readHeaders
      })
      expect(harness.requests[0]?.body).toBeUndefined()
      expect(harness.scopes).toEqual([['settings']])
    })
  )

  it.effect('update_predefined_account PUTs only Account in the PreDefinedAccount envelope', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ PreDefinedAccount: { Name: 'BG', Account: 1930 } })])

      const result = yield* fortnoxUpdatePredefinedAccountAction
        .execute({ integration, input: { Name: 'BG', Account: 1930 } })
        .pipe(Effect.provide(harness.layer))

      expect({ ...successValue(result, FortnoxPredefinedAccount) }).toEqual({
        Name: 'BG',
        Account: 1930
      })
      expect(harness.requests).toHaveLength(1)
      expect(harness.requests[0]).toMatchObject({
        method: 'PUT',
        url: url('predefinedaccounts/BG'),
        headers: writeHeaders
      })
      expect(harness.requests[0]?.body).toBe('{"PreDefinedAccount":{"Account":1930}}')
      expect(harness.scopes).toEqual([['settings']])
    })
  )

  it.effect('list_labels returns every label', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          Labels: [
            { Id: 1, Description: 'Campaign' },
            { Id: 2, Description: 'Open' }
          ]
        })
      ])

      const result = yield* fortnoxListLabelsAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(harness.layer))

      const value = successValue(result, FortnoxListLabelsOutput)

      expect(Chunk.toReadonlyArray(value.labels).map(item => ({ ...item }))).toEqual([
        { Id: 1, Description: 'Campaign' },
        { Id: 2, Description: 'Open' }
      ])
      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: url('labels'),
        headers: readHeaders
      })
      expect(harness.scopes).toEqual([['settings']])
    })
  )

  it.effect('list_labels returns an empty list as an empty Chunk', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Labels: [] })])

      const result = yield* fortnoxListLabelsAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(harness.layer))

      expect(Chunk.size(successValue(result, FortnoxListLabelsOutput).labels)).toBe(0)
    })
  )

  it.effect('create_label POSTs the Label envelope and returns the assigned Id', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Label: { Id: 25, Description: 'Special' } }, 201)])

      const result = yield* fortnoxCreateLabelAction
        .execute({ integration, input: { Description: 'Special' } })
        .pipe(Effect.provide(harness.layer))

      expect({ ...successValue(result, FortnoxLabel) }).toEqual({ Id: 25, Description: 'Special' })
      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: url('labels'),
        headers: writeHeaders
      })
      expect(harness.requests[0]?.body).toBe('{"Label":{"Description":"Special"}}')
      expect(harness.scopes).toEqual([['settings']])
    })
  )

  it.effect('create_label accepts a typed input built from the exported class', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Label: { Id: 26, Description: 'Typed' } }, 201)])

      const result = yield* fortnoxCreateLabelAction
        .executeTyped({
          integration,
          input: FortnoxCreateLabelInput.make({ Description: 'Typed' })
        })
        .pipe(Effect.provide(harness.layer))

      expect(result._tag).toBe('Success')
      expect(harness.requests[0]?.body).toBe('{"Label":{"Description":"Typed"}}')
    })
  )

  it.effect('update_label PUTs the Description to the Id path without Id in the body', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Label: { Id: 7, Description: 'Renamed' } })])

      const result = yield* fortnoxUpdateLabelAction
        .execute({ integration, input: { Id: 7, Description: 'Renamed' } })
        .pipe(Effect.provide(harness.layer))

      expect({ ...successValue(result, FortnoxLabel) }).toEqual({ Id: 7, Description: 'Renamed' })
      expect(harness.requests[0]).toMatchObject({
        method: 'PUT',
        url: url('labels/7'),
        headers: writeHeaders
      })
      expect(harness.requests[0]?.body).toBe('{"Label":{"Description":"Renamed"}}')
      expect(harness.scopes).toEqual([['settings']])
    })
  )

  for (const status of [200, 204]) {
    it.effect(`delete_label treats HTTP ${status} with an empty body as deleted`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([rawResponse('', status)])

        const result = yield* fortnoxDeleteLabelAction
          .execute({ integration, input: { labelId: 7 } })
          .pipe(Effect.provide(harness.layer))

        expect({ ...successValue(result, FortnoxDeleteLabelOutput) }).toEqual({
          labelId: 7,
          deleted: true
        })
        expect(harness.requests).toHaveLength(1)
        expect(harness.requests[0]).toMatchObject({
          method: 'DELETE',
          url: url('labels/7'),
          headers: readHeaders
        })
        expect(harness.requests[0]?.body).toBeUndefined()
        expect(harness.scopes).toEqual([['settings']])
      })
    )
  }

  const invalidInputs: ReadonlyArray<{
    readonly action: (typeof fortnoxSettingsActions)[number]
    readonly input: unknown
  }> = [
    { action: fortnoxGetCompanySettingsAction, input: null },
    { action: fortnoxGetPredefinedAccountAction, input: {} },
    { action: fortnoxGetPredefinedAccountAction, input: { name: '' } },
    { action: fortnoxGetPredefinedAccountAction, input: { name: 'sales' } },
    { action: fortnoxGetPredefinedAccountAction, input: { name: '..' } },
    { action: fortnoxGetPredefinedAccountAction, input: { name: 'SALES/../BG' } },
    { action: fortnoxGetPredefinedAccountAction, input: { name: 'SALES?x=1' } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'BG' } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'BG', Account: 999 } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'BG', Account: 10000 } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'BG', Account: 1930.5 } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'BG', Account: '1930' } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'BG', Account: null } },
    { action: fortnoxUpdatePredefinedAccountAction, input: { Name: 'bg', Account: 1930 } },
    {
      action: fortnoxUpdatePredefinedAccountAction,
      input: { Name: 'BG', Account: 1930, Unknown: 'value' }
    },
    { action: fortnoxCreateLabelAction, input: {} },
    { action: fortnoxCreateLabelAction, input: { Description: '' } },
    { action: fortnoxCreateLabelAction, input: { Description: null } },
    { action: fortnoxCreateLabelAction, input: { Description: 'x'.repeat(26) } },
    { action: fortnoxCreateLabelAction, input: { Description: 'Special', Id: 1 } },
    { action: fortnoxCreateLabelAction, input: { Description: 'Special', Unknown: 'value' } },
    { action: fortnoxUpdateLabelAction, input: { Description: 'Renamed' } },
    { action: fortnoxUpdateLabelAction, input: { Id: 7 } },
    { action: fortnoxUpdateLabelAction, input: { Id: 0, Description: 'Renamed' } },
    { action: fortnoxUpdateLabelAction, input: { Id: -1, Description: 'Renamed' } },
    { action: fortnoxUpdateLabelAction, input: { Id: 1.5, Description: 'Renamed' } },
    { action: fortnoxUpdateLabelAction, input: { Id: '7', Description: 'Renamed' } },
    { action: fortnoxUpdateLabelAction, input: { Id: 7, Description: null } },
    { action: fortnoxUpdateLabelAction, input: { Id: 7, Description: 'R', Unknown: 'v' } },
    { action: fortnoxDeleteLabelAction, input: {} },
    { action: fortnoxDeleteLabelAction, input: { labelId: null } },
    { action: fortnoxDeleteLabelAction, input: { labelId: '7' } },
    { action: fortnoxDeleteLabelAction, input: { labelId: 0 } }
  ]

  for (const [index, item] of invalidInputs.entries()) {
    it.effect(`${item.action.id} rejects invalid input ${index} before credentials or HTTP`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const result = yield* item.action
          .execute({ integration, input: item.input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )
  }

  it.effect('rejects unknown keys on typed closed writes too', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const result = yield* fortnoxCreateLabelAction
        .executeTyped({
          integration,
          input: { Description: 'Special', ...{ Extra: 'value' } }
        })
        .pipe(Effect.provide(harness.layer), Effect.result)

      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(harness.requests).toHaveLength(0)
    })
  )

  for (const [action, input, status, code] of [
    [
      fortnoxUpdatePredefinedAccountAction,
      { Name: 'BG', Account: 1930 },
      400,
      'fortnox_request_failed'
    ],
    [fortnoxUpdateLabelAction, { Id: 7, Description: 'Renamed' }, 404, 'fortnox_not_found'],
    [fortnoxDeleteLabelAction, { labelId: 7 }, 404, 'fortnox_not_found'],
    [fortnoxListLabelsAction, {}, 401, 'fortnox_unauthorized'],
    [fortnoxGetCompanySettingsAction, {}, 403, 'fortnox_forbidden'],
    [fortnoxGetLockedPeriodAction, {}, 429, 'fortnox_rate_limited'],
    [fortnoxCreateLabelAction, { Description: 'Special' }, 503, 'fortnox_request_failed']
  ] as const) {
    it.effect(`${action.id} returns HTTP ${status} as a ${code} provider failure`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ ErrorInformation: { Code: 2001265, Message: 'Provider detail' } }, status)
        ])

        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer))

        expect(result).toMatchObject({
          _tag: 'Failure',
          error: { code, status, message: 'Provider detail', underlying: { providerCode: 2001265 } }
        })
        expect(harness.requests).toHaveLength(1)
      })
    )
  }

  for (const [action, body] of [
    [fortnoxGetCompanySettingsAction, '{}'],
    [fortnoxGetCompanySettingsAction, '{"CompanySettings":{"TaxEnabled":"no"}}'],
    [fortnoxGetLockedPeriodAction, '{}'],
    [fortnoxListLabelsAction, 'not json'],
    [fortnoxListLabelsAction, '{}'],
    [fortnoxListLabelsAction, '{"Labels":[{"Description":"Missing Id"}]}'],
    [fortnoxListLabelsAction, '{"Labels":[{"Id":"1","Description":"String Id"}]}'],
    [fortnoxListLabelsAction, `{"Labels":[],"MetaInformation":${JSON.stringify(meta(1, 2, 150))}}`],
    [fortnoxListPredefinedAccountsAction, '{"PredefinedAccounts":[]}'],
    [fortnoxListPredefinedAccountsAction, '{"PreDefinedAccounts":[{"Account":3001}]}'],
    [
      fortnoxListPredefinedAccountsAction,
      `{"PreDefinedAccounts":[],"MetaInformation":${JSON.stringify(meta(1, 2, 150))}}`
    ],
    [fortnoxGetPredefinedAccountAction, '{"PredefinedAccount":{"Name":"BG","Account":1930}}']
  ] as const) {
    it.effect(`${action.id} rejects malformed or truncated success data: ${body}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([rawResponse(body)])

        const input = action.id === 'fortnox.get_predefined_account' ? { name: 'BG' } : {}

        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      })
    )
  }
})
