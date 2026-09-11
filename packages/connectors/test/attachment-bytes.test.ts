import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  ActionResult,
  ApiKeyCredential,
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  OAuthCredential,
  UsernamePasswordCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorBinaryHttpRequest, ConnectorBinaryHttpResponse } from '@yolk-sdk/connectors'
import { downloadGmailAttachment } from '@yolk-sdk/connectors/google'
import { downloadOutlookAttachment } from '@yolk-sdk/connectors/microsoft'
import { downloadEmailAttachment, EmailClient } from '@yolk-sdk/connectors/email'
import { downloadTelegramFile } from '@yolk-sdk/connectors/telegram'
import { downloadTodoistAttachment, TodoistConnector } from '@yolk-sdk/connectors/todoist'

const budget = { maxBytes: 16, maxMetadataBytes: 2048, maxErrorBodyBytes: 64 }
const bytes = new Uint8Array([0, 128, 255])
const response = (body = bytes, status = 200, headers = {}): ConnectorBinaryHttpResponse => ({
  bytes: body,
  status,
  headers,
  bodyComplete: true
})
const json = (value: unknown) => response(new TextEncoder().encode(JSON.stringify(value)))
const integration = (connectorId: string, config = {}) =>
  makeIntegration({
    connectorId,
    config,
    credentialBindings: [
      makeCredentialBinding({
        slotId:
          connectorId === 'telegram'
            ? 'telegram.bot_token'
            : connectorId === 'todoist'
              ? 'todoist.api_token'
              : connectorId === 'email'
                ? 'email.incoming'
                : `${connectorId}.oauth`,
        credentialRef: 'ref'
      })
    ]
  })
const host = (responses: readonly ConnectorBinaryHttpResponse[]) => {
  const requests: ConnectorBinaryHttpRequest[] = []
  const slots: { id: string; scopes: readonly string[] | undefined }[] = []
  return {
    requests,
    slots,
    layer: Layer.mergeAll(
      Layer.succeed(CredentialResolver, {
        resolve: req => {
          slots.push({ id: req.slot.id, scopes: req.slot.requiredScopes })
          return Effect.succeed(
            req.integration.connectorId === 'telegram'
              ? ApiKeyCredential.make({ _tag: 'ApiKeyCredential', key: '123:SECRET' })
              : req.integration.connectorId === 'email'
                ? UsernamePasswordCredential.make({
                    _tag: 'UsernamePasswordCredential',
                    username: 'user',
                    password: 'SECRET'
                  })
                : OAuthCredential.make({
                    _tag: 'OAuthCredential',
                    provider: req.integration.connectorId,
                    accessToken: 'SECRET',
                    expiresAt: 4e12
                  })
          )
        }
      }),
      Layer.succeed(ConnectorBinaryHttpClient, {
        request: req => {
          const r = responses[requests.length] ?? response(new Uint8Array(), 500)
          requests.push(req)
          return Effect.succeed(r)
        }
      })
    )
  }
}

