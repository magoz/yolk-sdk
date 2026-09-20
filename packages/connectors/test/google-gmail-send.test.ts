import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate, Result } from 'effect'
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
  GmailSendMessageInput,
  GoogleCombinedOAuthCredentialSlot,
  GoogleConnector,
  gmailSendMessageAction,
  googleGmailSendScope,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [makeCredentialBinding({ slotId: googleOAuthSlotId, credentialRef: 'mail' })]
})

const mime = [
  'From: sender@example.com',
  'To: edited@example.com',
  'Cc: copy@example.com',
  'Bcc: private@example.com',
  'Subject: Reviewed subject',
  'In-Reply-To: <original@example.com>',
  'References: <ancestor@example.com> <original@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Exact edited body: café\r\n  Preserve whitespace.  '
].join('\r\n')

const raw = Buffer.from(mime).toString('base64url')

const makeHost = (
  response: Effect.Effect<ConnectorHttpResponse, ConnectorError> = Effect.succeed(
    ConnectorHttpResponse.make({
      status: 200,
      headers: {},
      body: '{"id":"sent","threadId":"thread"}'
    })
  ),
  grantedScopes?: ReadonlyArray<string>
) => {
  const requests: ConnectorHttpRequest[] = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        if (
          grantedScopes !== undefined &&
          request.slot.requiredScopes?.some(scope => !grantedScopes.includes(scope))
        ) {
          return Effect.fail(
            new ConnectorError({ cause: 'credential_invalid', message: 'Scope denied' })
          )
        }

        const fields = { provider: 'google', accessToken: 'SECRET', expiresAt: 4e12 }

        const credential =
          grantedScopes === undefined
            ? OAuthCredential.make(fields)
            : OAuthCredential.make({ ...fields, scopes: [...grantedScopes] })

        return Effect.succeed(credential)
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)

        return response
      }
    })
  )

  return { requests, scopes, layer }
}

const response = (status: number, body: string) =>
  Effect.succeed(ConnectorHttpResponse.make({ status, body, headers: { 'retry-after': '30' } }))

