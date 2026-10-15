import { Effect, Option, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, contentText, type ToolResult } from '@yolk-sdk/agent/protocol'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  deleteScopeFiles,
  fileIdFor,
  FileUploadTransportError,
  makeFileToolModule,
  makeObjectStorageFileStore,
  ObjectStorageError,
  type FileUploadTransportApi,
  type ObjectStorageApi,
  type ObjectStorageHead
} from '../src/index.ts'

type StoredObject = ObjectStorageHead & { readonly bytes: Uint8Array }

type MemoryStorage = ObjectStorageApi & {
  readonly objects: Map<string, StoredObject>
  readonly puts: Array<string>
}

const memoryStorage = (): MemoryStorage => {
  const objects = new Map<string, StoredObject>()
  const puts: Array<string> = []

  return {
    objects,
    puts,
    put: ({ key, bytes, contentType, metadata }) =>
      Effect.sync(() => {
        puts.push(key)
        objects.set(key, { bytes, size: bytes.byteLength, contentType, metadata })
      }),
    head: key => Effect.succeed(Option.fromNullishOr(objects.get(key))),
    get: ({ key }) =>
      Option.match(Option.fromNullishOr(objects.get(key)), {
        onNone: () => Effect.fail(new ObjectStorageError({ reason: 'not_found', message: key })),
        onSome: object => Effect.succeed(object.bytes)
      }),
    signGet: ({ key, ttlSeconds, filename }) =>
      Effect.succeed(`https://r2.example/${key}?ttl=${ttlSeconds}&name=${filename}`),
    deletePrefix: prefix =>
      Effect.sync(() => {
        for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key)
      })
  }
}

type Sent = { url: string; headers: ReadonlyArray<readonly [string, string]>; size: number }

const recordingTransport = (
  answer: Effect.Effect<
    { readonly status: number; readonly etag?: string },
    FileUploadTransportError
  >
) => {
  const sent: Array<Sent> = []

  const transport: FileUploadTransportApi = {
    put: ({ url, headers, body }) =>
      Effect.sync(() => sent.push({ url: url.href, headers, size: body.byteLength })).pipe(
        Effect.andThen(answer)
      )
  }

  return { transport, sent }
}

const pdf = new TextEncoder().encode('%PDF-1.7 invoice 225')

const resultText = (result: ToolResult) =>
  Predicate.isString(result.content) ? result.content : contentText(result.content)

describe('object storage file store', () => {
  it.effect('stores once per scope and content, under the scope key', () =>
    Effect.gen(function* () {
      const storage = memoryStorage()
      const store = makeObjectStorageFileStore({ storage, scope: 'ws_1/session_1' })

      const first = yield* store.put({
        bytes: pdf,
        name: 'Faktura 225.pdf',
        mimeType: 'application/pdf'
      })

      const again = yield* store.put({ bytes: pdf, name: 'copy.pdf', mimeType: 'application/pdf' })

      expect(first.fileId).toMatch(/^file_[a-z2-7]{26}$/u)
      expect(again.fileId).toBe(first.fileId)
      expect(again.name).toBe('copy.pdf')
      expect(storage.puts).toEqual([`files/ws_1/session_1/${first.fileId}`])

      const head = yield* store.head(first.fileId)

      expect(Option.getOrUndefined(head)).toMatchObject({
        fileId: first.fileId,
        name: 'Faktura 225.pdf',
        mimeType: 'application/pdf',
        size: pdf.byteLength
      })
    })
  )

  it.effect('derives different ids for the same bytes in different scopes', () =>
    Effect.gen(function* () {
      const storage = memoryStorage()
      const one = makeObjectStorageFileStore({ storage, scope: 'ws_1/session_1' })
      const two = makeObjectStorageFileStore({ storage, scope: 'ws_1/session_2' })

      const a = yield* one.put({ bytes: pdf, name: 'a.pdf', mimeType: 'application/pdf' })
      const b = yield* two.put({ bytes: pdf, name: 'a.pdf', mimeType: 'application/pdf' })

      expect(a.fileId).not.toBe(b.fileId)
      expect(Option.isNone(yield* two.head(a.fileId))).toBe(true)

      const foreign = yield* two.read({ fileId: a.fileId, maxBytes: 1_000 }).pipe(Effect.flip)

      expect(foreign.reason).toBe('not_found')
    })
  )

  it.effect('derives a stable id from scope and content hash', () =>
    Effect.gen(function* () {
      const a = yield* fileIdFor({ scope: 's', sha256Hex: 'ab' })
      const b = yield* fileIdFor({ scope: 's', sha256Hex: 'ab' })
      const c = yield* fileIdFor({ scope: 't', sha256Hex: 'ab' })

      expect(a).toBe(b)
      expect(a).not.toBe(c)
    })
  )

  it.effect('bounds reads and signs links that download under the stored name', () =>
    Effect.gen(function* () {
      const storage = memoryStorage()
      const store = makeObjectStorageFileStore({ storage, scope: 'ws_1/session_1' })
      const file = yield* store.put({ bytes: pdf, name: 'a.pdf', mimeType: 'application/pdf' })

      const tooLarge = yield* store.read({ fileId: file.fileId, maxBytes: 4 }).pipe(Effect.flip)
      const bytes = yield* store.read({ fileId: file.fileId, maxBytes: 1_000 })
      const url = yield* store.signRead({ fileId: file.fileId, ttlSeconds: 60 })

      expect(tooLarge.reason).toBe('too_large')
      expect(bytes).toEqual(pdf)
      expect(url).toBe(`https://r2.example/files/ws_1/session_1/${file.fileId}?ttl=60&name=a.pdf`)
    })
  )

  it.effect('rejects unsafe scopes and deletes a scope prefix', () =>
    Effect.gen(function* () {
      const storage = memoryStorage()

      expect(() => makeObjectStorageFileStore({ storage, scope: 'ws_1/../other' })).toThrow()
      expect(() => makeObjectStorageFileStore({ storage, scope: '' })).toThrow()

      const store = makeObjectStorageFileStore({ storage, scope: 'ws_1/session_1' })

      yield* store.put({ bytes: pdf, name: 'a.pdf', mimeType: 'application/pdf' })
      yield* deleteScopeFiles({ storage, scope: 'ws_1/session_1' })

      expect(storage.objects.size).toBe(0)
    })
  )
})

