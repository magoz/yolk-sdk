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
  downloadOneDriveItem,
  MicrosoftConnector,
  microsoftOAuthSlotId,
  oneDriveActions,
  OneDriveListItemsOutput,
  outlookMailActions,
  type OneDriveDownloadBudget,
  type OneDriveDownloadInput
} from '@yolk-sdk/connectors/microsoft'

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [
    makeCredentialBinding({ slotId: microsoftOAuthSlotId, credentialRef: 'existing' })
  ]
})

const budget: OneDriveDownloadBudget = {
  maxBytes: 32,
  maxMetadataBytes: 4096,
  maxErrorBodyBytes: 64
}

const original = new Uint8Array([0x50, 0x4b, 3, 4, 0xff, 0xfe, 0x80, 0, 0xc0])

const file = {
  id: 'item/id%2F',
  name: 'source.xlsx',
  size: original.byteLength,
  file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  parentReference: { driveId: 'drive/id' },
  webUrl: 'https://tenant.sharepoint.com/sites/site/source.xlsx',
  eTag: '"version-1"',
  cTag: '"content-1"',
  createdDateTime: '2025-01-01T00:00:00Z',
  lastModifiedDateTime: '2025-02-01T00:00:00Z'
}

const response = (
  bytes = original,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
  bodyComplete = true
): ConnectorBinaryHttpResponse => ({ bytes, status, headers, bodyComplete })

const metadata = (value: unknown = file) =>
  response(new TextEncoder().encode(JSON.stringify(value)))

const redirect = (location: string, status = 302) =>
  response(new Uint8Array(), status, { Location: location })

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
                provider: 'microsoft',
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
    input: OneDriveDownloadInput = { itemId: file.id },
    limits = budget,
    configured: ConnectorIntegration = integration
  ) => downloadOneDriveItem(configured, input, limits).pipe(Effect.provide(layer))

  return { layer, requests, slots, run }
}

