import { Context, Effect, Layer } from 'effect'
import type {
  KnowledgeChunk,
  KnowledgeDocumentId,
  KnowledgeMetadata,
  KnowledgeScopeId
} from './documents.ts'
import { KnowledgeChunkingError } from './errors.ts'

export type ChunkKnowledgeDocumentInput = {
  readonly scopeId: KnowledgeScopeId
  readonly documentId: KnowledgeDocumentId
  readonly content: string
  readonly maxTokens?: number
  readonly metadata?: KnowledgeMetadata
}

export type KnowledgeChunkerApi = {
  readonly chunk: (
    input: ChunkKnowledgeDocumentInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeChunk>, KnowledgeChunkingError>
}

export class KnowledgeChunker extends Context.Service<KnowledgeChunker, KnowledgeChunkerApi>()(
  '@yolk-sdk/knowledge/KnowledgeChunker'
) {}

/**
 * The default `o200k_base` tokenizer, loaded on first use. Importing this module or building
 * `DefaultKnowledgeChunkerLive` does not evaluate it: its rank tables are megabytes of code that
 * a request which never chunks should not pay for. The runtime's module cache makes the load
 * happen once per process or isolate; later calls resolve the evaluated module.
 *
 * Keep this the only reference to `./chunking-tokenizer.ts`, and keep it a dynamic `import()`:
 * a static import or re-export would pull the tokenizer back into every importer.
 */
const loadTokenizer = Effect.tryPromise({
  try: () => import('./chunking-tokenizer.ts'),
  catch: cause =>
    new KnowledgeChunkingError({ message: 'Failed to load the default tokenizer', cause })
})

/**
 * Counts `text`'s tokens with the default chunker's tokenizer (`o200k_base`), loading it on first
 * use.
 */
export const countKnowledgeChunkTokens = (
  text: string
): Effect.Effect<number, KnowledgeChunkingError> =>
  Effect.map(loadTokenizer, tokenizer => tokenizer.countTokens(text))

const sanitizeText = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * Splits a document into chunks of at most `maxTokens` default-tokenizer tokens at paragraph and
 * sentence boundaries. Input that cannot be chunked (a `maxTokens` that is not a positive integer,
 * empty content) fails before the tokenizer loads.
 */
export const chunkKnowledgeText = (
  input: ChunkKnowledgeDocumentInput,
  maxTokens: number
): Effect.Effect<ReadonlyArray<KnowledgeChunk>, KnowledgeChunkingError> =>
  Effect.gen(function* () {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      return yield* Effect.fail(
        new KnowledgeChunkingError({ message: 'Chunk maxTokens must be a positive integer' })
      )
    }

    const sanitized = sanitizeText(input.content)

    if (sanitized.length === 0) {
      return yield* Effect.fail(
        new KnowledgeChunkingError({ message: 'Cannot chunk empty content' })
      )
    }

    const tokenizer = yield* loadTokenizer
    const chunks = tokenizer.chunkText(sanitized, maxTokens)

    if (chunks.length === 0) {
      return yield* Effect.fail(new KnowledgeChunkingError({ message: 'No chunks produced' }))
    }

    return chunks.map(({ content, tokenCount }, position): KnowledgeChunk => ({
      id: `${input.documentId}:chunk:${position}`,
      scopeId: input.scopeId,
      documentId: input.documentId,
      content,
      position,
      tokenCount,
      metadata: input.metadata
    }))
  })

/**
 * The default chunker: `chunkKnowledgeText` with each document's `maxTokens`, else
 * `input.maxTokens`. The tokenizer loads when the first document is chunked.
 */
export const makeDefaultKnowledgeChunker = (input: {
  readonly maxTokens: number
}): KnowledgeChunkerApi => ({
  chunk: document => chunkKnowledgeText(document, document.maxTokens ?? input.maxTokens)
})

/**
 * Provides `KnowledgeChunker` with `makeDefaultKnowledgeChunker` (512 tokens unless given).
 * Building the layer is cheap: the tokenizer loads when the first document is chunked.
 */
export const DefaultKnowledgeChunkerLive = (
  input: { readonly maxTokens: number } = { maxTokens: 512 }
) => Layer.succeed(KnowledgeChunker, makeDefaultKnowledgeChunker(input))
