import { and, asc, cosineDistance, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { Config, Context, Effect, Layer, Match, Predicate, Redacted } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core'
import * as Schema from 'effect/Schema'
import { DefaultKnowledgeChunkerLive } from '@yolk-sdk/knowledge/chunking'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { KnowledgeExtractor } from '@yolk-sdk/knowledge/extraction'
import { NoopKnowledgeSummarizerLive } from '@yolk-sdk/knowledge/summarization'
import {
  KnowledgeEmbeddingError,
  KnowledgeExtractionError,
  SearchIndexStoreError
} from '@yolk-sdk/knowledge/errors'
import { SearchIndexStore } from '@yolk-sdk/knowledge/store'
import type { SearchIndexStoreApi } from '@yolk-sdk/knowledge/store'
import type {
  ExtractedKnowledgeDocument,
  KnowledgeMetadata,
  KnowledgeSearchScope,
  KnowledgeSource
} from '@yolk-sdk/knowledge/documents'
import { Db } from '@/lib/services/db/live-layer'
import {
  encodePersistedJsonObject,
  persistedJsonObjectErrorMessage
} from '@/lib/services/db/persisted-json-object'
import * as dbSchema from '@/lib/services/db/schema'
import { isTransientError, retryPolicy } from '@/lib/services/retry'
import { OpenAiKnowledgeDocumentSummarizerLayer } from './document-summarizer'
import { AppKnowledgeEmbedderError } from './errors'
import { toKnowledgeChunk, toKnowledgeDocument } from './indexed-rows'

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'

const OpenAiEmbeddingDataSchema = Schema.Struct({
  index: Schema.Int,
  embedding: Schema.Array(Schema.Finite).pipe(Schema.check(Schema.isLengthBetween(1536, 1536)))
})

const OpenAiEmbeddingResponseSchema = Schema.Struct({
  data: Schema.Array(OpenAiEmbeddingDataSchema)
})

type StorageSourceType = (typeof dbSchema.storageSourceType.enumValues)[number]

const metadataString = (metadata: KnowledgeMetadata | undefined, key: string) => {
  const value = metadata?.[key]

  return Predicate.isString(value) ? value : undefined
}

const sourceTypeFromKnowledgeSource = (source: KnowledgeSource): StorageSourceType =>
  Match.value(source).pipe(
    Match.tag('File', (): StorageSourceType => 'file'),
    Match.tag('Url', (): StorageSourceType => 'url'),
    Match.tag('Text', (): StorageSourceType => 'text'),
    Match.exhaustive
  )

const searchScopeIds = (scope: KnowledgeSearchScope) =>
  Match.value(scope).pipe(
    Match.tagsExhaustive({
      KnowledgeScope: ({ id }) => [id],
      KnowledgeScopes: ({ ids }) => ids
    })
  )

const metadataStoreError = (error: Schema.SchemaError) =>
  new SearchIndexStoreError({
    message: persistedJsonObjectErrorMessage(error),
    cause: error
  })

const notFound = (label: string) => new SearchIndexStoreError({ message: `${label} not found` })

const sqlStoreError = (error: EffectDrizzleQueryError) =>
  new SearchIndexStoreError({ message: error.message, cause: error })

const isOkStatus = (status: number) => status >= 200 && status < 300

const readErrorBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(
      error =>
        new AppKnowledgeEmbedderError({
          message: `Could not read OpenAI error body: ${error.message}`
        })
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
      error =>
        new AppKnowledgeEmbedderError({
          message: `Could not parse OpenAI embeddings JSON: ${error.message}`
        })
    ),
    Effect.flatMap(value =>
      Schema.decodeUnknownEffect(OpenAiEmbeddingResponseSchema)(value).pipe(
        Effect.mapError(
          () => new AppKnowledgeEmbedderError({ message: 'Invalid OpenAI embeddings response' })
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

        return yield* toKnowledgeDocument(row)
      }).pipe(
        Effect.withSpan('SearchIndexStore.getDocument'),
        Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
      )

    const api: SearchIndexStoreApi = {
      upsertDocument: input =>
        Effect.gen(function* () {
          const metadata = yield* encodePersistedJsonObject(
            input.document.metadata === undefined ? {} : input.document.metadata
          ).pipe(Effect.mapError(metadataStoreError))

          const storageObjectId = metadataString(metadata, 'storageObjectId') ?? input.document.id

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
              metadata
            })
            .onConflictDoUpdate({
              target: dbSchema.knowledgeDocument.id,
              set: {
                status: input.document.status,
                title: input.document.title,
                summary: input.document.summary,
                errorMessage: input.document.errorMessage,
                contentHash: input.document.contentHash,
                metadata,
                updatedAt: sql`CURRENT_TIMESTAMP`
              }
            })
            .returning()

          if (row === undefined) {
            return yield* Effect.fail(
              new SearchIndexStoreError({ message: 'Could not upsert knowledge search document' })
            )
          }

          return yield* getDocument(row.id)
        }).pipe(
          Effect.withSpan('SearchIndexStore.upsertDocument'),
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
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
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
        ),

      replaceDocumentChunks: input =>
        Effect.gen(function* () {
          const chunks = yield* Effect.forEach(input.chunks, item =>
            encodePersistedJsonObject(
              item.chunk.metadata === undefined ? {} : item.chunk.metadata
            ).pipe(
              Effect.map(metadata => ({
                id: item.chunk.id,
                collectionId: input.scopeId,
                documentId: input.documentId,
                content: item.chunk.content,
                embedding: Array.from(item.embedding),
                position: item.chunk.position,
                tokenCount: item.chunk.tokenCount,
                metadata
              })),
              Effect.mapError(metadataStoreError)
            )
          )

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

              if (chunks.length === 0) {
                return
              }

              yield* tx.insert(dbSchema.knowledgeChunk).values(chunks)
            })
          )
        }).pipe(
          Effect.withSpan('SearchIndexStore.replaceDocumentChunks'),
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error))),
          Effect.catchTag('SqlError', error =>
            Effect.fail(new SearchIndexStoreError({ message: error.message, cause: error }))
          )
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
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
        ),

      markDocumentError: input =>
        Effect.gen(function* () {
          yield* db
            .update(dbSchema.knowledgeDocument)
            .set({
              status: 'error',
              errorMessage: input.message,
              updatedAt: sql`CURRENT_TIMESTAMP`
            })
            .where(
              and(
                eq(dbSchema.knowledgeDocument.id, input.documentId),
                eq(dbSchema.knowledgeDocument.collectionId, input.scopeId)
              )
            )
        }).pipe(
          Effect.withSpan('SearchIndexStore.markDocumentError'),
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
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
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
        ),

      searchChunks: input =>
        Effect.gen(function* () {
          const distance = cosineDistance(
            dbSchema.knowledgeChunk.embedding,
            Array.from(input.embedding)
          )

          const score = sql<number>`1 - (${distance})`

          const scopeIds = searchScopeIds(input.scope)
          const [singleScopeId] = scopeIds

          const scopeCondition =
            scopeIds.length === 1 && singleScopeId !== undefined
              ? eq(dbSchema.knowledgeChunk.collectionId, singleScopeId)
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
            .innerJoin(
              dbSchema.knowledgeDocument,
              eq(dbSchema.knowledgeDocument.id, dbSchema.knowledgeChunk.documentId)
            )
            .innerJoin(
              dbSchema.storageObject,
              eq(dbSchema.storageObject.id, dbSchema.knowledgeDocument.storageObjectId)
            )
            .where(
              and(scopeCondition, eq(dbSchema.knowledgeDocument.status, 'ready'), minScoreCondition)
            )
            .orderBy(asc(distance))
            .limit(input.limit)

          return yield* Effect.forEach(matches, match =>
            Effect.gen(function* () {
              const document = yield* toKnowledgeDocument({
                document: match.document,
                storage: match.storage
              })

              const chunk = yield* toKnowledgeChunk(match.chunk)

              return {
                chunk,
                score: match.score,
                document
              }
            })
          )
        }).pipe(
          Effect.withSpan('SearchIndexStore.searchChunks'),
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
        ),

      searchChunksByText: input =>
        Effect.gen(function* () {
          const scopeIds = searchScopeIds(input.scope)
          const [singleScopeId] = scopeIds

          const scopeCondition =
            scopeIds.length === 1 && singleScopeId !== undefined
              ? eq(dbSchema.knowledgeChunk.collectionId, singleScopeId)
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
            .innerJoin(
              dbSchema.knowledgeDocument,
              eq(dbSchema.knowledgeDocument.id, dbSchema.knowledgeChunk.documentId)
            )
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

          return yield* Effect.forEach(matches, match =>
            Effect.gen(function* () {
              const document = yield* toKnowledgeDocument({
                document: match.document,
                storage: match.storage
              })

              const chunk = yield* toKnowledgeChunk(match.chunk)

              return {
                chunk,
                score: match.score,
                document
              }
            })
          )
        }).pipe(
          Effect.withSpan('SearchIndexStore.searchChunksByText'),
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
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
                gte(
                  dbSchema.knowledgeChunk.position,
                  Math.max(0, input.position - input.contextChunks)
                ),
                lte(dbSchema.knowledgeChunk.position, input.position + input.contextChunks)
              )
            )
            .orderBy(asc(dbSchema.knowledgeChunk.position))

          return yield* Effect.forEach(rows, toKnowledgeChunk)
        }).pipe(
          Effect.withSpan('SearchIndexStore.getContextChunks'),
          Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
        )
    }

    return api
  })
)

