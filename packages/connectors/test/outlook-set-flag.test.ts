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
  outlookSetFlagAction
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
  ]
})

const makeHost = (body = '{"id":"m1"}', status = 200) => {
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

describe('Outlook set flag', () => {
  it.effect('registers a write action with a provider-safe tool schema', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer: host.layer })],
        {}
      )

      expect(outlookSetFlagAction.id).toBe('outlook.set_flag')
      expect(outlookSetFlagAction.access).toBe('write')
      expect(MicrosoftConnector.actions).toContain(outlookSetFlagAction)
      expect(tools.tools.find(tool => tool.name === 'outlook.set_flag')?.parameters).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['messageId', 'isFlagged'])
      })
    })
  )

  for (const [isFlagged, flagStatus] of [
    [true, 'flagged'],
    [false, 'notFlagged']
  ] as const) {
    it.effect(`PATCHes flagStatus=${flagStatus} with Mail.ReadWrite`, () =>
      Effect.gen(function* () {
        const host = makeHost(JSON.stringify({ id: 'm1' }))

        const result = yield* MicrosoftConnector.invoke({
          integration,
          action: 'outlook.set_flag',
          input: { messageId: 'm/1', isFlagged }
        }).pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(result).toMatchObject({ value: { id: 'm1' } })
        expect(host.requests).toMatchObject([
          {
            method: 'PATCH',
            url: 'https://graph.microsoft.com/v1.0/me/messages/m%2F1',
            body: JSON.stringify({ flag: { flagStatus } }),
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
  }

  it.effect('flags shared mailboxes through the Shared message slot', () =>
    Effect.gen(function* () {
      const host = makeHost('{"id":"m1"}')

      const result = yield* outlookSetFlagAction
        .execute({
          integration,
          input: { mailbox: 'shared@example.com', messageId: 'm1', isFlagged: true }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests.at(0)?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/m1'
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

      const result = yield* outlookSetFlagAction
        .execute({ integration: application, input: { messageId: 'm1', isFlagged: true } })
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

      for (const input of [{ messageId: '', isFlagged: true }, { messageId: 'm1' }]) {
        const result = yield* outlookSetFlagAction
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
      const host = makeHost('{"isFlagged":true}')

      const result = yield* outlookSetFlagAction
        .execute({ integration, input: { messageId: 'm1', isFlagged: true } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
    })
  )

  for (const [status, code] of [
    [401, 'microsoft_unauthorized'],
    [404, 'microsoft_not_found'],
    [429, 'microsoft_rate_limited'],
    [500, 'outlook_set_flag_failed']
  ] as const) {
    it.effect(`preserves provider failure at HTTP ${status}`, () =>
      Effect.gen(function* () {
        const host = makeHost('{"error":{"code":"ErrorAccessDenied","message":"Denied"}}', status)

        const result = yield* outlookSetFlagAction
          .execute({
            integration,
            input: { messageId: 'm1', isFlagged: true }
          })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ error: { code, status } })
      })
    )
  }
})
