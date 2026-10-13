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
  FortnoxListModesOfPaymentOutput,
  FortnoxModeOfPayment,
  FortnoxUnitCode,
  fortnoxCreateModeOfPaymentAction,
  fortnoxCreateTermsOfDeliveryAction,
  fortnoxCreateTermsOfPaymentAction,
  fortnoxCreateUnitAction,
  fortnoxCreateWayOfDeliveryAction,
  fortnoxDeleteModeOfPaymentAction,
  fortnoxDeleteTermsOfPaymentAction,
  fortnoxDeleteUnitAction,
  fortnoxDeleteWayOfDeliveryAction,
  fortnoxGetModeOfPaymentAction,
  fortnoxGetTermsOfDeliveryAction,
  fortnoxGetTermsOfPaymentAction,
  fortnoxGetUnitAction,
  fortnoxGetWayOfDeliveryAction,
  fortnoxListModesOfPaymentAction,
  fortnoxListTermsOfDeliveryAction,
  fortnoxListTermsOfPaymentAction,
  fortnoxListUnitsAction,
  fortnoxListWaysOfDeliveryAction,
  fortnoxSettingsRegisterActions,
  fortnoxUpdateModeOfPaymentAction,
  fortnoxUpdateTermsOfDeliveryAction,
  fortnoxUpdateTermsOfPaymentAction,
  fortnoxUpdateUnitAction,
  fortnoxUpdateWayOfDeliveryAction
} from '../src/fortnox/settings-registers.ts'

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

type RegisterAction = (typeof fortnoxSettingsRegisterActions)[number]

const run = (
  action: RegisterAction,
  input: unknown,
  responses: ReadonlyArray<ConnectorHttpResponse>
) => {
  const harness = makeHarness(responses)

  return action.execute({ integration, input }).pipe(
    Effect.provide(harness.layer),
    Effect.result,
    Effect.map(result => ({ result, harness }))
  )
}

// Runs an action that must succeed; `json` is exactly what an agent sees (the success value
// encoded with the action's output schema).
const runSuccess = (
  action: RegisterAction,
  input: unknown,
  responses: ReadonlyArray<ConnectorHttpResponse>
) =>
  Effect.gen(function* () {
    const harness = makeHarness(responses)
    const result = yield* action.execute({ integration, input }).pipe(Effect.provide(harness.layer))

    if (!Predicate.isTagged(result, 'Success')) {
      return yield* Effect.die(new Error(`Expected success, got ${JSON.stringify(result)}`))
    }

    const json = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(action.outputSchema))(
      result.value
    )

    return { value: result.value, json, harness }
  })

const base = 'https://api.fortnox.se/3'

const readHeaders = { authorization: 'Bearer test-access-token', accept: 'application/json' }

const writeHeaders = { ...readHeaders, 'content-type': 'application/json' }

type RegisterCase = {
  readonly name: string
  readonly path: string
  readonly listKey: string
  readonly singleKey: string
  readonly outputKey: string
  readonly list: RegisterAction
  readonly get: RegisterAction
  readonly create: RegisterAction
  readonly update: RegisterAction
  readonly delete: RegisterAction | undefined
  readonly entry: { readonly [key: string]: Schema.Json }
  readonly createInput: { readonly [key: string]: Schema.Json }
  readonly updateFields: { readonly [key: string]: Schema.Json }
}