export const TextKnowledgeExtractorLayer = Layer.succeed(KnowledgeExtractor, {
  extract: source =>
    Effect.gen(function* () {
      if (!Predicate.isString(source.content)) {
        return yield* Effect.fail(
          new KnowledgeExtractionError({ message: 'Text extractor requires string content' })
        )
      }

      const content = source.content.trim()

      if (content.length === 0) {
        return yield* Effect.fail(
          new KnowledgeExtractionError({ message: 'Cannot extract empty text' })
        )
      }

      const title = metadataString(source.metadata, 'title')

      return {
        content,
        title,
        metadata: source.metadata
      } satisfies ExtractedKnowledgeDocument
    })
})

type OpenAiEmbeddingsConfigValues = {
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string
}

class OpenAiEmbeddingsConfig extends Context.Service<
  OpenAiEmbeddingsConfig,
  OpenAiEmbeddingsConfigValues
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

export const makeOpenAiKnowledgeEmbedderLayer = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
) =>
  Layer.effect(
    KnowledgeEmbedder,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const config = yield* OpenAiEmbeddingsConfig

      const embedTexts = (texts: ReadonlyArray<string>) =>
        Effect.suspend(() => {
          const inputs = texts.slice()

          return Effect.gen(function* () {
            if (inputs.length === 0) {
              return []
            }

            const request = yield* HttpClientRequest.post(OPENAI_EMBEDDINGS_URL).pipe(
              HttpClientRequest.setHeaders({
                accept: 'application/json',
                authorization: `Bearer ${Redacted.value(config.apiKey)}`,
                'content-type': 'application/json'
              }),
              HttpClientRequest.bodyJson({ model: config.model, input: inputs }),
              Effect.mapError(
                error =>
                  new AppKnowledgeEmbedderError({
                    message: `Could not encode embeddings request: ${error.message}`
                  })
              )
            )

            const response = yield* client.execute(request).pipe(Effect.mapError(toRequestError))

            if (!isOkStatus(response.status)) {
              return yield* failOpenAiResponse(response)
            }

            const parsed = yield* parseOpenAiResponse(response)

            if (parsed.data.length !== inputs.length) {
              return yield* Effect.fail(
                new AppKnowledgeEmbedderError({
                  message: 'OpenAI embeddings response count does not match input count'
                })
              )
            }

            const ordered = parsed.data.toSorted((left, right) => left.index - right.index)

            if (ordered.some((item, index) => item.index !== index)) {
              return yield* Effect.fail(
                new AppKnowledgeEmbedderError({
                  message: 'OpenAI embeddings response indices do not match inputs'
                })
              )
            }

            return ordered.map(item => item.embedding)
          }).pipe(
            Effect.retry({ while: isTransientError, schedule: retryPolicy }),
            Effect.catchTag('AppKnowledgeEmbedderError', error =>
              Effect.fail(new KnowledgeEmbeddingError({ message: error.message, cause: error }))
            )
          )
        })

      return {
        embedTexts,
        embedQuery: query =>
          embedTexts([query]).pipe(
            Effect.flatMap(embeddings => {
              const embedding = embeddings[0]

              return embedding === undefined
                ? Effect.fail(
                    new KnowledgeEmbeddingError({ message: 'OpenAI query embedding is missing' })
                  )
                : Effect.succeed(embedding)
            })
          )
      }
    })
  ).pipe(Layer.provide(OpenAiEmbeddingsConfigLayer), Layer.provide(httpClientLayer))

export const OpenAiKnowledgeEmbedderLayer = makeOpenAiKnowledgeEmbedderLayer(FetchHttpClient.layer)

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
