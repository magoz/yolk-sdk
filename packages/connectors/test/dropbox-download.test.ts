import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate, Schema } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpError,
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential,
  type ConnectorBinaryHttpRequest,
  type ConnectorBinaryHttpResponse,
  type ConnectorIntegration
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import {
  downloadDropboxFile,
  DropboxCombinedOAuthCredentialSlot,
  DropboxConnector,
  dropboxActions,
  dropboxFilesContentReadScope,
  dropboxOAuthSlotId,
  DropboxSearchOutput,
  type DropboxDownloadBudget,
  type DropboxDownloadInput
} from '@yolk-sdk/connectors/dropbox'

const integration = makeIntegration({
  connectorId: 'dropbox',
  credentialBindings: [
    makeCredentialBinding({ slotId: dropboxOAuthSlotId, credentialRef: 'existing' })
  ]
})

const budget: DropboxDownloadBudget = { maxBytes: 32, maxErrorBodyBytes: 64 }

const original = new Uint8Array([0x50, 0x4b, 3, 4, 0xff, 0xfe, 0x80, 0, 0xc0])

const file = {
  '.tag': 'file',
  id: 'id:AbCdEf123',
  name: 'Källa – résumé.xlsx',
  path_lower: '/reports/källa – résumé.xlsx',
  path_display: '/Reports/Källa – résumé.xlsx',
  client_modified: '2025-01-01T00:00:00Z',
  server_modified: '2025-02-01T00:00:00Z',
  rev: '0123456789abc',
  size: original.byteLength,
  is_downloadable: true,
  content_hash: 'hash'
}

const response = (
  bytes = original,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
  bodyComplete = true
): ConnectorBinaryHttpResponse => ({ bytes, status, headers, bodyComplete })

const download = (metadata: unknown = file, bytes = original) =>
  response(bytes, 200, { 'Dropbox-API-Result': JSON.stringify(metadata) })

const conflict = (summary: string) =>
  response(new TextEncoder().encode(JSON.stringify({ error_summary: summary, s: 'SECRET' })), 409)

const host = (
  responses: ReadonlyArray<ConnectorBinaryHttpResponse | ConnectorBinaryHttpError>,
  credentialError?: ConnectorError
) => {
  const requests: Array<ConnectorBinaryHttpRequest> = []

  const slots: Array<{ readonly id: string; readonly scopes: ReadonlyArray<string> | undefined }> =
    []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        slots.push({ id: request.slot.id, scopes: request.slot.requiredScopes })

        return credentialError === undefined
          ? Effect.succeed(
              OAuthCredential.make({
                _tag: 'OAuthCredential',
                provider: 'dropbox',
                accessToken: 'FAKE-BEARER-SECRET',
                expiresAt: 4e12
              })
            )
          : Effect.fail(credentialError)
      }
    }),
    Layer.succeed(ConnectorBinaryHttpClient, {
      request: request => {
        const next = responses[requests.length]
        requests.push(request)

        if (next === undefined)
          return Effect.fail(new ConnectorBinaryHttpError({ code: 'transport_failed' }))

        return next instanceof ConnectorBinaryHttpError ? Effect.fail(next) : Effect.succeed(next)
      }
    })
  )

  const run = (
    input: DropboxDownloadInput = { path: file.id },
    limits = budget,
    configured: ConnectorIntegration = integration
  ) => downloadDropboxFile(configured, input, limits).pipe(Effect.provide(layer))

  return { layer, requests, slots, run }
}

