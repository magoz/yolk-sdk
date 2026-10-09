import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveTools } from '@yolk-sdk/agent/tools'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  GmailDraftAttachment,
  GmailDraftComposeInput,
  GoogleConnector,
  gmailDraftAttachmentsMaxBytes,
  gmailDraftComposeAction,
  gmailDraftMessageMaxBytes,
  gmailDraftReplyAction,
  gmailDraftUpdateAction,
  googleOAuthSlotId
} from '@yolk-sdk/connectors/google'
import {
  gmailDraftBodyMime,
  gmailDraftMime,
  gmailDraftMixedBoundary
} from '../src/google/gmail-draft-mime.ts'
import {
  boundaryOf,
  contentTypeName,
  decodeBase64Lines,
  dispositionFilename,
  headerOf,
  multipartParts,
  splitEntity
} from './gmail-mime-parse.ts'

const integration = makeIntegration({
  connectorId: 'google',
  credentialBindings: [makeCredentialBinding({ slotId: googleOAuthSlotId, credentialRef: 'mail' })]
})

const json = (body: unknown, status = 200) =>
  ConnectorHttpResponse.make({ status, headers: {}, body: JSON.stringify(body) })

/** A host answering each request with the next scripted response, recording requests. */
const makeHost = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
  const requests: Array<ConnectorHttpRequest> = []
  const credentialResolutions: Array<string> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        credentialResolutions.push(request.slot.id)

        return Effect.succeed(
          OAuthCredential.make({ provider: 'google', accessToken: 'SECRET', expiresAt: 4e12 })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        const response = responses[requests.length]

        requests.push(request)

        return response === undefined
          ? Effect.die(new Error(`unexpected request ${request.method} ${request.url}`))
          : Effect.succeed(response)
      }
    })
  )

  return { requests, credentialResolutions, layer }
}

const draftAnswer = json({ id: 'r-1', message: { id: 'm-1', threadId: 't-1' } })

const pdfBytes = Uint8Array.from({ length: 4000 }, (_, index) => (index * 7) % 256)

const attachments = [
  GmailDraftAttachment.make({
    filename: 'Offert för Åsa.pdf',
    mimeType: 'application/pdf',
    contentBase64: Buffer.from(pdfBytes).toString('base64')
  }),
  GmailDraftAttachment.make({
    filename: 'notes.txt',
    mimeType: 'text/plain',
    contentBase64: Buffer.from('hej').toString('base64')
  })
]

const uploadUrl = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts'

/** The JSON metadata and decoded MIME of one multipart/related upload, asserting its framing. */
const parseUpload = (request: ConnectorHttpRequest | undefined) => {
  const contentType = request?.headers?.['content-type'] ?? ''

  const boundary = /^multipart\/related; boundary=(yolk_gmail_draft_[0-9a-f]{32})$/u.exec(
    contentType
  )?.[1]

  expect(boundary).toBeDefined()

  const body = request?.body ?? ''
  const metadataHead = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
  const messageHead = `\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`
  const close = `\r\n--${boundary}--`

  expect(body.startsWith(metadataHead)).toBe(true)
  expect(body.endsWith(close)).toBe(true)
  expect(body.split(`--${boundary}`)).toHaveLength(4)

  const inner = body.slice(metadataHead.length, body.length - close.length)
  const split = inner.indexOf(messageHead)

  return { metadata: inner.slice(0, split), mime: inner.slice(split + messageHead.length) }
}

/** Header lines of a draft MIME (before `MIME-Version`) and its attachment parts. */
const parseDraftMime = (mime: string) => {
  const versionAt = mime.indexOf('\r\nMIME-Version: 1.0\r\n')
  const top = splitEntity(mime)

  expect(versionAt).toBeGreaterThan(0)
  expect(mime).toMatch(/^[\x20-\x7e\r\n]*$/u)
  expect(boundaryOf(headerOf(top, 'Content-Type'))).toBe(gmailDraftMixedBoundary)

  const [body, ...parts] = multipartParts(top.body, gmailDraftMixedBoundary)

  return { headers: mime.slice(0, versionAt).split('\r\n'), body, parts }
}

