import { Context, Effect, Layer } from 'effect'
import type { RagMetadata } from './documents.ts'
import type { RagSummarizationError } from './errors.ts'

export type RagDocumentSummary = {
  readonly title?: string
  readonly summary?: string
}

export type SummarizeRagDocumentInput = {
  readonly content: string
  readonly sourceTitle?: string
  readonly metadata?: RagMetadata
}

export type RagSummarizerApi = {
  readonly summarize: (
    input: SummarizeRagDocumentInput
  ) => Effect.Effect<RagDocumentSummary, RagSummarizationError>
}

export class RagSummarizer extends Context.Service<RagSummarizer, RagSummarizerApi>()(
  '@yolk/rag/RagSummarizer'
) {}

export const NoopRagSummarizerLive = Layer.succeed(RagSummarizer, {
  summarize: input => Effect.succeed({ title: input.sourceTitle })
})
