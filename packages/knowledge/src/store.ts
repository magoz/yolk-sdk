import { Context } from 'effect'
import type { Effect } from 'effect'
import type {
  CreateKnowledgeDocumentInput,
  IndexedKnowledgeDocument,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentId,
  KnowledgeFile,
  KnowledgeScope,
  KnowledgeScopeId,
  KnowledgeSearchScope,
  UpdateKnowledgeDocumentInput
} from './documents.ts'
import type { KnowledgeEmbedding } from './embeddings.ts'
import type { KnowledgeStoreError, SearchIndexStoreError } from './errors.ts'

export type GetKnowledgeDocumentInput = {
  readonly scope: KnowledgeScope
  readonly id: KnowledgeDocumentId
}

export type GetKnowledgeDocumentBySlugInput = {
  readonly scope: KnowledgeScope
  readonly slug: string
}

export type ListKnowledgeDocumentsInput = {
  readonly scope: KnowledgeScope
  readonly limit: number
  readonly availability?: KnowledgeDocument['availability']
}

export type ListKnowledgeDocumentsResult = {
  readonly documents: ReadonlyArray<KnowledgeDocument>
}

export type ListPinnedKnowledgeInput = {
  readonly scope: KnowledgeScope
  readonly limit: number
}

export type ListPinnedKnowledgeResult = {
  readonly documents: ReadonlyArray<KnowledgeDocument>
}

export type KnowledgeStoreApi = {
  readonly createDocument: (
    input: CreateKnowledgeDocumentInput
  ) => Effect.Effect<KnowledgeDocument, KnowledgeStoreError>
  readonly updateDocument: (
    input: UpdateKnowledgeDocumentInput
  ) => Effect.Effect<KnowledgeDocument, KnowledgeStoreError>
  readonly getDocument: (
    input: GetKnowledgeDocumentInput
  ) => Effect.Effect<KnowledgeDocument, KnowledgeStoreError>
  readonly getDocumentBySlug: (
    input: GetKnowledgeDocumentBySlugInput
  ) => Effect.Effect<KnowledgeDocument, KnowledgeStoreError>
  readonly listDocuments: (
    input: ListKnowledgeDocumentsInput
  ) => Effect.Effect<ListKnowledgeDocumentsResult, KnowledgeStoreError>
  readonly listPinned: (
    input: ListPinnedKnowledgeInput
  ) => Effect.Effect<ListPinnedKnowledgeResult, KnowledgeStoreError>
  readonly deleteDocument: (
    input: GetKnowledgeDocumentInput
  ) => Effect.Effect<void, KnowledgeStoreError>
  readonly listFiles: (
    input: GetKnowledgeDocumentInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeFile>, KnowledgeStoreError>
}

export class KnowledgeStore extends Context.Service<KnowledgeStore, KnowledgeStoreApi>()(
  '@yolk-sdk/knowledge/KnowledgeStore'
) {}

export type UpsertIndexedKnowledgeDocumentInput = {
  readonly document: IndexedKnowledgeDocument
}

export type ReplaceKnowledgeDocumentChunksInput = {
  readonly scopeId: KnowledgeScopeId
  readonly documentId: KnowledgeDocumentId
  readonly chunks: ReadonlyArray<{
    readonly chunk: KnowledgeChunk
    readonly embedding: KnowledgeEmbedding
  }>
}

export type MarkKnowledgeDocumentReadyInput = {
  readonly scopeId: KnowledgeScopeId
  readonly documentId: KnowledgeDocumentId
  readonly title?: string
  readonly summary?: string
  readonly contentHash?: string
  readonly tokenCount: number
  readonly chunkCount: number
}

export type MarkKnowledgeDocumentErrorInput = {
  readonly scopeId: KnowledgeScopeId
  readonly documentId: KnowledgeDocumentId
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
  readonly document: IndexedKnowledgeDocument
}

export type KnowledgeSearchContextChunksInput = {
  readonly scopeId: KnowledgeScopeId
  readonly documentId: KnowledgeDocumentId
  readonly position: number
  readonly contextChunks: number
}

export type SearchIndexStoreApi = {
  readonly upsertDocument: (
    input: UpsertIndexedKnowledgeDocumentInput
  ) => Effect.Effect<IndexedKnowledgeDocument, SearchIndexStoreError>
  readonly markDocumentProcessing: (input: {
    readonly scopeId: KnowledgeScopeId
    readonly documentId: KnowledgeDocumentId
  }) => Effect.Effect<IndexedKnowledgeDocument, SearchIndexStoreError>
  readonly replaceDocumentChunks: (
    input: ReplaceKnowledgeDocumentChunksInput
  ) => Effect.Effect<void, SearchIndexStoreError>
  readonly markDocumentReady: (
    input: MarkKnowledgeDocumentReadyInput
  ) => Effect.Effect<IndexedKnowledgeDocument, SearchIndexStoreError>
  readonly markDocumentError: (
    input: MarkKnowledgeDocumentErrorInput
  ) => Effect.Effect<void, SearchIndexStoreError>
  readonly deleteDocument: (input: {
    readonly scopeId: KnowledgeScopeId
    readonly documentId: KnowledgeDocumentId
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
