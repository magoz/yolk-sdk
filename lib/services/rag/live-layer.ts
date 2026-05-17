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
import { DefaultRagChunkerLive } from '@yolk/rag/chunking'
import { RagEmbedder } from '@yolk/rag/embeddings'
import { RagExtractor } from '@yolk/rag/extraction'
import { NoopRagSummarizerLive } from '@yolk/rag/summarization'
import { RagEmbeddingError, RagExtractionError, RagStoreError } from '@yolk/rag/errors'
import { RagStore } from '@yolk/rag/store'
import type {
  RagStoreApi,
  UpsertRagDocumentInput
} from '@yolk/rag/store'
import type {
  ExtractedRagDocument,
  RagChunk,
  RagDocument,
  RagMetadata,
  RagSet,
  RagSource
} from '@yolk/rag/documents'
import { Db } from '@/lib/services/db/live-layer'
import * as dbSchema from '@/lib/services/db/schema'
import { isTransientError, retryPolicy } from '@/lib/services/retry'
import { OpenAiRagDocumentSummarizerLayer } from './document-summarizer'
import { AppRagEmbedderError } from './errors'

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

const isRagStoreError = (error: unknown): error is RagStoreError => hasTag(error, 'RagStoreError')
const isRagExtractionError = (error: unknown): error is RagExtractionError =>
  hasTag(error, 'RagExtractionError')

const unknownToMessage = (error: unknown) => (hasStringMessage(error) ? error.message : String(error))

const metadataString = (metadata: RagMetadata | undefined, key: string) => {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : undefined
}

const sourceTypeFromRagSource = (source: RagSource): StorageSourceType => {
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
}): RagSource => {
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

const toRagSet = (row: typeof dbSchema.ragSet.$inferSelect): RagSet => ({
  id: row.id,
  label: row.label ?? undefined,
  embeddingConfig: {
    model: row.embeddingModel,
    dimensions: row.embeddingDimensions
  },
  chunkingConfig: {
    strategy: row.chunkingStrategy,
    maxTokens: row.chunkMaxTokens
  },
  metadata: row.metadata
})

const toRagDocument = (input: {
  readonly document: typeof dbSchema.ragDocument.$inferSelect
  readonly storage: typeof dbSchema.storageObject.$inferSelect
}): RagDocument => ({
  id: input.document.id,
  ragSetId: input.document.ragSetId,
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

const toRagChunk = (row: typeof dbSchema.ragChunk.$inferSelect): RagChunk => ({
  id: row.id,
  ragSetId: row.ragSetId,
  documentId: row.documentId,
  content: row.content,
  position: row.position,
  tokenCount: row.tokenCount,
  metadata: row.metadata
})

const storageObjectIdForDocument = (input: UpsertRagDocumentInput) =>
  metadataString(input.document.metadata, 'storageObjectId') ?? input.document.id

const notFound = (label: string) => new RagStoreError({ message: `${label} not found` })

const mapStoreError = (error: unknown) => {
  if (isRagStoreError(error)) {
    return error
  }

  return new RagStoreError({ message: unknownToMessage(error), cause: error })
}

const isOkStatus = (status: number) => status >= 200 && status < 300

const readErrorBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(
      error => new AppRagEmbedderError({ message: `Could not read OpenAI error body: ${error.message}` })
    )
  )

const failOpenAiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const body = yield* readErrorBody(response)
    return yield* Effect.fail(
      new AppRagEmbedderError({
        message: `OpenAI embeddings failed: ${response.status} ${body}`,
        isTransient: response.status === 429 || response.status >= 500 ? true : undefined
      })
    )
  })

const parseOpenAiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.mapError(
      error => new AppRagEmbedderError({ message: `Could not parse OpenAI embeddings JSON: ${error.message}` })
    ),
    Effect.flatMap(value =>
      Schema.decodeUnknownEffect(OpenAiEmbeddingResponseSchema)(value).pipe(
        Effect.mapError(
          error => new AppRagEmbedderError({ message: `Invalid OpenAI embeddings response: ${error.message}` })
        )
      )
    )
  )

