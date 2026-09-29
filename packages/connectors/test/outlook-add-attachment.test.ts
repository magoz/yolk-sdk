import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Predicate, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as Schema from 'effect/Schema'
import {
  ConnectorBinaryHttpError,
  ConnectorBinaryWriteHttpClient,
  ConnectorError,
  ConnectorFileTransferError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type {
  ConnectorBinaryHttpResponse,
  ConnectorBinaryUploadSessionRequest,
  ConnectorBinaryWriteHttpRequest,
  ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import {
  MicrosoftConnector,
  addOutlookAttachment,
  microsoftGraphMailReadWriteScope,
  microsoftGraphMailReadWriteSharedScope,
  microsoftOAuthSlotId,
  outlookAttachmentSingleRequestMaxBytes,
  outlookAttachmentUploadChunkBytes,
  outlookAttachmentUploadSessionMaxBytes,
  outlookMailActions,
  type OutlookAddAttachmentInput
} from '@yolk-sdk/connectors/microsoft'

const makeMicrosoftIntegration = (config: Record<string, string> = {}) =>
  makeIntegration({
    connectorId: 'microsoft',
    config,
    credentialBindings: [
      makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'microsoft-account' })
    ]
  })

const integration = makeMicrosoftIntegration()

const budget = {
  maxBytes: outlookAttachmentUploadSessionMaxBytes,
  maxMetadataBytes: 4096,
  maxErrorBodyBytes: 256
}

const SECRET_TOKEN = 'graph-secret-token'

const SESSION_SECRET = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IktmYUNIUlN6bllHMmNI'

const uploadUrl = `https://outlook.office.com/api/v2.0/Users('a8e8e219-4931@72aa88bf')/Messages('AAMkADI5MAAIT3drCAAA=')/AttachmentSessions('AAMkADI5MAAIT3k0tAAA=')?authtoken=${SESSION_SECRET}`

const json = (value: unknown, status: number, headers: Record<string, string> = {}) => ({
  status,
  headers,
  bytes: new TextEncoder().encode(JSON.stringify(value)),
  bodyComplete: true
})

const empty = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers,
  bytes: new Uint8Array(0),
  bodyComplete: true
})

// Graph JSON POSTs travel over the string ConnectorHttpClient.
const graphJson = (value: unknown, status: number, headers: Record<string, string> = {}) =>
  ConnectorHttpResponse.make({ status, headers, body: JSON.stringify(value) })

const graphEmpty = (status: number) => ConnectorHttpResponse.make({ status, headers: {}, body: '' })

type Reply = Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError>

type GraphReply = Effect.Effect<ConnectorHttpResponse, ConnectorError>

const credentialLayer = Layer.succeed(CredentialResolver, {
  resolve: () =>
    Effect.succeed(
      OAuthCredential.make({ provider: 'microsoft', accessToken: SECRET_TOKEN, expiresAt: 4e12 })
    )
})

const graphLayer = (reply: (request: ConnectorHttpRequest) => GraphReply) =>
  Layer.succeed(ConnectorHttpClient, { request: reply })

const patterned = (size: number) => {
  const bytes = new Uint8Array(size)

  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 256

  return bytes
}

/**
 * `session`: replies for the upload-session capability; `'missing'` provides a binary write port
 * without `uploadSession`; `'absent'` provides no binary write port at all.
 */
const makeHost = (options: {
  readonly graph?: ReadonlyArray<GraphReply>
  readonly session?: ReadonlyArray<Reply> | 'missing' | 'absent'
  readonly accountId?: string
}) => {
  const graphRequests: ConnectorHttpRequest[] = []
  const binaryWriteRequests: ConnectorBinaryWriteHttpRequest[] = []
  const sessionRequests: ConnectorBinaryUploadSessionRequest[] = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []
  const graphReplies = [...(options.graph ?? [])]

  const sessionReplies =
    options.session === 'missing' || options.session === 'absent'
      ? []
      : [...(options.session ?? [])]

  const binaryFailure = () =>
    Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))

  // The helper must never use the binary write port's generic request method.
  const request = (req: ConnectorBinaryWriteHttpRequest): Reply => {
    binaryWriteRequests.push(req)

    return binaryFailure()
  }

  const uploadSession = (req: ConnectorBinaryUploadSessionRequest) => {
    sessionRequests.push(req)

    return sessionReplies.shift() ?? binaryFailure()
  }

  const port = options.session === 'missing' ? { request } : { request, uploadSession }

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: req => {
        scopes.push(req.slot.requiredScopes)

        const fields = { provider: 'microsoft', accessToken: SECRET_TOKEN, expiresAt: 4e12 }

        return Effect.succeed(
          OAuthCredential.make(
            options.accountId === undefined ? fields : { ...fields, accountId: options.accountId }
          )
        )
      }
    }),
    graphLayer(req => {
      graphRequests.push(req)

      return (
        graphReplies.shift() ??
        Effect.fail(new ConnectorError({ cause: 'transport_failed', message: 'no reply' }))
      )
    })
  )

  return {
    graphRequests,
    binaryWriteRequests,
    sessionRequests,
    scopes,
    layer:
      options.session === 'absent'
        ? layer
        : Layer.merge(layer, Layer.succeed(ConnectorBinaryWriteHttpClient, port))
  }
}

