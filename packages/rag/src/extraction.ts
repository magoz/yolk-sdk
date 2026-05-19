import { Context } from 'effect'
import type { Effect } from 'effect'
import type { ExtractedRagDocument, RagMetadata, RagSource } from './documents.ts'
import type { RagExtractionError } from './errors.ts'

export type LoadedRagSource = {
  readonly source: RagSource
  readonly content: string | Uint8Array
  readonly mediaType?: string
  readonly metadata?: RagMetadata
}

export type RagExtractorApi = {
  readonly extract: (
    source: LoadedRagSource
  ) => Effect.Effect<ExtractedRagDocument, RagExtractionError>
}

export class RagExtractor extends Context.Service<RagExtractor, RagExtractorApi>()(
  '@yolk-sdk/rag/RagExtractor'
) {}