export const DrizzleRagStoreLayer = Layer.effect(
  RagStore,
  Effect.gen(function* () {
    const db = yield* Db

    const getDocument = (documentId: string) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ document: dbSchema.ragDocument, storage: dbSchema.storageObject })
          .from(dbSchema.ragDocument)
          .innerJoin(
            dbSchema.storageObject,
            eq(dbSchema.storageObject.id, dbSchema.ragDocument.storageObjectId)
          )
          .where(eq(dbSchema.ragDocument.id, documentId))

        if (row === undefined) {
          return yield* Effect.fail(notFound('RAG document'))
        }

        return toRagDocument(row)
      }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error))))

    const api: RagStoreApi = {
      upsertSet: set =>
        Effect.gen(function* () {
          const [row] = yield* db
            .insert(dbSchema.ragSet)
            .values({
              id: set.id,
              userId: metadataString(set.metadata, 'userId') ?? set.id,
              label: set.label,
              embeddingModel: set.embeddingConfig.model,
              embeddingDimensions: set.embeddingConfig.dimensions,
              chunkingStrategy: set.chunkingConfig.strategy,
              chunkMaxTokens: set.chunkingConfig.maxTokens,
              metadata: set.metadata ?? {}
            })
            .onConflictDoUpdate({
              target: dbSchema.ragSet.id,
              set: {
                label: set.label,
                embeddingModel: set.embeddingConfig.model,
                embeddingDimensions: set.embeddingConfig.dimensions,
                chunkingStrategy: set.chunkingConfig.strategy,
                chunkMaxTokens: set.chunkingConfig.maxTokens,
                metadata: set.metadata ?? {},
                updatedAt: sql`CURRENT_TIMESTAMP`
              }
            })
            .returning()

          if (row === undefined) {
            return yield* Effect.fail(new RagStoreError({ message: 'Could not upsert RAG set' }))
          }

          return toRagSet(row)
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      getSet: id =>
        Effect.gen(function* () {
          const [row] = yield* db.select().from(dbSchema.ragSet).where(eq(dbSchema.ragSet.id, id))
          if (row === undefined) {
            return yield* Effect.fail(notFound('RAG set'))
          }
          return toRagSet(row)
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      upsertDocument: input =>
        Effect.gen(function* () {
          const storageObjectId = storageObjectIdForDocument(input)
          const [row] = yield* db
            .insert(dbSchema.ragDocument)
            .values({
              id: input.document.id,
              ragSetId: input.document.ragSetId,
              storageObjectId,
              sourceType: sourceTypeFromRagSource(input.document.source),
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
              target: dbSchema.ragDocument.id,
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
            return yield* Effect.fail(new RagStoreError({ message: 'Could not upsert RAG document' }))
          }

          return yield* getDocument(row.id)
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      markDocumentProcessing: input =>
        Effect.gen(function* () {
          yield* db
            .update(dbSchema.ragDocument)
            .set({ status: 'processing', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(
              and(
                eq(dbSchema.ragDocument.id, input.documentId),
                eq(dbSchema.ragDocument.ragSetId, input.ragSetId)
              )
            )
          return yield* getDocument(input.documentId)
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      replaceDocumentChunks: input =>
        Effect.gen(function* () {
          yield* db.transaction(tx =>
            Effect.gen(function* () {
              yield* tx
                .delete(dbSchema.ragChunk)
                .where(
                  and(
                    eq(dbSchema.ragChunk.documentId, input.documentId),
                    eq(dbSchema.ragChunk.ragSetId, input.ragSetId)
                  )
                )

              if (input.chunks.length === 0) {
                return
              }

              yield* tx.insert(dbSchema.ragChunk).values(
                input.chunks.map(item => ({
                  id: item.chunk.id,
                  ragSetId: input.ragSetId,
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
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      markDocumentReady: input =>
        Effect.gen(function* () {
          const [row] = yield* db
            .update(dbSchema.ragDocument)
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
                eq(dbSchema.ragDocument.id, input.documentId),
                eq(dbSchema.ragDocument.ragSetId, input.ragSetId)
              )
            )
            .returning()

          if (row === undefined) {
            return yield* Effect.fail(notFound('RAG document'))
          }

          return yield* getDocument(row.id)
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      markDocumentError: input =>
        Effect.gen(function* () {
          yield* db
            .update(dbSchema.ragDocument)
            .set({ status: 'error', errorMessage: input.message, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(
              and(
                eq(dbSchema.ragDocument.id, input.documentId),
                eq(dbSchema.ragDocument.ragSetId, input.ragSetId)
              )
            )
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      deleteDocument: input =>
        Effect.gen(function* () {
          yield* db
            .delete(dbSchema.ragDocument)
            .where(
              and(
                eq(dbSchema.ragDocument.id, input.documentId),
                eq(dbSchema.ragDocument.ragSetId, input.ragSetId)
              )
            )
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      searchChunks: input =>
        Effect.gen(function* () {
          const distance = cosineDistance(dbSchema.ragChunk.embedding, Array.from(input.embedding))
          const score = sql<number>`1 - (${distance})`
          const scopeIds = input.scope._tag === 'RagSet' ? [input.scope.id] : [...input.scope.ids]
          const scopeCondition =
            scopeIds.length === 1
              ? eq(dbSchema.ragChunk.ragSetId, scopeIds[0] ?? '')
              : inArray(dbSchema.ragChunk.ragSetId, scopeIds)
          const minScoreCondition =
            input.minScore === undefined ? undefined : lte(distance, 1 - input.minScore)
          const matches = yield* db
            .select({
              chunk: dbSchema.ragChunk,
              document: dbSchema.ragDocument,
              storage: dbSchema.storageObject,
              score
            })
            .from(dbSchema.ragChunk)
            .innerJoin(dbSchema.ragDocument, eq(dbSchema.ragDocument.id, dbSchema.ragChunk.documentId))
            .innerJoin(
              dbSchema.storageObject,
              eq(dbSchema.storageObject.id, dbSchema.ragDocument.storageObjectId)
            )
            .where(
              and(scopeCondition, eq(dbSchema.ragDocument.status, 'ready'), minScoreCondition)
            )
            .orderBy(asc(distance))
            .limit(input.limit)

          return matches.map(match => ({
            chunk: toRagChunk(match.chunk),
            score: match.score,
            document: toRagDocument({ document: match.document, storage: match.storage })
          }))
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      searchChunksByText: input =>
        Effect.gen(function* () {
          const scopeIds = input.scope._tag === 'RagSet' ? [input.scope.id] : [...input.scope.ids]
          const scopeCondition =
            scopeIds.length === 1
              ? eq(dbSchema.ragChunk.ragSetId, scopeIds[0] ?? '')
              : inArray(dbSchema.ragChunk.ragSetId, scopeIds)
          const searchVector = sql`to_tsvector('english', ${dbSchema.ragChunk.content})`
          const searchQuery = sql`websearch_to_tsquery('english', ${input.query})`
          const score = sql<number>`ts_rank_cd(${searchVector}, ${searchQuery})`
          const matches = yield* db
            .select({
              chunk: dbSchema.ragChunk,
              document: dbSchema.ragDocument,
              storage: dbSchema.storageObject,
              score
            })
            .from(dbSchema.ragChunk)
            .innerJoin(dbSchema.ragDocument, eq(dbSchema.ragDocument.id, dbSchema.ragChunk.documentId))
            .innerJoin(
              dbSchema.storageObject,
              eq(dbSchema.storageObject.id, dbSchema.ragDocument.storageObjectId)
            )
            .where(
              and(
                scopeCondition,
                eq(dbSchema.ragDocument.status, 'ready'),
                sql`${searchVector} @@ ${searchQuery}`
              )
            )
            .orderBy(desc(score))
            .limit(input.limit)

          return matches.map(match => ({
            chunk: toRagChunk(match.chunk),
            score: match.score,
            document: toRagDocument({ document: match.document, storage: match.storage })
          }))
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error)))),

      getContextChunks: input =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(dbSchema.ragChunk)
            .where(
              and(
                eq(dbSchema.ragChunk.ragSetId, input.ragSetId),
                eq(dbSchema.ragChunk.documentId, input.documentId),
                gte(dbSchema.ragChunk.position, Math.max(0, input.position - input.contextChunks)),
                lte(dbSchema.ragChunk.position, input.position + input.contextChunks)
              )
            )
            .orderBy(asc(dbSchema.ragChunk.position))

          return rows.map(toRagChunk)
        }).pipe(Effect.catch(error => Effect.fail(mapStoreError(error))))
    }

    return api
  })
)

export const TextRagExtractorLayer = Layer.succeed(RagExtractor, {
  extract: source =>
    Effect.gen(function* () {
      if (typeof source.content !== 'string') {
        return yield* Effect.fail(
          new RagExtractionError({ message: 'Text extractor requires string content' })
        )
      }

      const content = source.content.trim()
      if (content.length === 0) {
        return yield* Effect.fail(new RagExtractionError({ message: 'Cannot extract empty text' }))
      }

      const title = metadataString(source.metadata, 'title')
      return {
        content,
        title,
        metadata: source.metadata
      } satisfies ExtractedRagDocument
    }).pipe(
      Effect.mapError(error => {
        if (isRagExtractionError(error)) {
          return error
        }

        return new RagExtractionError({ message: unknownToMessage(error), cause: error })
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
    Effect.mapError(() => new AppRagEmbedderError({ message: 'OPENAI_API_KEY not found' }))
  )
)

const toRequestError = (error: HttpClientError.HttpClientError) =>
  new AppRagEmbedderError({
    message: `OpenAI embeddings request failed: ${error.message}`,
    isTransient: true,
    cause: error
  })

export const OpenAiRagEmbedderLayer = Layer.effect(
  RagEmbedder,
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
            error => new AppRagEmbedderError({ message: `Could not encode embeddings request: ${error.message}` })
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
          new RagEmbeddingError({ message: unknownToMessage(error), cause: error })
        )
      )

    return {
      embedTexts,
      embedQuery: query => embedTexts([query]).pipe(Effect.map(embeddings => embeddings[0] ?? []))
    }
  })
).pipe(Layer.provide(OpenAiEmbeddingsConfigLayer), Layer.provide(FetchHttpClient.layer))

export const AppRagLayer = Layer.mergeAll(
  DrizzleRagStoreLayer,
  TextRagExtractorLayer,
  DefaultRagChunkerLive(),
  OpenAiRagEmbedderLayer,
  OpenAiRagDocumentSummarizerLayer
)

export const TestAppRagLayer = Layer.mergeAll(
  DrizzleRagStoreLayer,
  TextRagExtractorLayer,
  DefaultRagChunkerLive(),
  OpenAiRagEmbedderLayer,
  NoopRagSummarizerLive
)