const decodeJsonBody = (body: string | undefined) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body)

const failureOf = <A, E>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure : undefined

const expectSecretFree = (value: unknown) => {
  const serialized = JSON.stringify(value) + String(value)

  expect(serialized).not.toContain(SESSION_SECRET)
  expect(serialized).not.toContain('authtoken')
  expect(serialized).not.toContain('outlook.office.com')
  expect(serialized).not.toContain(SECRET_TOKEN)
}

describe('addOutlookAttachment host-only helper', () => {
  it('stays out of connector actions and agent serialization', () => {
    expect(outlookMailActions.map(action => action.id)).not.toContain('outlook.add_attachment')
    expect(MicrosoftConnector.actions.map(action => action.id)).not.toContain(
      'outlook.add_attachment'
    )
    expect(outlookAttachmentSingleRequestMaxBytes).toBe(3 * 1024 * 1024)
    expect(outlookAttachmentUploadSessionMaxBytes).toBe(150 * 1024 * 1024)
    expect(outlookAttachmentUploadChunkBytes % (320 * 1024)).toBe(0)
    expect(outlookAttachmentUploadChunkBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it.effect('attaches a small file with one Graph POST using Mail.ReadWrite', () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0, 255, 128, 10, 13])

      const host = makeHost({
        graph: [Effect.succeed(graphJson({ id: 'attachment/id', contentBytes: 'AP+ACg0=' }, 201))],
        session: 'missing'
      })

      const result = yield* addOutlookAttachment(
        integration,
        { messageId: 'draft/id', name: 'report.pdf', contentType: 'application/pdf', bytes },
        budget
      ).pipe(Effect.provide(host.layer))

      expect(result).toEqual({ attachmentId: 'attachment/id', name: 'report.pdf', size: 5 })
      expect(host.scopes).toEqual([[microsoftGraphMailReadWriteScope]])
      expect(host.sessionRequests).toHaveLength(0)
      expect(host.binaryWriteRequests).toHaveLength(0)
      expect(host.graphRequests).toHaveLength(1)

      const request = host.graphRequests[0]

      expect(request).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/me/messages/draft%2Fid/attachments',
        headers: {
          authorization: `Bearer ${SECRET_TOKEN}`,
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        redirect: 'manual',
        credentials: 'omit'
      })
      expect(yield* decodeJsonBody(request?.body)).toEqual({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'report.pdf',
        contentType: 'application/pdf',
        contentBytes: 'AP+ACg0='
      })
    })
  )

  it.effect('attaches a small file when the host provides no binary write port at all', () =>
    Effect.gen(function* () {
      const host = makeHost({
        graph: [Effect.succeed(graphJson({ id: 'a1' }, 201))],
        session: 'absent'
      })

      const result = yield* addOutlookAttachment(
        integration,
        { messageId: 'draft', name: 'a.txt', contentType: 'text/plain', bytes: patterned(3) },
        budget
      ).pipe(Effect.provide(host.layer))

      expect(result).toEqual({ attachmentId: 'a1', name: 'a.txt', size: 3 })
      expect(host.graphRequests).toHaveLength(1)
      expect(host.graphRequests[0]?.url).toBe(
        'https://graph.microsoft.com/v1.0/me/messages/draft/attachments'
      )
    })
  )

  it.effect('sends an ASCII-only JSON body that preserves non-ASCII file names', () =>
    Effect.gen(function* () {
      const host = makeHost({ graph: [Effect.succeed(graphJson({ id: 'a1' }, 201))] })
      const name = 'Informe año 2026 \u{1F4C4}.pdf'

      yield* addOutlookAttachment(
        integration,
        { messageId: 'draft', name, contentType: 'application/pdf', bytes: patterned(3) },
        budget
      ).pipe(Effect.provide(host.layer))

      const body = host.graphRequests[0]?.body ?? ''

      expect(body).toMatch(/^[\x20-\x7e]+$/)

      const decoded = yield* decodeJsonBody(body)

      expect(Predicate.hasProperty(decoded, 'name') && decoded.name).toBe(name)
    })
  )

  it.effect('bounds the small POST response by metadata plus the echoed contentBytes', () =>
    Effect.gen(function* () {
      const bytes = patterned(30)
      const contentBytes = Buffer.from(bytes).toString('base64')
      const limit = budget.maxMetadataBytes + contentBytes.length

      const padded = (length: number) => {
        const base = JSON.stringify({ id: 'a1', contentBytes, pad: '' })

        return JSON.stringify({ id: 'a1', contentBytes, pad: 'x'.repeat(length - base.length) })
      }

      for (const [length, expected] of [
        [limit, 'success'],
        [limit + 1, 'response_too_large']
      ] as const) {
        const body = padded(length)

        expect(body.length).toBe(length)

        const host = makeHost({
          graph: [Effect.succeed(ConnectorHttpResponse.make({ status: 201, headers: {}, body }))]
        })

        const result = yield* addOutlookAttachment(
          integration,
          { messageId: 'draft', name: 'a.bin', contentType: 'application/zip', bytes },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        if (expected === 'success') expect(result._tag).toBe('Success')
        else {
          expect(failureOf(result)).toMatchObject({ code: expected })
          expect(Predicate.hasProperty(failureOf(result), 'status')).toBe(false)
        }
      }

      // Multi-byte UTF-8 counts in bytes, not UTF-16 code units.
      const multiByte = JSON.stringify({
        id: 'a1',
        pad: 'é'.repeat(Math.ceil(limit / 2))
      })

      const host = makeHost({
        graph: [
          Effect.succeed(ConnectorHttpResponse.make({ status: 201, headers: {}, body: multiByte }))
        ]
      })

      expect(multiByte.length).toBeLessThanOrEqual(limit)

      const result = yield* addOutlookAttachment(
        integration,
        { messageId: 'draft', name: 'a.bin', contentType: 'application/zip', bytes },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result)

      expect(failureOf(result)).toMatchObject({ code: 'response_too_large' })
    })
  )

  it.effect('keeps the mapped status for oversized error bodies without reading them', () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ error: { message: 'x'.repeat(budget.maxErrorBodyBytes) } })

      const host = makeHost({
        graph: [Effect.succeed(ConnectorHttpResponse.make({ status: 429, headers: {}, body }))]
      })

      const result = yield* addOutlookAttachment(
        integration,
        { messageId: 'draft', name: 'a.txt', contentType: 'text/plain', bytes: patterned(3) },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result)

      expect(failureOf(result)).toMatchObject({ code: 'rate_limited', status: 429 })
    })
  )

  it.effect('maps a Graph transport failure to transport_failed without its cause text', () =>
    Effect.gen(function* () {
      for (const size of [3, outlookAttachmentSingleRequestMaxBytes]) {
        const host = makeHost({
          graph: [
            Effect.fail(
              new ConnectorError({
                cause: 'transport_failed',
                message: `PRIVATE Bearer ${SECRET_TOKEN} ${uploadUrl}`,
                underlying: new Error(`PRIVATE ${uploadUrl}`)
              })
            )
          ],
          session: []
        })

        const result = yield* addOutlookAttachment(
          integration,
          { messageId: 'draft', name: 'x.bin', contentType: 'image/png', bytes: patterned(size) },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        const failure = failureOf(result)

        expect(failure).toBeInstanceOf(ConnectorFileTransferError)
        expect(failure).toMatchObject({ code: 'transport_failed' })
        expect(Predicate.hasProperty(failure, 'status')).toBe(false)
        expect(JSON.stringify(failure) + String(failure)).not.toContain('PRIVATE')
        expectSecretFree(failure)
        expect(host.graphRequests).toHaveLength(1)
        expect(host.sessionRequests).toHaveLength(0)
      }
    })
  )

  it.effect('uses one POST just below 3 MiB even without the session capability', () =>
    Effect.gen(function* () {
      const bytes = patterned(outlookAttachmentSingleRequestMaxBytes - 1)

      const host = makeHost({
        graph: [Effect.succeed(graphJson({ id: 'a1' }, 201))],
        session: 'missing'
      })

      const result = yield* addOutlookAttachment(
        integration,
        { messageId: 'draft', name: 'big.bin', contentType: 'application/octet-stream', bytes },
        budget
      ).pipe(Effect.provide(host.layer))

      expect(result).toEqual({ attachmentId: 'a1', name: 'big.bin', size: bytes.byteLength })
      expect(host.graphRequests).toHaveLength(1)

      const body = yield* decodeJsonBody(host.graphRequests[0]?.body)

      expect(Predicate.hasProperty(body, 'contentBytes') && body.contentBytes).toBe(
        Buffer.from(bytes).toString('base64')
      )
    })
  )

  it.effect('reports success without an ID when a created attachment has no readable ID', () =>
    Effect.gen(function* () {
      for (const reply of [graphJson({}, 201), graphEmpty(201), graphJson({ id: '' }, 200)]) {
        const host = makeHost({ graph: [Effect.succeed(reply)] })

        const result = yield* addOutlookAttachment(
          integration,
          { messageId: 'draft', name: 'a.txt', contentType: 'text/plain', bytes: patterned(3) },
          budget
        ).pipe(Effect.provide(host.layer))

        expect(result).toEqual({ name: 'a.txt', size: 3 })
        expect(host.graphRequests).toHaveLength(1)
      }
    })
  )

  it.effect('maps small-path HTTP failures to code and status without provider details', () =>
    Effect.gen(function* () {
      for (const [status, code] of [
        [400, 'upstream_failed'],
        [401, 'unauthorized'],
        [403, 'forbidden'],
        [404, 'not_found'],
        [409, 'conflict'],
        [413, 'response_too_large'],
        [429, 'rate_limited'],
        [302, 'unexpected_redirect'],
        [503, 'upstream_failed']
      ] as const) {
        const host = makeHost({
          graph: [
            Effect.succeed(graphJson({ error: { message: 'PRIVATE provider detail' } }, status))
          ]
        })

        const result = yield* addOutlookAttachment(
          integration,
          { messageId: 'draft', name: 'a.txt', contentType: 'text/plain', bytes: patterned(3) },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        const failure = failureOf(result)

        expect(failure).toBeInstanceOf(ConnectorFileTransferError)
        expect(failure).toMatchObject({ code, status })
        expect(JSON.stringify(failure)).not.toContain('PRIVATE')
        expectSecretFree(failure)
        expect(host.graphRequests).toHaveLength(1)
      }
    })
  )

  it.effect('uploads 3 MiB and larger files through sequential pre-authenticated ranges', () =>
    Effect.gen(function* () {
      const chunk = outlookAttachmentUploadChunkBytes
      const size = chunk * 2 + 100
      const bytes = patterned(size)

      const host = makeHost({
        graph: [
          Effect.succeed(
            graphJson(
              {
                '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#uploadSession',
                uploadUrl,
                expirationDateTime: '2026-09-29T01:09:30Z',
                nextExpectedRanges: ['0-']
              },
              201
            )
          )
        ],
        session: [
          Effect.succeed(json({ nextExpectedRanges: [`${chunk}`] }, 200)),
          Effect.succeed(json({ NextExpectedRanges: [`${chunk * 2}-${size - 1}`] }, 200)),
          Effect.succeed(
            empty(201, {
              Location: `https://outlook.office.com/api/v2.0/Users('u')/Messages('m')/Attachments('AAMkADI5MAAIT3drCAAABEgAQANAqbAe7qaROhYdTnUQwXm0%3D')`
            })
          )
        ]
      })

      const result = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft/id',
          name: 'video.mp4',
          contentType: 'video/mp4',
          bytes,
          mailbox: 'shared@example.com'
        },
        budget
      ).pipe(Effect.provide(host.layer))

      expect(result).toEqual({
        attachmentId: 'AAMkADI5MAAIT3drCAAABEgAQANAqbAe7qaROhYdTnUQwXm0=',
        name: 'video.mp4',
        size
      })
      // Explicit non-own mailbox: identity lookup, then the shared write slot.
      expect(host.scopes).toEqual([undefined, [microsoftGraphMailReadWriteSharedScope]])

      expect(host.graphRequests).toHaveLength(1)
      expect(host.binaryWriteRequests).toHaveLength(0)
      expect(host.graphRequests[0]).toMatchObject({
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/shared%40example.com/messages/draft%2Fid/attachments/createUploadSession',
        headers: {
          authorization: `Bearer ${SECRET_TOKEN}`,
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        redirect: 'manual',
        credentials: 'omit'
      })
      expect(yield* decodeJsonBody(host.graphRequests[0]?.body)).toEqual({
        AttachmentItem: {
          attachmentType: 'file',
          name: 'video.mp4',
          size,
          contentType: 'video/mp4'
        }
      })

      expect(host.sessionRequests.map(request => request.headers)).toEqual([
        {
          'content-range': `bytes 0-${chunk - 1}/${size}`,
          'content-type': 'application/octet-stream'
        },
        {
          'content-range': `bytes ${chunk}-${chunk * 2 - 1}/${size}`,
          'content-type': 'application/octet-stream'
        },
        {
          'content-range': `bytes ${chunk * 2}-${size - 1}/${size}`,
          'content-type': 'application/octet-stream'
        }
      ])

      let offset = 0

      for (const request of host.sessionRequests) {
        expect(request).toMatchObject({
          method: 'PUT',
          url: uploadUrl,
          redirect: 'manual',
          credentials: 'omit',
          successStatuses: [200, 201],
          maxBytes: 4096,
          maxErrorBodyBytes: 256
        })
        expect(Object.keys(request.headers).map(name => name.toLowerCase())).not.toContain(
          'authorization'
        )
        expect(request.bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
        expect(request.maxUploadBytes).toBe(request.bytes.byteLength)
        expect(
          Buffer.from(request.bytes).equals(
            Buffer.from(bytes.subarray(offset, offset + request.bytes.byteLength))
          )
        ).toBe(true)
        offset += request.bytes.byteLength
      }

      expect(offset).toBe(size)
      expectSecretFree(result)
    })
  )

  it.effect('switches to an upload session at exactly 3 MiB', () =>
    Effect.gen(function* () {
      const size = outlookAttachmentSingleRequestMaxBytes

      const host = makeHost({
        graph: [Effect.succeed(graphJson({ uploadUrl }, 201))],
        session: [Effect.succeed(empty(201))]
      })

      const result = yield* addOutlookAttachment(
        integration,
        { messageId: 'd', name: 'x.bin', contentType: 'application/zip', bytes: patterned(size) },
        budget
      ).pipe(Effect.provide(host.layer))

      // A final 201 without Location still means the file is attached.
      expect(result).toEqual({ name: 'x.bin', size })
      expect(host.graphRequests[0]?.url).toMatch(/\/attachments\/createUploadSession$/)
      expect(host.sessionRequests).toHaveLength(1)
      expect(host.sessionRequests[0]?.headers['content-range']).toBe(`bytes 0-${size - 1}/${size}`)
    })
  )

  it.effect('fails definitively before credentials when the host lacks upload sessions', () =>
    Effect.gen(function* () {
      // Binary write port without `uploadSession`, and no binary write port at all.
      for (const session of ['missing', 'absent'] as const) {
        const host = makeHost({ session })

        const result = yield* addOutlookAttachment(
          integration,
          {
            messageId: 'draft',
            name: 'big.bin',
            contentType: 'application/octet-stream',
            bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
          },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        expect(failureOf(result)).toMatchObject({
          _tag: 'ConnectorFileTransferError',
          code: 'upload_session_required'
        })
        expect(host.scopes).toHaveLength(0)
        expect(host.graphRequests).toHaveLength(0)
        expect(host.binaryWriteRequests).toHaveLength(0)
      }
    })
  )

  it.effect('bounds the createUploadSession response by maxMetadataBytes', () =>
    Effect.gen(function* () {
      const base = JSON.stringify({ uploadUrl, pad: '' })

      const body = JSON.stringify({
        uploadUrl,
        pad: 'x'.repeat(budget.maxMetadataBytes + 1 - base.length)
      })

      expect(body.length).toBe(budget.maxMetadataBytes + 1)

      const host = makeHost({
        graph: [Effect.succeed(ConnectorHttpResponse.make({ status: 201, headers: {}, body }))],
        session: [Effect.succeed(empty(204))]
      })

      const result = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result)

      const failure = failureOf(result)

      expect(failure).toMatchObject({ code: 'response_too_large' })
      expectSecretFree(failure)
      // The oversized session was never read, so no URL was contacted or cancelled.
      expect(host.sessionRequests).toHaveLength(0)
    })
  )

  const sessionFailures: ReadonlyArray<{
    readonly name: string
    readonly replies: ReadonlyArray<Reply>
    readonly expected: { readonly code: string; readonly status?: number }
    readonly puts: number
  }> = [
    {
      name: 'an unexpected next range',
      replies: [Effect.succeed(json({ nextExpectedRanges: ['0-'] }, 200))],
      expected: { code: 'invalid_metadata' },
      puts: 1
    },
    {
      name: 'multiple missing ranges',
      replies: [
        Effect.succeed(
          json({ nextExpectedRanges: [`${outlookAttachmentUploadChunkBytes}-`, '1-2'] }, 200)
        )
      ],
      expected: { code: 'invalid_metadata' },
      puts: 1
    },
    {
      name: 'a missing progress body',
      replies: [Effect.succeed(empty(200))],
      expected: { code: 'invalid_metadata' },
      puts: 1
    },
    {
      name: 'an early 201',
      replies: [Effect.succeed(empty(201))],
      expected: { code: 'invalid_metadata', status: 201 },
      puts: 1
    },
    {
      name: 'a final 200',
      replies: [
        Effect.succeed(
          json({ nextExpectedRanges: [`${outlookAttachmentUploadChunkBytes}-`] }, 200)
        ),
        Effect.succeed(json({ nextExpectedRanges: [] }, 200))
      ],
      expected: { code: 'invalid_metadata', status: 200 },
      puts: 2
    },
    {
      name: 'an HTTP error on the second range',
      replies: [
        Effect.succeed(json({ nextExpectedRanges: [`${outlookAttachmentUploadChunkBytes}`] }, 200)),
        Effect.succeed(json({ error: { message: `PRIVATE ${uploadUrl}` } }, 500))
      ],
      expected: { code: 'upstream_failed', status: 500 },
      puts: 2
    },
    {
      name: 'an expired session',
      replies: [Effect.succeed(json({ error: { message: 'PRIVATE' } }, 404))],
      expected: { code: 'not_found', status: 404 },
      puts: 1
    },
    {
      name: 'a transport failure',
      replies: [Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))],
      expected: { code: 'transport_failed' },
      puts: 1
    }
  ]

  for (const scenario of sessionFailures) {
    it.effect(`cancels the upload session after ${scenario.name} without leaking its URL`, () =>
      Effect.gen(function* () {
        const size = outlookAttachmentUploadChunkBytes + 10

        const host = makeHost({
          graph: [Effect.succeed(graphJson({ uploadUrl, nextExpectedRanges: ['0-'] }, 201))],
          session: [
            ...scenario.replies,
            // Cancellation failure must never mask the original error.
            Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))
          ]
        })

        const result = yield* addOutlookAttachment(
          integration,
          { messageId: 'draft', name: 'x.bin', contentType: 'image/png', bytes: patterned(size) },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        const failure = failureOf(result)

        expect(failure).toBeInstanceOf(ConnectorFileTransferError)
        expect(failure).toMatchObject(scenario.expected)

        if (scenario.expected.status === undefined)
          expect(Predicate.hasProperty(failure, 'status') && failure.status).toBeFalsy()
        expectSecretFree(failure)

        const puts = host.sessionRequests.filter(request => request.method === 'PUT')
        const deletes = host.sessionRequests.filter(request => request.method === 'DELETE')

        expect(puts).toHaveLength(scenario.puts)
        expect(deletes).toHaveLength(1)
        expect(host.sessionRequests.at(-1)).toMatchObject({
          method: 'DELETE',
          url: uploadUrl,
          headers: {},
          redirect: 'manual',
          credentials: 'omit',
          successStatuses: [204],
          maxUploadBytes: 0
        })
        expect(deletes[0]?.bytes.byteLength).toBe(0)
      })
    )
  }

  it.effect('cancels the upload session when the upload is interrupted', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()

      const host = makeHost({
        graph: [Effect.succeed(graphJson({ uploadUrl }, 201))],
        session: [Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))]
      })

      const fiber = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(host.layer), Effect.forkChild)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      expect(host.sessionRequests.map(request => request.method)).toEqual(['PUT', 'DELETE'])
      expect(host.sessionRequests[1]?.url).toBe(uploadUrl)
    })
  )

  it.effect('bounds a hanging session cancellation at 10 seconds', () =>
    Effect.gen(function* () {
      const cancelling = yield* Deferred.make<void>()

      const host = makeHost({
        graph: [Effect.succeed(graphJson({ uploadUrl }, 201))],
        session: [
          Effect.succeed(empty(500)),
          Deferred.succeed(cancelling, undefined).pipe(Effect.andThen(Effect.never))
        ]
      })

      const fiber = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result, Effect.forkChild)

      yield* Deferred.await(cancelling)
      yield* TestClock.adjust('10 seconds')

      const result = yield* Fiber.join(fiber)

      expect(failureOf(result)).toMatchObject({ status: 500 })
      expect(host.sessionRequests.map(request => request.method)).toEqual(['PUT', 'DELETE'])
    })
  )

  it.effect('does not create or cancel a session when Graph refuses to create it', () =>
    Effect.gen(function* () {
      const host = makeHost({
        graph: [Effect.succeed(graphJson({ error: { message: 'PRIVATE' } }, 403))],
        session: []
      })

      const result = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result)

      expect(failureOf(result)).toMatchObject({ code: 'forbidden', status: 403 })
      expect(host.graphRequests).toHaveLength(1)
      expect(host.sessionRequests).toHaveLength(0)
    })
  )

  it.effect('rejects a mismatched initial session range and cancels before any PUT', () =>
    Effect.gen(function* () {
      const host = makeHost({
        graph: [Effect.succeed(graphJson({ uploadUrl, nextExpectedRanges: ['5-'] }, 201))],
        session: [Effect.succeed(empty(204))]
      })

      const result = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result)

      expect(failureOf(result)).toMatchObject({ code: 'invalid_metadata' })
      expect(host.sessionRequests.map(request => request.method)).toEqual(['DELETE'])
    })
  )

  it.effect('never contacts an upload URL outside the Outlook session allowlist', () =>
    Effect.gen(function* () {
      for (const url of [
        uploadUrl.replace('https://', 'http://'),
        uploadUrl.replace('outlook.office.com', 'outlook.office.com.evil.example'),
        uploadUrl.replace('outlook.office.com', 'graph.microsoft.com'),
        uploadUrl.replace('outlook.office.com', 'outlook.office.com:8443'),
        uploadUrl.replace('/api/v2.0/', '/api/v3.0/'),
        uploadUrl.replace('/api/v2.0/', '/api/'),
        uploadUrl.replace('/api/v2.0/', '/v2.0/'),
        uploadUrl.replace('AttachmentSessions', 'Attachments'),
        uploadUrl.replace('https://', 'https://user:pass@'),
        `${uploadUrl}#fragment`,
        'not a url'
      ]) {
        const host = makeHost({
          graph: [Effect.succeed(graphJson({ uploadUrl: url }, 201))],
          session: [Effect.succeed(empty(204))]
        })

        const result = yield* addOutlookAttachment(
          integration,
          {
            messageId: 'draft',
            name: 'x.bin',
            contentType: 'image/png',
            bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
          },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        const failure = failureOf(result)

        expect(failure).toMatchObject({ code: 'network_policy_rejected' })
        expectSecretFree(failure)
        expect(host.sessionRequests).toHaveLength(0)
      }
    })
  )

  it.effect('does not leak the upload URL when the session response is malformed', () =>
    Effect.gen(function* () {
      for (const body of [{ uploadUrl: 42, echo: uploadUrl }]) {
        const host = makeHost({ graph: [Effect.succeed(graphJson(body, 201))] })

        const result = yield* addOutlookAttachment(
          integration,
          {
            messageId: 'draft',
            name: 'x.bin',
            contentType: 'image/png',
            bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
          },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        const failure = failureOf(result)

        expect(failure).toMatchObject({ code: 'invalid_metadata' })
        expectSecretFree(failure)
        expect(host.sessionRequests).toHaveLength(0)
      }
    })
  )

  it.effect('cancels a created session whose initial range metadata is malformed', () =>
    Effect.gen(function* () {
      const host = makeHost({
        graph: [Effect.succeed(graphJson({ uploadUrl, nextExpectedRanges: uploadUrl }, 201))],
        session: [Effect.succeed(empty(204))]
      })

      const result = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(host.layer), Effect.result)

      const failure = failureOf(result)

      expect(failure).toMatchObject({ code: 'invalid_metadata' })
      expectSecretFree(failure)
      expect(host.sessionRequests.map(request => request.method)).toEqual(['DELETE'])
    })
  )

  it.effect('accepts every documented Outlook session API version segment', () =>
    Effect.gen(function* () {
      for (const version of ['v1.0', 'v2.0', 'gv1.0', 'beta', 'GV1.0']) {
        const size = outlookAttachmentSingleRequestMaxBytes
        const url = uploadUrl.replace('/api/v2.0/', `/api/${version}/`)

        const host = makeHost({
          graph: [Effect.succeed(graphJson({ uploadUrl: url }, 201))],
          session: [Effect.succeed(empty(201))]
        })

        const result = yield* addOutlookAttachment(
          integration,
          { messageId: 'draft', name: 'x.bin', contentType: 'image/png', bytes: patterned(size) },
          budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        expect(result._tag).toBe('Success')
        expect(host.sessionRequests.map(request => request.url)).toEqual([url])
      }
    })
  )

  it.effect('calls a class-based upload session port with its receiver', () =>
    Effect.gen(function* () {
      class Port {
        readonly urls: string[] = []

        request(_request: ConnectorBinaryWriteHttpRequest): Reply {
          return Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))
        }

        uploadSession(request: ConnectorBinaryUploadSessionRequest): Reply {
          this.urls.push(request.url)

          return Effect.succeed(empty(201))
        }
      }

      const port = new Port()

      const layer = Layer.mergeAll(
        credentialLayer,
        graphLayer(() => Effect.succeed(graphJson({ uploadUrl }, 201))),
        Layer.succeed(ConnectorBinaryWriteHttpClient, port)
      )

      const result = yield* addOutlookAttachment(
        integration,
        {
          messageId: 'draft',
          name: 'x.bin',
          contentType: 'image/png',
          bytes: patterned(outlookAttachmentSingleRequestMaxBytes)
        },
        budget
      ).pipe(Effect.provide(layer), Effect.result)

      expect(result._tag).toBe('Success')
      expect(port.urls).toEqual([uploadUrl])
    })
  )

  it.effect('rejects invalid inputs and oversized files before credentials or network', () =>
    Effect.gen(function* () {
      const valid: OutlookAddAttachmentInput = {
        messageId: 'draft',
        name: 'a.txt',
        contentType: 'text/plain',
        bytes: patterned(3)
      }

      const cases: ReadonlyArray<{
        readonly input: OutlookAddAttachmentInput
        readonly budget?: typeof budget
        readonly integration?: ReturnType<typeof makeMicrosoftIntegration>
        readonly code: string
      }> = [
        { input: { ...valid, messageId: '..' }, code: 'invalid_input' },
        { input: { ...valid, messageId: '' }, code: 'invalid_input' },
        { input: { ...valid, name: '' }, code: 'invalid_input' },
        { input: { ...valid, name: 'a\r\nb.txt' }, code: 'invalid_input' },
        { input: { ...valid, contentType: 'text' }, code: 'invalid_input' },
        { input: { ...valid, contentType: 'text/plain\r\nX: y' }, code: 'invalid_input' },
        { input: { ...valid, mailbox: '' }, code: 'invalid_input' },
        { input: valid, budget: { ...budget, maxBytes: 2 }, code: 'response_too_large' },
        { input: valid, budget: { ...budget, maxBytes: -1 }, code: 'invalid_input' },
        {
          input: { ...valid, bytes: new Uint8Array(outlookAttachmentUploadSessionMaxBytes + 1) },
          budget: { ...budget, maxBytes: Number.MAX_SAFE_INTEGER },
          code: 'response_too_large'
        },
        // Application access requires an explicit mailbox before credentials.
        {
          input: valid,
          integration: makeMicrosoftIntegration({ mailboxAccessMode: 'application' }),
          code: 'invalid_input'
        },
        {
          input: valid,
          integration: makeIntegration({ connectorId: 'google' }),
          code: 'invalid_input'
        }
      ]

      const expectRejected = (
        host: ReturnType<typeof makeHost>,
        result: Result.Result<unknown, unknown>,
        code: string
      ) => {
        expect(failureOf(result)).toMatchObject({ code })
        expect(host.scopes).toHaveLength(0)
        expect(host.graphRequests).toHaveLength(0)
      }

      for (const testCase of cases) {
        const host = makeHost({ graph: [Effect.succeed(graphJson({ id: 'a' }, 201))] })

        const result = yield* addOutlookAttachment(
          testCase.integration ?? integration,
          testCase.input,
          testCase.budget ?? budget
        ).pipe(Effect.provide(host.layer), Effect.result)

        expectRejected(host, result, testCase.code)
      }

      const arrayHost = makeHost({ graph: [Effect.succeed(graphJson({ id: 'a' }, 201))] })

      const arrayResult = yield* addOutlookAttachment(
        integration,
        // @ts-expect-error - untrusted host envelopes must fail runtime validation, not types
        { ...valid, bytes: [1, 2, 3] },
        budget
      ).pipe(Effect.provide(arrayHost.layer), Effect.result)

      expectRejected(arrayHost, arrayResult, 'invalid_input')

      const wideHost = makeHost({ graph: [Effect.succeed(graphJson({ id: 'a' }, 201))] })

      const wideResult = yield* addOutlookAttachment(
        integration,
        // @ts-expect-error - only Uint8Array views are accepted
        { ...valid, bytes: new Uint16Array(3) },
        budget
      ).pipe(Effect.provide(wideHost.layer), Effect.result)

      expectRejected(wideHost, wideResult, 'invalid_input')
    })
  )

  it.effect('keeps ordinary write scopes for an explicit own mailbox in application mode', () =>
    Effect.gen(function* () {
      const host = makeHost({ graph: [Effect.succeed(graphJson({ id: 'a' }, 201))] })

      yield* addOutlookAttachment(
        makeMicrosoftIntegration({ mailboxAccessMode: 'application' }),
        {
          messageId: 'draft',
          name: 'a.txt',
          contentType: 'text/plain',
          bytes: patterned(3),
          mailbox: 'user@example.com'
        },
        budget
      ).pipe(Effect.provide(host.layer))

      expect(host.scopes).toEqual([[microsoftGraphMailReadWriteScope]])
      expect(host.graphRequests[0]?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/user%40example.com/messages/draft/attachments'
      )
    })
  )
})
