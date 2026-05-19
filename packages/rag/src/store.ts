import { Context } from 'effect'
import type { Effect } from 'effect'
import type { RagDocument, RagSet, RagChunk, RagSearchScope } from './documents.ts'
import type { RagEmbedding } from './embeddings.ts'
import type { RagStoreError } from './errors.ts'

export type UpsertRagDocumentInput = {
  readonly document: RagDocument
}

export type ReplaceRagDocumentChunksInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly chunks: ReadonlyArray<{
    readonly chunk: RagChunk
    readonly embedding: RagEmbedding
  }>
}

export type MarkRagDocumentReadyInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly title?: string
  readonly summary?: string
  readonly contentHash?: string
  readonly tokenCount: number
  readonly chunkCount: number
}

export type MarkRagDocumentErrorInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly message: string
}

export type RagChunkSearchInput = {
  readonly scope: RagSearchScope
  readonly embedding: RagEmbedding
  readonly limit: number
  readonly minScore?: number
}

export type RagChunkTextSearchInput = {
  readonly scope: RagSearchScope
  readonly query: string
  readonly limit: number
}

export type RagChunkSearchResult = {
  readonly chunk: RagChunk
  readonly score: number
  readonly document: RagDocument
}

export type RagContextChunksInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly position: number
  readonly contextChunks: number
}

export type RagStoreApi = {
  readonly upsertSet: (set: RagSet) => Effect.Effect<RagSet, RagStoreError>
  readonly getSet: (id: string) => Effect.Effect<RagSet, RagStoreError>
  readonly upsertDocument: (
    input: UpsertRagDocumentInput
  ) => Effect.Effect<RagDocument, RagStoreError>
  readonly markDocumentProcessing: (input: {
    readonly ragSetId: string
    readonly documentId: string
  }) => Effect.Effect<RagDocument, RagStoreError>
  readonly replaceDocumentChunks: (
    input: ReplaceRagDocumentChunksInput
  ) => Effect.Effect<void, RagStoreError>
  readonly markDocumentReady: (
    input: MarkRagDocumentReadyInput
  ) => Effect.Effect<RagDocument, RagStoreError>
  readonly markDocumentError: (
    input: MarkRagDocumentErrorInput
  ) => Effect.Effect<void, RagStoreError>
  readonly deleteDocument: (input: {
    readonly ragSetId: string
    readonly documentId: string
  }) => Effect.Effect<void, RagStoreError>
  readonly searchChunks: (
    input: RagChunkSearchInput
  ) => Effect.Effect<ReadonlyArray<RagChunkSearchResult>, RagStoreError>
  readonly searchChunksByText: (
    input: RagChunkTextSearchInput
  ) => Effect.Effect<ReadonlyArray<RagChunkSearchResult>, RagStoreError>
  readonly getContextChunks: (
    input: RagContextChunksInput
  ) => Effect.Effect<ReadonlyArray<RagChunk>, RagStoreError>
}

export class RagStore extends Context.Service<RagStore, RagStoreApi>()('@yolk-sdk/rag/RagStore') {}
