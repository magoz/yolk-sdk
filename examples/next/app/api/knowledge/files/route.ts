import { Array as Arr, Data, Effect, Layer, Option } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { KnowledgeStore } from '@yolk-sdk/knowledge/store'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import {
  DrizzleKnowledgeStoreLayer,
  R2KnowledgeFileBlobStoreLayer
} from '@/lib/services/knowledge/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class KnowledgeFileDownloadRouteError extends Data.TaggedError('KnowledgeFileDownloadRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class KnowledgeFileNotFoundError extends Data.TaggedError('KnowledgeFileNotFoundError')<
  Record<string, never>
> {}

const DownloadLayer = Layer.mergeAll(
  AppLayer,
  DrizzleKnowledgeStoreLayer.pipe(Layer.provide(AppLayer)),
  R2KnowledgeFileBlobStoreLayer
)

const safeFilename = (value: string) => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')
  return normalized.length === 0 ? 'knowledge-file' : normalized
}

const responseHeaders = (input: { readonly filename: string; readonly mediaType: string }) => ({
  'cache-control': 'private, no-store',
  'content-disposition': `attachment; filename="${safeFilename(input.filename)}"`,
  'content-type': input.mediaType,
  'x-content-type-options': 'nosniff'
})

const arrayBufferFromBytes = (bytes: Uint8Array) => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const downloadFile = Effect.gen(function* () {
  const session = yield* getSession()
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url)
  const documentId = url.searchParams.get('documentId')?.trim()
  const fileId = url.searchParams.get('fileId')?.trim()

  if (
    documentId === undefined ||
    documentId.length === 0 ||
    fileId === undefined ||
    fileId.length === 0
  ) {
    return HttpServerResponse.text('Missing file', { status: 400 })
  }

  yield* Effect.annotateCurrentSpan({
    'user.id': session.user.id,
    'knowledge.document_id': documentId,
    'knowledge.file_id': fileId
  })

  const store = yield* KnowledgeStore
  const fileStore = yield* KnowledgeFileBlobStore
  const files = yield* store.listFiles({ scope: { id: session.user.id }, id: documentId })
  const file = yield* Option.match(
    Arr.findFirst(files, item => item.id === fileId),
    {
      onNone: () => Effect.fail(new KnowledgeFileNotFoundError({})),
      onSome: item => Effect.succeed(item)
    }
  )
  const bytes = yield* fileStore.getFile({ storageKey: file.storageKey })
  const mediaType = file.mediaType ?? 'application/octet-stream'

  return HttpServerResponse.raw(arrayBufferFromBytes(bytes), {
    headers: responseHeaders({ filename: file.storageKey.split('/').at(-1) ?? file.id, mediaType })
  })
}).pipe(
  Effect.withSpan('api.knowledge.file.download'),
  Effect.catchTag('UnauthenticatedError', () =>
    Effect.succeed(HttpServerResponse.text('Unauthorized', { status: 401 }))
  ),
  Effect.catchTag('KnowledgeFileNotFoundError', () =>
    Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))
  ),
  Effect.catchTag('KnowledgeStoreError', () =>
    Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))
  ),
  Effect.catch(error =>
    reportError(
      new KnowledgeFileDownloadRouteError({
        message: 'Knowledge file download failed',
        cause: error
      }),
      { operation: 'knowledge.file.download', status: 500 }
    ).pipe(Effect.as(HttpServerResponse.text('Internal error', { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(downloadFile, DownloadLayer)

export const GET = (request: Request) => effectHandler(request)
