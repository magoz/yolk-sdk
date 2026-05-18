import { Effect, Layer } from 'effect'
import { ToolError } from '@yolk/agent/loop'
import { getKnowledgeContext } from '@/lib/core/knowledge/get-knowledge-context'
import { listUserKnowledgeObjects } from '@/lib/core/knowledge/list-user-knowledge-objects'
import { searchUserKnowledge } from '@/lib/core/knowledge/search-user-knowledge'
import { Db } from '@/lib/services/db/live-layer'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { makeKnowledgeToolModule } from './knowledge-tool.ts'

const KnowledgeToolLayer = Layer.mergeAll(Db.layer, AppRagLayer.pipe(Layer.provide(Db.layer)))

const unknownToMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const listKnowledgeForAgent = (input: {
  readonly userId: string
  readonly query?: string
  readonly policy?: 'archival' | 'pinned' | 'routable' | 'searchable'
  readonly limit: number
}) =>
  listUserKnowledgeObjects(input).pipe(
    Effect.provide(KnowledgeToolLayer),
    Effect.mapError(error =>
      new ToolError({ tool: 'list_knowledge_objects', message: unknownToMessage(error), cause: 'execution' })
    )
  )

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

const getKnowledgeContextForAgent = (input: {
  readonly userId: string
  readonly objectId: string
  readonly chunkId?: string
  readonly position?: number
  readonly before: number
  readonly after: number
  readonly maxChars: number
}) =>
  getKnowledgeContext(input).pipe(
    Effect.provide(KnowledgeToolLayer),
    Effect.mapError(error =>
      new ToolError({ tool: 'get_knowledge_context', message: unknownToMessage(error), cause: 'execution' })
    )
  )

export const makeAppKnowledgeToolModule = () =>
  makeKnowledgeToolModule({
    list: listKnowledgeForAgent,
    search: searchKnowledgeForAgent,
    getContext: getKnowledgeContextForAgent
  })
