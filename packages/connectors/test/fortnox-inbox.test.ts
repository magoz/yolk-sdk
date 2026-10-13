import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools, toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  ConnectorBinaryHttpClient,
  ConnectorBinaryWriteHttpClient,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  defineConnector,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type {
  ConnectorBinaryHttpRequest,
  ConnectorBinaryHttpResponse,
  ConnectorBinaryWriteHttpRequest,
  ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  FortnoxInboxFile,
  FortnoxInboxFolder,
  downloadFortnoxInboxFile,
  fortnoxDeleteInboxItemAction,
  fortnoxGetInboxFolderAction,
  fortnoxInboxActions,
  fortnoxInboxUploadMaxBytes,
  uploadFortnoxInboxFile
} from '../src/fortnox/inbox.ts'
import type { FortnoxInboxUploadInput } from '../src/fortnox/inbox.ts'

const integration = makeIntegration({
  connectorId: 'fortnox',
  credentialBindings: [
    makeCredentialBinding({ slotId: 'fortnox.oauth', credentialRef: 'host-fortnox-ref' })
  ]
})

const oauth = OAuthCredential.make({
  provider: 'fortnox',
  accessToken: 'test-access-token',
  expiresAt: 4_000_000_000_000
})

const isJson = Schema.is(Schema.Json)

const jsonText = (body: Schema.Json) => {
  if (!isJson(body)) throw new TypeError('JSON fixture requires a finite JSON value')

  return JSON.stringify(body)
}

const response = (body: Schema.Json, status = 200) =>
  ConnectorHttpResponse.make({ status, headers: {}, body: jsonText(body) })

const empty = (status: number) => ConnectorHttpResponse.make({ status, headers: {}, body: '' })

const binary = (
  bytes: Uint8Array,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): ConnectorBinaryHttpResponse => ({ status, headers, bytes, bodyComplete: true })

const binaryJson = (body: Schema.Json, status = 200) =>
  binary(new TextEncoder().encode(jsonText(body)), status)

type Responses = {
  readonly http?: ReadonlyArray<ConnectorHttpResponse>
  readonly read?: ReadonlyArray<ConnectorBinaryHttpResponse>
  readonly write?: ReadonlyArray<ConnectorBinaryHttpResponse>
}

const makeHarness = (responses: Responses = {}) => {
  const requests: Array<ConnectorHttpRequest> = []
  const reads: Array<ConnectorBinaryHttpRequest> = []
  const writes: Array<ConnectorBinaryWriteHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const next = <A>(list: ReadonlyArray<A> | undefined, index: number) => {
    const item = list?.at(index)

    return item === undefined
      ? Effect.die(new Error('Unexpected Fortnox request'))
      : Effect.succeed(item)
  }

  const layer = Layer.mergeAll(
    Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: request => {
          expect(request.binding.credentialRef).toBe('host-fortnox-ref')
          expect(request.slot.id).toBe('fortnox.oauth')
          scopes.push(request.slot.requiredScopes)

          return Effect.succeed(oauth)
        }
      })
    ),
    Layer.succeed(
      ConnectorHttpClient,
      ConnectorHttpClient.of({
        request: request => {
          requests.push(request)

          return next(responses.http, requests.length - 1)
        }
      })
    ),
    Layer.succeed(ConnectorBinaryHttpClient, {
      request: request => {
        reads.push(request)

        return next(responses.read, reads.length - 1)
      }
    }),
    Layer.succeed(ConnectorBinaryWriteHttpClient, {
      request: request => {
        writes.push(request)

        return next(responses.write, writes.length - 1)
      }
    })
  )

  const sent = () => requests.length + reads.length + writes.length

  return { layer, requests, reads, writes, scopes, sent }
}

const readHeaders = { authorization: 'Bearer test-access-token', accept: 'application/json' }

const budget = { maxBytes: 64, maxMetadataBytes: 4096, maxErrorBodyBytes: 256 }

const InboxConnector = defineConnector({ id: 'fortnox', actions: [...fortnoxInboxActions] })