describe('host-only OneDrive download', () => {
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
                  body: JSON.stringify({ value: [file] })
                })
              )
          }),
          host([]).layer
        )

        const search = yield* MicrosoftConnector.invoke({
          integration,
          action: 'onedrive.search_items',
          input: { query: 'source' }
        }).pipe(Effect.provide(searchLayer))

        expect(search._tag).toBe('Success')

        if (!Predicate.isTagged(search, 'Success')) return
        const found = yield* Schema.decodeUnknownEffect(OneDriveListItemsOutput)(search.value)
        const candidate = found.items[0]
        expect(candidate).toBeDefined()

        if (candidate === undefined) return

        const h = host([
          metadata({ ...file, '@microsoft.graph.downloadUrl': 'SIGNED-SECRET', raw: 'RAW-SECRET' }),
          response()
        ])

        const result = yield* h.run({
          itemId: candidate.id,
          driveId: candidate.parentReference?.driveId
        })

        expect(result.bytes).toBe(original)
        expect(result.byteLength).toBe(original.byteLength)
        expect(result.source).toEqual({
          itemId: file.id,
          driveId: file.parentReference.driveId,
          name: file.name,
          mimeType: file.file.mimeType,
          webUrl: file.webUrl,
          size: file.size,
          eTag: file.eTag,
          cTag: file.cTag,
          createdDateTime: file.createdDateTime,
          lastModifiedDateTime: file.lastModifiedDateTime
        })
        expect(JSON.stringify(result)).not.toMatch(/SECRET|downloadUrl|raw/)
        expect(h.requests[0]?.url).toContain('/drives/drive%2Fid/items/item%2Fid%252F?')
        expect(h.requests[1]?.url).toBe(
          'https://graph.microsoft.com/v1.0/drives/drive%2Fid/items/item%2Fid%252F/content'
        )
        expect(h.slots).toEqual([
          { id: microsoftOAuthSlotId, scopes: ['https://graph.microsoft.com/Files.Read'] }
        ])
      })
  )

  it.effect('supports /me and preserves unknown drive identity without inventing it', () =>
    Effect.gen(function* () {
      const h = host([
        metadata({ id: 'id', name: 'empty', size: 0, file: {} }),
        response(new Uint8Array())
      ])

      const result = yield* h.run({ itemId: 'id' }, { ...budget, maxBytes: 0 })
      expect(h.requests[0]?.url).toContain('/me/drive/items/id?')
      expect(h.requests[1]?.url).toContain('/me/drive/items/id/content')
      expect(result).toMatchObject({ byteLength: 0, source: { name: 'empty' } })
      expect(result.source.driveId).toBeUndefined()
    })
  )

  it.effect('resolves remoteItem into explicit SharePoint drive IDs before downloading', () =>
    Effect.gen(function* () {
      const h = host([
        metadata({
          id: 'shortcut',
          name: 'shortcut',
          remoteItem: { id: file.id, parentReference: file.parentReference }
        }),
        metadata(),
        response()
      ])

      const result = yield* h.run({ itemId: 'shortcut' })
      expect(h.requests[1]?.url).toContain('/drives/drive%2Fid/items/item%2Fid%252F?')
      expect(result.requested).toEqual({ itemId: 'shortcut' })
      expect(result.source.itemId).toBe(file.id)
    })
  )

  it.effect('rejects remote loops and incomplete targets', () =>
    Effect.gen(function* () {
      const loop = host([
        metadata({
          id: 'id',
          name: 'loop',
          remoteItem: { id: 'id', parentReference: { driveId: 'drive' } }
        })
      ])

      expect(yield* loop.run({ itemId: 'id', driveId: 'drive' }).pipe(Effect.flip)).toMatchObject({
        code: 'remote_item_limit'
      })
      expect(loop.requests).toHaveLength(1)

      const incomplete = host([
        metadata({ id: file.id, name: 'remote', remoteItem: { id: 'target' } })
      ])

      expect(yield* incomplete.run().pipe(Effect.flip)).toMatchObject({
        code: 'remote_item_unresolved'
      })

      const chain = host(
        Array.from({ length: 5 }, (_, i) =>
          metadata({
            id: `id${i}`,
            name: 'remote',
            remoteItem: { id: `id${i + 1}`, parentReference: { driveId: 'drive' } }
          })
        )
      )

      expect(yield* chain.run({ itemId: 'id0', driveId: 'drive' }).pipe(Effect.flip)).toMatchObject(
        { code: 'remote_item_limit' }
      )
      expect(chain.requests).toHaveLength(5)
    })
  )

  for (const mode of ['delegated_all', 'application']) {
    it.effect(`reuses read-all slot for ${mode} without new bindings`, () =>
      Effect.gen(function* () {
        const h = host([metadata(), response()])
        yield* h.run(
          { itemId: file.id, driveId: file.parentReference.driveId },
          budget,
          makeIntegration({ ...integration, config: { oneDriveAccessMode: mode } })
        )
        expect(h.slots).toEqual([
          { id: microsoftOAuthSlotId, scopes: ['https://graph.microsoft.com/Files.Read.All'] }
        ])
      })
    )
  }

  it.effect('guards application /me and invalid config before credentials or HTTP', () =>
    Effect.gen(function* () {
      for (const mode of ['application', 'bad']) {
        const h = host([])
        expect(
          yield* h
            .run(
              undefined,
              budget,
              makeIntegration({ ...integration, config: { oneDriveAccessMode: mode } })
            )
            .pipe(Effect.flip)
        ).toMatchObject({ code: 'invalid_input' })
        expect(h.slots).toHaveLength(0)
        expect(h.requests).toHaveLength(0)
      }
    })
  )

  it.effect(
    'drops all original headers on redirect chains, even back to Graph; handles casing',
    () =>
      Effect.gen(function* () {
        const h = host([
          metadata(),
          response(new Uint8Array(), 302, {
            lOcAtIoN: 'https://tenant.sharepoint.com/download?sig=SIGNED-SECRET'
          }),
          redirect('https://graph.microsoft.com/v1.0/signed?sig=SIGNED-SECRET'),
          response()
        ])

        const result = yield* h.run()
        expect(
          h.requests.slice(0, 2).every(r => r.headers.authorization === 'Bearer FAKE-BEARER-SECRET')
        ).toBe(true)
        expect(h.requests.slice(2).map(r => r.headers)).toEqual([{}, {}])
        expect(h.requests.every(r => r.redirect === 'manual' && r.credentials === 'omit')).toBe(
          true
        )
        expect(JSON.stringify(result)).not.toContain('SECRET')
      })
  )

  for (const destination of [
    'http://tenant.sharepoint.com/x',
    'https://user:secret@tenant.sharepoint.com/x',
    'https://@tenant.sharepoint.com/x',
    'https://tenant.sharepoint.com:444/x',
    'https://tenant.sharepoint.com:bad/x',
    'https://tenant.sharepoint.com:/x',
    'https:///tenant.sharepoint.com/x',
    'https://tenant.sharepoint.com/x%ZZ',
    'https://tenant.sharepoint.com/x?sig=%',
    'https://tenant.sharepoint.com/x#fragment',
    'https://tenant.sharepoint.com/x#',
    'https://localhost/x',
    'https://sub.localhost/x',
    'https://host.local/x',
    'https://127.0.0.1/x',
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://10.0.0.1/x',
    'https://169.254.169.254/x',
    'https://[::1]/x',
    'https://[2606:4700::1111]/x',
    'https://192.168.1.1/x',
    'https://intranet/x',
    'https://host.internal/x',
    '/relative',
    '//tenant.sharepoint.com/x',
    'not a url',
    ' https://tenant.sharepoint.com/x',
    'https://tenant.sharepoint.com\\@localhost/x'
  ]) {
    it.effect(`rejects unsafe or malformed redirect syntax: ${destination}`, () =>
      Effect.gen(function* () {
        const h = host([metadata(), redirect(destination)])
        const error = yield* h.run().pipe(Effect.flip)
        expect(error).toMatchObject({ code: 'invalid_redirect' })
        expect(h.requests).toHaveLength(2)
        expect(JSON.stringify(error)).not.toContain(destination)
      })
    )
  }

  it.effect(
    'rejects missing/ambiguous Location, metadata redirects, and bounded redirect overflow',
    () =>
      Effect.gen(function* () {
        const headerCases: ReadonlyArray<Readonly<Record<string, string>>> = [
          {},
          { Location: 'https://a.sharepoint.com/x', location: 'https://b.sharepoint.com/x' }
        ]

        for (const headers of headerCases) {
          const h = host([metadata(), response(new Uint8Array(), 302, headers)])
          expect(yield* h.run().pipe(Effect.flip)).toMatchObject({ code: 'invalid_redirect' })
        }

        const meta = host([redirect('https://tenant.sharepoint.com/x')])
        expect(yield* meta.run().pipe(Effect.flip)).toMatchObject({ code: 'upstream_failed' })
        expect(meta.requests).toHaveLength(1)

        const h = host([
          metadata(),
          ...Array.from({ length: 6 }, () => redirect('https://tenant.sharepoint.com/x'))
        ])

        expect(yield* h.run().pipe(Effect.flip)).toMatchObject({ code: 'redirect_limit' })
        expect(h.requests).toHaveLength(7)
      })
  )

  it.effect(
    'propagates distinct host budgets and checks actual returned bytes, not metadata sizes',
    () =>
      Effect.gen(function* () {
        const h = host([metadata({ ...file, size: 0 }), response(new Uint8Array(33))])
        expect(yield* h.run().pipe(Effect.flip)).toMatchObject({ code: 'response_too_large' })
        expect(h.requests.map(r => [r.maxBytes, r.maxErrorBodyBytes])).toEqual([
          [4096, 64],
          [32, 64]
        ])
        const oversizedMetadata = host([response(new Uint8Array(4097))])
        expect(yield* oversizedMetadata.run().pipe(Effect.flip)).toMatchObject({
          code: 'response_too_large'
        })
        const hint = host([metadata({ ...file, size: 33 })])
        expect(yield* hint.run().pipe(Effect.flip)).toMatchObject({ code: 'response_too_large' })
        expect(hint.requests).toHaveLength(1)
        const errorBody = host([response(new Uint8Array(65), 403)])
        expect(yield* errorBody.run().pipe(Effect.flip)).toMatchObject({
          code: 'response_too_large'
        })
      })
  )

  const statusCases: ReadonlyArray<readonly [number, string]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [206, 'partial_content']
  ]

  for (const [status, code] of statusCases) {
    it.effect(`sanitizes metadata and content HTTP ${status}`, () =>
      Effect.gen(function* () {
        for (const prefix of [[], [metadata()]]) {
          const h = host([
            ...prefix,
            response(new TextEncoder().encode('RAW-SECRET sig=SIGNED-SECRET'), status, {}, false)
          ])

          const error = yield* h.run().pipe(Effect.flip)
          expect(error).toMatchObject({ code })
          expect(JSON.stringify(error)).not.toContain('SECRET')
        }
      })
    )
  }

  it.effect('sanitizes credential errors, malformed metadata, and wrapped transport errors', () =>
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

      for (const prefix of [[], [metadata()]]) {
        const transportError = Object.assign(
          new ConnectorBinaryHttpError({ code: 'transport_failed' }),
          {
            underlying: {
              url: 'https://tenant.sharepoint.com?sig=SECRET',
              headers: { authorization: 'SECRET' },
              body: 'SECRET'
            }
          }
        )

        const h = host([...prefix, transportError])
        const failure = yield* h.run().pipe(Effect.flip)
        expect(failure).toMatchObject({ code: 'transport_failed' })
        expect(JSON.stringify(failure)).not.toContain('SECRET')
      }

      const malformed = host([response(new TextEncoder().encode('{"secret":"SECRET"}'))])
      const failure = yield* malformed.run().pipe(Effect.flip)
      expect(failure).toMatchObject({ code: 'invalid_metadata' })
      expect(JSON.stringify(failure)).not.toContain('SECRET')
    })
  )

  it.effect('rejects folders/non-files, incomplete 200, invalid IDs, and invalid budgets', () =>
    Effect.gen(function* () {
      for (const item of [
        { id: file.id, name: 'folder', folder: {} },
        { id: file.id, name: 'package' },
        { ...file, folder: {} }
      ]) {
        const h = host([metadata(item)])
        expect(yield* h.run().pipe(Effect.flip)).toMatchObject({ code: 'not_a_file' })
        expect(h.requests).toHaveLength(1)
      }

      const partial = host([metadata(), response(original, 200, {}, false)])
      expect(yield* partial.run().pipe(Effect.flip)).toMatchObject({ code: 'partial_content' })

      for (const id of ['', '.', '..', '...', 'bad\r\nid', '\ud800']) {
        const h = host([])
        expect(yield* h.run({ itemId: id }).pipe(Effect.flip)).toMatchObject({
          code: 'invalid_input'
        })
        expect(h.requests).toHaveLength(0)
      }

      const invalid = host([])
      expect(
        yield* invalid.run(undefined, { ...budget, maxBytes: -1 }).pipe(Effect.flip)
      ).toMatchObject({ code: 'invalid_input' })
    })
  )

  it.effect('keeps host budget/network refusal codes safe and rejects missing credentials', () =>
    Effect.gen(function* () {
      for (const code of ['response_too_large', 'network_policy_rejected'] as const) {
        const h = host([metadata(), new ConnectorBinaryHttpError({ code })])
        expect(yield* h.run().pipe(Effect.flip)).toMatchObject({ code })
      }

      const missing = host([])
      expect(
        yield* missing
          .run(undefined, budget, makeIntegration({ connectorId: 'microsoft' }))
          .pipe(Effect.flip)
      ).toMatchObject({ code: 'credential_failed' })
      expect(missing.requests).toHaveLength(0)
    })
  )

  it.effect('rejects partial headers and malformed metadata without exposing bytes', () =>
    Effect.gen(function* () {
      const partial = host([
        metadata(),
        response(original, 200, { 'CoNtEnT-RaNgE': 'bytes 0-8/100' })
      ])

      expect(yield* partial.run().pipe(Effect.flip)).toMatchObject({ code: 'partial_content' })

      for (const invalid of [original, new TextEncoder().encode('{"secret":"SECRET"')]) {
        const h = host([response(invalid)])
        const error = yield* h.run().pipe(Effect.flip)
        expect(error).toMatchObject({ code: 'invalid_metadata' })
        expect(JSON.stringify(error)).not.toContain('SECRET')
      }
    })
  )

  it.effect('rejects dot-only drive IDs but preserves already-percent-encoded opaque IDs', () =>
    Effect.gen(function* () {
      const invalid = host([])
      expect(yield* invalid.run({ itemId: 'id', driveId: '..' }).pipe(Effect.flip)).toMatchObject({
        code: 'invalid_input'
      })
      expect(invalid.requests).toHaveLength(0)
      const h = host([metadata({ id: '%2e%2e', name: 'opaque', file: {} }), response()])
      yield* h.run({ itemId: '%2e%2e', driveId: '%2e' })
      expect(h.requests[1]?.url).toContain('/drives/%252e/items/%252e%252e/content')
    })
  )

  it.effect('allows exactly five redirect hops without restoring credentials', () =>
    Effect.gen(function* () {
      const h = host([
        metadata(),
        ...[301, 302, 303, 307, 308].map(status =>
          redirect('https://tenant.sharepoint.com:443/bytes?sig=fake', status)
        ),
        response()
      ])

      expect((yield* h.run()).bytes).toBe(original)
      expect(h.requests).toHaveLength(7)
      expect(h.requests.slice(2).every(request => Object.keys(request.headers).length === 0)).toBe(
        true
      )
    })
  )

  it.effect('does not change default inventory or generic tool dependencies/serialization', () =>
    Effect.gen(function* () {
      expect(MicrosoftConnector.actions).toEqual([...outlookMailActions, ...oneDriveActions])
      expect(
        MicrosoftConnector.actions.filter(a => a.id.startsWith('onedrive.')).map(a => a.id)
      ).toEqual([
        'onedrive.list_items',
        'onedrive.search_items',
        'onedrive.get_item',
        'onedrive.create_folder',
        'onedrive.delete_item'
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
        [makeConnectorToolModule(MicrosoftConnector, { integration, layer })],
        {}
      )

      expect(tools.tools.map(t => t.name)).toEqual(MicrosoftConnector.actions.map(a => a.id))
      expect(tools.tools.some(t => /download|content/.test(t.name))).toBe(false)
    })
  )
})