const expectAttachments = (parts: ReadonlyArray<ReturnType<typeof splitEntity>>) => {
  expect(parts).toHaveLength(attachments.length)

  for (const [index, part] of parts.entries()) {
    const expected = attachments[index]

    expect(headerOf(part, 'Content-Type')?.split(';')[0]).toBe(expected?.mimeType)
    expect(contentTypeName(headerOf(part, 'Content-Type'))).toBe(expected?.filename)
    expect(dispositionFilename(headerOf(part, 'Content-Disposition'))).toBe(expected?.filename)
    expect(Buffer.from(decodeBase64Lines(part.body)).toString('base64')).toBe(
      expected?.contentBase64
    )
  }

  expect(decodeBase64Lines(parts[0]?.body ?? '')).toEqual(pdfBytes)
}

const composeInput = {
  to: ['Lead <lead@example.com>'],
  cc: ['copy@example.com'],
  bcc: ['hidden@example.com'],
  subject: 'Offert',
  body: 'Hej,\n\nHär är offerten.'
}

describe('Gmail draft attachments', () => {
  it.effect('composes with attachments through one POST media upload', () =>
    Effect.gen(function* () {
      const host = makeHost([draftAnswer])

      const result = yield* gmailDraftComposeAction
        .execute({ integration, input: { ...composeInput, attachments } })
        .pipe(Effect.provide(host.layer))

      expect(result).toEqual({
        _tag: 'Success',
        value: { id: 'r-1', message: { id: 'm-1', threadId: 't-1' } }
      })
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.method).toBe('POST')
      expect(host.requests[0]?.url).toBe(`${uploadUrl}?uploadType=multipart`)
      expect(host.requests[0]?.headers?.authorization).toBe('Bearer SECRET')

      const upload = parseUpload(host.requests[0])
      const draft = parseDraftMime(upload.mime)

      expect(upload.metadata).toBe('{"message":{}}')
      expect(draft.headers).toEqual([
        'To: Lead <lead@example.com>',
        'Cc: copy@example.com',
        'Bcc: hidden@example.com',
        'Subject: Offert'
      ])
      expect(
        `MIME-Version: 1.0\r\n${draft.body?.headers.join('\r\n')}\r\n\r\n${draft.body?.body}`
      ).toBe(gmailDraftBodyMime(composeInput.body, 'text'))
      expectAttachments(draft.parts)
    })
  )

  it.effect('keeps drafts without attachments (or with an empty list) on the JSON endpoint', () =>
    Effect.gen(function* () {
      const inputs = [composeInput, { ...composeInput, attachments: [] }]
      const bodies: Array<string | undefined> = []

      for (const input of inputs) {
        const host = makeHost([draftAnswer])

        yield* gmailDraftComposeAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer))

        expect(host.requests).toHaveLength(1)
        expect(host.requests[0]).toMatchObject({
          method: 'POST',
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
          headers: { 'content-type': 'application/json' }
        })
        bodies.push(host.requests[0]?.body)
      }

      const mime = [
        'To: Lead <lead@example.com>',
        'Cc: copy@example.com',
        'Bcc: hidden@example.com',
        'Subject: Offert',
        gmailDraftBodyMime(composeInput.body, 'text')
      ].join('\r\n')

      const expected = JSON.stringify({
        message: { raw: Buffer.from(mime).toString('base64url') }
      })

      expect(bodies).toEqual([expected, expected])
    })
  )

  it.effect('updates with attachments through one PUT media upload naming the draft', () =>
    Effect.gen(function* () {
      const host = makeHost([draftAnswer])

      const result = yield* gmailDraftUpdateAction
        .execute({
          integration,
          input: {
            ...composeInput,
            draftId: 'r-1/x',
            contentType: 'html',
            body: '<p>Ny</p>',
            attachments
          }
        })
        .pipe(Effect.provide(host.layer))

      expect(result._tag).toBe('Success')
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.method).toBe('PUT')
      expect(host.requests[0]?.url).toBe(`${uploadUrl}/r-1%2Fx?uploadType=multipart`)

      const upload = parseUpload(host.requests[0])
      const draft = parseDraftMime(upload.mime)

      expect(upload.metadata).toBe('{"id":"r-1/x","message":{}}')
      expect(draft.body?.headers).toEqual([
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable'
      ])
      expectAttachments(draft.parts)
    })
  )

  it.effect('keeps updates without attachments on the JSON PUT', () =>
    Effect.gen(function* () {
      const host = makeHost([draftAnswer])

      yield* gmailDraftUpdateAction
        .execute({ integration, input: { ...composeInput, draftId: 'r-1' } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]).toMatchObject({
        method: 'PUT',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-1'
      })
      expect(JSON.parse(host.requests[0]?.body ?? '{}')).toMatchObject({ id: 'r-1', message: {} })
    })
  )

  it.effect(
    'derives reply headers and thread exactly as before, then uploads with attachments',
    () =>
      Effect.gen(function* () {
        const host = makeHost([
          json({
            id: 'msg_1',
            threadId: 'thread_1',
            payload: {
              headers: [
                { name: 'From', value: 'Lead <lead@example.com>' },
                { name: 'To', value: 'Elina <elina@speldosa.app>' },
                { name: 'Cc', value: 'Other <other@example.com>, primary@gmail.com' },
                { name: 'Message-ID', value: '<msg_1@example.com>' },
                { name: 'References', value: '<root@example.com>' },
                { name: 'Subject', value: 'Hej' }
              ]
            }
          }),
          json({ emailAddress: 'primary@gmail.com' }),
          json({ sendAs: [{ sendAsEmail: 'elina@speldosa.app' }] }),
          draftAnswer
        ])

        const result = yield* gmailDraftReplyAction
          .execute({ integration, input: { messageId: 'msg_1', body: 'Tack', attachments } })
          .pipe(Effect.provide(host.layer))

        expect(result._tag).toBe('Success')
        expect(host.requests.map(request => `${request.method} ${request.url}`)).toEqual([
          'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_1?format=metadata',
          'GET https://gmail.googleapis.com/gmail/v1/users/me/profile',
          'GET https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs',
          `POST ${uploadUrl}?uploadType=multipart`
        ])

        const upload = parseUpload(host.requests[3])
        const draft = parseDraftMime(upload.mime)

        expect(upload.metadata).toBe('{"message":{"threadId":"thread_1"}}')
        expect(draft.headers).toEqual([
          'From: elina@speldosa.app',
          'To: Lead <lead@example.com>, Other <other@example.com>',
          'Subject: Re: Hej',
          'In-Reply-To: <msg_1@example.com>',
          'References: <root@example.com> <msg_1@example.com>'
        ])
        expectAttachments(draft.parts)
      })
  )

  it.effect('uploads raw non-ASCII header text too, as the UTF-8 text raw would carry', () =>
    Effect.gen(function* () {
      const host = makeHost([draftAnswer])

      yield* gmailDraftComposeAction
        .execute({
          integration,
          input: { ...composeInput, to: ['åsa@exämple.se'], attachments }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.url).toBe(`${uploadUrl}?uploadType=multipart`)

      const { mime } = parseUpload(host.requests[0])

      expect(mime.startsWith('To: åsa@exämple.se\r\nCc: copy@example.com\r\n')).toBe(true)
      expectAttachments(multipartParts(splitEntity(mime).body, gmailDraftMixedBoundary).slice(1))
    })
  )

  it.effect('maps a refused upload to the action failure without retrying', () =>
    Effect.gen(function* () {
      const cases = [
        {
          action: gmailDraftComposeAction,
          input: { ...composeInput, attachments },
          code: 'gmail_draft_compose_failed'
        },
        {
          action: gmailDraftUpdateAction,
          input: { ...composeInput, draftId: 'r-1', attachments },
          code: 'gmail_draft_update_failed'
        }
      ]

      for (const { action, input, code } of cases) {
        const host = makeHost([json({ error: { code: 413, message: 'Request too large' } }, 413)])

        const result = yield* action
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer))

        expect(result).toMatchObject({ _tag: 'Failure', error: { code, status: 413 } })
        expect(host.requests).toHaveLength(1)
      }
    })
  )

  it.effect('rejects invalid attachments before credentials or any request', () =>
    Effect.gen(function* () {
      const valid = { filename: 'a.txt', mimeType: 'text/plain', contentBase64: 'aGk=' }

      const invalid: ReadonlyArray<unknown> = [
        Array.from({ length: 11 }, () => valid),
        [{ ...valid, filename: '' }],
        [{ ...valid, filename: 'dir/a.txt' }],
        [{ ...valid, filename: 'dir\\a.txt' }],
        [{ ...valid, filename: '..' }],
        [{ ...valid, filename: 'a\r\nBcc: x@example.com' }],
        [{ ...valid, filename: 'a\u0000.txt' }],
        [{ ...valid, filename: 'fdp.\u202eexe' }],
        [{ ...valid, filename: 'a\ud800.txt' }],
        [{ ...valid, filename: 'x'.repeat(256) }],
        [{ ...valid, mimeType: 'text/plain; charset=UTF-8' }],
        [{ ...valid, mimeType: 'text' }],
        [{ ...valid, mimeType: 'multipart/mixed' }],
        [{ ...valid, mimeType: 'Message/rfc822' }],
        [{ ...valid, contentBase64: 'aGk' }],
        [{ ...valid, contentBase64: 'aGl=' }],
        [{ ...valid, contentBase64: 'aG k=' }],
        [{ ...valid, contentBase64: 'aGk=\r\n' }],
        [{ ...valid, contentBase64: 'aGk-' }],
        [{ ...valid, contentBase64: 'aGk==' }],
        [{ filename: 'a.txt', mimeType: 'text/plain' }]
      ]

      for (const value of invalid) {
        for (const run of [
          (layer: Layer.Layer<CredentialResolver | ConnectorHttpClient>) =>
            gmailDraftComposeAction
              .execute({ integration, input: { ...composeInput, attachments: value } })
              .pipe(Effect.provide(layer), Effect.result),
          (layer: Layer.Layer<CredentialResolver | ConnectorHttpClient>) =>
            gmailDraftReplyAction
              .execute({
                integration,
                input: { messageId: 'msg_1', body: 'x', attachments: value }
              })
              .pipe(Effect.provide(layer), Effect.result)
        ]) {
          const host = makeHost([])
          const result = yield* run(host.layer)

          expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
          expect(host.credentialResolutions).toEqual([])
          expect(host.requests).toEqual([])
        }
      }
    })
  )

  it.effect('rechecks attachments of mutable typed inputs before credentials or any request', () =>
    Effect.gen(function* () {
      const edits = [
        { mimeType: 'text/plain\r\nBcc: hidden@example.com' },
        { filename: '../a.txt' },
        { contentBase64: 'not base64' }
      ]

      for (const edit of edits) {
        const attachment = GmailDraftAttachment.make({
          filename: 'a.txt',
          mimeType: 'text/plain',
          contentBase64: 'aGk='
        })

        // Decoded schema-class instances remain mutable at runtime.
        Object.assign(attachment, edit)

        const host = makeHost([draftAnswer])

        const result = yield* gmailDraftComposeAction
          .executeTyped({
            integration,
            input: GmailDraftComposeInput.make({ ...composeInput, attachments: [attachment] })
          })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.credentialResolutions).toEqual([])
        expect(host.requests).toEqual([])
      }
    })
  )

  it('rejects more than 25 MiB of decoded attachments in the schema', () => {
    const half = Buffer.alloc(gmailDraftAttachmentsMaxBytes / 2).toString('base64')

    const at = (contentBase64: string) => ({
      filename: 'a.bin',
      mimeType: 'application/octet-stream',
      contentBase64
    })

    const decode = Schema.decodeUnknownResult(GmailDraftComposeInput)

    expect(decode({ ...composeInput, attachments: [at(half), at(half)] })._tag).toBe('Success')
    expect(decode({ ...composeInput, attachments: [at(half), at(half), at('AA==')] })._tag).toBe(
      'Failure'
    )
    expect(() =>
      GmailDraftAttachment.make({ filename: 'a/b', mimeType: 'text/plain', contentBase64: '' })
    ).toThrow()
  })

  it.effect('rejects a message over 35 MiB before credentials or any request', () =>
    Effect.gen(function* () {
      // 25 MiB of attachments (about 34.2 MiB as base64 lines) plus a 2 MiB text body, which
      // its text and HTML alternatives more than double.
      const big = GmailDraftAttachment.make({
        filename: 'big.bin',
        mimeType: 'application/octet-stream',
        contentBase64: Buffer.alloc(gmailDraftAttachmentsMaxBytes).toString('base64')
      })

      const body = 'a'.repeat(2 * 1024 * 1024)

      const runs = [
        gmailDraftComposeAction.execute({
          integration,
          input: { ...composeInput, body, attachments: [big] }
        }),
        gmailDraftUpdateAction.execute({
          integration,
          input: { ...composeInput, draftId: 'r-1', body, attachments: [big] }
        }),
        gmailDraftReplyAction.execute({
          integration,
          input: { messageId: 'msg_1', body, attachments: [big] }
        })
      ]

      for (const run of runs) {
        const host = makeHost([])
        const result = yield* run.pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: {
            cause: 'validation_failed',
            underlying: { outcome: 'rejected', retryable: false, reason: 'too_large' }
          }
        })
        expect(host.credentialResolutions).toEqual([])
        expect(host.requests).toEqual([])
      }

      // The same attachment with a short body fits.
      const host = makeHost([draftAnswer])

      const fits = yield* gmailDraftComposeAction
        .execute({ integration, input: { ...composeInput, attachments: [big] } })
        .pipe(Effect.provide(host.layer))

      expect(fits._tag).toBe('Success')
      expect(host.requests[0]?.url).toBe(`${uploadUrl}?uploadType=multipart`)
      expect(parseUpload(host.requests[0]).mime.length).toBeLessThanOrEqual(
        gmailDraftMessageMaxBytes
      )
    })
  )

  it.effect('rejects a reply its derived headers push over 35 MiB before writing', () =>
    Effect.gen(function* () {
      const big = GmailDraftAttachment.make({
        filename: 'big.bin',
        mimeType: 'application/octet-stream',
        contentBase64: Buffer.alloc(gmailDraftAttachmentsMaxBytes).toString('base64')
      })

      const bodyMimeLength = (length: number) =>
        gmailDraftMime('a'.repeat(length), 'text', [big]).length

      // A body whose MIME with the attachment fits, less than 200 bytes below the cap.
      let length = 0

      for (let gap = gmailDraftMessageMaxBytes - bodyMimeLength(length); gap >= 200;) {
        length += Math.max(1, Math.floor((gap - 100) / 3))
        gap = gmailDraftMessageMaxBytes - bodyMimeLength(length)
      }

      expect(bodyMimeLength(length)).toBeLessThanOrEqual(gmailDraftMessageMaxBytes)

      const host = makeHost([
        json({
          id: 'msg_1',
          threadId: 'thread_1',
          payload: {
            headers: [
              { name: 'From', value: 'lead@example.com' },
              { name: 'Message-ID', value: '<msg_1@example.com>' },
              { name: 'References', value: '<ancestor@example.com> '.repeat(20).trim() },
              { name: 'Subject', value: 'Hej' }
            ]
          }
        }),
        json({ emailAddress: 'elina@speldosa.app' }),
        json({ sendAs: [{ sendAsEmail: 'elina@speldosa.app' }] }),
        draftAnswer
      ])

      const result = yield* gmailDraftReplyAction
        .execute({
          integration,
          input: { messageId: 'msg_1', body: 'a'.repeat(length), attachments: [big] }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { cause: 'validation_failed', underlying: { reason: 'too_large' } }
      })
      // The reads ran (the headers come from them); the draft was never written.
      expect(host.requests.map(request => request.method)).toEqual(['GET', 'GET', 'GET'])
    })
  )

  it.effect('publishes the attachment shape and limits in the tool schemas', () =>
    Effect.gen(function* () {
      const host = makeHost([])

      const tools = yield* resolveTools(
        [makeConnectorToolModule(GoogleConnector, { integration, layer: host.layer })],
        {}
      )

      for (const name of ['gmail.draft_compose', 'gmail.draft_reply', 'gmail.draft_update']) {
        const parameters = JSON.stringify(tools.tools.find(tool => tool.name === name)?.parameters)

        expect(parameters).toContain('"attachments"')
        expect(parameters).toContain('"maxItems":10')
        expect(parameters).toContain('"contentBase64"')
        expect(parameters).toContain('"mimeType"')
        expect(parameters).toContain('"filename"')
      }
    })
  )
})
