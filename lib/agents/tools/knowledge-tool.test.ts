import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { resolveAgentToolSet } from './resolve-toolset'
import { makeKnowledgeToolModule } from './knowledge-tool'
import type { KnowledgeContextWindow } from '@/lib/core/knowledge/get-knowledge-context'
import type { KnowledgeObjectSummary } from '@/lib/core/knowledge/list-user-knowledge-objects'
import type { KnowledgeSearchResult } from '@/lib/core/knowledge/search-user-knowledge'

const date = new Date('2026-05-18T00:00:00.000Z')

const searchResult: KnowledgeSearchResult = {
  object: {
    id: 'object_1',
    userId: 'user_1',
    role: 'note',
    title: 'Project memory',
    status: 'ready',
    contextPolicy: 'searchable',
    summary: 'Useful memory',
    metadata: {},
    createdAt: date,
    updatedAt: date
  },
  representation: {
    id: 'representation_1',
    objectId: 'object_1',
    artifactId: null,
    modality: 'text',
    status: 'ready',
    contentText: 'Full text',
    summary: null,
    model: null,
    errorMessage: null,
    metadata: {},
    createdAt: date,
    updatedAt: date
  },
  chunk: {
    id: 'chunk_1',
    objectId: 'object_1',
    representationId: 'representation_1',
    content: 'matched durable fact',
    embedding: Array.from({ length: 1536 }, () => 0),
    position: 0,
    tokenCount: 3,
    metadata: {},
    createdAt: date
  },
  score: 0.91,
  vectorScore: 0.9,
  textScore: 0.5,
  context: [
    {
      id: 'chunk_1',
      objectId: 'object_1',
      representationId: 'representation_1',
      content: 'matched durable fact',
      embedding: Array.from({ length: 1536 }, () => 0),
      position: 0,
      tokenCount: 3,
      metadata: {},
      createdAt: date
    }
  ]
}

const contextWindow: KnowledgeContextWindow = {
  object: searchResult.object,
  representation: searchResult.representation,
  anchor: searchResult.chunk,
  chunks: searchResult.context,
  startPosition: 0,
  endPosition: 1,
  hasBefore: false,
  hasAfter: true,
  text: 'matched durable fact',
  textTruncated: false,
  textCharacters: 20
}

const objectSummary: KnowledgeObjectSummary = {
  id: 'object_1',
  title: 'Project memory',
  role: 'note',
  status: 'ready',
  contextPolicy: 'searchable',
  summary: 'Useful memory',
  representationCount: 1,
  artifactCount: 0,
  chunkCount: 1,
  artifacts: [],
  createdAt: date,
  updatedAt: date
}

describe('knowledge tool', () => {
  it.effect('lists authenticated user knowledge objects', () => {
    const calls: Array<{
      readonly userId: string
      readonly query?: string
      readonly policy?: 'archival' | 'pinned' | 'routable' | 'searchable'
      readonly limit: number
    }> = []
    const toolModule = makeKnowledgeToolModule({
      list: input => Effect.sync(() => {
        calls.push(input)
        return [objectSummary]
      }),
      search: () => Effect.succeed([])
    })

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'list_knowledge_objects',
          params: { query: ' memory ', policy: 'searchable', limit: 100 }
        })
      )

      expect(calls).toEqual([
        { userId: 'user_1', query: 'memory', policy: 'searchable', limit: 50 }
      ])
      expect(result.content).toContain('Knowledge objects')
      expect(result.content).toContain('Project memory')
      expect(result.content).toContain('Chunks: 1')
    })
  })

  it.effect('searches authenticated user knowledge', () => {
    const calls: Array<{
      readonly userId: string
      readonly query: string
      readonly limit: number
      readonly minScore?: number
      readonly contextChunks: number
    }> = []
    const toolModule = makeKnowledgeToolModule(input =>
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
          name: 'search_knowledge',
          params: { queries: [' memory '], limit: 50, minScore: 0.4, contextChunks: 9 }
        })
      )

      expect(calls).toEqual([
        { userId: 'user_1', query: 'memory', limit: 20, minScore: 0.4, contextChunks: 5 }
      ])
      expect(result.content).toContain('Knowledge search results for: memory')
      expect(result.content).toContain('Citation [1]')
      expect(result.content).toContain('Object: Project memory')
      expect(result.content).toContain('matched durable fact')
    })
  })

  it.effect('rejects blank queries', () => {
    const toolModule = makeKnowledgeToolModule(() => Effect.succeed([]))

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      const error = yield* toolSet
        .execute(ToolCall.make({ id: 'call_1', name: 'search_knowledge', params: { queries: ['   '] } }))
        .pipe(Effect.flip)

      expect(error.cause).toBe('validation')
    })
  })

  it.effect('runs multiple knowledge queries', () => {
    const calls: Array<string> = []
    const toolModule = makeKnowledgeToolModule(input =>
      Effect.sync(() => {
        calls.push(input.query)
        return []
      })
    )

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'voice', route: '/agent', userId: 'user_1' }
      })
      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'search_knowledge',
          params: { queries: ['alpha', ' beta '] }
        })
      )

      expect(calls).toEqual(['alpha', 'beta'])
      expect(result.content).toContain('No knowledge results found for: alpha')
      expect(result.content).toContain('No knowledge results found for: beta')
    })
  })

  it.effect('reads surrounding knowledge context', () => {
    const calls: Array<{
      readonly userId: string
      readonly objectId: string
      readonly chunkId?: string
      readonly before: number
      readonly after: number
      readonly maxChars: number
    }> = []
    const toolModule = makeKnowledgeToolModule({
      search: () => Effect.succeed([]),
      getContext: input => Effect.sync(() => {
        calls.push(input)
        return contextWindow
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
          name: 'get_knowledge_context',
          params: { objectId: ' object_1 ', chunkId: ' chunk_1 ', before: 50, after: 4, maxChars: 90_000 }
        })
      )

      expect(calls).toEqual([
        { userId: 'user_1', objectId: 'object_1', chunkId: 'chunk_1', before: 20, after: 4, maxChars: 60_000 }
      ])
      expect(result.content).toContain('Knowledge context: Project memory')
      expect(result.content).toContain('Has after: yes')
      expect(result.content).toContain('matched durable fact')
    })
  })

  it.effect('accepts null optional knowledge context params', () => {
    const calls: Array<{
      readonly objectId: string
      readonly position?: number
      readonly before: number
      readonly after: number
      readonly maxChars: number
    }> = []
    const toolModule = makeKnowledgeToolModule({
      search: () => Effect.succeed([]),
      getContext: input => Effect.sync(() => {
        calls.push(input)
        return contextWindow
      })
    })

    return Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [toolModule],
        context: { surface: 'text', route: '/agent/next', userId: 'user_1' }
      })
      yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'get_knowledge_context',
          params: { objectId: 'object_1', chunkId: null, position: null, before: null, after: null, maxChars: null }
        })
      )

      expect(calls).toEqual([
        { userId: 'user_1', objectId: 'object_1', chunkId: undefined, position: undefined, before: 3, after: 6, maxChars: 20_000 }
      ])
    })
  })
})
