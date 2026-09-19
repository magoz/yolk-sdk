import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  MicrosoftConnector,
  microsoftOAuthSlotId,
  outlookGetMessageAction
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

describe('Outlook get message headers', () => {
  it.effect('selects internet headers and returns them typed', () =>
    Effect.gen(function* () {
      const host = makeHost(
        JSON.stringify({
          id: 'm1',
          subject: 'Hello',
          internetMessageHeaders: [
            { name: 'List-Unsubscribe', value: '<https://example.com/unsubscribe>' },
            { name: 'Authentication-Results', value: 'dkim=pass' }
          ]
        })
      )

      const result = yield* outlookGetMessageAction
        .execute({ integration, input: { messageId: 'm1' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(result).toMatchObject({
        value: {
          id: 'm1',
          internetMessageHeaders: [
            { name: 'List-Unsubscribe', value: '<https://example.com/unsubscribe>' },
            { name: 'Authentication-Results', value: 'dkim=pass' }
          ]
        }
      })

      const url = host.requests.at(0)?.url ?? ''

      expect(url).toContain('/me/messages/m1?')
      expect(decodeURIComponent(url)).toContain('$select=')
      expect(decodeURIComponent(url)).toContain('internetMessageHeaders')
      expect(MicrosoftConnector.actions).toContain(outlookGetMessageAction)
    })
  )

  it.effect('fails when headers are omitted or malformed', () =>
    Effect.gen(function* () {
      for (const body of [
        '{"id":"m1"}',
        '{"id":"m1","internetMessageHeaders":null}',
        '{"id":"m1","internetMessageHeaders":[{"name":"Subject"}]}'
      ]) {
        const host = makeHost(body)

        const result = yield* outlookGetMessageAction
          .execute({ integration, input: { messageId: 'm1' } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      }
    })
  )

  it.effect('preserves provider failures', () =>
    Effect.gen(function* () {
      const host = makeHost('{"error":{"code":"ErrorItemNotFound","message":"Missing"}}', 404)

      const result = yield* outlookGetMessageAction
        .execute({ integration, input: { messageId: 'm1' } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ error: { code: 'microsoft_not_found', status: 404 } })
    })
  )
})
