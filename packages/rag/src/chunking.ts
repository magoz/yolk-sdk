import type { Effect } from 'effect'
import type { RagChunk, RagMetadata } from './documents.ts'
import type { RagChunkingError } from './errors.ts'

export type ChunkRagDocumentInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly content: string
  readonly metadata?: RagMetadata
}

export type RagChunker = {
  readonly chunk: (
    input: ChunkRagDocumentInput
  ) => Effect.Effect<ReadonlyArray<RagChunk>, RagChunkingError>
}
