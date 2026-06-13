import { Effect, Layer } from 'effect'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ModelVisibleToolError, modelVisibleToolError } from '@yolk-sdk/agent/tools'
import { ensureUserKnowledgeCollection } from '@/lib/core/storage/ensure-user-knowledge-collection'
import type { NotFoundError } from '@/lib/core/errors'
import { getStorageObject } from '@/lib/core/storage/get-storage-object'
import { getUserStorage } from '@/lib/core/storage/get-user-storage'
import { Db } from '@/lib/services/db/live-layer'
import { AppKnowledgeSearchLayer } from '@/lib/services/knowledge-search/live-layer'
import { searchAppKnowledge } from '@/lib/services/knowledge-search/search-app-knowledge'
import {
  makeStorageSearchToolModule,
  type StorageSourceDetail,
  type StorageSourceSummary
} from './storage-search-tool.ts'

const KnowledgeSearchToolLayer = Layer.mergeAll(Db.layer, AppKnowledgeSearchLayer.pipe(Layer.provide(Db.layer)))

const storageSourceName = (source: {
  readonly filename: string | null
  readonly url: string | null
  readonly id: string
}) => source.filename ?? source.url ?? source.id

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const notFoundToolError = (tool: string, error: NotFoundError) =>
  modelVisibleToolError({ tool, message: error.message, reason: 'not_found' })

const fatalToolError = (tool: string, error: unknown) =>
  error instanceof ToolError || error instanceof ModelVisibleToolError
    ? error
    : new ToolError({ tool, message: unknownToMessage(error), cause: 'execution' })

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
    const collection = yield* ensureUserKnowledgeCollection({ userId: input.userId })

    return yield* searchAppKnowledge({
      userId: input.userId,
      scope: { _tag: 'KnowledgeCollection', id: collection.id },
      query: input.query,
      options: {
        limit: input.limit,
        minScore: input.minScore,
        contextChunks: input.contextChunks
      }
    })
  }).pipe(
    Effect.provide(KnowledgeSearchToolLayer),
    Effect.mapError(error => fatalToolError('search_storage', error))
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
    Effect.mapError(error => fatalToolError('list_storage_sources', error))
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
    Effect.catchTag('NotFoundError', error => Effect.fail(notFoundToolError('get_storage_source', error))),
    Effect.provide(Db.layer),
    Effect.mapError(error => fatalToolError('get_storage_source', error))
  )

export const makeAppStorageKnowledgeSearchToolModule = () =>
  makeStorageSearchToolModule({
    search: searchStorageForAgent,
    listSources: listStorageSourcesForAgent,
    getSource: getStorageSourceForAgent
  })
