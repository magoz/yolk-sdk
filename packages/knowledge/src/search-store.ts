import { Context } from 'effect'
import type { Effect } from 'effect'
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeSearchScope, KnowledgeCollection } from './documents.ts'
import type { KnowledgeEmbedding } from './embeddings.ts'
import type { SearchIndexStoreError } from './errors.ts'

export type UpsertKnowledgeDocumentInput = {
  readonly document: KnowledgeDocument
}

export type ReplaceKnowledgeDocumentChunksInput = {
  readonly collectionId: string
  readonly documentId: string
  readonly chunks: ReadonlyArray<{
    readonly chunk: KnowledgeChunk
    readonly embedding: KnowledgeEmbedding
  }>
}

export type MarkKnowledgeDocumentReadyInput = {
  readonly collectionId: string
  readonly documentId: string
  readonly title?: string
  readonly summary?: string
  readonly contentHash?: string
  readonly tokenCount: number
  readonly chunkCount: number
}

export type MarkKnowledgeDocumentErrorInput = {
  readonly collectionId: string
  readonly documentId: string
  readonly message: string
}

export type KnowledgeChunkSearchInput = {
  readonly scope: KnowledgeSearchScope
  readonly embedding: KnowledgeEmbedding
  readonly limit: number
  readonly minScore?: number
}

export type KnowledgeChunkTextSearchInput = {
  readonly scope: KnowledgeSearchScope
  readonly query: string
  readonly limit: number
}

export type KnowledgeChunkSearchResult = {
  readonly chunk: KnowledgeChunk
  readonly score: number
  readonly document: KnowledgeDocument
}

export type KnowledgeSearchContextChunksInput = {
  readonly collectionId: string
  readonly documentId: string
  readonly position: number
  readonly contextChunks: number
}

export type SearchIndexStoreApi = {
  readonly upsertSet: (set: KnowledgeCollection) => Effect.Effect<KnowledgeCollection, SearchIndexStoreError>
  readonly getSet: (id: string) => Effect.Effect<KnowledgeCollection, SearchIndexStoreError>
  readonly upsertDocument: (
    input: UpsertKnowledgeDocumentInput
  ) => Effect.Effect<KnowledgeDocument, SearchIndexStoreError>
  readonly markDocumentProcessing: (input: {
    readonly collectionId: string
    readonly documentId: string
  }) => Effect.Effect<KnowledgeDocument, SearchIndexStoreError>
  readonly replaceDocumentChunks: (
    input: ReplaceKnowledgeDocumentChunksInput
  ) => Effect.Effect<void, SearchIndexStoreError>
  readonly markDocumentReady: (
    input: MarkKnowledgeDocumentReadyInput
  ) => Effect.Effect<KnowledgeDocument, SearchIndexStoreError>
  readonly markDocumentError: (
    input: MarkKnowledgeDocumentErrorInput
  ) => Effect.Effect<void, SearchIndexStoreError>
  readonly deleteDocument: (input: {
    readonly collectionId: string
    readonly documentId: string
  }) => Effect.Effect<void, SearchIndexStoreError>
  readonly searchChunks: (
    input: KnowledgeChunkSearchInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeChunkSearchResult>, SearchIndexStoreError>
  readonly searchChunksByText: (
    input: KnowledgeChunkTextSearchInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeChunkSearchResult>, SearchIndexStoreError>
  readonly getContextChunks: (
    input: KnowledgeSearchContextChunksInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeChunk>, SearchIndexStoreError>
}

export class SearchIndexStore extends Context.Service<SearchIndexStore, SearchIndexStoreApi>()(
  '@yolk-sdk/knowledge/SearchIndexStore'
) {}