describe('host-only Dropbox download', () => {
  it.effect(
    'uses search-result IDs and preserves original XLSX-like non-UTF8 bytes and selected metadata',
    () =>
      Effect.gen(function* () {
        const searchLayer = Layer.mergeAll(
          Layer.succeed(ConnectorHttpClient, {
            request: () =>
              Effect.succeed(
                ConnectorHttpResponse.make({
                  status: 200,
                  headers: {},
                  body: JSON.stringify({
                    matches: [{ metadata: { '.tag': 'metadata', metadata: file } }],
                    has_more: false
                  })
                })
              )
          }),
          host([]).layer
        )

        const search = yield* DropboxConnector.invoke({
          integration,
          action: 'dropbox.search',
          input: { query: 'source' }
        }).pipe(Effect.provide(searchLayer))

        expect(search._tag).toBe('Success')

        if (!Predicate.isTagged(search, 'Success')) return
        const found = yield* Schema.decodeUnknownEffect(DropboxSearchOutput)(search.value)
        const candidate = found.matches[0]?.metadata
        expect(candidate?.type).toBe('file')

        if (candidate === undefined || candidate.type !== 'file') return
        const h = host([download({ ...file, sharing_info: { secret: 'RAW-SECRET' } })])
        const result = yield* h.run({ path: candidate.id })
        expect(result.bytes).toBe(original)
        expect(result.byteLength).toBe(original.byteLength)
        expect(result.requested).toEqual({ path: file.id })
        expect(result.source).toEqual({
          id: file.id,
          name: file.name,
          pathLower: file.path_lower,
          pathDisplay: file.path_display,
          rev: file.rev,
          size: file.size,
          clientModified: file.client_modified,
          serverModified: file.server_modified,
          contentHash: file.content_hash
        })
        expect(JSON.stringify(result)).not.toMatch(/SECRET|sharing_info/)
        expect(h.requests).toHaveLength(1)
        expect(h.requests[0]).toMatchObject({
          method: 'GET',
          url: 'https://content.dropboxapi.com/2/files/download',
          redirect: 'manual',
          credentials: 'omit',
          maxBytes: 32,
          maxErrorBodyBytes: 64,
          headers: {
            authorization: 'Bearer FAKE-BEARER-SECRET',
            'dropbox-api-arg': '{"path":"id:AbCdEf123"}'
          }
        })
        expect(h.slots).toEqual([
          { id: dropboxOAuthSlotId, scopes: [dropboxFilesContentReadScope] }
        ])
      })
  )

  it.effect(
    'escapes non-ASCII path arguments into header-safe JSON without altering identity',
    () =>
      Effect.gen(function* () {
        const h = host([download()])
        yield* h.run({ path: '/Reports/Källa – résumé 😀.xlsx' })
        const arg = h.requests[0]?.headers['dropbox-api-arg']
        expect(arg).toBe(
          '{"path":"/Reports/K\\u00e4lla \\u2013 r\\u00e9sum\\u00e9 \\ud83d\\ude00.xlsx"}'
        )
        expect(arg).toMatch(/^[\u0020-\u007e]+$/)
        expect(JSON.parse(arg ?? '')).toEqual({ path: '/Reports/Källa – résumé 😀.xlsx' })
      })
  )

  it.effect('accepts path, rev and namespace addressing and verifies id/rev identity', () =>
    Effect.gen(function* () {
      for (const path of ['/Reports/a.txt', `rev:${file.rev}`, 'ns:123/a.txt', file.id]) {
        const h = host([download()])
        const result = yield* h.run({ path })
        expect(result.source.id).toBe(file.id)
      }

      const wrongId = host([download({ ...file, id: 'id:other' })])
      expect(yield* wrongId.run({ path: file.id }).pipe(Effect.flip)).toMatchObject({
        code: 'invalid_metadata'
      })
      const wrongRev = host([download({ ...file, rev: 'fedcba9876543' })])
      expect(yield* wrongRev.run({ path: `rev:${file.rev}` }).pipe(Effect.flip)).toMatchObject({
        code: 'invalid_metadata'
      })
    })
  )

  it.effect('downloads folder-ID-relative paths using the returned child identity', () =>
    Effect.gen(function* () {
      for (const path of ['id:folder/hello.txt', 'id:folder/Källa – résumé.xlsx']) {
        const h = host([download()])
        const result = yield* h.run({ path })
        expect(result.bytes).toBe(original)
        expect(result.source.id).toBe(file.id)
        expect(result.requested).toEqual({ path })
        expect(JSON.parse(h.requests[0]?.headers['dropbox-api-arg'] ?? '')).toEqual({ path })
      }
    })
  )

  it.effect('supports empty files and omits null paths without inventing them', () =>
    Effect.gen(function* () {
      const h = host([
        download(
          { ...file, size: 0, path_lower: null, path_display: null, content_hash: undefined },
          new Uint8Array()
        )
      ])

      const result = yield* h.run(undefined, { ...budget, maxBytes: 0 })
      expect(result).toMatchObject({ byteLength: 0, source: { size: 0 } })
      expect(result.source.pathLower).toBeUndefined()
      expect(result.source.pathDisplay).toBeUndefined()
      expect(result.source.contentHash).toBeUndefined()
    })
  )

  it.effect('never follows redirects and drops credentials from failures', () =>
    Effect.gen(function* () {
      for (const status of [301, 302, 303, 307, 308]) {
        const h = host([
          response(new Uint8Array(), status, {
            Location: 'https://content.dropboxapi.com/x?sig=SIGNED-SECRET'
          })
        ])

        const error = yield* h.run().pipe(Effect.flip)
        expect(error).toMatchObject({ code: 'unexpected_redirect' })
        expect(h.requests).toHaveLength(1)
        expect(JSON.stringify(error)).not.toContain('SECRET')
      }
    })
  )

  it.effect('classifies Dropbox 409 error summaries without exposing the body', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ['path/not_found/..', 'not_found'],
        ['path/not_file/...', 'not_a_file'],
        ['unsupported_file/...', 'not_downloadable'],
        ['path/restricted_content/...', 'forbidden'],
        ['path/malformed_path/...', 'invalid_input'],
        ['other/...', 'upstream_failed']
      ]

      for (const [summary, code] of cases) {
        const h = host([conflict(summary)])
        const error = yield* h.run().pipe(Effect.flip)
        expect(error).toMatchObject({ code })
        expect(JSON.stringify(error)).not.toMatch(/SECRET|error_summary/)
      }

      for (const body of [new Uint8Array([0xff, 0xfe]), new TextEncoder().encode('not json')]) {
        const h = host([response(body, 409)])
        expect(yield* h.run().pipe(Effect.flip)).toMatchObject({ code: 'upstream_failed' })
      }
    })
  )

  const statusCases: ReadonlyArray<readonly [number, string]> = [
    [400, 'upstream_failed'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [413, 'response_too_large'],
    [429, 'rate_limited'],
    [500, 'upstream_failed'],
    [206, 'partial_content']
  ]

  for (const [status, code] of statusCases) {
    it.effect(`sanitizes content HTTP ${status}`, () =>
      Effect.gen(function* () {
        const h = host([
          response(new TextEncoder().encode('RAW-SECRET sig=SIGNED-SECRET'), status, {}, false)
        ])

        const error = yield* h.run().pipe(Effect.flip)
        expect(error).toMatchObject({ code })
        expect(JSON.stringify(error)).not.toContain('SECRET')
      })
    )
  }

  it.effect('checks actual returned bytes, error-body bounds, and metadata size agreement', () =>
    Effect.gen(function* () {
      const oversized = host([download({ ...file, size: 33 }, new Uint8Array(33))])
      expect(yield* oversized.run().pipe(Effect.flip)).toMatchObject({
        code: 'response_too_large'
      })
      const errorBody = host([response(new Uint8Array(65), 403)])
      expect(yield* errorBody.run().pipe(Effect.flip)).toMatchObject({
        code: 'response_too_large'
      })
      const truncated = host([download({ ...file, size: 20 })])
      expect(yield* truncated.run().pipe(Effect.flip)).toMatchObject({ code: 'partial_content' })

      const incomplete = host([
        response(original, 200, { 'dropbox-api-result': JSON.stringify(file) }, false)
      ])

      expect(yield* incomplete.run().pipe(Effect.flip)).toMatchObject({ code: 'partial_content' })

      const ranged = host([
        response(original, 200, {
          'dropbox-api-result': JSON.stringify(file),
          'CoNtEnT-RaNgE': 'bytes 0-8/100'
        })
      ])

      expect(yield* ranged.run().pipe(Effect.flip)).toMatchObject({ code: 'partial_content' })
    })
  )

  it.effect('rejects missing, ambiguous, malformed, or non-file result metadata', () =>
    Effect.gen(function* () {
      const headerCases: ReadonlyArray<Readonly<Record<string, string>>> = [
        {},
        { 'Dropbox-API-Result': JSON.stringify(file), 'dropbox-api-result': JSON.stringify(file) },
        { 'dropbox-api-result': '{"secret":"SECRET"' },
        { 'dropbox-api-result': JSON.stringify({ '.tag': 'folder', id: 'id:x', name: 'x' }) },
        { 'dropbox-api-result': JSON.stringify({ ...file, id: '' }) },
        { 'dropbox-api-result': JSON.stringify({ ...file, size: -1 }) }
      ]

      for (const headers of headerCases) {
        const h = host([response(original, 200, headers)])
        const error = yield* h.run().pipe(Effect.flip)
        expect(error).toMatchObject({ code: 'invalid_metadata' })
        expect(JSON.stringify(error)).not.toContain('SECRET')
      }

      const notDownloadable = host([download({ ...file, is_downloadable: false })])
      expect(yield* notDownloadable.run().pipe(Effect.flip)).toMatchObject({
        code: 'not_downloadable'
      })
    })
  )

  it.effect(
    'rejects invalid paths, budgets, and foreign integrations before credentials or HTTP',
    () =>
      Effect.gen(function* () {
        for (const path of [
          '',
          '/',
          'relative/path.txt',
          'id:',
          'id:with space',
          'id:/child.txt',
          'id:folder/',
          'id:folder/file.txt\n',
          'rev:short',
          'rev:XYZ123456789',
          'ns:abc/x',
          'https://www.dropbox.com/s/share/file.txt',
          '/bad\r\nid',
          '/file.txt\n',
          'id:AbCdEf123\r',
          'rev:0123456789abc\n',
          'ns:123/file.txt\n',
          '/bad\u0000id',
          '/bad\u007fid'
        ]) {
          const h = host([])
          expect(yield* h.run({ path }).pipe(Effect.flip)).toMatchObject({ code: 'invalid_input' })
          expect(h.slots).toHaveLength(0)
          expect(h.requests).toHaveLength(0)
        }

        for (const limits of [
          { ...budget, maxBytes: -1 },
          { ...budget, maxErrorBodyBytes: 1.5 },
          { ...budget, maxBytes: Number.POSITIVE_INFINITY }
        ]) {
          const h = host([])
          expect(yield* h.run(undefined, limits).pipe(Effect.flip)).toMatchObject({
            code: 'invalid_input'
          })
          expect(h.requests).toHaveLength(0)
        }

        const foreign = host([])
        expect(
          yield* foreign
            .run(undefined, budget, makeIntegration({ connectorId: 'microsoft' }))
            .pipe(Effect.flip)
        ).toMatchObject({ code: 'invalid_input' })
        expect(foreign.slots).toHaveLength(0)
      })
  )

  it.effect('sanitizes credential errors and wrapped transport errors', () =>
    Effect.gen(function* () {
      const credential = host(
        [],
        new ConnectorError({
          cause: 'transport_failed',
          message: 'SECRET',
          underlying: { secret: 'SECRET' }
        })
      )

      const credentialFailure = yield* credential.run().pipe(Effect.flip)
      expect(credentialFailure).toMatchObject({ code: 'credential_failed' })
      expect(JSON.stringify(credentialFailure)).not.toContain('SECRET')

      const transportError = Object.assign(
        new ConnectorBinaryHttpError({ code: 'transport_failed' }),
        {
          underlying: {
            url: 'https://content.dropboxapi.com?sig=SECRET',
            headers: { authorization: 'SECRET' },
            body: 'SECRET'
          }
        }
      )

      const h = host([transportError])
      const failure = yield* h.run().pipe(Effect.flip)
      expect(failure).toMatchObject({ code: 'transport_failed' })
      expect(JSON.stringify(failure)).not.toContain('SECRET')

      for (const code of ['response_too_large', 'network_policy_rejected'] as const) {
        const refused = host([new ConnectorBinaryHttpError({ code })])
        expect(yield* refused.run().pipe(Effect.flip)).toMatchObject({ code })
      }

      const missing = host([])
      expect(
        yield* missing
          .run(undefined, budget, makeIntegration({ connectorId: 'dropbox' }))
          .pipe(Effect.flip)
      ).toMatchObject({ code: 'credential_failed' })
      expect(missing.requests).toHaveLength(0)
    })
  )

  it.effect('does not change default inventory, scopes, or generic tool serialization', () =>
    Effect.gen(function* () {
      expect(DropboxConnector.actions).toEqual(dropboxActions)
      expect(DropboxConnector.actions.map(a => a.id)).toEqual([
        'dropbox.list_folder',
        'dropbox.list_folder_continue',
        'dropbox.search',
        'dropbox.search_continue',
        'dropbox.get_metadata',
        'dropbox.create_folder',
        'dropbox.move',
        'dropbox.copy',
        'dropbox.delete'
      ])
      expect(DropboxCombinedOAuthCredentialSlot.requiredScopes).toEqual([
        'files.metadata.read',
        'files.content.read',
        'files.content.write'
      ])

      const layer = Layer.mergeAll(
        Layer.succeed(CredentialResolver, {
          resolve: () =>
            Effect.fail(new ConnectorError({ cause: 'credential_missing', message: 'offline' }))
        }),
        Layer.succeed(ConnectorHttpClient, {
          request: () =>
            Effect.succeed(ConnectorHttpResponse.make({ status: 200, headers: {}, body: '{}' }))
        })
      )

      const tools = yield* resolveTools(
        [makeConnectorToolModule(DropboxConnector, { integration, layer })],
        {}
      )

      expect(tools.tools.map(t => t.name)).toEqual(DropboxConnector.actions.map(a => a.id))
      expect(tools.tools.some(t => /download|content/.test(t.name))).toBe(false)
    })
  )
})
