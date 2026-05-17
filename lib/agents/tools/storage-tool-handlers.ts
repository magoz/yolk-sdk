import { Effect, Layer } from 'effect'
import { ToolError } from '@yolk/agent/loop'
import { ensureUserRagSet } from '@/lib/core/storage/ensure-user-rag-set'
import { getStorageObject } from '@/lib/core/storage/get-storage-object'
import { getUserStorage } from '@/lib/core/storage/get-user-storage'
import { Db } from '@/lib/services/db/live-layer'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { searchAppRag } from '@/lib/services/rag/search-app-rag'
import {
  makeStorageRagToolModule,
  type StorageSourceDetail,
  type StorageSourceSummary
} from './storage-rag-tool.ts'

const RagToolLayer = Layer.mergeAll(Db.layer, AppRagLayer.pipe(Layer.provide(Db.layer)))

const storageSourceName = (source: {
  readonly filename: string | null
  readonly url: string | null
  readonly id: string
}) => source.filename ?? source.url ?? source.id

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const truncateText = (input: { readonly text: string; readonly maxChars: number }) => ({
  text: input.text.slice(0, input.maxChars),
  textTruncated: input.text.length > input.maxChars,
  textCharacters: input.text.length
})

const searchStorageForAgent = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) =>
  Effect.gen(function* () {
    const ragSet = yield* ensureUserRagSet({ userId: input.userId })

    return yield* searchAppRag({
      userId: input.userId,
      scope: { _tag: 'RagSet', id: ragSet.id },
      query: input.query,
      options: {
        limit: input.limit,
        minScore: input.minScore,
        contextChunks: input.contextChunks
      }
    })
  }).pipe(
    Effect.provide(RagToolLayer),
    Effect.mapError(
      error =>
        new ToolError({
          tool: 'search_storage',
          message: error.message,
          cause: 'execution'
        })
    )
  )

const listStorageSourcesForAgent = (input: { readonly userId: string }) =>
  getUserStorage({ userId: input.userId }).pipe(
    Effect.map(rows =>
      rows.map(
        (row): StorageSourceSummary => ({
          id: row.object.id,
          name: storageSourceName(row.object),
          sourceType: row.object.sourceType,
          status: row.document?.status,
          summary: row.document?.summary ?? undefined,
          chunkCount: row.document?.chunkCount,
          tokenCount: row.document?.tokenCount,
          createdAt: row.object.createdAt.toISOString()
        })
      )
    ),
    Effect.provide(Db.layer),
    Effect.mapError(
      error =>
        new ToolError({
          tool: 'list_storage_sources',
          message: unknownToMessage(error),
          cause: 'execution'
        })
    )
  )

const getStorageSourceForAgent = (input: {
  readonly userId: string
  readonly id: string
  readonly maxChars: number
}) =>
  getStorageObject({ id: input.id, userId: input.userId }).pipe(
    Effect.map(row => {
      const text = truncateText({ text: row.object.textContent ?? '', maxChars: input.maxChars })

      return {
        id: row.object.id,
        name: storageSourceName(row.object),
        sourceType: row.object.sourceType,
        status: row.document?.status,
        summary: row.document?.summary ?? undefined,
        chunkCount: row.document?.chunkCount,
        tokenCount: row.document?.tokenCount,
        createdAt: row.object.createdAt.toISOString(),
        mediaType: row.object.mediaType ?? undefined,
        byteSize: row.object.byteSize ?? undefined,
        contentHash: row.object.contentHash ?? row.document?.contentHash ?? undefined,
        ...text
      } satisfies StorageSourceDetail
    }),
    Effect.provide(Db.layer),
    Effect.mapError(
      error =>
        new ToolError({
          tool: 'get_storage_source',
          message: unknownToMessage(error),
          cause: 'execution'
        })
    )
  )

export const makeAppStorageRagToolModule = () =>
  makeStorageRagToolModule({
    search: searchStorageForAgent,
    listSources: listStorageSourcesForAgent,
    getSource: getStorageSourceForAgent
  })
