import { describe, expect, it, vi } from '@effect/vitest'
import { Effect, Layer, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveTools } from '@yolk-sdk/agent/tools'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
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
  gmailSendMessageMaxBytes,
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
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Exact edited body: caf=C3=A9\r\n  Preserve whitespace.  =20'
].join('\r\n')

const raw = Buffer.from(mime).toString('base64url')

const uploadUrl =
  'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart'

/** Parse the single multipart/related upload body, asserting its exact framing. */
const parseUpload = (request: ConnectorHttpRequest | undefined) => {
  const contentType = request?.headers?.['content-type'] ?? ''
  const boundary = /^multipart\/related; boundary=([A-Za-z0-9_]+)$/.exec(contentType)?.[1]

  expect(boundary).toBeDefined()

  const body = request?.body ?? ''
  const metadataHead = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
  const messageHead = `\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`
  const close = `\r\n--${boundary}--`

  expect(body.startsWith(metadataHead)).toBe(true)
  expect(body.endsWith(close)).toBe(true)

  const inner = body.slice(metadataHead.length, body.length - close.length)
  const split = inner.indexOf(messageHead)

  expect(split).toBeGreaterThanOrEqual(0)

  const message = inner.slice(split + messageHead.length)

  return {
    boundary: boundary ?? '',
    metadata: inner.slice(0, split),
    message,
    boundaryCount: body.split(`--${boundary}`).length - 1
  }
}

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

  it.effect('keeps publishing the canonical base64url pattern in the tool schema', () =>
    Effect.gen(function* () {
      const host = makeHost()

      const tools = yield* resolveTools(
        [makeConnectorToolModule(GoogleConnector, { integration, layer: host.layer })],
        {}
      )

      expect(
        tools.tools.find(tool => tool.name === 'gmail.send_message')?.parameters
      ).toMatchObject({
        type: 'object',
        properties: {
          raw: {
            type: 'string',
            pattern:
              '^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw](?:==)?|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]=?)?$'
          }
        }
      })
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
            url: uploadUrl,
            headers: { authorization: 'Bearer SECRET' }
          })
          expect(Object.keys(host.requests[0]?.headers ?? {}).sort()).toEqual([
            'authorization',
            'content-type'
          ])

          const upload = parseUpload(host.requests[0])

          const metadata = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
          )(upload.metadata)

          // threadId is present only when provided; no raw field duplicates the MIME part.
          expect(metadata).toEqual('threadId' in input ? { threadId: input.threadId } : {})
          expect(upload.metadata).toBe(
            'threadId' in input ? '{"threadId":"original-thread"}' : '{}'
          )
          expect(upload.message).toBe(mime)
          expect(mime.includes(upload.boundary)).toBe(false)
          expect(upload.boundaryCount).toBe(3)
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

  it.effect('accepts canonical padded and unpadded encodings and uploads the decoded bytes', () =>
    Effect.gen(function* () {
      for (const [raw, decoded] of [
        ['Zg', 'f'],
        ['Zg==', 'f'],
        ['Zm8', 'fo'],
        ['Zm8=', 'fo'],
        ['Zm9v', 'foo'],
        ['LS0t', '---'],
        ['AH8', '\u0000\u007f']
      ] as const) {
        const host = makeHost()
        yield* gmailSendMessageAction
          .execute({ integration, input: { raw } })
          .pipe(Effect.provide(host.layer))
        expect(host.requests).toHaveLength(1)
        expect(parseUpload(host.requests[0]).message).toBe(decoded)
      }
    })
  )

  it.effect('sends 8-bit MIME unchanged as one JSON raw request to the metadata endpoint', () =>
    Effect.gen(function* () {
      const eightBit = Buffer.from('Subject: hi\r\n\r\ncafé').toString('base64url')

      for (const [raw, threadId] of [
        [eightBit, 'thread'],
        ['____', undefined],
        [Buffer.from([0x80]).toString('base64url'), undefined]
      ] as const) {
        const host = makeHost()
        const input = threadId === undefined ? { raw } : { raw, threadId }

        const result = yield* gmailSendMessageAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(host.requests).toHaveLength(1)
        expect(host.requests[0]).toMatchObject({
          method: 'POST',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          headers: { 'content-type': 'application/json' }
        })
        expect(JSON.parse(host.requests[0]?.body ?? '')).toEqual(input)
      }
    })
  )

  it.effect('rejects long padding runs before resolving credentials', () =>
    Effect.gen(function* () {
      for (const raw of [`${'='.repeat(2_000_000)}A`, `A${'='.repeat(2_000_000)}`]) {
        const host = makeHost()

        const result = yield* gmailSendMessageAction
          .execute({ integration, input: { raw } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.scopes).toHaveLength(0)
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('rejects decoded MIME over 35 MiB before resolving credentials', () =>
    Effect.gen(function* () {
      expect(gmailSendMessageMaxBytes).toBe(36_700_160)
      // 'QUFB' decodes to 'AAA'; 12,233,387 groups are one byte over the cap.
      const oversized = 'QUFB'.repeat(12_233_387)
      const host = makeHost()

      const result = yield* gmailSendMessageAction
        .execute({ integration, input: { raw: oversized } })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          cause: 'validation_failed',
          underlying: { outcome: 'rejected', retryable: false, reason: 'too_large' }
        }
      })
      expect(JSON.stringify(result)).not.toContain('QUFB')
      expect(host.scopes).toHaveLength(0)
      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('accepts decoded MIME of exactly 35 MiB in one request', () =>
    Effect.gen(function* () {
      // 12,233,386 full groups plus 'QUE' ('AA') decode to exactly 36,700,160 bytes.
      const atLimit = `${'QUFB'.repeat(12_233_386)}QUE`
      const host = makeHost()

      const result = yield* gmailSendMessageAction
        .execute({ integration, input: { raw: atLimit } })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests).toHaveLength(1)
      expect(parseUpload(host.requests[0]).message).toHaveLength(gmailSendMessageMaxBytes)
    })
  )

  it.effect('chooses a multipart boundary that never occurs in the MIME', () =>
    Effect.gen(function* () {
      const colliding = '00000000-0000-4000-8000-000000000000'
      const fresh = '11111111-1111-4111-8111-111111111111'
      const collidingMime = `Subject: yolk_gmail_send_${colliding.replaceAll('-', '')}\r\n\r\nbody`

      const spy = vi
        .spyOn(crypto, 'randomUUID')
        .mockReturnValueOnce(colliding)
        .mockReturnValueOnce(fresh)

      const host = makeHost()

      yield* gmailSendMessageAction
        .execute({
          integration,
          input: { raw: Buffer.from(collidingMime).toString('base64url') }
        })
        .pipe(Effect.provide(host.layer), Effect.ensuring(Effect.sync(() => spy.mockRestore())))

      const upload = parseUpload(host.requests[0])

      expect(upload.boundary).toBe(`yolk_gmail_send_${fresh.replaceAll('-', '')}`)
      expect(upload.message).toBe(collidingMime)
      expect(upload.boundaryCount).toBe(3)
    })
  )

  it.effect(
    'keeps provider rejections distinct from uncertain failures and never suggests a retry',
    () =>
      Effect.gen(function* () {
        const rejectedStatuses = [400, 401, 403, 404, 405, 413, 415, 422, 429]

        for (const status of [...rejectedStatuses, 302, 408, 409, 500, 502, 503, 504]) {
          const host = makeHost(response(status, 'PRIVATE provider payload'))

          const result = yield* gmailSendMessageAction
            .execute({ integration, input: { raw } })
            .pipe(Effect.provide(host.layer))

          const outcome = rejectedStatuses.includes(status) ? 'rejected' : 'unknown'
          expect(result).toMatchObject({
            _tag: 'Failure',
            error: {
              code: `gmail_send_message_${outcome}`,
              status,
              underlying: { outcome, retryable: false }
            }
          })
          expect(JSON.stringify(result)).not.toContain('PRIVATE')

          if (Predicate.isTagged(result, 'Failure'))
            expect(result.error.retryAfterMs).toBeUndefined()
          expect(host.requests).toHaveLength(1)
          expect(host.requests[0]?.url).toBe(uploadUrl)
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

        // A host timeout after dispatch surfaces as a transport failure: outcome unknown.
        const timeout = Effect.fail(
          new ConnectorError({ cause: 'transport_failed', message: 'PRIVATE request timed out' })
        )

        for (const reply of [
          transportFailure,
          timeout,
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
