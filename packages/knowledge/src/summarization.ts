import { Context, Effect, Layer } from 'effect'
import type { KnowledgeMetadata } from './documents.ts'
import type { KnowledgeSummarizationError } from './errors.ts'

export type KnowledgeDocumentSummary = {
  readonly title?: string
  readonly summary?: string
}

export type SummarizeKnowledgeDocumentInput = {
  readonly content: string
  readonly sourceTitle?: string
  readonly metadata?: KnowledgeMetadata
}

export type KnowledgeSummarizerApi = {
  readonly summarize: (
    input: SummarizeKnowledgeDocumentInput
  ) => Effect.Effect<KnowledgeDocumentSummary, KnowledgeSummarizationError>
}

export class KnowledgeSummarizer extends Context.Service<
  KnowledgeSummarizer,
  KnowledgeSummarizerApi
>()('@yolk-sdk/knowledge/KnowledgeSummarizer') {}

export const NoopKnowledgeSummarizerLive = Layer.succeed(KnowledgeSummarizer, {
  summarize: input => Effect.succeed({ title: input.sourceTitle })
})
