import type * as schema from '@/lib/services/db/schema'

export type AppKnowledgeDocumentRecord = {
  readonly document: schema.KnowledgeDocument
  readonly storageRecord: schema.StorageObject
}

export type AppKnowledgeDocumentWithContent = AppKnowledgeDocumentRecord & {
  readonly content: string
}

export type AppKnowledgeChunkRecord = {
  readonly chunk: schema.KnowledgeChunk
  readonly document: schema.KnowledgeDocument
  readonly storageRecord: schema.StorageObject
}
