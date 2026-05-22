import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import type { KnowledgeSearchResult } from '@yolk-sdk/knowledge/search'
import { resolveAgentToolSet } from './resolve-toolset'
import { makeStorageSearchToolModule } from './storage-search-tool'

const searchResult: KnowledgeSearchResult = {
  chunk: {
    id: 'chunk_1',
    collectionId: 'set_1',
    documentId: 'doc_1',
    content: 'matched chunk',
    position: 0,
    tokenCount: 2
  },
  score: 0.87,
  document: {
    id: 'doc_1',
    collectionId: 'set_1',
    source: { _tag: 'Text', label: 'Project note' },
    status: 'ready',
    title: 'Project note'
  },
  context: [
    {
      id: 'chunk_1',
      collectionId: 'set_1',
      documentId: 'doc_1',
      content: 'context chunk',
      position: 0,
      tokenCount: 2
    }
  ]
}

describe('storage knowledge search tool', () => {
  it.effect('searches authenticated user storage', () => {
    const calls: Array<{
      readonly userId: string
      readonly query: string
      readonly limit: number
      readonly minScore?: number
      readonly contextChunks: number
    }> = []
    const toolModule = makeStorageSearchToolModule(input =>
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
          params: { queries: [' docs '], limit: 50, minScore: 0.4, contextChunks: 9 }
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
    const toolModule = makeStorageSearchToolModule(() => Effect.succeed([]))

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
            params: { queries: ['   '] }
          })
        )
        .pipe(Effect.flip)

      expect(error.cause).toBe('validation')
    })
  })

  it.effect('runs multiple storage queries', () => {
    const calls: Array<string> = []
    const toolModule = makeStorageSearchToolModule(input =>
      Effect.sync(() => {
        calls.push(input.query)
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
          params: { queries: ['alpha', ' beta '], limit: 2 }
        })
      )

      expect(calls).toEqual(['alpha', 'beta'])
      expect(result.content).toContain('Storage search results')
      expect(result.content).toContain('Storage search results for: alpha')
      expect(result.content).toContain('Storage search results for: beta')
    })
  })

  it.effect('lists storage sources when handler is provided', () => {
    const toolModule = makeStorageSearchToolModule({
      search: () => Effect.succeed([]),
      listSources: () =>
        Effect.succeed([
          {
            id: 'source_1',
            name: 'notes.pdf',
            sourceType: 'file',
            status: 'ready',
            summary: 'Project notes',
            chunkCount: 3,
            tokenCount: 42,
            createdAt: '2026-05-17T00:00:00.000Z'
          }
        ])
    })

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'list_storage_sources', params: {} })
      )

      expect(result.content).toContain('Storage sources')
      expect(result.content).toContain('Name: notes.pdf')
      expect(result.content).toContain('Summary: Project notes')
    })
  })

  it.effect('reads storage source detail when handler is provided', () => {
    const toolModule = makeStorageSearchToolModule({
      search: () => Effect.succeed([]),
      getSource: input =>
        Effect.succeed({
          id: input.id,
          name: 'notes.pdf',
          sourceType: 'file',
          status: 'ready',
          summary: 'Project notes',
          chunkCount: 3,
          tokenCount: 42,
          createdAt: '2026-05-17T00:00:00.000Z',
          mediaType: 'application/pdf',
          byteSize: 123,
          text: 'full extracted text',
          textTruncated: false,
          textCharacters: 19
        })
    })

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'get_storage_source',
          params: { id: 'source_1', maxChars: 50_000 }
        })
      )

      expect(result.content).toContain('Storage source: notes.pdf')
      expect(result.content).toContain('Media type: application/pdf')
      expect(result.content).toContain('full extracted text')
    })
  })

  it.effect('is available to subagents', () => {
    const toolModule = makeStorageSearchToolModule(() => Effect.succeed([]))

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1', subagent: true }
      })

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['search_storage'])
    })
  })

  it.effect('is available to voice', () => {
    const toolModule = makeStorageSearchToolModule({
      search: () => Effect.succeed([]),
      listSources: () => Effect.succeed([]),
      getSource: () =>
        Effect.succeed({
          id: 'source_1',
          name: 'notes.pdf',
          sourceType: 'file',
          createdAt: '2026-05-17T00:00:00.000Z',
          text: '',
          textTruncated: false,
          textCharacters: 0
        })
    })

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'voice', route: '/agent', userId: 'user_1' }
      })

      expect(toolSet.tools.map(tool => tool.name)).toEqual([
        'search_storage',
        'list_storage_sources',
        'get_storage_source'
      ])
    })
  })
})
