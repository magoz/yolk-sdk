import type { Effect } from 'effect'
import type { ExtractedRagDocument, RagDocument, RagSource } from './documents.ts'
import type { RagIngestionError } from './errors.ts'

export type IngestRagDocumentInput = {
  readonly ragSetId: string
  readonly documentId: string
  readonly source: RagSource
  readonly extracted: ExtractedRagDocument
}

export type RagIngestionPipeline = {
  readonly ingest: (
    input: IngestRagDocumentInput
  ) => Effect.Effect<RagDocument, RagIngestionError>
}
