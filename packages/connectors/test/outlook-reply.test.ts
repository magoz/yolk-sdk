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
  OutlookReplyInput,
  microsoftGraphMailSendScope,
  microsoftGraphMailSendSharedScope,
  outlookReplyAction
} from '@yolk-sdk/connectors/microsoft'

const loneHigh = String.fromCharCode(0xd800)

const loneLow = String.fromCharCode(0xdc00)

const smile = String.fromCodePoint(0x1f600)

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [makeCredentialBinding({ slotId: 'microsoft.oauth', credentialRef: 'mail' })]
})

const accepted = Effect.succeed(ConnectorHttpResponse.make({ status: 202, headers: {}, body: '' }))

const response = (status: number, body: string) =>
  Effect.succeed(ConnectorHttpResponse.make({ status, headers: { 'retry-after': '30' }, body }))

const makeHost = (
  reply: Effect.Effect<ConnectorHttpResponse, ConnectorError> = accepted,
  accountId?: string
) => {
  const requests: ConnectorHttpRequest[] = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        const credential =
          accountId === undefined
            ? OAuthCredential.make({
                provider: 'microsoft',
                accessToken: 'SECRET',
                expiresAt: 4e12
              })
            : OAuthCredential.make({
                provider: 'microsoft',
                accessToken: 'SECRET',
                expiresAt: 4e12,
                accountId
              })

        return Effect.succeed(credential)
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

const reviewedInput = {
  messageId: 'original-message',
  to: ['edited@example.com'],
  cc: ['copy@example.com'],
  bcc: [],
  subject: '  Reviewed subject  ',
  body: '  Complete reviewed body\nNo hidden quoted history.  '
} satisfies OutlookReplyInput

describe('Outlook direct reply', () => {
  it.effect('revalidates all typed reply fields before credentials or HTTP', () =>
    Effect.gen(function* () {
      for (const edit of [
        { messageId: '' },
        { messageId: '..' },
        { mailbox: '' },
        { mailbox: '..' },
        { mailbox: 'bad\nidentity' },
        { mailbox: loneLow },
        { to: [] },
        { to: [''] },
        { cc: ['\r\n'] },
        { bcc: [''] },
        { cc: undefined },
        { bcc: undefined },
        { subject: 123 },
        { body: 123 },
        { contentType: 'invalid' }
      ]) {
        const host = makeHost()
        const input = OutlookReplyInput.make(reviewedInput)

        Object.assign(input, edit)

        const result = yield* outlookReplyAction
          .executeTyped({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.scopes).toEqual([])
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('registers a destructive send action, not a draft mutation', () =>
    Effect.sync(() => {
      expect(outlookReplyAction.id).toBe('outlook.reply')
      expect(outlookReplyAction.access).toBe('destructive')
      expect(MicrosoftConnector.actions).toContain(outlookReplyAction)
    })
  )

  it.effect('sends the complete reviewed reply in one JSON POST with default text', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const result = yield* outlookReplyAction
        .executeTyped({ integration, input: OutlookReplyInput.make(reviewedInput) })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual({ _tag: 'Success', value: { accepted: true } })
      expect(host.scopes).toEqual([[microsoftGraphMailSendScope]])
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/me/messages/original-message/reply',
        headers: {
          authorization: 'Bearer SECRET',
          prefer: 'IdType="ImmutableId"',
          'content-type': 'application/json'
        }
      })

      const sent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        host.requests[0]?.body
      )

      expect(sent).toEqual({
        message: {
          subject: '  Reviewed subject  ',
          body: {
            contentType: 'Text',
            content: '  Complete reviewed body\nNo hidden quoted history.  '
          },
          toRecipients: [{ emailAddress: { address: 'edited@example.com' } }],
          ccRecipients: [{ emailAddress: { address: 'copy@example.com' } }],
          bccRecipients: []
        }
      })
    })
  )

  it.effect('supports explicit html without comment, from, or quoted history', () =>
    Effect.gen(function* () {
      const host = makeHost()

      yield* outlookReplyAction
        .execute({
          integration,
          input: {
            ...reviewedInput,
            messageId: 'opaque/id?x=#',
            body: '<p>Exact HTML</p>',
            contentType: 'html'
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.url).toBe(
        'https://graph.microsoft.com/v1.0/me/messages/opaque%2Fid%3Fx%3D%23/reply'
      )

      const sent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        host.requests[0]?.body
      )

      expect(sent).toMatchObject({
        message: {
          body: { contentType: 'HTML', content: '<p>Exact HTML</p>' }
        }
      })
      expect(JSON.stringify(sent)).not.toContain('comment')
      expect(JSON.stringify(sent)).not.toContain('"from"')
    })
  )

  it.effect('preserves empty arrays, whitespace, and Unicode content exactly', () =>
    Effect.gen(function* () {
      const host = makeHost()

      yield* outlookReplyAction
        .execute({
          integration,
          input: {
            messageId: `orig-${smile}`,
            to: [`  spaced-${smile}@example.com  `],
            cc: [],
            bcc: [],
            subject: `  Caf\u00e9 ${smile}  `,
            body: `\n  Caf\u00e9 ${smile}\n  `
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.url).toContain(`/messages/orig-${encodeURIComponent(smile)}/reply`)

      const sent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        host.requests[0]?.body
      )

      expect(sent).toEqual({
        message: {
          subject: `  Caf\u00e9 ${smile}  `,
          body: { contentType: 'Text', content: `\n  Caf\u00e9 ${smile}\n  ` },
          toRecipients: [{ emailAddress: { address: `  spaced-${smile}@example.com  ` } }],
          ccRecipients: [],
          bccRecipients: []
        }
      })
    })
  )

  it.effect('routes own, shared, and application mailboxes through the send slot', () =>
    Effect.gen(function* () {
      for (const mailbox of ['shared@example.com', 'OWN@example.com']) {
        const host = makeHost(accepted, 'own@example.com')

        yield* outlookReplyAction
          .execute({ integration, input: { ...reviewedInput, mailbox } })
          .pipe(Effect.provide(host.layer))

        expect(host.scopes).toEqual([
          undefined,
          [
            mailbox === 'shared@example.com'
              ? microsoftGraphMailSendSharedScope
              : microsoftGraphMailSendScope
          ]
        ])
        expect(host.requests[0]?.url).toBe(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/original-message/reply`
        )
        expect(host.requests).toHaveLength(1)
      }

      const application = makeIntegration({
        ...integration,
        config: { mailboxAccessMode: 'application' }
      })

      const applicationHost = makeHost()

      yield* outlookReplyAction
        .execute({
          integration: application,
          input: { ...reviewedInput, mailbox: 'target@example.com' }
        })
        .pipe(Effect.provide(applicationHost.layer))

      expect(applicationHost.scopes).toEqual([[microsoftGraphMailSendScope]])
      expect(applicationHost.requests[0]?.url).toContain('/users/target%40example.com/')
    })
  )

  it.effect('requires an explicit mailbox for application access before IO', () =>
    Effect.gen(function* () {
      const application = makeIntegration({
        ...integration,
        config: { mailboxAccessMode: 'application' }
      })

      const host = makeHost()

      const denied = yield* outlookReplyAction
        .execute({ integration: application, input: reviewedInput })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(denied).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      expect(host.requests).toHaveLength(0)
      expect(host.scopes).toHaveLength(0)
    })
  )

  it.effect('never reaches HTTP when credentials are denied', () =>
    Effect.gen(function* () {
      const requests: ConnectorHttpRequest[] = []

      const deniedLayer = Layer.mergeAll(
        Layer.succeed(CredentialResolver, {
          resolve: () =>
            Effect.fail(new ConnectorError({ cause: 'credential_invalid', message: 'Denied' }))
        }),
        Layer.succeed(ConnectorHttpClient, {
          request: request => {
            requests.push(request)

            return Effect.succeed(
              ConnectorHttpResponse.make({ status: 202, headers: {}, body: '' })
            )
          }
        })
      )

      const result = yield* outlookReplyAction
        .execute({ integration, input: reviewedInput })
        .pipe(Effect.provide(deniedLayer), Effect.result)

      expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'credential_invalid' } })
      expect(requests).toHaveLength(0)
    })
  )

  it.effect('rejects malformed IDs and fields before credentials or network', () =>
    Effect.gen(function* () {
      for (const input of [
        { ...reviewedInput, messageId: '' },
        { ...reviewedInput, messageId: '.' },
        { ...reviewedInput, messageId: '..' },
        { ...reviewedInput, messageId: 'draft\n' },
        { ...reviewedInput, messageId: `draft-${loneHigh}` },
        { ...reviewedInput, messageId: `draft-${loneLow}` },
        { ...reviewedInput, mailbox: '..' },
        { ...reviewedInput, mailbox: `box-${loneLow}` },
        { ...reviewedInput, to: [] },
        { ...reviewedInput, to: [''] },
        { ...reviewedInput, to: ['   '] },
        { ...reviewedInput, to: ['ok@example.com', ''] },
        { ...reviewedInput, cc: ['\t'] },
        { ...reviewedInput, subject: null },
        { messageId: 'original-message' }
      ]) {
        const host = makeHost()

        const result = yield* outlookReplyAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.requests).toHaveLength(0)
        expect(host.scopes).toHaveLength(0)
      }
    })
  )

  it.effect('also rejects malformed typed input through executeTyped before IO', () =>
    Effect.gen(function* () {
      const valid = OutlookReplyInput.make(reviewedInput)
      expect(valid.to).toHaveLength(1)

      const mutated = OutlookReplyInput.make(reviewedInput)
      Object.assign(mutated, { messageId: `draft-${loneLow}` })

      const host = makeHost()

      const result = yield* outlookReplyAction
        .executeTyped({ integration, input: mutated })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
      expect(host.requests).toHaveLength(0)
      expect(host.scopes).toHaveLength(0)
    })
  )

  it.effect('accepts exactly 202 without parsing the success body', () =>
    Effect.gen(function* () {
      const host = makeHost(
        Effect.succeed(
          ConnectorHttpResponse.make({ status: 202, headers: {}, body: 'not-json{{{PRIVATE' })
        )
      )

      const result = yield* outlookReplyAction
        .execute({ integration, input: reviewedInput })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual({ _tag: 'Success', value: { accepted: true } })
    })
  )

  it.effect('keeps recognized rejections distinct from unconfirmed replies', () =>
    Effect.gen(function* () {
      for (const status of [400, 401, 403, 404, 405, 413, 415, 422, 429]) {
        const host = makeHost(response(status, 'PRIVATE provider payload'))

        const result = yield* outlookReplyAction
          .execute({ integration, input: reviewedInput })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          _tag: 'Failure',
          error: {
            code: 'outlook_reply_rejected',
            status,
            underlying: { outcome: 'rejected', retryable: false }
          }
        })
        expect(JSON.stringify(result)).not.toContain('PRIVATE')

        if (Predicate.isTagged(result, 'Failure')) expect(result.error.retryAfterMs).toBeUndefined()
        expect(host.requests).toHaveLength(1)
      }

      for (const status of [200, 201, 204, 206, 302, 308, 408, 500, 502, 503]) {
        const host = makeHost(response(status, 'PRIVATE provider payload'))

        const result = yield* outlookReplyAction
          .execute({ integration, input: reviewedInput })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({
          _tag: 'Failure',
          error: {
            code: 'outlook_reply_unknown',
            status,
            underlying: { outcome: 'unknown', retryable: false }
          }
        })
        expect(JSON.stringify(result)).not.toContain('PRIVATE')

        if (Predicate.isTagged(result, 'Failure')) expect(result.error.retryAfterMs).toBeUndefined()
        expect(host.requests).toHaveLength(1)
      }
    })
  )

  it.effect('treats transport failures as unconfirmed without leaking details', () =>
    Effect.gen(function* () {
      const host = makeHost(
        Effect.fail(new ConnectorError({ cause: 'transport_failed', message: 'PRIVATE detail' }))
      )

      const result = yield* outlookReplyAction
        .execute({ integration, input: reviewedInput })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { actionId: 'outlook.reply', underlying: { outcome: 'unknown', retryable: false } }
      })
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect(host.requests).toHaveLength(1)
    })
  )
})