const registers: ReadonlyArray<RegisterCase> = [
  {
    name: 'modes of payment',
    path: 'modesofpayments',
    listKey: 'ModesOfPayments',
    singleKey: 'ModeOfPayment',
    outputKey: 'modesOfPayment',
    list: fortnoxListModesOfPaymentAction,
    get: fortnoxGetModeOfPaymentAction,
    create: fortnoxCreateModeOfPaymentAction,
    update: fortnoxUpdateModeOfPaymentAction,
    delete: fortnoxDeleteModeOfPaymentAction,
    entry: { Code: 'EX', Description: 'Example payment', AccountNumber: 1930 },
    createInput: { Code: 'EX', Description: 'Example payment', AccountNumber: 1930 },
    updateFields: { Description: 'Example payment 2' }
  },
  {
    name: 'terms of payment',
    path: 'termsofpayments',
    listKey: 'TermsOfPayments',
    singleKey: 'TermsOfPayment',
    outputKey: 'termsOfPayment',
    list: fortnoxListTermsOfPaymentAction,
    get: fortnoxGetTermsOfPaymentAction,
    create: fortnoxCreateTermsOfPaymentAction,
    update: fortnoxUpdateTermsOfPaymentAction,
    delete: fortnoxDeleteTermsOfPaymentAction,
    entry: { Code: 'EX', Description: 'Example terms' },
    createInput: { Code: 'EX', Description: 'Example terms' },
    updateFields: { Description: 'Example terms 2' }
  },
  {
    name: 'terms of delivery',
    path: 'termsofdeliveries',
    listKey: 'TermsOfDeliveries',
    singleKey: 'TermsOfDelivery',
    outputKey: 'termsOfDelivery',
    list: fortnoxListTermsOfDeliveryAction,
    get: fortnoxGetTermsOfDeliveryAction,
    create: fortnoxCreateTermsOfDeliveryAction,
    update: fortnoxUpdateTermsOfDeliveryAction,
    delete: undefined,
    entry: { Code: 'EX', Description: 'Example delivery', DescriptionEnglish: null },
    createInput: { Code: 'EX', Description: 'Example delivery' },
    updateFields: { DescriptionEnglish: 'Example delivery' }
  },
  {
    name: 'ways of delivery',
    path: 'wayofdeliveries',
    listKey: 'WayOfDeliveries',
    singleKey: 'WayOfDelivery',
    outputKey: 'waysOfDelivery',
    list: fortnoxListWaysOfDeliveryAction,
    get: fortnoxGetWayOfDeliveryAction,
    create: fortnoxCreateWayOfDeliveryAction,
    update: fortnoxUpdateWayOfDeliveryAction,
    delete: fortnoxDeleteWayOfDeliveryAction,
    entry: { Code: 'EX', Description: 'Example way', DescriptionEnglish: 'Example way' },
    createInput: { Code: 'EX', Description: 'Example way', DescriptionEnglish: 'Example way' },
    updateFields: { Description: 'Example way 2' }
  },
  {
    name: 'units',
    path: 'units',
    listKey: 'Units',
    singleKey: 'Unit',
    outputKey: 'units',
    list: fortnoxListUnitsAction,
    get: fortnoxGetUnitAction,
    create: fortnoxCreateUnitAction,
    update: fortnoxUpdateUnitAction,
    delete: fortnoxDeleteUnitAction,
    entry: { Code: 'EX', Description: 'example unit', CodeEnglish: 'ex' },
    createInput: { Code: 'EX', Description: 'example unit', CodeEnglish: 'ex' },
    updateFields: { Description: 'example unit 2' }
  }
]

