import { Effect, Layer } from 'effect'
import { ToolError } from '@yolk/agent/loop'
import { searchUserKnowledge } from '@/lib/core/knowledge/search-user-knowledge'
import { Db } from '@/lib/services/db/live-layer'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { makeKnowledgeToolModule } from './knowledge-tool.ts'

const KnowledgeToolLayer = Layer.mergeAll(Db.layer, AppRagLayer.pipe(Layer.provide(Db.layer)))

const unknownToMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const searchKnowledgeForAgent = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) =>
  searchUserKnowledge(input).pipe(
    Effect.provide(KnowledgeToolLayer),
    Effect.mapError(error =>
      new ToolError({ tool: 'search_knowledge', message: unknownToMessage(error), cause: 'execution' })
    )
  )

export const makeAppKnowledgeToolModule = () => makeKnowledgeToolModule(searchKnowledgeForAgent)