const fileId = '00000000-0000-4000-8000-000000000001'

const archiveFileId = '00000000-0000-4000-8000-000000000002'

// Synthetic root folder in the documented JSON shape; Size arrives as a number or numeric string.
const rootFolder = {
  Folder: {
    '@url': 'https://api.fortnox.se/3/inbox/root',
    Email: 'inbox.example@example.test',
    Files: [
      {
        '@url': `https://api.fortnox.se/3/inbox/${fileId}`,
        Comments: null,
        Id: fileId,
        ArchiveFileId: archiveFileId,
        Name: 'example.pdf',
        Path: 'inbox',
        Size: '157'
      }
    ],
    Folders: [
      { '@url': 'https://api.fortnox.se/3/inbox/inbox_s', Id: 'inbox_s', Name: 'Example folder' }
    ],
    Id: 'root',
    Name: 'Inbox'
  }
}

const uploadedFile = (size: number | string) => ({
  File: {
    '@url': `https://api.fortnox.se/3/inbox/${fileId}`,
    Comments: null,
    Id: fileId,
    ArchiveFileId: archiveFileId,
    Name: 'example.pdf',
    Path: 'inbox_kf',
    Size: size
  }
})

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a])

const ascii = (text: string) => new TextEncoder().encode(text)

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }

  return out
}

const includes = (haystack: Uint8Array, needle: Uint8Array) =>
  haystack.some(
    (_, i) => i + needle.length <= haystack.length && needle.every((b, j) => haystack[i + j] === b)
  )

