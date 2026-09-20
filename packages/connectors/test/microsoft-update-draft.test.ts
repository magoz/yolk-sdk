import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  MicrosoftConnector,
  OutlookUpdateDraftInput,
  outlookUpdateDraftAction,
  microsoftGraphMailReadWriteScope,
  microsoftGraphMailReadWriteSharedScope
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [makeCredentialBinding({ slotId: 'microsoft.oauth', credentialRef: 'mail' })]
})

const draft = { id: 'existing-draft', isDraft: true, conversationId: 'original-conversation' }

const response = (status: number, body: string) =>
  Effect.succeed(ConnectorHttpResponse.make({ status, body, headers: { 'retry-after': '30' } }))

const makeHost = (
  reply: Effect.Effect<ConnectorHttpResponse, ConnectorError> = response(200, JSON.stringify(draft))
) => {
  const requests: ConnectorHttpRequest[] = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
            accessToken: 'SECRET',
            expiresAt: 4e12,
            accountId: 'own@example.com'
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)

        return reply
      }
    })
  )

  return { requests, scopes, layer }
}

describe('Outlook draft updates', () => {
  it.effect('registers a write action, not a send action', () =>
    Effect.sync(() => {
      expect(outlookUpdateDraftAction.access).toBe('write')
      expect(MicrosoftConnector.actions).toContain(outlookUpdateDraftAction)
    })
  )

  it.effect('saves all edited fields exactly, replacing rather than prepending the body', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* outlookUpdateDraftAction
        .executeTyped({
          integration,
          input: OutlookUpdateDraftInput.make({
            messageId: 'existing-draft',
            to: ['edited@example.com'],
            cc: [],
            bcc: ['private@example.com'],
            subject: '  Edited subject  ',
            body: '  My complete body\nNo hidden quoted history.  ',
            contentType: 'text'
          })
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({ _tag: 'Success', value: draft })
      expect(host.scopes).toEqual([[microsoftGraphMailReadWriteScope]])
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]).toMatchObject({
        method: 'PATCH',
        url: 'https://graph.microsoft.com/v1.0/me/messages/existing-draft',
        headers: {
          authorization: 'Bearer SECRET',
          prefer: 'IdType="ImmutableId"',
          'content-type': 'application/json'
        }
      })

      const patch = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        host.requests[0]?.body
      )

      expect(patch).toEqual({
        toRecipients: [{ emailAddress: { address: 'edited@example.com' } }],
        ccRecipients: [],
        bccRecipients: [{ emailAddress: { address: 'private@example.com' } }],
        subject: '  Edited subject  ',
        body: { contentType: 'Text', content: '  My complete body\nNo hidden quoted history.  ' }
      })
    })
  )

  it.effect('preserves omitted fields and permits explicit clearing and HTML replacement', () =>
    Effect.gen(function* () {
      const updates = [
        { input: { subject: '' }, patch: { subject: '' } },
        { input: { bcc: [] }, patch: { bccRecipients: [] } },
        { input: { body: '' }, patch: { body: { contentType: 'Text', content: '' } } },
        {
          input: { body: '<p>Exact HTML</p>', contentType: 'html' },
          patch: { body: { contentType: 'HTML', content: '<p>Exact HTML</p>' } }
        }
      ]

      for (const update of updates) {
        const host = makeHost()
        yield* outlookUpdateDraftAction
          .execute({ integration, input: { messageId: 'draft', ...update.input } })
          .pipe(Effect.provide(host.layer))

        const patch = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          host.requests[0]?.body
        )

        expect(patch).toEqual(update.patch)
        expect(host.requests).toHaveLength(1)
      }
    })
  )

  it.effect('uses shared or own-mailbox write permissions and encodes complete opaque IDs', () =>
    Effect.gen(function* () {
      for (const mailbox of ['shared@example.com', 'OWN@example.com']) {
        const host = makeHost()
        yield* outlookUpdateDraftAction
          .execute({
            integration,
            input: { mailbox, messageId: 'opaque/id?x=#', subject: 'Edited' }
          })
          .pipe(Effect.provide(host.layer))
        expect(host.scopes).toEqual([
          undefined,
          [
            mailbox === 'shared@example.com'
              ? microsoftGraphMailReadWriteSharedScope
              : microsoftGraphMailReadWriteScope
          ]
        ])
        expect(host.requests[0]?.url).toBe(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/opaque%2Fid%3Fx%3D%23`
        )
      }
    })
  )

  it.effect('requires an explicit mailbox for application access before credentials or HTTP', () =>
    Effect.gen(function* () {
      const application = makeIntegration({
        ...integration,
        config: { mailboxAccessMode: 'application' }
      })

      const host = makeHost()

      const denied = yield* outlookUpdateDraftAction
        .execute({ integration: application, input: { messageId: 'draft', subject: 'Edited' } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(denied).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      expect(host.requests).toHaveLength(0)
      expect(host.scopes).toHaveLength(0)

      yield* outlookUpdateDraftAction
        .execute({
          integration: application,
          input: { mailbox: 'target@example.com', messageId: 'draft', subject: 'Edited' }
        })
        .pipe(Effect.provide(host.layer))
      expect(host.scopes).toEqual([[microsoftGraphMailReadWriteScope]])
      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect(
    'rejects empty updates, nulls, content-type-only updates and unsafe identities before IO',
    () =>
      Effect.gen(function* () {
        for (const input of [
          { messageId: 'draft' },
          { messageId: 'draft', contentType: 'html' },
          { messageId: 'draft', subject: null },
          { messageId: 'draft', to: [''] },
          { messageId: '.', subject: 'Edited' },
          { messageId: '..', subject: 'Edited' },
          { messageId: '', subject: 'Edited' },
          { messageId: 'draft\n', subject: 'Edited' },
          { messageId: 'draft', mailbox: '..', subject: 'Edited' }
        ]) {
          const host = makeHost()

          const result = yield* outlookUpdateDraftAction
            .execute({ integration, input })
            .pipe(Effect.provide(host.layer), Effect.result)

          expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
          expect(host.requests).toHaveLength(0)
          expect(host.scopes).toHaveLength(0)
        }
      })
  )

  it.effect('also rejects an empty decoded update through executeTyped before IO', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* outlookUpdateDraftAction
        .executeTyped({
          integration,
          input: OutlookUpdateDraftInput.make({ messageId: 'draft' })
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      expect(host.requests).toHaveLength(0)
      expect(host.scopes).toHaveLength(0)
    })
  )

  it.effect(
    'retains the existing draft ID on HTTP failure without leaking payloads or retry hints',
    () =>
      Effect.gen(function* () {
        for (const status of [400, 404, 429, 503]) {
          const host = makeHost(response(status, 'PRIVATE provider detail'))

          const result = yield* outlookUpdateDraftAction
            .execute({ integration, input: { messageId: 'existing-draft', body: 'Reviewed' } })
            .pipe(Effect.provide(host.layer))

          expect(result).toMatchObject({
            _tag: 'Failure',
            error: {
              code: 'outlook_update_draft_failed',
              status,
              underlying: {
                draftId: 'existing-draft',
                retryable: false,
                recovery: 'read_edit_existing_draft'
              }
            }
          })

          if (Predicate.isTagged(result, 'Failure'))
            expect(result.error.retryAfterMs).toBeUndefined()
          expect(JSON.stringify(result)).not.toContain('PRIVATE')
          expect(host.requests).toHaveLength(1)
        }
      })
  )

  it.effect(
    'keeps recovery identity after transport, decoding, and non-draft acknowledgement failures',
    () =>
      Effect.gen(function* () {
        const transport = Effect.fail(
          new ConnectorError({ cause: 'transport_failed', message: 'PRIVATE detail' })
        )

        for (const reply of [
          transport,
          response(200, '{}'),
          response(200, '{"id":"draft","isDraft":false}'),
          response(200, '{"id":"","isDraft":true}'),
          response(200, 'malformed')
        ]) {
          const host = makeHost(reply)

          const result = yield* outlookUpdateDraftAction
            .execute({ integration, input: { messageId: 'existing-draft', subject: 'Edited' } })
            .pipe(Effect.provide(host.layer), Effect.result)

          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: {
              underlying: {
                draftId: 'existing-draft',
                retryable: false,
                recovery: 'read_edit_existing_draft'
              }
            }
          })
          expect(JSON.stringify(result)).not.toContain('PRIVATE')
          expect(host.requests).toHaveLength(1)
        }
      })
  )
})