describe('Gmail message submission', () => {
  it.effect('revalidates every field of a mutable typed input before IO', () =>
    Effect.gen(function* () {
      for (const edit of [{ raw: 'not+base64url' }, { raw: 'AB' }, { threadId: '' }]) {
        const host = makeHost()
        const input = GmailSendMessageInput.make({ raw })

        // Decoded schema-class instances remain mutable at runtime.
        Object.assign(input, edit)

        const result = yield* gmailSendMessageAction
          .executeTyped({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.scopes).toEqual([])
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('registers a destructive action without expanding combined consent', () =>
    Effect.sync(() => {
      expect(gmailSendMessageAction.access).toBe('destructive')
      expect(GoogleConnector.actions).toContain(gmailSendMessageAction)
      expect(GoogleCombinedOAuthCredentialSlot.requiredScopes).not.toContain(googleGmailSendScope)
    })
  )

  it.effect(
    'submits new mail and replies once, preserving the complete MIME and thread reference',
    () =>
      Effect.gen(function* () {
        for (const input of [{ raw }, { raw, threadId: 'original-thread' }]) {
          const host = makeHost()

          const result = yield* gmailSendMessageAction
            .executeTyped({ integration, input: GmailSendMessageInput.make(input) })
            .pipe(Effect.provide(host.layer))

          expect(result).toEqual({
            _tag: 'Success',
            value: { accepted: true, id: 'sent', threadId: 'thread' }
          })
          expect(host.scopes).toEqual([undefined, [googleGmailSendScope]])
          expect(host.requests).toHaveLength(1)
          expect(host.requests[0]).toMatchObject({
            method: 'POST',
            url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
            headers: { authorization: 'Bearer SECRET', 'content-type': 'application/json' }
          })

          const sent = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(GmailSendMessageInput)
          )(host.requests[0]?.body)

          expect(sent).toEqual(input)
          expect(Buffer.from(sent.raw, 'base64url').toString('utf8')).toBe(mime)
        }
      })
  )

  it.effect('uses an existing sufficient grant through strict host scope enforcement', () =>
    Effect.gen(function* () {
      for (const grant of [
        googleGmailSendScope,
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://mail.google.com/'
      ]) {
        const host = makeHost(undefined, [grant])

        const result = yield* gmailSendMessageAction
          .execute({ integration, input: { raw } })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(host.scopes).toEqual([undefined, [grant]])
        expect(host.requests).toHaveLength(1)
      }
    })
  )

  it.effect('does not treat scope inspection or a readable mailbox as send authority', () =>
    Effect.gen(function* () {
      const host = makeHost(undefined, ['https://www.googleapis.com/auth/gmail.readonly'])

      const result = yield* gmailSendMessageAction
        .execute({ integration, input: { raw } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'credential_invalid' } })
      expect(host.scopes).toEqual([undefined, [googleGmailSendScope]])
      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('rejects malformed or noncanonical base64url before resolving credentials', () =>
    Effect.gen(function* () {
      for (const input of [
        ...['', 'A', 'Zh', 'Zh==', 'Zm9=', 'Zm+/', 'Zg=', 'Zg===', 'Z g', 'Zg\n'].map(raw => ({
          raw
        })),
        { raw, threadId: '' },
        { raw: null }
      ]) {
        const host = makeHost()

        const result = yield* gmailSendMessageAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.requests).toHaveLength(0)
        expect(host.scopes).toHaveLength(0)
      }
    })
  )

  it.effect('accepts canonical padded and unpadded encodings without normalizing either', () =>
    Effect.gen(function* () {
      for (const raw of ['Zg', 'Zg==', 'Zm8', 'Zm8=', 'Zm9v', '____']) {
        const host = makeHost()
        yield* gmailSendMessageAction
          .execute({ integration, input: { raw } })
          .pipe(Effect.provide(host.layer))
        expect(host.requests[0]?.body).toBe(JSON.stringify({ raw }))
      }
    })
  )

  it.effect(
    'keeps provider rejections distinct from uncertain failures and never suggests a retry',
    () =>
      Effect.gen(function* () {
        for (const status of [400, 401, 403, 429, 302, 408, 500, 503]) {
          const host = makeHost(response(status, 'PRIVATE provider payload'))

          const result = yield* gmailSendMessageAction
            .execute({ integration, input: { raw } })
            .pipe(Effect.provide(host.layer))

          const outcome = [400, 401, 403, 429].includes(status) ? 'rejected' : 'unknown'
          expect(result).toMatchObject({
            _tag: 'Failure',
            error: { status, underlying: { outcome, retryable: false } }
          })
          expect(JSON.stringify(result)).not.toContain('PRIVATE')

          if (Predicate.isTagged(result, 'Failure'))
            expect(result.error.retryAfterMs).toBeUndefined()
          expect(host.requests).toHaveLength(1)
        }
      })
  )

  it.effect(
    'treats transport failures and malformed successful acknowledgements as unconfirmed',
    () =>
      Effect.gen(function* () {
        const transportFailure = Effect.fail(
          new ConnectorError({ cause: 'transport_failed', message: 'PRIVATE transport detail' })
        )

        for (const reply of [
          transportFailure,
          response(200, '{}'),
          response(200, '{"id":""}'),
          response(200, 'invalid JSON')
        ]) {
          const host = makeHost(reply)

          const result = yield* gmailSendMessageAction
            .execute({ integration, input: { raw } })
            .pipe(Effect.provide(host.layer), Effect.result)

          expect(Result.isFailure(result)).toBe(true)
          expect(result).toMatchObject({
            failure: { underlying: { outcome: 'unknown', retryable: false } }
          })
          expect(JSON.stringify(result)).not.toContain('PRIVATE')
          expect(host.requests).toHaveLength(1)
        }
      })
  )
})
