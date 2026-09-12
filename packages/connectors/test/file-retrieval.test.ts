import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Predicate } from 'effect'
import {
  ConnectorBinaryHttpClient,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorBinaryHttpRequest, ConnectorBinaryHttpResponse } from '@yolk-sdk/connectors'
import { downloadGoogleDriveFile, exportGoogleDriveFile } from '@yolk-sdk/connectors/google'
import {
  downloadFortnoxArchiveFile,
  downloadFortnoxInvoicePreview
} from '@yolk-sdk/connectors/fortnox'
import { downloadNotionFile } from '@yolk-sdk/connectors/notion'

const budget = { maxBytes: 16, maxMetadataBytes: 2000, maxErrorBodyBytes: 32 }

const bytes = new Uint8Array([0, 128, 255])

const integration = (connectorId: string) =>
  makeIntegration({
    connectorId,
    credentialBindings: [
      makeCredentialBinding({ slotId: `${connectorId}.oauth`, credentialRef: 'ref' })
    ]
  })

const response = (body = bytes, status = 200, headers = {}): ConnectorBinaryHttpResponse => ({
  bytes: body,
  status,
  headers,
  bodyComplete: true
})

const json = (value: unknown) => response(new TextEncoder().encode(JSON.stringify(value)))

const host = (responses: readonly ConnectorBinaryHttpResponse[]) => {
  const requests: ConnectorBinaryHttpRequest[] = []
  const scopes: (readonly string[] | undefined)[] = []

  return {
    requests,
    scopes,
    layer: Layer.mergeAll(
      Layer.succeed(CredentialResolver, {
        resolve: req => {
          scopes.push(req.slot.requiredScopes)

          return Effect.succeed(
            OAuthCredential.make({
              _tag: 'OAuthCredential',
              provider: req.integration.connectorId,
              accessToken: 'secret',
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

const driveMetadata = {
  id: 'file',
  name: 'x',
  mimeType: 'application/octet-stream',
  size: '3',
  capabilities: { canDownload: true }
}

describe('bounded document retrieval', () => {
  it.effect('Drive blob uses content consent, resource keys and shared-drive support', () =>
    Effect.gen(function* () {
      const h = host([
        json({
          ...driveMetadata,
          downloadRestrictions: {
            effectiveDownloadRestrictionWithContext: { restrictedForReaders: true }
          }
        }),
        response()
      ])

      const result = yield* downloadGoogleDriveFile(
        integration('google'),
        { fileId: 'file', resourceKey: 'key' },
        budget
      ).pipe(Effect.provide(h.layer))

      expect(result.bytes).toEqual(bytes)
      expect(h.requests[1]).toMatchObject({
        url: 'https://www.googleapis.com/drive/v3/files/file?alt=media&supportsAllDrives=true',
        headers: { authorization: 'Bearer secret', 'X-Goog-Drive-Resource-Keys': 'file/key' },
        redirect: 'manual',
        credentials: 'omit'
      })
      expect(h.scopes).toEqual([['https://www.googleapis.com/auth/drive.file']])
    })
  )
  it.effect('Drive exports compatible native docs with host broad consent and provider cap', () =>
    Effect.gen(function* () {
      const h = host([
        json({ ...driveMetadata, mimeType: 'application/vnd.google-apps.document' }),
        response()
      ])

      const result = yield* exportGoogleDriveFile(
        integration('google'),
        { fileId: 'file', mimeType: 'application/pdf' },
        { ...budget, maxBytes: 20_000_000, contentAccess: 'readonly' }
      ).pipe(Effect.provide(h.layer))

      expect(result.source.exported).toBe(true)
      expect(h.requests[1]?.url).toContain('/export?mimeType=application%2Fpdf')
      expect(h.requests[1]?.maxBytes).toBe(10_000_000)
      expect(h.scopes).toEqual([['https://www.googleapis.com/auth/drive.readonly']])
    })
  )
  it.effect(
    'Drive denies restricted/native/shortcut blobs and incompatible exports before byte request',
    () =>
      Effect.gen(function* () {
        for (const metadata of [
          { ...driveMetadata, capabilities: { canDownload: false } },
          { ...driveMetadata, mimeType: 'application/vnd.google-apps.folder' },
          { ...driveMetadata, mimeType: 'application/vnd.google-apps.shortcut' },
          { ...driveMetadata, id: 'other' }
        ]) {
          const h = host([json(metadata)])
          expect(
            (yield* downloadGoogleDriveFile(integration('google'), { fileId: 'file' }, budget).pipe(
              Effect.provide(h.layer),
              Effect.result
            ))._tag
          ).toBe('Failure')
          expect(h.requests).toHaveLength(1)
        }

        const h = host([json(driveMetadata)])
        expect(
          (yield* exportGoogleDriveFile(
            integration('google'),
            { fileId: 'file', mimeType: 'application/pdf' },
            budget
          ).pipe(Effect.provide(h.layer), Effect.result))._tag
        ).toBe('Failure')
        expect(h.requests).toHaveLength(1)
      })
  )
  it.effect('Drive rejects inherited object keys as unsupported export MIME types', () =>
    Effect.gen(function* () {
      for (const mimeType of ['constructor', 'toString', '__proto__']) {
        const h = host([json({ ...driveMetadata, mimeType })])

        const result = yield* exportGoogleDriveFile(
          integration('google'),
          { fileId: 'file', mimeType: 'application/pdf' },
          budget
        ).pipe(Effect.provide(h.layer), Effect.result)

        expect(result._tag).toBe('Failure')

        if (Predicate.isTagged(result, 'Failure'))
          expect(result.failure.code).toBe('not_downloadable')
        expect(h.requests).toHaveLength(1)
      }
    })
  )
  it.effect('Drive checks byte length and redirects without leaking bearer credentials', () =>
    Effect.gen(function* () {
      for (const r of [
        response(new Uint8Array()),
        response(bytes, 302, { location: 'https://evil.example/SECRET' }),
        { ...response(), bodyComplete: false },
        response(new Uint8Array(17))
      ]) {
        const h = host([json(driveMetadata), r])

        const result = yield* downloadGoogleDriveFile(
          integration('google'),
          { fileId: 'file' },
          budget
        ).pipe(Effect.provide(h.layer), Effect.result)

        expect(result._tag).toBe('Failure')
        expect(JSON.stringify(result)).not.toContain('SECRET')
        expect(h.requests).toHaveLength(2)
      }
    })
  )
  it.effect('Fortnox preview is generated PDF, archive is bytes, each with resource consent', () =>
    Effect.gen(function* () {
      const h = host([response(bytes, 200, { 'content-type': 'application/pdf' }), response()])
      expect(
        (yield* downloadFortnoxInvoicePreview(
          integration('fortnox'),
          { documentNumber: '12' },
          budget
        ).pipe(Effect.provide(h.layer))).source.generatedPreview
      ).toBe(true)
      expect(
        (yield* downloadFortnoxArchiveFile(
          integration('fortnox'),
          { fileId: 'archive-id' },
          budget
        ).pipe(Effect.provide(h.layer))).bytes
      ).toEqual(bytes)
      expect(h.requests.map(r => r.url)).toEqual([
        'https://api.fortnox.se/3/invoices/12/preview',
        'https://api.fortnox.se/3/archive/archive-id'
      ])
      expect(h.scopes).toEqual([['invoice'], ['archive']])
    })
  )
  it.effect('Notion file objects fetch without credentials and require external opt-in', () =>
    Effect.gen(function* () {
      const h = host([response()])
      const policy = { allowHostedUrl: (u: URL) => u.hostname === 'assets.example.com' }

      const file = {
        type: 'file' as const,
        file: { url: 'https://assets.example.com/x?signed=SECRET' }
      }

      const result = yield* downloadNotionFile(integration('notion'), file, budget, policy).pipe(
        Effect.provide(h.layer)
      )

      expect(result).toEqual({ bytes, byteLength: 3 })
      expect(h.requests[0]?.headers).toEqual({})
      expect(h.scopes).toHaveLength(0)
      expect(
        (yield* downloadNotionFile(
          integration('notion'),
          { type: 'external', external: { url: 'https://assets.example.com/x' } },
          budget,
          policy
        ).pipe(Effect.provide(h.layer), Effect.result))._tag
      ).toBe('Failure')
      expect(h.requests).toHaveLength(1)
    })
  )
  it.effect('URL syntax and input validation reject pre-network', () =>
    Effect.gen(function* () {
      const h = host([])

      for (const url of [
        'https://127.0.0.1/x',
        'https://[::1]/',
        'http://assets.example.com/',
        'https://user:secret@assets.example.com/',
        'https://assets.example.com:444/',
        'https://x.local/',
        'https://assets.example.com/%GG',
        'https://assets.example.com/#',
        'https:////assets.example.com/',
        'https://-bad.example.com/'
      ]) {
        expect(
          (yield* downloadNotionFile(
            integration('notion'),
            { type: 'external', external: { url } },
            budget,
            { allowHostedUrl: () => true, allowExternalUrl: () => true }
          ).pipe(Effect.provide(h.layer), Effect.result))._tag
        ).toBe('Failure')
      }

      expect(
        (yield* downloadGoogleDriveFile(
          integration('google'),
          { fileId: 'file', resourceKey: 'key\r\n' },
          budget
        ).pipe(Effect.provide(h.layer), Effect.result))._tag
      ).toBe('Failure')
      expect(h.requests).toHaveLength(0)
      expect(h.scopes).toHaveLength(0)
    })
  )
})
