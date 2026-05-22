import { Array as Arr, Effect } from 'effect'
import { KnowledgeChunker } from './chunking.ts'
import { KnowledgeEmbedder } from './embeddings.ts'
import { KnowledgeExtractor } from './extraction.ts'
import { KnowledgeSummarizer } from './summarization.ts'
import type { LoadedKnowledgeSource } from './extraction.ts'
import { KnowledgeIngestionError } from './errors.ts'
import { SearchIndexStore } from './search-store.ts'

export type IngestKnowledgeDocumentInput = {
  readonly collectionId: string
  readonly documentId: string
  readonly source: LoadedKnowledgeSource
  readonly contentHash?: string
}

const markErrorBestEffort = (input: IngestKnowledgeDocumentInput, error: KnowledgeIngestionError) =>
  Effect.gen(function* () {
    const store = yield* SearchIndexStore
    yield* store.markDocumentError({
      collectionId: input.collectionId,
      documentId: input.documentId,
      message: error.message
    })
  }).pipe(Effect.catch(() => Effect.void))

export const ingestKnowledgeDocument = (input: IngestKnowledgeDocumentInput) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      'knowledge_search.set_id': input.collectionId,
      'knowledge_search.document_id': input.documentId,
      'knowledge_search.source_type': input.source.source._tag
    })
    const store = yield* SearchIndexStore
    const extractor = yield* KnowledgeExtractor
    const chunker = yield* KnowledgeChunker
    const embedder = yield* KnowledgeEmbedder
    const summarizer = yield* KnowledgeSummarizer
    const collection = yield* store
      .getSet(input.collectionId)
      .pipe(
        Effect.mapError(
          error => new KnowledgeIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )

    yield* store
      .upsertDocument({
        document: {
          id: input.documentId,
          collectionId: input.collectionId,
          source: input.source.source,
          status: 'processing',
          metadata: input.source.metadata
        }
      })
      .pipe(
        Effect.mapError(
          error => new KnowledgeIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )

    const extracted = yield* extractor
      .extract(input.source)
      .pipe(
        Effect.mapError(
          error => new KnowledgeIngestionError({ message: error.message, stage: 'extract', cause: error })
        )
      )

    const chunks = yield* chunker
      .chunk({
        collectionId: input.collectionId,
        documentId: input.documentId,
        content: extracted.content,
        maxTokens: collection.chunkingConfig.maxTokens,
        metadata: extracted.metadata
      })
      .pipe(
        Effect.mapError(
          error => new KnowledgeIngestionError({ message: error.message, stage: 'chunk', cause: error })
        )
      )

    const indexed = yield* Effect.all(
      {
        embeddings: embedder.embedTexts(chunks.map(chunk => chunk.content)).pipe(
          Effect.mapError(
            error => new KnowledgeIngestionError({ message: error.message, stage: 'embed', cause: error })
          )
        ),
        summary: summarizer
          .summarize({
            content: extracted.content,
            sourceTitle: extracted.title,
            metadata: extracted.metadata
          })
          .pipe(
            Effect.mapError(
              error =>
                new KnowledgeIngestionError({ message: error.message, stage: 'summarize', cause: error })
            )
          )
      },
      { concurrency: 'unbounded' }
    )

    if (indexed.embeddings.length !== chunks.length) {
      return yield* Effect.fail(
        new KnowledgeIngestionError({ message: 'Embedding count did not match chunk count', stage: 'embed' })
      )
    }

    const indexedChunks = Arr.zip(chunks, indexed.embeddings).map(([chunk, embedding]) => ({
      chunk,
      embedding
    }))
    yield* store
      .replaceDocumentChunks({
        collectionId: input.collectionId,
        documentId: input.documentId,
        chunks: indexedChunks
      })
      .pipe(
        Effect.mapError(
          error => new KnowledgeIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )

    const tokenCount = chunks.reduce((total, chunk) => total + chunk.tokenCount, 0)
    return yield* store
      .markDocumentReady({
        collectionId: input.collectionId,
        documentId: input.documentId,
        title: indexed.summary.title ?? extracted.title,
        summary: indexed.summary.summary ?? extracted.summary,
        contentHash: input.contentHash,
        tokenCount,
        chunkCount: chunks.length
      })
      .pipe(
        Effect.mapError(
          error => new KnowledgeIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )
  }).pipe(
    Effect.withSpan('knowledge_search.ingestDocument'),
    Effect.catch(error => markErrorBestEffort(input, error).pipe(Effect.flatMap(() => Effect.fail(error))))
  )

export type KnowledgeIngestionPipeline = {
  readonly ingest: (input: IngestKnowledgeDocumentInput) => ReturnType<typeof ingestKnowledgeDocument>
}

export const makeIngestionPipeline = (): KnowledgeIngestionPipeline => ({
  ingest: ingestKnowledgeDocument
})
