import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import {
  OutlookMessage,
  outlookCreateReplyDraftAction,
  outlookGetMessageAction
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  config: {},
  credentialBindings: [makeCredentialBinding({ slotId: 'microsoft.oauth', credentialRef: 'mail' })]
})

const credentials = Layer.succeed(CredentialResolver, {
  resolve: () =>
    Effect.succeed(
      OAuthCredential.make({
        provider: 'microsoft',
        accessToken: 'SECRET',
        expiresAt: 4e12
      })
    )
})

const jsonResponse = (body: Schema.Json) =>
  ConnectorHttpResponse.make({
    status: 200,
    headers: {},
    body: JSON.stringify(body)
  })

const PatchBody = Schema.Struct({
  body: Schema.Struct({ contentType: Schema.Literals(['Text', 'HTML']), content: Schema.String })
})

describe('reply draft persistence and recovery', () => {
  it.effect('reads back persisted text and HTML replies without replacing generated history', () =>
    Effect.gen(function* () {
      for (const contentType of ['text', 'html'] as const) {
        const original =
          contentType === 'text'
            ? 'From: sender@example.com\nOriginal contract terms'
            : '<html><body><blockquote>Original contract terms</blockquote></body></html>'

        const reply = contentType === 'text' ? 'My reply' : '<p>My reply</p>'
        let saved = original
        const requests: ConnectorHttpRequest[] = []

        const message = () => ({
          id: 'reply-draft',
          isDraft: true,
          conversationId: 'original-conversation',
          body: { contentType, content: saved }
        })

        const http = Layer.succeed(ConnectorHttpClient, {
          request: request =>
            Effect.gen(function* () {
              requests.push(request)

              if (request.method === 'POST') {
                expect(request.url).toContain('/messages/original/createReply')
                expect(request.body).toBeUndefined()

                return jsonResponse(message())
              }

              if (request.method === 'PATCH') {
                const patch = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PatchBody))(
                  request.body
                ).pipe(
                  Effect.mapError(
                    () =>
                      new ConnectorError({
                        cause: 'validation_failed',
                        message: 'Invalid test PATCH'
                      })
                  )
                )

                saved = patch.body.content

                return jsonResponse(message())
              }

              expect(request.method).toBe('GET')
              expect(request.url).toContain('/messages/reply-draft?')

              return jsonResponse(message())
            })
        })

        const layer = Layer.mergeAll(credentials, http)

        const created = yield* outlookCreateReplyDraftAction
          .execute({
            integration,
            input: { messageId: 'original', body: reply, contentType }
          })
          .pipe(Effect.provide(layer))

        expect(Predicate.isTagged(created, 'Success')).toBe(true)

        const read = yield* outlookGetMessageAction
          .execute({
            integration,
            input: { messageId: 'reply-draft' }
          })
          .pipe(Effect.provide(layer))

        expect(Predicate.isTagged(read, 'Success')).toBe(true)

        if (!Predicate.isTagged(read, 'Success')) return

        const messageRead = yield* Schema.decodeUnknownEffect(Schema.toType(OutlookMessage))(
          read.value
        )

        expect(messageRead.conversationId).toBe('original-conversation')
        expect(messageRead.body?.content).toContain(reply)
        expect(messageRead.body?.content).toContain('Original contract terms')
        expect(saved).toBe(
          contentType === 'text'
            ? `${reply}\n\n${original}`
            : `<html><body>${reply}<blockquote>Original contract terms</blockquote></body></html>`
        )
        expect(requests.map(request => request.method)).toEqual(['POST', 'PATCH', 'GET'])
      }
    })
  )

  it.effect('retains the draft identity after transport and malformed-response failures', () =>
    Effect.gen(function* () {
      for (const phase of ['create-decode', 'read', 'patch'] as const) {
        for (const fault of ['transport', 'decode'] as const) {
          if (phase === 'create-decode' && fault === 'transport') continue
          const requests: string[] = []

          const http = Layer.succeed(ConnectorHttpClient, {
            request: request =>
              Effect.gen(function* () {
                requests.push(request.method)

                if (request.method === 'POST')
                  return jsonResponse({
                    id: 'known-draft',
                    isDraft: true,
                    ...Match.value(phase).pipe(
                      Match.when('create-decode', () => ({ body: 7 })),
                      Match.when('patch', () => ({
                        body: { contentType: 'text', content: 'Original' }
                      })),
                      Match.orElse(() => ({}))
                    )
                  })
                expect(request.method).toBe(phase === 'read' ? 'GET' : 'PATCH')

                if (fault === 'transport')
                  return yield* Effect.fail(
                    new ConnectorError({
                      cause: 'transport_failed',
                      message: 'SECRET provider detail'
                    })
                  )

                return jsonResponse({ id: 'known-draft', body: 7 })
              })
          })

          const error = yield* outlookCreateReplyDraftAction
            .execute({
              integration,
              input: { messageId: 'original', body: 'My reply' }
            })
            .pipe(Effect.provide(Layer.mergeAll(credentials, http)), Effect.flip)

          expect(error.message).toContain('known-draft')
          expect(error.message).toContain('instead of creating another reply draft')
          expect(JSON.stringify(error)).not.toContain('SECRET')
          expect(requests.filter(method => method === 'POST')).toHaveLength(1)
          expect(requests).not.toContain('DELETE')
        }
      }
    })
  )
})
