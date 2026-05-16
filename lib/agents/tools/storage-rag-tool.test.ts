import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/agent/protocol'
import type { RagSearchResult } from '@yolk/rag/retrieval'
import { resolveAgentToolSet } from './resolve-toolset'
import { makeStorageRagToolModule } from './storage-rag-tool'

const searchResult: RagSearchResult = {
  chunk: {
    id: 'chunk_1',
    ragSetId: 'set_1',
    documentId: 'doc_1',
    content: 'matched chunk',
    position: 0,
    tokenCount: 2
  },
  score: 0.87,
  document: {
    id: 'doc_1',
    ragSetId: 'set_1',
    source: { _tag: 'Text', label: 'Project note' },
    status: 'ready',
    title: 'Project note'
  },
  context: [
    {
      id: 'chunk_1',
      ragSetId: 'set_1',
      documentId: 'doc_1',
      content: 'context chunk',
      position: 0,
      tokenCount: 2
    }
  ]
}

describe('storage RAG tool', () => {
  it.effect('searches authenticated user storage', () => {
    const calls: Array<{
      readonly userId: string
      readonly query: string
      readonly limit: number
      readonly minScore?: number
      readonly contextChunks: number
    }> = []
    const toolModule = makeStorageRagToolModule(input =>
      Effect.sync(() => {
        calls.push(input)
        return [searchResult]
      })
    )

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'search_storage',
          params: { query: ' docs ', limit: 50, minScore: 0.4, contextChunks: 9 }
        })
      )

      expect(calls).toEqual([
        { userId: 'user_1', query: 'docs', limit: 20, minScore: 0.4, contextChunks: 5 }
      ])
      expect(result.content).toContain('Storage search results for: docs')
      expect(result.content).toContain('Source: Project note')
      expect(result.content).toContain('context chunk')
    })
  })

  it.effect('rejects blank queries', () => {
    const toolModule = makeStorageRagToolModule(() => Effect.succeed([]))

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      const error = yield* toolSet
        .execute(
          ToolCall.make({
            id: 'call_1',
            name: 'search_storage',
            params: { query: '   ' }
          })
        )
        .pipe(Effect.flip)

      expect(error.cause).toBe('validation')
    })
  })

  it.effect('is available to subagents', () => {
    const toolModule = makeStorageRagToolModule(() => Effect.succeed([]))

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1', subagent: true }
      })

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['search_storage'])
    })
  })
})
