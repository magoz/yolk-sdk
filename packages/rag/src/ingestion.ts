import { Array as Arr, Effect } from 'effect'
import { RagChunker } from './chunking.ts'
import { RagEmbedder } from './embeddings.ts'
import { RagExtractor } from './extraction.ts'
import { RagSummarizer } from './summarization.ts'
import type { LoadedRagSource } from './extraction.ts'
import { RagIngestionError } from './errors.ts'
import { RagStore } from './store.ts'

export type IngestRagDocumentInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly source: LoadedRagSource
  readonly contentHash?: string
}

const markErrorBestEffort = (input: IngestRagDocumentInput, error: RagIngestionError) =>
  Effect.gen(function* () {
    const store = yield* RagStore
    yield* store.markDocumentError({
      ragSetId: input.ragSetId,
      documentId: input.documentId,
      message: error.message
    })
  }).pipe(Effect.catch(() => Effect.void))

export const ingestRagDocument = (input: IngestRagDocumentInput) =>
  Effect.gen(function* () {
    const store = yield* RagStore
    const extractor = yield* RagExtractor
    const chunker = yield* RagChunker
    const embedder = yield* RagEmbedder
    const summarizer = yield* RagSummarizer
    const ragSet = yield* store
      .getSet(input.ragSetId)
      .pipe(
        Effect.mapError(
          error => new RagIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )

    yield* store
      .upsertDocument({
        document: {
          id: input.documentId,
          ragSetId: input.ragSetId,
          source: input.source.source,
          status: 'processing',
          metadata: input.source.metadata
        }
      })
      .pipe(
        Effect.mapError(
          error => new RagIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )

    const extracted = yield* extractor
      .extract(input.source)
      .pipe(
        Effect.mapError(
          error => new RagIngestionError({ message: error.message, stage: 'extract', cause: error })
        )
      )

    const chunks = yield* chunker
      .chunk({
        ragSetId: input.ragSetId,
        documentId: input.documentId,
        content: extracted.content,
        maxTokens: ragSet.chunkingConfig.maxTokens,
        metadata: extracted.metadata
      })
      .pipe(
        Effect.mapError(
          error => new RagIngestionError({ message: error.message, stage: 'chunk', cause: error })
        )
      )

    const indexed = yield* Effect.all(
      {
        embeddings: embedder.embedTexts(chunks.map(chunk => chunk.content)).pipe(
          Effect.mapError(
            error => new RagIngestionError({ message: error.message, stage: 'embed', cause: error })
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
                new RagIngestionError({ message: error.message, stage: 'summarize', cause: error })
            )
          )
      },
      { concurrency: 'unbounded' }
    )

    if (indexed.embeddings.length !== chunks.length) {
      return yield* Effect.fail(
        new RagIngestionError({ message: 'Embedding count did not match chunk count', stage: 'embed' })
      )
    }

    const indexedChunks = Arr.zip(chunks, indexed.embeddings).map(([chunk, embedding]) => ({
      chunk,
      embedding
    }))
    yield* store
      .replaceDocumentChunks({
        ragSetId: input.ragSetId,
        documentId: input.documentId,
        chunks: indexedChunks
      })
      .pipe(
        Effect.mapError(
          error => new RagIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )

    const tokenCount = chunks.reduce((total, chunk) => total + chunk.tokenCount, 0)
    return yield* store
      .markDocumentReady({
        ragSetId: input.ragSetId,
        documentId: input.documentId,
        title: indexed.summary.title ?? extracted.title,
        summary: indexed.summary.summary ?? extracted.summary,
        contentHash: input.contentHash,
        tokenCount,
        chunkCount: chunks.length
      })
      .pipe(
        Effect.mapError(
          error => new RagIngestionError({ message: error.message, stage: 'store', cause: error })
        )
      )
  }).pipe(
    Effect.catch(error => markErrorBestEffort(input, error).pipe(Effect.flatMap(() => Effect.fail(error))))
  )

export type RagIngestionPipeline = {
  readonly ingest: (input: IngestRagDocumentInput) => ReturnType<typeof ingestRagDocument>
}

export const makeIngestionPipeline = (): RagIngestionPipeline => ({
  ingest: ingestRagDocument
})
