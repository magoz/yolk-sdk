import { and, asc, cosineDistance, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { Config, Context, Effect, Layer, Redacted } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import { DefaultKnowledgeChunkerLive } from '@yolk-sdk/knowledge/chunking'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { KnowledgeExtractor } from '@yolk-sdk/knowledge/extraction'
import { NoopKnowledgeSummarizerLive } from '@yolk-sdk/knowledge/summarization'
import { KnowledgeEmbeddingError, KnowledgeExtractionError, SearchIndexStoreError } from '@yolk-sdk/knowledge/errors'
import { SearchIndexStore } from '@yolk-sdk/knowledge/store'
import type {
  SearchIndexStoreApi,
  UpsertIndexedKnowledgeDocumentInput
} from '@yolk-sdk/knowledge/store'
import type {
  ExtractedKnowledgeDocument,
  IndexedKnowledgeDocument,
  KnowledgeChunk,
  KnowledgeMetadata,
  KnowledgeSource
} from '@yolk-sdk/knowledge/documents'
import { Db } from '@/lib/services/db/live-layer'
import * as dbSchema from '@/lib/services/db/schema'
import { isTransientError, retryPolicy } from '@/lib/services/retry'
import { OpenAiKnowledgeDocumentSummarizerLayer } from './document-summarizer'
import { AppKnowledgeEmbedderError } from './errors'

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'

const OpenAiEmbeddingDataSchema = Schema.Struct({
  embedding: Schema.Array(Schema.Number)
})

const OpenAiEmbeddingResponseSchema = Schema.Struct({
  data: Schema.Array(OpenAiEmbeddingDataSchema)
})

type StorageSourceType = typeof dbSchema.storageSourceType.enumValues[number]
const hasStringMessage = (error: unknown): error is { readonly message: string } =>
  typeof error === 'object' &&
  error !== null &&
  'message' in error &&
  typeof error.message === 'string'

const hasTag = <Tag extends string>(error: unknown, tag: Tag): error is { readonly _tag: Tag } =>
  typeof error === 'object' && error !== null && '_tag' in error && error._tag === tag

const isSearchIndexStoreError = (error: unknown): error is SearchIndexStoreError => hasTag(error, 'SearchIndexStoreError')
const isKnowledgeExtractionError = (error: unknown): error is KnowledgeExtractionError =>
  hasTag(error, 'KnowledgeExtractionError')

const unknownToMessage = (error: unknown) => (hasStringMessage(error) ? error.message : String(error))

const metadataString = (metadata: KnowledgeMetadata | undefined, key: string) => {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : undefined
}

const sourceTypeFromKnowledgeSource = (source: KnowledgeSource): StorageSourceType => {
  switch (source._tag) {
    case 'File':
      return 'file'
    case 'Url':
      return 'url'
    case 'Text':
      return 'text'
  }
}

const sourceFromRows = (input: {
  readonly sourceType: StorageSourceType
  readonly r2Key: string | null
  readonly url: string | null
  readonly filename: string | null
  readonly mediaType: string | null
}): KnowledgeSource => {
  switch (input.sourceType) {
    case 'file':
      return {
        _tag: 'File',
        ref: input.r2Key ?? '',
        name: input.filename ?? undefined,
        mediaType: input.mediaType ?? undefined
      }
    case 'url':
      return { _tag: 'Url', url: input.url ?? '' }
    case 'text':
      return { _tag: 'Text', label: input.filename ?? undefined }
  }
}

const toKnowledgeDocument = (input: {
  readonly document: typeof dbSchema.knowledgeDocument.$inferSelect
  readonly storage: typeof dbSchema.storageObject.$inferSelect
}): IndexedKnowledgeDocument => ({
  id: input.document.id,
  scopeId: input.document.collectionId,
  source: sourceFromRows({
    sourceType: input.storage.sourceType,
    r2Key: input.storage.r2Key,
    url: input.storage.url,
    filename: input.storage.filename,
    mediaType: input.storage.mediaType
  }),
  status: input.document.status,
  title: input.document.title ?? undefined,
  summary: input.document.summary ?? undefined,
  errorMessage: input.document.errorMessage ?? undefined,
  contentHash: input.document.contentHash ?? undefined,
  tokenCount: input.document.tokenCount,
  chunkCount: input.document.chunkCount,
  metadata: input.document.metadata
})

const toKnowledgeChunk = (row: typeof dbSchema.knowledgeChunk.$inferSelect): KnowledgeChunk => ({
  id: row.id,
  scopeId: row.collectionId,
  documentId: row.documentId,
  content: row.content,
  position: row.position,
  tokenCount: row.tokenCount,
  metadata: row.metadata
})

const storageObjectIdForDocument = (input: UpsertIndexedKnowledgeDocumentInput) =>
  metadataString(input.document.metadata, 'storageObjectId') ?? input.document.id

const notFound = (label: string) => new SearchIndexStoreError({ message: `${label} not found` })

const mapStoreError = (error: unknown) => {
  if (isSearchIndexStoreError(error)) {
    return error
  }

  return new SearchIndexStoreError({ message: unknownToMessage(error), cause: error })
}

const isOkStatus = (status: number) => status >= 200 && status < 300

const readErrorBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(
      error => new AppKnowledgeEmbedderError({ message: `Could not read OpenAI error body: ${error.message}` })
    )
  )

const failOpenAiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const body = yield* readErrorBody(response)
    return yield* Effect.fail(
      new AppKnowledgeEmbedderError({
        message: `OpenAI embeddings failed: ${response.status} ${body}`,
        isTransient: response.status === 429 || response.status >= 500 ? true : undefined
      })
    )
  })

const parseOpenAiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.mapError(
      error => new AppKnowledgeEmbedderError({ message: `Could not parse OpenAI embeddings JSON: ${error.message}` })
    ),
    Effect.flatMap(value =>
      Schema.decodeUnknownEffect(OpenAiEmbeddingResponseSchema)(value).pipe(
        Effect.mapError(
          error => new AppKnowledgeEmbedderError({ message: `Invalid OpenAI embeddings response: ${error.message}` })
        )
      )
    )
  )

export const DrizzleSearchIndexStoreLayer = Layer.effect(
  SearchIndexStore,
  Effect.gen(function* () {
    const db = yield* Db

    const getDocument = (documentId: string) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ document: dbSchema.knowledgeDocument, storage: dbSchema.storageObject })
          .from(dbSchema.knowledgeDocument)
          .innerJoin(
            dbSchema.storageObject,
            eq(dbSchema.storageObject.id, dbSchema.knowledgeDocument.storageObjectId)
          )
          .where(eq(dbSchema.knowledgeDocument.id, documentId))

        if (row === undefined) {
          return yield* Effect.fail(notFound('knowledge search document'))
        }

        return toKnowledgeDocument(row)
      }).pipe(
        Effect.withSpan('SearchIndexStore.getDocument'),
        Effect.catch(error => Effect.fail(mapStoreError(error)))
      )

    const api: SearchIndexStoreApi = {
      upsertDocument: input =>
        Effect.gen(function* () {
          const storageObjectId = storageObjectIdForDocument(input)
          const [row] = yield* db
            .insert(dbSchema.knowledgeDocument)
            .values({
              id: input.document.id,
              collectionId: input.document.scopeId,
              storageObjectId,
              sourceType: sourceTypeFromKnowledgeSource(input.document.source),
              status: input.document.status,
              title: input.document.title,
              summary: input.document.summary,
              errorMessage: input.document.errorMessage,
              contentHash: input.document.contentHash,
              tokenCount: input.document.tokenCount ?? 0,
              chunkCount: input.document.chunkCount ?? 0,
              metadata: input.document.metadata ?? {}
            })
            .onConflictDoUpdate({
              target: dbSchema.knowledgeDocument.id,
              set: {
                status: input.document.status,
                title: input.document.title,
                summary: input.document.summary,
                errorMessage: input.document.errorMessage,
                contentHash: input.document.contentHash,
                metadata: input.document.metadata ?? {},
                updatedAt: sql`CURRENT_TIMESTAMP`
              }
            })
            .returning()

          if (row === undefined) {
            return yield* Effect.fail(new SearchIndexStoreError({ message: 'Could not upsert knowledge search document' }))
          }

          return yield* getDocument(row.id)
        }).pipe(
          Effect.withSpan('SearchIndexStore.upsertDocument'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      markDocumentProcessing: input =>
        Effect.gen(function* () {
          yield* db
            .update(dbSchema.knowledgeDocument)
            .set({ status: 'processing', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(
              and(
                eq(dbSchema.knowledgeDocument.id, input.documentId),
                eq(dbSchema.knowledgeDocument.collectionId, input.scopeId)
              )
            )
          return yield* getDocument(input.documentId)
        }).pipe(
          Effect.withSpan('SearchIndexStore.markDocumentProcessing'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      replaceDocumentChunks: input =>
        Effect.gen(function* () {
          yield* db.transaction(tx =>
            Effect.gen(function* () {
              yield* tx
                .delete(dbSchema.knowledgeChunk)
                .where(
                  and(
                    eq(dbSchema.knowledgeChunk.documentId, input.documentId),
                    eq(dbSchema.knowledgeChunk.collectionId, input.scopeId)
                  )
                )

              if (input.chunks.length === 0) {
                return
              }

              yield* tx.insert(dbSchema.knowledgeChunk).values(
                input.chunks.map(item => ({
                  id: item.chunk.id,
                  collectionId: input.scopeId,
                  documentId: input.documentId,
                  content: item.chunk.content,
                  embedding: Array.from(item.embedding),
                  position: item.chunk.position,
                  tokenCount: item.chunk.tokenCount,
                  metadata: item.chunk.metadata ?? {}
                }))
              )
            })
          )
        }).pipe(
          Effect.withSpan('SearchIndexStore.replaceDocumentChunks'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      markDocumentReady: input =>
        Effect.gen(function* () {
          const [row] = yield* db
            .update(dbSchema.knowledgeDocument)
            .set({
              status: 'ready',
              title: input.title,
              summary: input.summary,
              errorMessage: null,
              contentHash: input.contentHash,
              tokenCount: input.tokenCount,
              chunkCount: input.chunkCount,
              processedAt: sql`CURRENT_TIMESTAMP`,
              updatedAt: sql`CURRENT_TIMESTAMP`
            })
            .where(
              and(
                eq(dbSchema.knowledgeDocument.id, input.documentId),
                eq(dbSchema.knowledgeDocument.collectionId, input.scopeId)
              )
            )
            .returning()

          if (row === undefined) {
            return yield* Effect.fail(notFound('knowledge search document'))
          }

          return yield* getDocument(row.id)
        }).pipe(
          Effect.withSpan('SearchIndexStore.markDocumentReady'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      markDocumentError: input =>
        Effect.gen(function* () {
          yield* db
            .update(dbSchema.knowledgeDocument)
            .set({ status: 'error', errorMessage: input.message, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(
              and(
                eq(dbSchema.knowledgeDocument.id, input.documentId),
                eq(dbSchema.knowledgeDocument.collectionId, input.scopeId)
              )
            )
        }).pipe(
          Effect.withSpan('SearchIndexStore.markDocumentError'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      deleteDocument: input =>
        Effect.gen(function* () {
          yield* db
            .delete(dbSchema.knowledgeDocument)
            .where(
              and(
                eq(dbSchema.knowledgeDocument.id, input.documentId),
                eq(dbSchema.knowledgeDocument.collectionId, input.scopeId)
              )
            )
        }).pipe(
          Effect.withSpan('SearchIndexStore.deleteDocument'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      searchChunks: input =>
        Effect.gen(function* () {
          const distance = cosineDistance(dbSchema.knowledgeChunk.embedding, Array.from(input.embedding))
          const score = sql<number>`1 - (${distance})`
          const scopeIds = input.scope._tag === 'KnowledgeScope' ? [input.scope.id] : [...input.scope.ids]
          const scopeCondition =
            scopeIds.length === 1
              ? eq(dbSchema.knowledgeChunk.collectionId, scopeIds[0] ?? '')
              : inArray(dbSchema.knowledgeChunk.collectionId, scopeIds)
          const minScoreCondition =
            input.minScore === undefined ? undefined : lte(distance, 1 - input.minScore)
          const matches = yield* db
            .select({
              chunk: dbSchema.knowledgeChunk,
              document: dbSchema.knowledgeDocument,
              storage: dbSchema.storageObject,
              score
            })
            .from(dbSchema.knowledgeChunk)
            .innerJoin(dbSchema.knowledgeDocument, eq(dbSchema.knowledgeDocument.id, dbSchema.knowledgeChunk.documentId))
            .innerJoin(
              dbSchema.storageObject,
              eq(dbSchema.storageObject.id, dbSchema.knowledgeDocument.storageObjectId)
            )
            .where(
              and(scopeCondition, eq(dbSchema.knowledgeDocument.status, 'ready'), minScoreCondition)
            )
            .orderBy(asc(distance))
            .limit(input.limit)

          return matches.map(match => ({
            chunk: toKnowledgeChunk(match.chunk),
            score: match.score,
            document: toKnowledgeDocument({ document: match.document, storage: match.storage })
          }))
        }).pipe(
          Effect.withSpan('SearchIndexStore.searchChunks'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      searchChunksByText: input =>
        Effect.gen(function* () {
          const scopeIds = input.scope._tag === 'KnowledgeScope' ? [input.scope.id] : [...input.scope.ids]
          const scopeCondition =
            scopeIds.length === 1
              ? eq(dbSchema.knowledgeChunk.collectionId, scopeIds[0] ?? '')
              : inArray(dbSchema.knowledgeChunk.collectionId, scopeIds)
          const searchVector = sql`to_tsvector('english', ${dbSchema.knowledgeChunk.content})`
          const searchQuery = sql`websearch_to_tsquery('english', ${input.query})`
          const score = sql<number>`ts_rank_cd(${searchVector}, ${searchQuery})`
          const matches = yield* db
            .select({
              chunk: dbSchema.knowledgeChunk,
              document: dbSchema.knowledgeDocument,
              storage: dbSchema.storageObject,
              score
            })
            .from(dbSchema.knowledgeChunk)
            .innerJoin(dbSchema.knowledgeDocument, eq(dbSchema.knowledgeDocument.id, dbSchema.knowledgeChunk.documentId))
            .innerJoin(
              dbSchema.storageObject,
              eq(dbSchema.storageObject.id, dbSchema.knowledgeDocument.storageObjectId)
            )
            .where(
              and(
                scopeCondition,
                eq(dbSchema.knowledgeDocument.status, 'ready'),
                sql`${searchVector} @@ ${searchQuery}`
              )
            )
            .orderBy(desc(score))
            .limit(input.limit)

          return matches.map(match => ({
            chunk: toKnowledgeChunk(match.chunk),
            score: match.score,
            document: toKnowledgeDocument({ document: match.document, storage: match.storage })
          }))
        }).pipe(
          Effect.withSpan('SearchIndexStore.searchChunksByText'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      getContextChunks: input =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(dbSchema.knowledgeChunk)
            .where(
              and(
                eq(dbSchema.knowledgeChunk.collectionId, input.scopeId),
                eq(dbSchema.knowledgeChunk.documentId, input.documentId),
                gte(dbSchema.knowledgeChunk.position, Math.max(0, input.position - input.contextChunks)),
                lte(dbSchema.knowledgeChunk.position, input.position + input.contextChunks)
              )
            )
            .orderBy(asc(dbSchema.knowledgeChunk.position))

          return rows.map(toKnowledgeChunk)
        }).pipe(
          Effect.withSpan('SearchIndexStore.getContextChunks'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        )
    }

    return api
  })
)

export const TextKnowledgeExtractorLayer = Layer.succeed(KnowledgeExtractor, {
  extract: source =>
    Effect.gen(function* () {
      if (typeof source.content !== 'string') {
        return yield* Effect.fail(
          new KnowledgeExtractionError({ message: 'Text extractor requires string content' })
        )
      }

      const content = source.content.trim()
      if (content.length === 0) {
        return yield* Effect.fail(new KnowledgeExtractionError({ message: 'Cannot extract empty text' }))
      }

      const title = metadataString(source.metadata, 'title')
      return {
        content,
        title,
        metadata: source.metadata
      } satisfies ExtractedKnowledgeDocument
    }).pipe(
      Effect.mapError(error => {
        if (isKnowledgeExtractionError(error)) {
          return error
        }

        return new KnowledgeExtractionError({ message: unknownToMessage(error), cause: error })
      })
    )
})

type OpenAiEmbeddingsConfigShape = {
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string
}

class OpenAiEmbeddingsConfig extends Context.Service<
  OpenAiEmbeddingsConfig,
  OpenAiEmbeddingsConfigShape
>()('@app/OpenAiEmbeddingsConfig') {}

const OpenAiEmbeddingsConfigLayer = Layer.effect(
  OpenAiEmbeddingsConfig,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted('OPENAI_API_KEY')
    return { apiKey, model: 'text-embedding-3-small' }
  }).pipe(
    Effect.mapError(() => new AppKnowledgeEmbedderError({ message: 'OPENAI_API_KEY not found' }))
  )
)

const toRequestError = (error: HttpClientError.HttpClientError) =>
  new AppKnowledgeEmbedderError({
    message: `OpenAI embeddings request failed: ${error.message}`,
    isTransient: true,
    cause: error
  })

export const OpenAiKnowledgeEmbedderLayer = Layer.effect(
  KnowledgeEmbedder,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const config = yield* OpenAiEmbeddingsConfig

    const embedTexts = (texts: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(OPENAI_EMBEDDINGS_URL).pipe(
          HttpClientRequest.setHeaders({
            accept: 'application/json',
            authorization: `Bearer ${Redacted.value(config.apiKey)}`,
            'content-type': 'application/json'
          }),
          HttpClientRequest.bodyJson({ model: config.model, input: texts }),
          Effect.mapError(
            error => new AppKnowledgeEmbedderError({ message: `Could not encode embeddings request: ${error.message}` })
          )
        )
        const response = yield* client.execute(request).pipe(Effect.mapError(toRequestError))

        if (!isOkStatus(response.status)) {
          return yield* failOpenAiResponse(response)
        }

        const parsed = yield* parseOpenAiResponse(response)
        return parsed.data.map(item => item.embedding)
      }).pipe(
        Effect.retry({ while: isTransientError, schedule: retryPolicy }),
        Effect.mapError(error =>
          new KnowledgeEmbeddingError({ message: unknownToMessage(error), cause: error })
        )
      )

    return {
      embedTexts,
      embedQuery: query => embedTexts([query]).pipe(Effect.map(embeddings => embeddings[0] ?? []))
    }
  })
).pipe(Layer.provide(OpenAiEmbeddingsConfigLayer), Layer.provide(FetchHttpClient.layer))

export const AppKnowledgeSearchLayer = Layer.mergeAll(
  DrizzleSearchIndexStoreLayer,
  TextKnowledgeExtractorLayer,
  DefaultKnowledgeChunkerLive(),
  OpenAiKnowledgeEmbedderLayer,
  OpenAiKnowledgeDocumentSummarizerLayer
)

export const TestAppKnowledgeSearchLayer = Layer.mergeAll(
  DrizzleSearchIndexStoreLayer,
  TextKnowledgeExtractorLayer,
  DefaultKnowledgeChunkerLive(),
  OpenAiKnowledgeEmbedderLayer,
  NoopKnowledgeSummarizerLive
)