const expectedBody = (boundary: string, name: string, contentType: string, data: Uint8Array) =>
  concat([
    ascii(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`),
    new TextEncoder().encode(name),
    ascii(`"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    ascii(`\r\n--${boundary}--\r\n`)
  ])

describe('Fortnox inbox actions', () => {
  it('exports only the folder read and the destructive delete as actions', () => {
    expect(fortnoxInboxActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.get_inbox_folder', 'read'],
      ['fortnox.delete_inbox_item', 'destructive']
    ])
    expect(fortnoxDeleteInboxItemAction.description).toContain('cannot be undone')
    expect(fortnoxDeleteInboxItemAction.description).toContain('Deleting a subfolder')
    expect(fortnoxGetInboxFolderAction.description).toContain('file Id')
  })

  it('lowers every inbox action output schema to JSON Schema', () => {
    for (const action of fortnoxInboxActions) {
      expect(toolJsonSchemaFromSchema(action.outputSchema), action.id).toBeDefined()
    }
  })

  it.effect('adapts the actions to agent tools without the host-only byte helpers', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(InboxConnector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools.map(tool => tool.name).sort()).toEqual([
        'fortnox.delete_inbox_item',
        'fortnox.get_inbox_folder'
      ])

      for (const tool of toolSet.tools) {
        expect(tool.parameters).toMatchObject({ type: 'object' })
      }

      expect(harness.sent()).toBe(0)
    })
  )

  it.effect('reads the root folder without an Id and decodes files and subfolders', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ http: [response(rootFolder)] })

      const result = yield* fortnoxGetInboxFolderAction
        .execute({ integration, input: {} })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests).toHaveLength(1)
      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: 'https://api.fortnox.se/3/inbox',
        headers: readHeaders
      })
      expect(harness.requests[0]?.body).toBeUndefined()
      expect(harness.scopes).toEqual([['inbox']])
      expect(result._tag).toBe('Success')

      if (!Predicate.isTagged(result, 'Success')) return

      const folder = yield* Schema.decodeUnknownEffect(Schema.toType(FortnoxInboxFolder))(
        result.value
      )

      expect(folder).toMatchObject({
        Id: 'root',
        Name: 'Inbox',
        Email: 'inbox.example@example.test'
      })

      const [file] = Chunk.toReadonlyArray(folder.Files)

      expect(file).toBeInstanceOf(FortnoxInboxFile)
      expect(file).toMatchObject({
        Id: fileId,
        Name: 'example.pdf',
        Path: 'inbox',
        Size: 157,
        ArchiveFileId: archiveFileId,
        Comments: null
      })
      expect(file !== undefined && '@url' in file).toBe(false)
      expect(Chunk.toReadonlyArray(folder.Folders)).toMatchObject([
        { Id: 'inbox_s', Name: 'Example folder' }
      ])
    })
  )

  it.effect('reads a folder by encoded Id and accepts empty file and folder lists', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({ Folder: { Id: 'inbox_s', Name: 'Example', Files: [], Folders: [] } }),
          response({ Folder: { Id: 'a/b c', Name: null, Files: [], Folders: [] } })
        ]
      })

      const first = yield* fortnoxGetInboxFolderAction
        .execute({ integration, input: { folderId: 'inbox_s' } })
        .pipe(Effect.provide(harness.layer))

      yield* fortnoxGetInboxFolderAction
        .execute({ integration, input: { folderId: 'a/b c' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests.map(request => request.url)).toEqual([
        'https://api.fortnox.se/3/inbox/inbox_s',
        'https://api.fortnox.se/3/inbox/a%2Fb%20c'
      ])
      expect(first).toMatchObject({ _tag: 'Success', value: { Id: 'inbox_s', Name: 'Example' } })

      const folder = yield* Schema.decodeUnknownEffect(Schema.toType(FortnoxInboxFolder))(
        Predicate.isTagged(first, 'Success') ? first.value : undefined
      )

      expect([Chunk.size(folder.Files), Chunk.size(folder.Folders)]).toEqual([0, 0])
    })
  )

  it.effect('fails decoding when Files is missing or a file Id returns bytes', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({ Folder: { Id: 'inbox_s', Folders: [] } }),
          ConnectorHttpResponse.make({ status: 200, headers: {}, body: '%PDF-1.4' })
        ]
      })

      for (const folderId of ['inbox_s', fileId]) {
        const result = yield* fortnoxGetInboxFolderAction
          .execute({ integration, input: { folderId } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result, folderId).toMatchObject({ failure: { cause: 'validation_failed' } })
      }
    })
  )

  it.effect('rejects unsafe or empty Ids and unknown types before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      for (const id of ['', ' ', '.', '..', ' inbox_s', 'inbox\n_s', null]) {
        const got = yield* fortnoxGetInboxFolderAction
          .execute({ integration, input: { folderId: id } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        const deleted = yield* fortnoxDeleteInboxItemAction
          .execute({ integration, input: { itemId: id } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        for (const result of [got, deleted]) {
          expect(result, JSON.stringify(id)).toMatchObject({
            failure: { cause: 'validation_failed' }
          })
        }
      }

      expect(harness.sent()).toBe(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('refuses to delete root or a static inbox folder before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      for (const itemId of ['root', 'ROOT', 'inbox_s', 'Inbox_V', 'inbox_kf']) {
        const result = yield* fortnoxDeleteInboxItemAction
          .execute({ integration, input: { itemId } })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result, itemId).toMatchObject({ failure: { cause: 'validation_failed' } })
      }

      expect(harness.sent()).toBe(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('deletes a file or folder by encoded Id without decoding the empty answer', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ http: [empty(204), empty(200)] })

      const file = yield* fortnoxDeleteInboxItemAction
        .execute({ integration, input: { itemId: fileId } })
        .pipe(Effect.provide(harness.layer))

      const folder = yield* fortnoxDeleteInboxItemAction
        .execute({ integration, input: { itemId: 'Example folder' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests).toMatchObject([
        { method: 'DELETE', url: `https://api.fortnox.se/3/inbox/${fileId}`, headers: readHeaders },
        { method: 'DELETE', url: 'https://api.fortnox.se/3/inbox/Example%20folder' }
      ])
      expect(harness.requests[0]?.body).toBeUndefined()
      expect(harness.scopes).toEqual([['inbox'], ['inbox']])
      expect(file).toMatchObject({ _tag: 'Success', value: { itemId: fileId, deleted: true } })
      expect(folder).toMatchObject({
        _tag: 'Success',
        value: { itemId: 'Example folder', deleted: true }
      })
    })
  )

  it.effect('maps non-2xx answers to ActionResult failures with Fortnox codes', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        http: [
          response({ ErrorInformation: { code: 2000423, message: 'Not found.' } }, 404),
          response({ ErrorInformation: { Code: 2000663, Message: 'No access.' } }, 403)
        ]
      })

      const got = yield* fortnoxGetInboxFolderAction
        .execute({ integration, input: { folderId: 'inbox_x' } })
        .pipe(Effect.provide(harness.layer))

      const deleted = yield* fortnoxDeleteInboxItemAction
        .execute({ integration, input: { itemId: fileId } })
        .pipe(Effect.provide(harness.layer))

      expect(got).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'fortnox_not_found',
          message: 'Not found.',
          status: 404,
          underlying: { providerCode: 2000423 }
        }
      })
      expect(deleted).toMatchObject({
        _tag: 'Failure',
        error: { code: 'fortnox_forbidden', status: 403 }
      })
    })
  )
})

