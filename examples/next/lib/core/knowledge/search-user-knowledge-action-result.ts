import type { KnowledgeAvailability } from './availability'

export type KnowledgeSearchActionResult =
  | {
      readonly _tag: 'Success'
      readonly results: ReadonlyArray<{
        readonly documentId: string
        readonly title: string
        readonly purpose: string
        readonly origin: string
        readonly availability: KnowledgeAvailability
        readonly score: number
        readonly vectorScore?: number
        readonly textScore?: number
        readonly chunkId: string
        readonly text: string
      }>
    }
  | { readonly _tag: 'Error'; readonly message: string }