describe('host-only mail bytes', () => {
  it.effect('Gmail decodes canonical padded/unpadded base64url, including empty files', () =>
    Effect.gen(function* () {
      for (const [data, size, expected] of [
        ['AID_', 3, bytes],
        ['AA==', 1, new Uint8Array([0])],
        ['', 0, new Uint8Array()]
      ] as const) {
        const h = host([json({ data, size })])
        const result = yield* downloadGmailAttachment(
          integration('google'),
          { messageId: 'message', attachmentId: 'attachment' },
          budget
        ).pipe(Effect.provide(h.layer))
        expect(result.bytes).toEqual(expected)
        expect(result.byteLength).toBe(size)
        expect(h.requests[0]?.url).toBe(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/message/attachments/attachment'
        )
        expect(h.requests[0]?.maxBytes).toBe(2048)
        expect(h.slots[0]?.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly'])
        expect(JSON.stringify(result)).not.toContain('data')
      }
    })
  )
  it.effect('Gmail rejects noncanonical pad bits, wrong lengths, whitespace and size lies', () =>
    Effect.gen(function* () {
      for (const body of [
        { data: 'AB', size: 1 },
        { data: 'AA=', size: 1 },
        { data: 'A', size: 1 },
        { data: 'AA\n', size: 1 },
        { data: 'AA', size: 2 },
        { data: 'AID/', size: 3 },
        { data: 'AA', size: 100 }
      ]) {
        const h = host([json(body)])
        expect(
          (yield* downloadGmailAttachment(
            integration('google'),
            { messageId: 'm', attachmentId: 'a' },
            budget
          ).pipe(Effect.provide(h.layer), Effect.result))._tag
        ).toBe('Failure')
      }
    })
  )
  it.effect('Outlook reads bounded discriminator then raw $value with shared consent', () =>
    Effect.gen(function* () {
      const h = host([
        json({
          id: 'a',
          '@odata.type': '#microsoft.graph.fileAttachment',
          size: 100,
          name: 'x.bin'
        }),
        response()
      ])
      const result = yield* downloadOutlookAttachment(
        integration('microsoft'),
        { messageId: 'm', attachmentId: 'a', mailbox: 'mail@example.com' },
        budget
      ).pipe(Effect.provide(h.layer))
      expect(result.bytes).toEqual(bytes)
      expect(h.requests[0]?.url).not.toContain('contentBytes')
      expect(h.requests[1]?.url).toBe(
        'https://graph.microsoft.com/v1.0/users/mail%40example.com/messages/m/attachments/a/$value'
      )
      expect(h.requests[1]?.headers.prefer).toBe('IdType="ImmutableId"')
      expect(h.slots[0]?.scopes).toEqual(['https://graph.microsoft.com/Mail.Read.Shared'])
    })
  )
  it.effect(
    'Outlook rejects item/reference types and application default mailbox pre-network',
    () =>
      Effect.gen(function* () {
        for (const kind of ['itemAttachment', 'referenceAttachment']) {
          const h = host([json({ id: 'a', '@odata.type': `#microsoft.graph.${kind}` })])
          expect(
            (yield* downloadOutlookAttachment(
              integration('microsoft'),
              { messageId: 'm', attachmentId: 'a' },
              budget
            ).pipe(Effect.provide(h.layer), Effect.result))._tag
          ).toBe('Failure')
          expect(h.requests).toHaveLength(1)
        }
        const h = host([])
        expect(
          (yield* downloadOutlookAttachment(
            integration('microsoft', { mailboxAccessMode: 'application' }),
            { messageId: 'm', attachmentId: 'a' },
            budget
          ).pipe(Effect.provide(h.layer), Effect.result))._tag
        ).toBe('Failure')
        expect(h.slots).toHaveLength(0)
      })
  )
  it.effect(
    'IMAP/POP3 optional byte method preserves credentials/connection, no base64 roundtrip',
    () =>
      Effect.gen(function* () {
        const h = host([])
        const requests: unknown[] = []
        const client = EmailClient.of({
          listMessages: () =>
            Effect.succeed(ActionResult.failure({ code: 'unused', message: 'unused' })),
          getMessage: () =>
            Effect.succeed(ActionResult.failure({ code: 'unused', message: 'unused' })),
          createDraft: () =>
            Effect.succeed(ActionResult.failure({ code: 'unused', message: 'unused' })),
          sendMessage: () =>
            Effect.succeed(ActionResult.failure({ code: 'unused', message: 'unused' })),
          getAttachmentBytes: req => {
            requests.push(req)
            return Effect.succeed({
              messageId: req.messageId,
              attachmentId: req.attachmentId,
              bytes,
              byteLength: 3
            })
          }
        })
        for (const protocol of ['imap', 'pop3']) {
          const i = integration('email', {
            incomingProtocol: protocol,
            incomingHost: 'mail.example.com'
          })
          const result = yield* downloadEmailAttachment(
            i,
            { messageId: 'm', attachmentId: 'a' },
            budget
          ).pipe(Effect.provideService(EmailClient, client), Effect.provide(h.layer))
          expect(result.bytes).toBe(bytes)
        }
        expect(requests).toMatchObject([
          {
            connection: { protocol: 'imap', port: 993 },
            maxBytes: 16,
            credential: { username: 'user' }
          },
          { connection: { protocol: 'pop3', port: 995 } }
        ])
        const invalid = yield* downloadEmailAttachment(
          integration('email', { incomingProtocol: 'pop3', incomingHost: 'mail.example.com' }),
          { messageId: 'm', attachmentId: 'a', folder: 'INBOX' },
          budget
        ).pipe(Effect.provideService(EmailClient, client), Effect.provide(h.layer), Effect.result)
        expect(invalid._tag).toBe('Failure')
        expect(requests).toHaveLength(2)
        const oversized = yield* downloadEmailAttachment(
          integration('email', { incomingHost: 'mail.example.com' }),
          { messageId: 'm', attachmentId: 'a' },
          { ...budget, maxBytes: 2 }
        ).pipe(Effect.provideService(EmailClient, client), Effect.provide(h.layer), Effect.result)
        expect(oversized._tag).toBe('Failure')
      })
  )
})

describe('Telegram and Todoist file bytes', () => {
  it.effect('Telegram trusted hosted URL and exact size, never name/MIME/token in output', () =>
    Effect.gen(function* () {
      const h = host([
        json({
          ok: true,
          result: {
            file_id: 'id',
            file_unique_id: 'unique',
            file_path: 'documents/file_1.pdf',
            file_size: 3
          }
        }),
        response()
      ])
      const r = yield* downloadTelegramFile(
        integration('telegram'),
        { fileId: 'id' },
        { ...budget, maxBytes: 30_000_000 }
      ).pipe(Effect.provide(h.layer))
      expect(h.requests[0]?.url).toBe('https://api.telegram.org/bot123:SECRET/getFile?file_id=id')
      expect(h.requests[1]).toMatchObject({
        url: 'https://api.telegram.org/file/bot123:SECRET/documents/file_1.pdf',
        maxBytes: 20_000_000,
        headers: {},
        redirect: 'manual'
      })
      expect(r.bytes).toEqual(bytes)
      expect(JSON.stringify(r)).not.toContain('SECRET')
      expect(JSON.stringify(r)).not.toContain('file_1.pdf')
    })
  )
  it.effect('Telegram rejects traversal/local paths, size overflow and redirects', () =>
    Effect.gen(function* () {
      for (const file_path of [
        '../x',
        '/tmp/file',
        'folder/../x',
        'x?token=SECRET',
        'https://evil.example/x',
        'folder/%2e%2e/x',
        'a\\b'
      ]) {
        const h = host([json({ ok: true, result: { file_id: 'id', file_path } })])
        const result = yield* downloadTelegramFile(
          integration('telegram'),
          { fileId: 'id' },
          budget
        ).pipe(Effect.provide(h.layer), Effect.result)
        expect(result._tag).toBe('Failure')
        expect(JSON.stringify(result)).not.toContain('SECRET')
        expect(h.requests).toHaveLength(1)
      }
      for (const next of [
        response(bytes, 302, { location: 'https://evil.example/' }),
        response(new Uint8Array(17))
      ]) {
        const h = host([json({ ok: true, result: { file_id: 'id', file_path: 'file' } }), next])
        expect(
          (yield* downloadTelegramFile(integration('telegram'), { fileId: 'id' }, budget).pipe(
            Effect.provide(h.layer),
            Effect.result
          ))._tag
        ).toBe('Failure')
        expect(h.requests).toHaveLength(2)
      }
    })
  )
  it.effect('Todoist sends auth only to file host then strips on every redirect', () =>
    Effect.gen(function* () {
      const h = host([
        json({
          id: 'c',
          content: '',
          file_attachment: { file_url: 'https://files.todoist.com/x' }
        }),
        response(new Uint8Array(), 302, { location: 'https://todoist.b-cdn.net/x?signed=SECRET' }),
        response()
      ])
      const r = yield* downloadTodoistAttachment(
        integration('todoist'),
        { commentId: 'c' },
        budget
      ).pipe(Effect.provide(h.layer))
      expect(r.bytes).toEqual(bytes)
      expect(h.requests[1]?.headers.authorization).toBe('Bearer SECRET')
      expect(h.requests[2]?.headers).toEqual({})
      expect(JSON.stringify(r)).not.toContain('SECRET')
      const cdn = host([
        json({
          id: 'c',
          content: '',
          file_attachment: { file_url: 'https://d1ysz50cxb9zwl.cloudfront.net/x' }
        }),
        response()
      ])
      yield* downloadTodoistAttachment(integration('todoist'), { commentId: 'c' }, budget).pipe(
        Effect.provide(cdn.layer)
      )
      expect(cdn.requests[1]?.headers).toEqual({})
    })
  )
  it.effect('Todoist rejects unauthorized initial/redirect hosts and redirect loops', () =>
    Effect.gen(function* () {
      for (const url of [
        'http://files.todoist.com/x',
        'https://evil.example/x',
        'https://files.todoist.com:444/x'
      ]) {
        const h = host([json({ id: 'c', content: '', file_attachment: { file_url: url } })])
        expect(
          (yield* downloadTodoistAttachment(
            integration('todoist'),
            { commentId: 'c' },
            budget
          ).pipe(Effect.provide(h.layer), Effect.result))._tag
        ).toBe('Failure')
        expect(h.requests).toHaveLength(1)
      }
      const h = host([
        json({
          id: 'c',
          content: '',
          file_attachment: { file_url: 'https://files.todoist.com/x' }
        }),
        ...Array.from({ length: 6 }, () =>
          response(new Uint8Array(), 302, { location: 'https://todoist.b-cdn.net/x' })
        )
      ])
      expect(
        (yield* downloadTodoistAttachment(integration('todoist'), { commentId: 'c' }, budget).pipe(
          Effect.provide(h.layer),
          Effect.result
        ))._tag
      ).toBe('Failure')
      expect(h.requests).toHaveLength(7)
      expect(h.requests.slice(2).every(r => r.headers.authorization === undefined)).toBe(true)
    })
  )
  it.effect('Todoist invalid comment selectors fail validation before credentials or HTTP', () =>
    Effect.gen(function* () {
      const h = host([])
      let calls = 0
      for (const input of [{}, { taskId: 'task', projectId: 'project' }]) {
        const result = yield* TodoistConnector.invoke({
          integration: integration('todoist'),
          action: 'todoist.list_comments',
          input
        }).pipe(
          Effect.provideService(ConnectorHttpClient, {
            request: () => {
              calls++
              return Effect.die('Unexpected HTTP request')
            }
          }),
          Effect.provide(h.layer),
          Effect.result
        )
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') expect(result.failure.cause).toBe('validation_failed')
      }
      expect(calls).toBe(0)
      expect(h.slots).toHaveLength(0)
    })
  )
  it.effect('Todoist comment discovery paginates and omits signed URLs', () =>
    Effect.gen(function* () {
      const h = host([])
      const urls: string[] = []
      const r = yield* TodoistConnector.invoke({
        integration: integration('todoist'),
        action: 'todoist.list_comments',
        input: { taskId: 'task', cursor: 'opaque', limit: 5 }
      }).pipe(
        Effect.provideService(ConnectorHttpClient, {
          request: req => {
            urls.push(req.url)
            return Effect.succeed(
              ConnectorHttpResponse.make({
                status: 200,
                headers: {},
                body: JSON.stringify({
                  results: [
                    {
                      id: 'c',
                      content: 'text',
                      file_attachment: {
                        file_url: 'https://files.todoist.com/SECRET',
                        file_name: 'x.pdf'
                      }
                    }
                  ],
                  next_cursor: 'next'
                })
              })
            )
          }
        }),
        Effect.provide(h.layer)
      )
      expect(urls).toEqual([
        'https://api.todoist.com/api/v1/comments?task_id=task&cursor=opaque&limit=5'
      ])
      expect(r._tag).toBe('Success')
      expect(JSON.stringify(r)).toContain('next')
      expect(JSON.stringify(r)).not.toContain('SECRET')
    })
  )
  it.effect('binary port failure preserves safe code, without provider details', () =>
    Effect.gen(function* () {
      const h = host([])
      const r = yield* downloadGmailAttachment(
        integration('google'),
        { messageId: 'm', attachmentId: 'a' },
        budget
      ).pipe(
        Effect.provideService(ConnectorBinaryHttpClient, {
          request: () =>
            Effect.fail(new ConnectorBinaryHttpError({ code: 'network_policy_rejected' }))
        }),
        Effect.provide(h.layer),
        Effect.result
      )
      expect(r._tag).toBe('Failure')
      expect(JSON.stringify(r)).not.toContain('SECRET')
    })
  )
})

it.effect('Graph opaque IDs containing slash are encoded as complete path segments', () =>
  Effect.gen(function* () {
    const h = host([
      json({ id: 'a/b==', '@odata.type': '#microsoft.graph.fileAttachment' }),
      response()
    ])
    yield* downloadOutlookAttachment(
      integration('microsoft'),
      { messageId: 'm/n==', attachmentId: 'a/b==' },
      budget
    ).pipe(Effect.provide(h.layer))
    expect(h.requests[1]?.url).toBe(
      'https://graph.microsoft.com/v1.0/me/messages/m%2Fn%3D%3D/attachments/a%2Fb%3D%3D/$value'
    )
  })
)

it.effect('Todoist never follows 304 or malformed redirect byte bodies', () =>
  Effect.gen(function* () {
    const comment = json({
      id: 'c',
      content: '',
      file_attachment: { file_url: 'https://files.todoist.com/x' }
    })
    const malformed = {
      ...response(new Uint8Array(), 302, { location: 'https://todoist.b-cdn.net/x' }),
      bytes: 'SECRET'
    }
    for (const r of [
      response(new Uint8Array(), 304, { location: 'https://todoist.b-cdn.net/x' }),
      malformed
    ]) {
      // @ts-expect-error Exercise a malformed host response as well as valid 304.
      const h = host([comment, r])
      const result = yield* downloadTodoistAttachment(
        integration('todoist'),
        { commentId: 'c' },
        budget
      ).pipe(Effect.provide(h.layer), Effect.result)
      expect(result._tag).toBe('Failure')
      expect(h.requests).toHaveLength(2)
      expect(JSON.stringify(result)).not.toContain('SECRET')
    }
  })
)