describe('Fortnox inbox host-only byte helpers', () => {
  it.effect('downloads file bytes with the inbox scope through the binary port', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ read: [binary(bytes)] })

      const result = yield* downloadFortnoxInboxFile(integration, { fileId }, budget).pipe(
        Effect.provide(harness.layer)
      )

      expect(result).toEqual({ bytes, byteLength: bytes.byteLength, source: { id: fileId } })
      expect(harness.reads).toMatchObject([
        {
          method: 'GET',
          url: `https://api.fortnox.se/3/inbox/${fileId}`,
          headers: {
            authorization: 'Bearer test-access-token',
            accept: 'application/octet-stream'
          },
          redirect: 'manual',
          credentials: 'omit',
          maxBytes: budget.maxBytes
        }
      ])
      expect(harness.scopes).toEqual([['inbox']])
    })
  )

  it.effect('rejects folder and unsafe Ids before credentials or requests', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      for (const id of ['root', 'ROOT', 'inbox_s', 'Inbox_KF', '', '..', 'a/b', 'a b', 'a?b']) {
        const result = yield* downloadFortnoxInboxFile(integration, { fileId: id }, budget).pipe(
          Effect.provide(harness.layer),
          Effect.result
        )

        expect(result, id).toMatchObject({ failure: { code: 'invalid_input' } })
      }

      expect(harness.sent()).toBe(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('download failures carry only the code and status', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ read: [binary(ascii('{"ErrorInformation":{}}'), 404)] })

      const result = yield* downloadFortnoxInboxFile(integration, { fileId }, budget).pipe(
        Effect.provide(harness.layer),
        Effect.result
      )

      expect(result).toMatchObject({ failure: { code: 'not_found', status: 404 } })
    })
  )

  it.effect('uploads one multipart POST and returns the stored file metadata', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ write: [binaryJson(uploadedFile(bytes.byteLength), 201)] })

      const result = yield* uploadFortnoxInboxFile(
        integration,
        { folderId: 'inbox_kf', fileName: 'faktura å.pdf', contentType: 'application/pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer))

      expect(result).toBeInstanceOf(FortnoxInboxFile)
      expect(result).toMatchObject({
        Id: fileId,
        Name: 'example.pdf',
        Path: 'inbox_kf',
        Size: bytes.byteLength,
        ArchiveFileId: archiveFileId
      })
      expect(harness.writes).toHaveLength(1)

      const request = harness.writes[0]
      const boundary = 'yolk-fortnox-inbox-00000000'
      const body = expectedBody(boundary, 'faktura å.pdf', 'application/pdf', bytes)

      expect(request).toMatchObject({
        method: 'POST',
        url: 'https://api.fortnox.se/3/inbox?folderid=inbox_kf',
        headers: {
          authorization: 'Bearer test-access-token',
          accept: 'application/json',
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        redirect: 'manual',
        credentials: 'omit',
        successStatuses: [200, 201],
        maxUploadBytes: body.byteLength,
        maxBytes: budget.maxMetadataBytes,
        maxErrorBodyBytes: budget.maxErrorBodyBytes
      })
      expect(Object.keys(request?.headers ?? {}).sort()).toEqual([
        'accept',
        'authorization',
        'content-type'
      ])
      expect(request?.bytes).toEqual(body)
      expect(harness.scopes).toEqual([['inbox']])
      expect(harness.requests).toHaveLength(0)
    })
  )

  it.effect('defaults the part type, encodes the folder Id, and accepts 200 with string Size', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ write: [binaryJson(uploadedFile(String(bytes.byteLength)))] })

      const result = yield* uploadFortnoxInboxFile(
        integration,
        { folderId: 'root&x=1', fileName: 'data.bin', bytes },
        budget
      ).pipe(Effect.provide(harness.layer))

      expect(result.Size).toBe(bytes.byteLength)
      expect(harness.writes[0]?.url).toBe('https://api.fortnox.se/3/inbox?folderid=root%26x%3D1')
      expect(harness.writes[0]?.bytes).toEqual(
        expectedBody('yolk-fortnox-inbox-00000000', 'data.bin', 'application/octet-stream', bytes)
      )
    })
  )

  it.effect('picks a boundary that occurs in neither the bytes nor the file name', () =>
    Effect.gen(function* () {
      const data = concat([
        ascii('x yolk-fortnox-inbox-00000000 '),
        ascii('yolk-fortnox-inbox-00000002'),
        ascii('yolk-fortnox-inbox-')
      ])

      const harness = makeHarness({ write: [binaryJson(uploadedFile(data.byteLength))] })

      yield* uploadFortnoxInboxFile(
        integration,
        { folderId: 'root', fileName: 'yolk-fortnox-inbox-00000001.txt', bytes: data },
        { ...budget, maxBytes: 1024 }
      ).pipe(Effect.provide(harness.layer))

      const boundary = 'yolk-fortnox-inbox-00000003'

      expect(harness.writes[0]?.headers['content-type']).toBe(
        `multipart/form-data; boundary=${boundary}`
      )
      expect(includes(data, ascii(boundary))).toBe(false)
      expect(harness.writes[0]?.bytes).toEqual(
        expectedBody(boundary, 'yolk-fortnox-inbox-00000001.txt', 'application/octet-stream', data)
      )
    })
  )

  it.effect('rejects invalid upload input before credentials or requests', () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const valid = { folderId: 'inbox_s', fileName: 'a.pdf', bytes }

      const cases: ReadonlyArray<readonly [FortnoxInboxUploadInput, string]> = [
        [{ ...valid, fileName: '' }, 'invalid_input'],
        [{ ...valid, fileName: '..' }, 'invalid_input'],
        [{ ...valid, fileName: 'a"b.pdf' }, 'invalid_input'],
        [{ ...valid, fileName: 'a\\b.pdf' }, 'invalid_input'],
        [{ ...valid, fileName: 'dir/a.pdf' }, 'invalid_input'],
        [{ ...valid, fileName: 'a\r\nX-Injected: 1' }, 'invalid_input'],
        [{ ...valid, fileName: ' a.pdf' }, 'invalid_input'],
        [{ ...valid, fileName: 'a'.repeat(256) }, 'invalid_input'],
        [{ ...valid, folderId: 'a/b' }, 'invalid_input'],
        [{ ...valid, folderId: '..' }, 'invalid_input'],
        [{ ...valid, folderId: '' }, 'invalid_input'],
        [{ ...valid, contentType: 'text/plain; charset=utf-8' }, 'invalid_input'],
        [{ ...valid, contentType: 'text/plain\r\nX: 1' }, 'invalid_input'],
        [{ ...valid, bytes: new Uint8Array(budget.maxBytes + 1) }, 'response_too_large']
      ]

      for (const [input, code] of cases) {
        const result = yield* uploadFortnoxInboxFile(integration, input, budget).pipe(
          Effect.provide(harness.layer),
          Effect.result
        )

        expect(result, JSON.stringify({ ...input, bytes: input.bytes.byteLength })).toMatchObject({
          failure: { code }
        })
      }

      const arrayBytes = yield* uploadFortnoxInboxFile(
        integration,
        // @ts-expect-error - untrusted host envelopes must fail runtime validation, not types
        { ...valid, bytes: [1, 2, 3] },
        budget
      ).pipe(Effect.provide(harness.layer), Effect.result)

      const nullInput = yield* uploadFortnoxInboxFile(
        integration,
        // @ts-expect-error - untrusted host envelopes must fail runtime validation, not types
        null,
        budget
      ).pipe(Effect.provide(harness.layer), Effect.result)

      expect(arrayBytes).toMatchObject({ failure: { code: 'invalid_input' } })
      expect(nullInput).toMatchObject({ failure: { code: 'invalid_input' } })
      expect(harness.sent()).toBe(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('rejects files above the single-request cap even when the budget allows them', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const result = yield* uploadFortnoxInboxFile(
        integration,
        {
          folderId: 'inbox_s',
          fileName: 'large.bin',
          bytes: new Uint8Array(fortnoxInboxUploadMaxBytes + 1)
        },
        { ...budget, maxBytes: fortnoxInboxUploadMaxBytes * 2 }
      ).pipe(Effect.provide(harness.layer), Effect.result)

      expect(result).toMatchObject({ failure: { code: 'upload_session_required' } })
      expect(harness.sent()).toBe(0)
      expect(harness.scopes).toHaveLength(0)
    })
  )

  it.effect('rejects a non-Fortnox integration and a bad budget before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const input = { folderId: 'inbox_s', fileName: 'a.pdf', bytes }

      const foreign = yield* uploadFortnoxInboxFile(
        makeIntegration({ connectorId: 'dropbox' }),
        input,
        budget
      ).pipe(Effect.provide(harness.layer), Effect.result)

      const badBudget = yield* uploadFortnoxInboxFile(integration, input, {
        ...budget,
        maxBytes: -1
      }).pipe(Effect.provide(harness.layer), Effect.result)

      expect(foreign).toMatchObject({ failure: { code: 'invalid_input' } })
      expect(badBudget).toMatchObject({ failure: { code: 'invalid_input' } })
      expect(harness.sent()).toBe(0)
    })
  )

  it.effect('fails invalid_metadata on a size mismatch or an undecodable answer', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        write: [binaryJson(uploadedFile(bytes.byteLength + 1)), binary(ascii('not json'))]
      })

      for (const label of ['size', 'json']) {
        const result = yield* uploadFortnoxInboxFile(
          integration,
          { folderId: 'inbox_s', fileName: 'a.pdf', bytes },
          budget
        ).pipe(Effect.provide(harness.layer), Effect.result)

        expect(result, label).toMatchObject({ failure: { code: 'invalid_metadata' } })
      }

      expect(harness.writes).toHaveLength(2)
    })
  )

  it.effect('maps upload rejections to code and status without retrying', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        write: [
          binaryJson({ ErrorInformation: { message: 'Bad request' } }, 400),
          binary(new Uint8Array(), 302, { location: 'https://example.test/' })
        ]
      })

      const rejected = yield* uploadFortnoxInboxFile(
        integration,
        { folderId: 'inbox_s', fileName: 'a.pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer), Effect.result)

      const redirected = yield* uploadFortnoxInboxFile(
        integration,
        { folderId: 'inbox_s', fileName: 'a.pdf', bytes },
        budget
      ).pipe(Effect.provide(harness.layer), Effect.result)

      expect(rejected).toMatchObject({ failure: { code: 'upstream_failed', status: 400 } })
      expect(redirected).toMatchObject({ failure: { code: 'unexpected_redirect', status: 302 } })
      expect(harness.writes).toHaveLength(2)
    })
  )
})
