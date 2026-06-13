import { Effect, Layer } from 'effect'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ModelVisibleToolError, modelVisibleToolError } from '@yolk-sdk/agent/tools'
import type { NotFoundError, ValidationError } from '@/lib/core/errors'
import { getKnowledgeContext } from '@/lib/core/knowledge/get-knowledge-context'
import { listUserKnowledgeRecords } from '@/lib/core/knowledge/list-user-knowledge-records'
import { searchUserKnowledge } from '@/lib/core/knowledge/search-user-knowledge'
import { Db } from '@/lib/services/db/live-layer'
import { AppKnowledgeSearchLayer } from '@/lib/services/knowledge-search/live-layer'
import { makeKnowledgeToolModule } from './knowledge-tool.ts'

const KnowledgeToolLayer = Layer.mergeAll(Db.layer, AppKnowledgeSearchLayer.pipe(Layer.provide(Db.layer)))

const unknownToMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const validationToolError = (tool: string, error: ValidationError) =>
  modelVisibleToolError({ tool, message: error.message, reason: 'validation' })

const notFoundToolError = (tool: string, error: NotFoundError) =>
  modelVisibleToolError({ tool, message: error.message, reason: 'not_found' })

const fatalToolError = (tool: string, error: unknown) =>
  error instanceof ToolError || error instanceof ModelVisibleToolError
    ? error
    : new ToolError({ tool, message: unknownToMessage(error), cause: 'execution' })

const listKnowledgeForAgent = (input: {
  readonly userId: string
  readonly query?: string
  readonly policy?: 'archived' | 'pinned' | 'routable' | 'searchable'
  readonly limit: number
}) =>
  listUserKnowledgeRecords(input).pipe(
    Effect.catchTag('ValidationError', error => Effect.fail(validationToolError('list_knowledge_records', error))),
    Effect.provide(KnowledgeToolLayer),
    Effect.mapError(error => fatalToolError('list_knowledge_records', error))
  )

const searchKnowledgeForAgent = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) =>
  searchUserKnowledge(input).pipe(
    Effect.catchTag('ValidationError', error => Effect.fail(validationToolError('search_knowledge', error))),
    Effect.provide(KnowledgeToolLayer),
    Effect.mapError(error => fatalToolError('search_knowledge', error))
  )

const getKnowledgeContextForAgent = (input: {
  readonly userId: string
  readonly recordId: string
  readonly chunkId?: string
  readonly position?: number
  readonly before: number
  readonly after: number
  readonly maxChars: number
}) =>
  getKnowledgeContext(input).pipe(
    Effect.catchTag('ValidationError', error => Effect.fail(validationToolError('get_knowledge_context', error))),
    Effect.catchTag('NotFoundError', error => Effect.fail(notFoundToolError('get_knowledge_context', error))),
    Effect.provide(KnowledgeToolLayer),
    Effect.mapError(error => fatalToolError('get_knowledge_context', error))
  )

export const makeAppKnowledgeToolModule = () =>
  makeKnowledgeToolModule({
    list: listKnowledgeForAgent,
    search: searchKnowledgeForAgent,
    getContext: getKnowledgeContextForAgent
  })
