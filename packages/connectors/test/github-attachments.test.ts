import { Effect, Layer, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { BearerTokenCredential, ConnectorBinaryWriteHttpClient } from '@yolk-sdk/connectors'
import type {
  ConnectorBinaryHttpResponse,
  ConnectorBinaryWriteHttpRequest
} from '@yolk-sdk/connectors'
import {
  githubAttachmentMaxImageBytes,
  githubAttachmentMaxVideoBytes,
  uploadGithubAttachment
} from '../src/github/attachments.ts'
import type {
  GithubAttachmentUploadInput,
  GithubAttachmentUploadOptions
} from '../src/github/attachments.ts'
import { githubUploadTokenSlotId } from '../src/github/shared.ts'
import { githubIntegration, makeGithubHost } from './github-fake.ts'

const budget = { maxBytes: 20_000_000, maxMetadataBytes: 50_000, maxErrorBodyBytes: 2_000 }

const pngBytes = () => new TextEncoder().encode('fake-png-bytes')

const assetUrl = 'https://github.com/user-attachments/assets/abc123'

const binaryResponse = (status: number, value: unknown): ConnectorBinaryHttpResponse => ({
  status,
  headers: {},
  bytes: new TextEncoder().encode(JSON.stringify(value)),
  bodyComplete: true
})

const makeBinaryHost = (response: ConnectorBinaryHttpResponse) => {
  const requests: Array<ConnectorBinaryWriteHttpRequest> = []

  const layer = Layer.succeed(ConnectorBinaryWriteHttpClient, {
    request: (request: ConnectorBinaryWriteHttpRequest) => {
      requests.push(request)

      return Effect.succeed(response)
    }
  })

  return { requests, layer }
}

const userCredential = () => BearerTokenCredential.make({ token: 'gho_usertoken123' })

describe('github attachment upload', () => {
  it('exports documented size limits', () => {
    expect(githubAttachmentMaxImageBytes).toBe(10 * 1024 * 1024)
    expect(githubAttachmentMaxVideoBytes).toBe(100 * 1024 * 1024)
  })

  it.effect('looks up the repo id and uploads png bytes with image markdown', () =>
    Effect.gen(function* () {
      const bytes = pngBytes()
      const http = makeGithubHost([{ body: { id: 555 } }], userCredential)
      const binary = makeBinaryHost(binaryResponse(201, { url: assetUrl }))
      const layer = Layer.mergeAll(http.layer, binary.layer)

      const output = yield* uploadGithubAttachment(
        githubIntegration(),
        { name: 'photo.png', contentType: 'image/png', bytes },
        budget
      ).pipe(Effect.provide(layer))

      expect(http.requests).toHaveLength(1)
      expect(http.requests[0]?.method).toBe('GET')
      expect(http.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets')

      expect(binary.requests).toHaveLength(1)

      const upload = binary.requests[0]
      const url = new URL(upload?.url ?? '')

      expect(upload?.method).toBe('POST')
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://uploads.github.com/user-attachments/assets'
      )
      expect(url.searchParams.get('name')).toBe('photo.png')
      expect(url.searchParams.get('content_type')).toBe('image/png')
      expect(url.searchParams.get('repository_id')).toBe('555')
      expect(upload?.url).toContain('content_type=image%2Fpng')
      expect(upload?.headers).toMatchObject({
        authorization: 'Bearer gho_usertoken123',
        'content-type': 'image/png',
        accept: 'application/json',
        'user-agent': 'yolk-sdk-connectors'
      })
      expect(upload?.bytes).toBe(bytes)
      expect(upload?.redirect).toBe('manual')
      expect(upload?.credentials).toBe('omit')
      expect(upload?.successStatuses).toEqual([200, 201])
      expect(upload?.maxUploadBytes).toBe(githubAttachmentMaxImageBytes)
      expect(upload?.maxBytes).toBe(budget.maxMetadataBytes)

      expect(output).toEqual({ url: assetUrl, markdown: `![photo](${assetUrl})` })
    })
  )

  it.effect('encodes svg content types, uses provided repo ids, and renders video urls bare', () =>
    Effect.gen(function* () {
      const http = makeGithubHost([{ body: { id: 1 } }], userCredential)
      const binary = makeBinaryHost(binaryResponse(200, { url: assetUrl }))
      const layer = Layer.mergeAll(http.layer, binary.layer)

      const svg = yield* uploadGithubAttachment(
        githubIntegration(),
        { name: 'diagram.svg', contentType: 'image/svg+xml', bytes: pngBytes(), repositoryId: 999 },
        budget
      ).pipe(Effect.provide(layer))

      expect(http.requests).toHaveLength(0)
      expect(binary.requests[0]?.url).toContain('content_type=image%2Fsvg%2Bxml')
      expect(binary.requests[0]?.url).toContain('repository_id=999')
      expect(svg).toEqual({ url: assetUrl, markdown: `![diagram](${assetUrl})` })

      const video = yield* uploadGithubAttachment(
        githubIntegration(),
        { name: 'clip.mp4', contentType: 'video/mp4', bytes: pngBytes(), repositoryId: 999 },
        budget
      ).pipe(Effect.provide(layer))

      expect(video).toEqual({ url: assetUrl, markdown: assetUrl })
      expect(binary.requests[1]?.maxUploadBytes).toBe(budget.maxBytes)

      const jpeg = yield* uploadGithubAttachment(
        githubIntegration(),
        { name: 'photo.jpeg', contentType: 'image/jpeg', bytes: pngBytes(), repositoryId: 999 },
        budget
      ).pipe(Effect.provide(layer))

      expect(jpeg.markdown).toBe(`![photo](${assetUrl})`)
    })
  )

  it.effect('escapes markdown alt text and falls back to href metadata', () =>
    Effect.gen(function* () {
      const http = makeGithubHost([], userCredential)
      const binary = makeBinaryHost(binaryResponse(201, { href: assetUrl }))
      const layer = Layer.mergeAll(http.layer, binary.layer)

      const output = yield* uploadGithubAttachment(
        githubIntegration(),
        {
          name: 'a.png',
          contentType: 'image/png',
          bytes: pngBytes(),
          repositoryId: 7,
          alt: 'x[y]\\z'
        },
        budget
      ).pipe(Effect.provide(layer))

      expect(output.markdown).toBe(`![x\\[y\\]\\\\z](${assetUrl})`)
    })
  )

  it.effect('rejects oversize, unsupported, and malformed inputs before network', () =>
    Effect.gen(function* () {
      const http = makeGithubHost([{ body: { id: 1 } }], userCredential)
      const binary = makeBinaryHost(binaryResponse(201, { url: assetUrl }))
      const layer = Layer.mergeAll(http.layer, binary.layer)

      const oversizedImage = new Uint8Array(githubAttachmentMaxImageBytes + 1)

      const cases: Array<{
        readonly name: string
        readonly input: GithubAttachmentUploadInput
        readonly options?: GithubAttachmentUploadOptions
      }> = [
        {
          name: 'oversize-image',
          input: { name: 'a.png', contentType: 'image/png', bytes: oversizedImage }
        },
        {
          name: 'host-lower-limit',
          input: { name: 'a.png', contentType: 'image/png', bytes: pngBytes() },
          options: { maxImageBytes: 8 }
        },
        {
          name: 'host-cannot-raise',
          input: {
            name: 'a.png',
            contentType: 'image/png',
            bytes: new Uint8Array(githubAttachmentMaxImageBytes + 1)
          },
          options: { maxImageBytes: 50_000_000 }
        },
        {
          name: 'empty-bytes',
          input: { name: 'a.png', contentType: 'image/png', bytes: new Uint8Array(0) }
        },
        {
          name: 'unsupported-type',
          input: { name: 'a.pdf', contentType: 'application/pdf', bytes: pngBytes() }
        },
        {
          name: 'slash-name',
          input: { name: 'a/b.png', contentType: 'image/png', bytes: pngBytes() }
        },
        {
          name: 'backslash-name',
          input: { name: 'a\\b.png', contentType: 'image/png', bytes: pngBytes() }
        },
        {
          name: 'missing-extension',
          input: { name: 'noext', contentType: 'image/png', bytes: pngBytes() }
        },
        {
          name: 'mismatched-extension',
          input: { name: 'a.txt', contentType: 'image/png', bytes: pngBytes() }
        },
        {
          name: 'bad-repository-id',
          input: { name: 'a.png', contentType: 'image/png', bytes: pngBytes(), repositoryId: 0 }
        }
      ]

      for (const entry of cases) {
        const result = yield* uploadGithubAttachment(
          githubIntegration(),
          entry.input,
          budget,
          entry.options
        ).pipe(Effect.provide(layer), Effect.result)

        expect(Result.isFailure(result), entry.name).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: 'invalid_input' })
          expect(JSON.stringify(result)).not.toContain('gho_usertoken123')
        }
      }

      const overBudget = yield* uploadGithubAttachment(
        githubIntegration(),
        { name: 'clip.mp4', contentType: 'video/mp4', bytes: pngBytes(), repositoryId: 3 },
        { ...budget, maxBytes: 4 }
      ).pipe(Effect.provide(layer), Effect.result)

      expect(Result.isFailure(overBudget)).toBe(true)

      expect(http.requests).toHaveLength(0)
      expect(binary.requests).toHaveLength(0)
    })
  )

  it.effect('maps upload statuses without leaking secrets', () =>
    Effect.gen(function* () {
      const cases: Array<{ readonly status: number; readonly code: string }> = [
        { status: 401, code: 'unauthorized' },
        { status: 404, code: 'not_found' },
        { status: 422, code: 'invalid_input' }
      ]

      for (const entry of cases) {
        const http = makeGithubHost([{ body: { id: 1 } }], userCredential)
        const binary = makeBinaryHost(binaryResponse(entry.status, { message: 'nope' }))
        const layer = Layer.mergeAll(http.layer, binary.layer)

        const result = yield* uploadGithubAttachment(
          githubIntegration(),
          { name: 'a.png', contentType: 'image/png', bytes: pngBytes(), repositoryId: 9 },
          budget
        ).pipe(Effect.provide(layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: entry.code })
          expect(JSON.stringify(result)).not.toContain('gho_usertoken123')
          expect(JSON.stringify(result)).not.toContain(assetUrl)
        }
      }
    })
  )

  it.effect('rejects attachment metadata outside the user-attachments prefix', () =>
    Effect.gen(function* () {
      for (const metadata of [
        { url: 'https://evil.example/x' },
        {},
        { url: `${assetUrl}) ![x](https://evil.example/y` },
        { url: `${assetUrl}\nnext` }
      ]) {
        const http = makeGithubHost([], userCredential)
        const binary = makeBinaryHost(binaryResponse(201, metadata))
        const layer = Layer.mergeAll(http.layer, binary.layer)

        const result = yield* uploadGithubAttachment(
          githubIntegration(),
          { name: 'a.png', contentType: 'image/png', bytes: pngBytes(), repositoryId: 9 },
          budget
        ).pipe(Effect.provide(layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: 'invalid_metadata' })
        }
      }
    })
  )

  it.effect('rejects installation tokens before any network call', () =>
    Effect.gen(function* () {
      const http = makeGithubHost([{ body: { id: 1 } }], slotId =>
        BearerTokenCredential.make({
          token: slotId === githubUploadTokenSlotId ? 'ghs_install123' : 'gho_usertoken123'
        })
      )

      const binary = makeBinaryHost(binaryResponse(201, { url: assetUrl }))
      const layer = Layer.mergeAll(http.layer, binary.layer)

      const result = yield* uploadGithubAttachment(
        githubIntegration(),
        { name: 'a.png', contentType: 'image/png', bytes: pngBytes(), repositoryId: 9 },
        budget
      ).pipe(Effect.provide(layer), Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'credential_failed' })
        expect(JSON.stringify(result)).not.toContain('ghs_install123')
      }

      expect(http.requests).toHaveLength(0)
      expect(binary.requests).toHaveLength(0)
    })
  )

  it.effect('sanitizes control characters in alt text', () =>
    Effect.gen(function* () {
      const http = makeGithubHost([], userCredential)
      const binary = makeBinaryHost(binaryResponse(201, { url: assetUrl }))

      const output = yield* uploadGithubAttachment(
        githubIntegration(),
        {
          name: 'a.png',
          contentType: 'image/png',
          bytes: pngBytes(),
          repositoryId: 9,
          alt: 'line one\n\n# heading [x]'
        },
        budget
      ).pipe(Effect.provide(Layer.mergeAll(http.layer, binary.layer)))

      expect(output.markdown).toBe(`![line one # heading \\[x\\]](${assetUrl})`)
    })
  )

  it.effect('rejects invalid repo config before resolving credentials', () =>
    Effect.gen(function* () {
      const http = makeGithubHost([], userCredential)
      const binary = makeBinaryHost(binaryResponse(201, { url: assetUrl }))

      const result = yield* uploadGithubAttachment(
        githubIntegration({ owner: 'acme', repo: '..' }),
        { name: 'a.png', contentType: 'image/png', bytes: pngBytes(), repositoryId: 9 },
        budget
      ).pipe(Effect.provide(Layer.mergeAll(http.layer, binary.layer)), Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) expect(result.failure).toMatchObject({ code: 'invalid_input' })

      expect(http.resolvedSlots).toEqual([])
      expect(binary.requests).toHaveLength(0)
    })
  )
})
