import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  MicrosoftConnector,
  microsoftGraphMailboxSettingsReadScope,
  microsoftGraphMailboxSettingsReadWriteScope,
  microsoftOAuthSlotId,
  outlookGetCategoryAction,
  outlookUpdateCategoryAction
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

const makeHost = (body = '{}', status = 200) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
            accessToken: 'token',
            expiresAt: 4_000_000_000_000
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)

        return Effect.succeed(ConnectorHttpResponse.make({ status, headers: {}, body }))
      }
    })
  )

  return { layer, requests, scopes }
}

describe('Outlook category read and color update', () => {
  it.effect('registers read/write actions with provider-safe tool schemas', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      expect(outlookGetCategoryAction.access).toBe('read')
      expect(outlookUpdateCategoryAction.access).toBe('write')
      expect(MicrosoftConnector.actions).toContain(outlookGetCategoryAction)
      expect(MicrosoftConnector.actions).toContain(outlookUpdateCategoryAction)
      expect(
        tools.tools.find(tool => tool.name === 'outlook.get_category')?.parameters
      ).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['categoryId'])
      })
      expect(
        tools.tools.find(tool => tool.name === 'outlook.update_category')?.parameters
      ).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['categoryId', 'color'])
      })
    })
  )

  it.effect('gets one category with MailboxSettings.Read', () =>
    Effect.gen(function* () {
      const host = makeHost(
        JSON.stringify({ id: 'cat/1', displayName: 'Receipts', color: 'preset0' })
      )

      const result = yield* outlookGetCategoryAction
        .execute({ integration, input: { categoryId: 'cat/1' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: { id: 'cat/1', displayName: 'Receipts', color: 'preset0' }
      })
      expect(host.requests).toMatchObject([
        {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories/cat%2F1',
          headers: {
            authorization: 'Bearer token',
            prefer: 'IdType="ImmutableId"'
          }
        }
      ])
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadScope]])
    })
  )

  it.effect('updates only the color with PATCH and MailboxSettings.ReadWrite', () =>
    Effect.gen(function* () {
      const host = makeHost(
        JSON.stringify({ id: 'cat_1', displayName: 'Receipts', color: 'preset15' })
      )

      const result = yield* outlookUpdateCategoryAction
        .execute({ integration, input: { categoryId: 'cat_1', color: 'preset15' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: { id: 'cat_1', displayName: 'Receipts', color: 'preset15' }
      })
      expect(host.requests).toMatchObject([
        {
          method: 'PATCH',
          url: 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories/cat_1',
          body: JSON.stringify({ color: 'preset15' }),
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json'
          }
        }
      ])
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadWriteScope]])
    })
  )

  it.effect('targets explicit mailboxes without Shared settings scopes', () =>
    Effect.gen(function* () {
      const host = makeHost(JSON.stringify({ id: 'cat_1', displayName: 'Receipts' }))

      const result = yield* outlookGetCategoryAction
        .execute({ integration, input: { mailbox: 'shared@example.com', categoryId: 'cat_1' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/shared%40example.com/outlook/masterCategories/cat_1'
      )
      expect(host.scopes).toEqual([[microsoftGraphMailboxSettingsReadScope]])

      const updateHost = makeHost(
        JSON.stringify({ id: 'cat_1', displayName: 'Receipts', color: 'preset2' })
      )

      const updated = yield* outlookUpdateCategoryAction
        .execute({
          integration,
          input: { mailbox: 'shared@example.com', categoryId: 'cat_1', color: 'preset2' }
        })
        .pipe(Effect.provide(updateHost.layer))

      expect(updated._tag).toBe('Success')
      expect(updateHost.requests.at(0)).toMatchObject({
        method: 'PATCH',
        url: 'https://graph.microsoft.com/v1.0/users/shared%40example.com/outlook/masterCategories/cat_1',
        body: JSON.stringify({ color: 'preset2' })
      })
      expect(updateHost.scopes).toEqual([[microsoftGraphMailboxSettingsReadWriteScope]])
    })
  )

  it.effect('requires an explicit mailbox for application mode before IO', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const application = makeIntegration({
        connectorId: 'microsoft',
        config: { mailboxAccessMode: 'application' },
        credentialBindings: integration.credentialBindings
      })

      for (const effect of [
        outlookGetCategoryAction.execute({ integration: application, input: { categoryId: 'c' } }),
        outlookUpdateCategoryAction.execute({
          integration: application,
          input: { categoryId: 'c', color: 'preset1' }
        })
      ]) {
        const result = yield* effect.pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('rejects invalid inputs before credentials or HTTP', () =>
    Effect.gen(function* () {
      const host = makeHost()

      for (const categoryId of ['', '.', '..']) {
        const result = yield* outlookGetCategoryAction
          .execute({ integration, input: { categoryId } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      for (const mailbox of ['.', '..']) {
        for (const effect of [
          outlookGetCategoryAction.execute({ integration, input: { mailbox, categoryId: 'c' } }),
          outlookUpdateCategoryAction.execute({
            integration,
            input: { mailbox, categoryId: 'c', color: 'preset1' }
          })
        ]) {
          const result = yield* effect.pipe(Effect.provide(host.layer), Effect.result)

          expect(result._tag).toBe('Failure')
          expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        }
      }

      const updateCases: ReadonlyArray<{ readonly categoryId: string; readonly color: string }> = [
        { categoryId: '', color: 'preset1' },
        { categoryId: '.', color: 'preset1' },
        { categoryId: 'cat_1', color: 'blue' },
        { categoryId: 'cat_1', color: '' }
      ]

      for (const input of updateCases) {
        const result = yield* outlookUpdateCategoryAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('fails malformed outputs as validation errors', () =>
    Effect.gen(function* () {
      const getHost = makeHost('{"displayName":"Receipts"}')
      const updateHost = makeHost('{"id":"cat_1"}')

      const getResult = yield* outlookGetCategoryAction
        .execute({ integration, input: { categoryId: 'cat_1' } })
        .pipe(Effect.provide(getHost.layer), Effect.result)

      const updateResult = yield* outlookUpdateCategoryAction
        .execute({ integration, input: { categoryId: 'cat_1', color: 'preset1' } })
        .pipe(Effect.provide(updateHost.layer), Effect.result)

      expect(getResult).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(updateResult).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  for (const [actionId, execute] of [
    [
      'outlook.get_category',
      (host: ReturnType<typeof makeHost>) =>
        outlookGetCategoryAction
          .execute({ integration, input: { categoryId: 'cat_1' } })
          .pipe(Effect.provide(host.layer))
    ],
    [
      'outlook.update_category',
      (host: ReturnType<typeof makeHost>) =>
        outlookUpdateCategoryAction
          .execute({
            integration,
            input: { categoryId: 'cat_1', color: 'preset1' }
          })
          .pipe(Effect.provide(host.layer))
    ]
  ] as const) {
    for (const [status, code] of [
      [401, 'microsoft_unauthorized'],
      [404, 'microsoft_not_found'],
      [429, 'microsoft_rate_limited'],
      [500, `${actionId.replace('.', '_')}_failed`]
    ] as const) {
      it.effect(`${actionId} preserves provider failure at HTTP ${status}`, () =>
        Effect.gen(function* () {
          const host = makeHost('{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', status)

          const result = yield* execute(host)

          expect(result._tag).toBe('Failure')
          expect(result).toMatchObject({ error: { code, status } })
        })
      )
    }
  }
})
