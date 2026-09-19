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
  microsoftOAuthSlotId,
  outlookMoveMessageAction
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

const makeHost = (body = '{"id":"moved-id"}', status = 200) => {
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

describe('Outlook move message', () => {
  it.effect('registers a write action with a provider-safe tool schema', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      expect(outlookMoveMessageAction.id).toBe('outlook.move_message')
      expect(outlookMoveMessageAction.access).toBe('write')
      expect(MicrosoftConnector.actions).toContain(outlookMoveMessageAction)
      expect(
        tools.tools.find(tool => tool.name === 'outlook.move_message')?.parameters
      ).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['messageId', 'destinationFolderId'])
      })
    })
  )

  it.effect('moves via POST /move with Mail.ReadWrite and returns the provider message', () =>
    Effect.gen(function* () {
      const host = makeHost(JSON.stringify({ id: 'moved-id', parentFolderId: 'archive-id' }))

      const result = yield* MicrosoftConnector.invoke({
        integration,
        action: 'outlook.move_message',
        input: { messageId: 'message/1', destinationFolderId: 'archive' }
      }).pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({ value: { id: 'moved-id', parentFolderId: 'archive-id' } })
      expect(host.requests).toMatchObject([
        {
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/me/messages/message%2F1/move',
          body: JSON.stringify({ destinationId: 'archive' }),
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
            prefer: 'IdType="ImmutableId"'
          }
        }
      ])
      expect(host.scopes).toEqual([['https://graph.microsoft.com/Mail.ReadWrite']])
    })
  )

  it.effect('moves shared mailboxes through the Shared message slot', () =>
    Effect.gen(function* () {
      const host = makeHost('{"id":"moved-id"}')

      const result = yield* outlookMoveMessageAction
        .execute({
          integration,
          input: {
            mailbox: 'shared@example.com',
            messageId: 'm1',
            destinationFolderId: 'archive'
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/m1/move'
      )
      expect(host.scopes).toEqual([
        undefined,
        ['https://graph.microsoft.com/Mail.ReadWrite.Shared']
      ])
    })
  )

  it.effect('requires a mailbox for application mode before IO', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const application = makeIntegration({
        connectorId: 'microsoft',
        config: { mailboxAccessMode: 'application' },
        credentialBindings: integration.credentialBindings
      })

      const result = yield* outlookMoveMessageAction
        .execute({
          integration: application,
          input: { messageId: 'm1', destinationFolderId: 'archive' }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('rejects empty identifiers before credentials or HTTP', () =>
    Effect.gen(function* () {
      const host = makeHost()

      for (const input of [
        { messageId: '', destinationFolderId: 'archive' },
        { messageId: 'm1', destinationFolderId: '' },
        { messageId: 'm1', destinationFolderId: '   ' },
        { messageId: 'm1' }
      ]) {
        const result = yield* outlookMoveMessageAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(host.requests).toEqual([])
      expect(host.scopes).toEqual([])
    })
  )

  it.effect('fails malformed provider output as a validation error', () =>
    Effect.gen(function* () {
      const host = makeHost('{"parentFolderId":"archive-id"}')

      const result = yield* outlookMoveMessageAction
        .execute({ integration, input: { messageId: 'm1', destinationFolderId: 'archive' } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  for (const [status, code] of [
    [401, 'microsoft_unauthorized'],
    [404, 'microsoft_not_found'],
    [429, 'microsoft_rate_limited'],
    [500, 'outlook_move_message_failed']
  ] as const) {
    it.effect(`preserves provider failure at HTTP ${status}`, () =>
      Effect.gen(function* () {
        const host = makeHost('{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', status)

        const result = yield* outlookMoveMessageAction
          .execute({
            integration,
            input: { messageId: 'm1', destinationFolderId: 'archive' }
          })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ error: { code, status } })
      })
    )
  }
})
