import type * as schema from '@/lib/services/db/schema'

export type AppRagDocumentRecord = {
  readonly document: schema.RagDocument
  readonly storageObject: schema.StorageObject
}

export type AppRagDocumentWithContent = AppRagDocumentRecord & {
  readonly content: string
}

export type AppRagChunkRecord = {
  readonly chunk: schema.RagChunk
  readonly document: schema.RagDocument
  readonly storageObject: schema.StorageObject
}