const setup = (transport?: FileUploadTransportApi) =>
  Effect.gen(function* () {
    const storage = memoryStorage()
    const store = makeObjectStorageFileStore({ storage, scope: 'ws_1/session_1' })
    const file = yield* store.put({ bytes: pdf, name: 'a.pdf', mimeType: 'application/pdf' })

    const toolSet = yield* resolveTools(
      [
        transport === undefined
          ? makeFileToolModule<Record<never, never>>({ store })
          : makeFileToolModule<Record<never, never>>({ store, transport })
      ],
      {}
    )

    const call = (name: string, params: unknown) =>
      toolSet.execute(ToolCall.make({ id: 'call_1', name, params }))

    return { file, call, toolSet }
  })

describe('file tools', () => {
  it.effect('uploads the stored bytes with the given headers and reports the status', () =>
    Effect.gen(function* () {
      const { transport, sent } = recordingTransport(Effect.succeed({ status: 200, etag: '"e1"' }))
      const { file, call } = yield* setup(transport)

      const result = yield* call('file_upload', {
        fileId: file.fileId,
        url: 'https://bucket.r2.example/receipt?X-Amz-Signature=secret',
        headers: { 'content-type': 'application/pdf' }
      })

      expect(result.isError).toBeUndefined()
      expect(sent).toEqual([
        {
          url: 'https://bucket.r2.example/receipt?X-Amz-Signature=secret',
          headers: [['content-type', 'application/pdf']],
          size: pdf.byteLength
        }
      ])
      expect(result.structuredContent).toEqual({ status: 200, size: pdf.byteLength, etag: '"e1"' })
      expect(resultText(result)).not.toContain('secret')
    })
  )

  it.effect('refuses non-https URLs, credentials and forbidden headers before sending', () =>
    Effect.gen(function* () {
      const { transport, sent } = recordingTransport(Effect.succeed({ status: 200 }))
      const { file, call } = yield* setup(transport)

      const http = yield* call('file_upload', { fileId: file.fileId, url: 'http://x.example/u' })

      const credentials = yield* call('file_upload', {
        fileId: file.fileId,
        url: 'https://user:pw@x.example/u'
      })

      const header = yield* call('file_upload', {
        fileId: file.fileId,
        url: 'https://x.example/u',
        headers: { Cookie: 'a=b' }
      })

      expect([http, credentials, header].map(result => result.isError)).toEqual([true, true, true])
      expect(sent).toEqual([])
    })
  )

  it.effect('reports rejected and unknown uploads without the URL', () =>
    Effect.gen(function* () {
      const rejected = recordingTransport(Effect.succeed({ status: 403 }))

      const unknown = recordingTransport(
        Effect.fail(new FileUploadTransportError({ reason: 'network', message: 'reset' }))
      )

      const first = yield* setup(rejected.transport)
      const second = yield* setup(unknown.transport)
      const url = 'https://bucket.r2.example/receipt?X-Amz-Signature=secret'

      const denied = yield* first.call('file_upload', { fileId: first.file.fileId, url })
      const lost = yield* second.call('file_upload', { fileId: second.file.fileId, url })

      expect(denied.isError).toBe(true)
      expect(resultText(denied)).toContain('rejected the upload with HTTP 403')
      expect(lost.isError).toBe(true)
      expect(resultText(lost)).toContain('the outcome is unknown')
      expect(resultText(denied) + resultText(lost)).not.toContain('secret')
    })
  )

  it.effect('reports missing files as not found', () =>
    Effect.gen(function* () {
      const { transport } = recordingTransport(Effect.succeed({ status: 200 }))
      const { call } = yield* setup(transport)

      const result = yield* call('file_upload', {
        fileId: 'file_missing',
        url: 'https://x.example/u'
      })

      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('No file file_missing')
    })
  )

  it.effect('signs a download link with the requested lifetime', () =>
    Effect.gen(function* () {
      const { file, call } = yield* setup()

      const result = yield* call('file_url', { fileId: file.fileId, ttlMinutes: 15 })

      expect(result.structuredContent).toEqual({
        url: `https://r2.example/files/ws_1/session_1/${file.fileId}?ttl=900&name=a.pdf`,
        expiresAt: new Date(900_000).toISOString()
      })
    })
  )

  it.effect('leaves file_upload out without a transport', () =>
    Effect.gen(function* () {
      const { toolSet } = yield* setup()

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['file_url'])
    })
  )
})
