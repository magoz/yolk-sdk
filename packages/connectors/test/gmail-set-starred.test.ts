import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate, Result } from 'effect'
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
  gmailSetStarredAction,
  GoogleConnector,
  googleGmailModifyScope,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [
    makeCredentialBinding({ slotId: googleOAuthSlotId, credentialRef: 'google-account' })
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
            provider: 'google',
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

describe('Gmail set starred', () => {
  it.effect('registers a write action on the connector', () =>
    Effect.gen(function* () {
      expect(gmailSetStarredAction.id).toBe('gmail.set_starred')
      expect(gmailSetStarredAction.access).toBe('write')
      expect(GoogleConnector.actions).toContain(gmailSetStarredAction)
    })
  )

  for (const [isStarred, body] of [
    [true, { addLabelIds: ['STARRED'] }],
    [false, { removeLabelIds: ['STARRED'] }]
  ] as const) {
    it.effect(`stars=${isStarred} with the modify scope`, () =>
      Effect.gen(function* () {
        const host = makeHost('{"id":"message_1","labelIds":["STARRED"]}')

        const result = yield* gmailSetStarredAction
          .execute({ integration, input: { messageId: 'message_1', isStarred } })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(host.requests).toMatchObject([
          {
            method: 'POST',
            url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/message_1/modify',
            body: JSON.stringify(body),
            headers: {
              authorization: 'Bearer token',
              'content-type': 'application/json'
            }
          }
        ])
        expect(host.scopes).toEqual([[googleGmailModifyScope]])
      })
    )
  }

  it.effect('rejects missing fields', () =>
    Effect.gen(function* () {
      for (const input of [{ messageId: 'm1' }, { isStarred: true }]) {
        const result = yield* gmailSetStarredAction
          .execute({ integration, input })
          .pipe(Effect.provide(makeHost().layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
          expect(result.failure).toMatchObject({ cause: 'validation_failed' })
        }
      }
    })
  )

  it.effect('returns provider failures for star errors', () =>
    Effect.gen(function* () {
      const host = makeHost('{"error":{"message":"Not found"}}', 404)

      const result = yield* gmailSetStarredAction
        .execute({ integration, input: { messageId: 'message_1', isStarred: true } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Failure')
      expect(result).toMatchObject({ error: { code: 'google_not_found', status: 404 } })
    })
  )
})
