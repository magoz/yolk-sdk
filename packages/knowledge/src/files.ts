import { Context } from 'effect'
import type { Effect } from 'effect'
import type { KnowledgeFileError } from './errors.ts'

export type PutKnowledgeFileInput = {
  readonly storageKey: string
  readonly mediaType?: string
  readonly bytes: Uint8Array
}

export type GetKnowledgeFileInput = {
  readonly storageKey: string
}

export type KnowledgeFileBlobStoreApi = {
  readonly putFile: (input: PutKnowledgeFileInput) => Effect.Effect<void, KnowledgeFileError>
  readonly getFile: (input: GetKnowledgeFileInput) => Effect.Effect<Uint8Array, KnowledgeFileError>
  readonly deleteFile: (input: GetKnowledgeFileInput) => Effect.Effect<void, KnowledgeFileError>
}

export class KnowledgeFileBlobStore extends Context.Service<
  KnowledgeFileBlobStore,
  KnowledgeFileBlobStoreApi
>()('@yolk-sdk/knowledge/KnowledgeFileBlobStore') {}
