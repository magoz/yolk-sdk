import { Array as Arr, Data, Effect, Layer, Option } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { KnowledgeArtifactStore } from '@yolk/knowledge/artifacts'
import { KnowledgeStore } from '@yolk/knowledge/store'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import {
  DrizzleKnowledgeStoreLayer,
  R2KnowledgeArtifactStoreLayer
} from '@/lib/services/knowledge/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class KnowledgeArtifactDownloadRouteError extends Data.TaggedError(
  'KnowledgeArtifactDownloadRouteError'
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

class KnowledgeArtifactNotFoundError extends Data.TaggedError('KnowledgeArtifactNotFoundError')<
  Record<string, never>
> {}

const DownloadLayer = Layer.mergeAll(
  AppLayer,
  DrizzleKnowledgeStoreLayer.pipe(Layer.provide(AppLayer)),
  R2KnowledgeArtifactStoreLayer
)

const safeFilename = (value: string) => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')
  return normalized.length === 0 ? 'knowledge-artifact' : normalized
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

const downloadArtifact =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url)
    const objectId = url.searchParams.get('objectId')?.trim()
    const artifactId = url.searchParams.get('artifactId')?.trim()

    if (objectId === undefined || objectId.length === 0 || artifactId === undefined || artifactId.length === 0) {
      return HttpServerResponse.text('Missing artifact', { status: 400 })
    }

    const session = yield* getSession()
    const store = yield* KnowledgeStore
    const artifactStore = yield* KnowledgeArtifactStore
    const artifacts = yield* store.listArtifacts({ scope: { id: session.user.id }, id: objectId })
    const artifact = yield* Option.match(
      Arr.findFirst(artifacts, item => item.id === artifactId),
      {
        onNone: () => Effect.fail(new KnowledgeArtifactNotFoundError({})),
        onSome: item => Effect.succeed(item)
      }
    )
    const bytes = yield* artifactStore.getArtifact({ storageKey: artifact.storageKey })
    const mediaType = artifact.mediaType ?? 'application/octet-stream'

    return HttpServerResponse.raw(arrayBufferFromBytes(bytes), {
      headers: responseHeaders({ filename: artifact.storageKey.split('/').at(-1) ?? artifact.id, mediaType })
    })
  }).pipe(
    Effect.catchTag('UnauthenticatedError', () => Effect.succeed(HttpServerResponse.text('Unauthorized', { status: 401 }))),
    Effect.catchTag('KnowledgeArtifactNotFoundError', () => Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))),
    Effect.catchTag('KnowledgeStoreError', () => Effect.succeed(HttpServerResponse.text('Not found', { status: 404 }))),
    Effect.catch(error =>
      reportError(
        new KnowledgeArtifactDownloadRouteError({
          message: 'Knowledge artifact download failed',
          cause: error
        }),
        { operation: 'knowledge.artifact.download', status: 500 }
      ).pipe(Effect.as(HttpServerResponse.text('Internal error', { status: 500 })))
    )
  )

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(downloadArtifact, DownloadLayer)

export const GET = (request: Request) => effectHandler(request)