describe('Fortnox settings registers', () => {
  it('exports every action in a stable order with access metadata', () => {
    expect(fortnoxSettingsRegisterActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.list_modes_of_payment', 'read'],
      ['fortnox.get_mode_of_payment', 'read'],
      ['fortnox.create_mode_of_payment', 'write'],
      ['fortnox.update_mode_of_payment', 'write'],
      ['fortnox.delete_mode_of_payment', 'destructive'],
      ['fortnox.list_terms_of_payment', 'read'],
      ['fortnox.get_terms_of_payment', 'read'],
      ['fortnox.create_terms_of_payment', 'write'],
      ['fortnox.update_terms_of_payment', 'write'],
      ['fortnox.delete_terms_of_payment', 'destructive'],
      ['fortnox.list_terms_of_delivery', 'read'],
      ['fortnox.get_terms_of_delivery', 'read'],
      ['fortnox.create_terms_of_delivery', 'write'],
      ['fortnox.update_terms_of_delivery', 'write'],
      ['fortnox.list_ways_of_delivery', 'read'],
      ['fortnox.get_way_of_delivery', 'read'],
      ['fortnox.create_way_of_delivery', 'write'],
      ['fortnox.update_way_of_delivery', 'write'],
      ['fortnox.delete_way_of_delivery', 'destructive'],
      ['fortnox.list_units', 'read'],
      ['fortnox.get_unit', 'read'],
      ['fortnox.create_unit', 'write'],
      ['fortnox.update_unit', 'write'],
      ['fortnox.delete_unit', 'destructive']
    ])

    for (const action of fortnoxSettingsRegisterActions) {
      if (action.access === 'destructive') {
        expect(action.description).toContain('cannot be undone')
      }
    }
  })

  it('lowers every output schema to JSON Schema', () => {
    for (const action of fortnoxSettingsRegisterActions) {
      expect(toolJsonSchemaFromSchema(action.outputSchema)).toMatchObject({ type: 'object' })
    }
  })

  it.effect('adapts every action to an agent tool with object input schemas', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])
      const connector = defineConnector({ id: 'fortnox', actions: fortnoxSettingsRegisterActions })

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(connector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools).toHaveLength(fortnoxSettingsRegisterActions.length)

      for (const tool of toolSet.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
      }

      expect(harness.requests).toHaveLength(0)
    })
  )

  for (const register of registers) {
    describe(register.name, () => {
      it.effect('lists one page with page/limit and pagination', () =>
        Effect.gen(function* () {
          const { json, harness } = yield* runSuccess(register.list, { page: 2, limit: 50 }, [
            response({ [register.listKey]: [register.entry], MetaInformation: meta(2, 3, 101) })
          ])

          expect(json).toEqual({
            [register.outputKey]: [register.entry],
            pagination: { currentPage: 2, totalPages: 3, totalResources: 101, nextPage: 3 }
          })
          expect(harness.requests).toHaveLength(1)
          expect(harness.requests[0]).toMatchObject({
            method: 'GET',
            url: `${base}/${register.path}?page=2&limit=50`,
            headers: readHeaders
          })
          expect(harness.requests[0]?.headers).toEqual(readHeaders)
          expect(harness.requests[0]?.body).toBeUndefined()
          expect(harness.scopes).toEqual([['settings']])
        })
      )

      it.effect('fails a list without MetaInformation instead of assuming one page', () =>
        Effect.gen(function* () {
          const { result } = yield* run(register.list, {}, [
            response({ [register.listKey]: [register.entry] })
          ])

          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { cause: 'validation_failed' }
          })
        })
      )

      it.effect('reads one entry by encoded Code', () =>
        Effect.gen(function* () {
          const { json, harness } = yield* runSuccess(register.get, { code: 'HÄM/1' }, [
            response({
              [register.singleKey]: { '@url': 'https://example.test/x', ...register.entry }
            })
          ])

          expect(json).toEqual(register.entry)
          expect(harness.requests[0]).toMatchObject({
            method: 'GET',
            url: `${base}/${register.path}/H%C3%84M%2F1`
          })
          expect(harness.scopes).toEqual([['settings']])
        })
      )

      it.effect('creates with the Fortnox envelope', () =>
        Effect.gen(function* () {
          const { json, harness } = yield* runSuccess(register.create, register.createInput, [
            response({ [register.singleKey]: register.entry }, 201)
          ])

          expect(json).toEqual(register.entry)
          expect(harness.requests[0]).toMatchObject({
            method: 'POST',
            url: `${base}/${register.path}`
          })
          expect(harness.requests[0]?.headers).toEqual(writeHeaders)
          expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
            [register.singleKey]: register.createInput
          })
          expect(harness.scopes).toEqual([['settings']])
        })
      )

      it.effect('updates by Code in the URL without sending Code', () =>
        Effect.gen(function* () {
          const { json, harness } = yield* runSuccess(
            register.update,
            { Code: 'A B', ...register.updateFields },
            [response({ [register.singleKey]: register.entry })]
          )

          expect(json).toEqual(register.entry)
          expect(harness.requests[0]).toMatchObject({
            method: 'PUT',
            url: `${base}/${register.path}/A%20B`
          })
          expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
            [register.singleKey]: register.updateFields
          })
        })
      )

      it.effect('rejects bad codes, nulls, and unknown keys before any request', () =>
        Effect.gen(function* () {
          const invalid: ReadonlyArray<readonly [RegisterAction, unknown]> = [
            [register.get, { code: '..' }],
            [register.get, { code: '' }],
            [register.get, { code: ' EX' }],
            [register.create, { ...register.createInput, Unknown: 'x' }],
            [register.create, { ...register.createInput, Description: null }],
            [register.create, { Description: 'missing code' }],
            [register.update, { Code: 'EX', Unknown: 'x' }],
            [register.update, { Code: '.', ...register.updateFields }],
            [register.list, { limit: 501 }],
            [register.list, { page: 0 }]
          ]

          for (const [action, input] of invalid) {
            const { result, harness } = yield* run(action, input, [])
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { cause: 'validation_failed' }
            })
            expect(harness.requests).toHaveLength(0)
            expect(harness.scopes).toHaveLength(0)
          }
        })
      )

      it.effect('maps non-2xx answers to ActionResult failures', () =>
        Effect.gen(function* () {
          const { result } = yield* run(register.get, { code: 'EX' }, [
            response(
              { ErrorInformation: { error: 1, message: 'Kan inte hitta', code: 2000430 } },
              404
            )
          ])

          expect(result).toMatchObject({
            _tag: 'Success',
            success: {
              _tag: 'Failure',
              error: {
                code: 'fortnox_not_found',
                status: 404,
                message: 'Kan inte hitta',
                underlying: { providerCode: 2000430 }
              }
            }
          })
        })
      )

      const deleteAction = register.delete

      if (deleteAction === undefined) {
        it('has no delete action (Fortnox documents none)', () => {
          expect(
            fortnoxSettingsRegisterActions.some(
              action => action.id === 'fortnox.delete_terms_of_delivery'
            )
          ).toBe(false)
        })
      } else {
        it.effect('deletes by encoded Code without decoding the empty answer', () =>
          Effect.gen(function* () {
            const { json, harness } = yield* runSuccess(deleteAction, { code: 'A/B' }, [empty(204)])

            expect(json).toEqual({ code: 'A/B', deleted: true })
            expect(harness.requests).toHaveLength(1)
            expect(harness.requests[0]).toMatchObject({
              method: 'DELETE',
              url: `${base}/${register.path}/A%2FB`
            })
            expect(harness.requests[0]?.headers).toEqual(readHeaders)
            expect(harness.requests[0]?.body).toBeUndefined()
            expect(harness.scopes).toEqual([['settings']])
          })
        )

        it.effect('reports a failed delete as an ActionResult failure', () =>
          Effect.gen(function* () {
            const { result } = yield* run(deleteAction, { code: 'EX' }, [
              response({ ErrorInformation: { message: 'Används' } }, 400)
            ])

            expect(result).toMatchObject({
              _tag: 'Success',
              success: {
                _tag: 'Failure',
                error: { code: 'fortnox_request_failed', status: 400, message: 'Används' }
              }
            })
          })
        )
      }
    })
  }

  it.effect('decodes mode-of-payment AccountNumber from string list rows and numeric reads', () =>
    Effect.gen(function* () {
      const list = yield* runSuccess(fortnoxListModesOfPaymentAction, {}, [
        response({
          ModesOfPayments: [
            {
              '@url': `${base}/modesofpayments/EX`,
              Code: 'EX',
              Description: 'Ex',
              AccountNumber: '1930'
            }
          ],
          MetaInformation: meta()
        })
      ])

      expect(list.json).toEqual({
        modesOfPayment: [{ Code: 'EX', Description: 'Ex', AccountNumber: 1930 }],
        pagination: { currentPage: 1, totalPages: 1, totalResources: 1 }
      })

      // Runtime value: a Class instance holding a Chunk of Class rows (not the wire arrays).
      expect(list.value).toBeInstanceOf(FortnoxListModesOfPaymentOutput)

      const rows = Schema.is(FortnoxListModesOfPaymentOutput)(list.value)
        ? Chunk.toReadonlyArray(list.value.modesOfPayment)
        : []

      expect(rows).toHaveLength(1)
      expect(rows[0]).toBeInstanceOf(FortnoxModeOfPayment)

      const single = yield* runSuccess(fortnoxGetModeOfPaymentAction, { code: 'EX' }, [
        response({ ModeOfPayment: { Code: 'EX', AccountNumber: 1930, Description: null } })
      ])

      expect(single.json).toEqual({
        Code: 'EX',
        AccountNumber: 1930,
        Description: null
      })

      const bad = yield* run(fortnoxGetModeOfPaymentAction, { code: 'EX' }, [
        response({ ModeOfPayment: { Code: 'EX', AccountNumber: '19x0' } })
      ])

      expect(bad.result).toMatchObject({
        _tag: 'Failure',
        failure: { cause: 'validation_failed' }
      })
    })
  )

  it.effect('enforces documented write limits before any request', () =>
    Effect.gen(function* () {
      const invalid: ReadonlyArray<readonly [RegisterAction, unknown]> = [
        [fortnoxCreateModeOfPaymentAction, { Code: 'EX', Description: 'Ex' }],
        [fortnoxCreateModeOfPaymentAction, { Code: 'EX', AccountNumber: 193 }],
        [fortnoxCreateModeOfPaymentAction, { Code: 'EX', AccountNumber: '1930' }],
        [fortnoxUpdateModeOfPaymentAction, { Code: 'EX', AccountNumber: 19300 }],
        [fortnoxCreateTermsOfPaymentAction, { Code: 'X'.repeat(26), Description: 'Ex' }],
        [fortnoxCreateTermsOfPaymentAction, { Code: 'EX' }],
        [fortnoxCreateTermsOfDeliveryAction, { Code: 'X'.repeat(21), Description: 'Ex' }],
        [fortnoxCreateTermsOfDeliveryAction, { Code: 'EX', Description: 'X'.repeat(201) }],
        [fortnoxCreateWayOfDeliveryAction, { Code: 'X'.repeat(51) }],
        [fortnoxCreateWayOfDeliveryAction, { Code: 'EX', DescriptionEnglish: 'X'.repeat(101) }],
        [fortnoxCreateUnitAction, { Code: 'X'.repeat(21), Description: 'Ex' }],
        [fortnoxCreateUnitAction, { Code: 'EX', Description: '' }],
        [fortnoxCreateUnitAction, { Code: 'EX' }]
      ]

      for (const [action, input] of invalid) {
        const { result, harness } = yield* run(action, input, [])
        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
      }
    })
  )

  it.effect('accepts maximum-length codes and an optional-only way of delivery', () =>
    Effect.gen(function* () {
      const accepted: ReadonlyArray<readonly [RegisterAction, Schema.Json, Schema.Json]> = [
        [
          fortnoxCreateTermsOfPaymentAction,
          { Code: 'X'.repeat(25), Description: 'Ex' },
          { TermsOfPayment: { Code: 'X'.repeat(25), Description: 'Ex' } }
        ],
        [
          fortnoxCreateWayOfDeliveryAction,
          { Code: 'X'.repeat(50) },
          { WayOfDelivery: { Code: 'X'.repeat(50) } }
        ],
        [
          fortnoxCreateUnitAction,
          { Code: 'X'.repeat(20), Description: 'Ex' },
          { Unit: { Code: 'X'.repeat(20), Description: 'Ex' } }
        ]
      ]

      for (const [action, input, body] of accepted) {
        const { harness } = yield* runSuccess(action, input, [response(body, 201)])
        expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual(body)
      }
    })
  )

  it.effect('sends typed writes built from exported schemas', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ Unit: { Code: 'm', Description: 'meter' } })])
      const code = yield* Schema.decodeUnknownEffect(FortnoxUnitCode)('m')

      const result = yield* fortnoxUpdateUnitAction
        .executeTyped({ integration, input: { Code: code, Description: 'meter' } })
        .pipe(Effect.provide(harness.layer))

      expect(result).toMatchObject({ _tag: 'Success', value: { Code: 'm', Description: 'meter' } })
      expect(harness.requests[0]).toMatchObject({ method: 'PUT', url: `${base}/units/m` })
      expect(JSON.parse(harness.requests[0]?.body ?? '')).toEqual({
        Unit: { Description: 'meter' }
      })
    })
  )
})
