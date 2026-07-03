import { Context } from 'effect'
import type { Effect } from 'effect'
import type { ExtractedKnowledgeDocument, KnowledgeMetadata, KnowledgeSource } from './documents.ts'
import type { KnowledgeExtractionError } from './errors.ts'

export type LoadedKnowledgeSource = {
  readonly source: KnowledgeSource
  readonly content: string | Uint8Array
  readonly mediaType?: string
  readonly metadata?: KnowledgeMetadata
}

export type KnowledgeExtractorApi = {
  readonly extract: (
    source: LoadedKnowledgeSource
  ) => Effect.Effect<ExtractedKnowledgeDocument, KnowledgeExtractionError>
}

export class KnowledgeExtractor extends Context.Service<
  KnowledgeExtractor,
  KnowledgeExtractorApi
>()('@yolk-sdk/knowledge/KnowledgeExtractor') {}
