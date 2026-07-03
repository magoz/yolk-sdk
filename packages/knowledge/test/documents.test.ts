import { DateTime, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { ToolError } from '@yolk-sdk/agent/loop'
import { makeKnowledgeLookupTool } from '../src/agent.ts'
import {
  KnowledgeChunker,
  chunkKnowledgeText,
  makeDefaultKnowledgeChunker
} from '../src/chunking.ts'
import { KnowledgeEmbedder } from '../src/embeddings.ts'
import { KnowledgeExtractor } from '../src/extraction.ts'
import { ingestKnowledgeDocument } from '../src/ingestion.ts'
import { SearchIndexStore } from '../src/store.ts'
import {
  KnowledgeChunkSchema,
  KnowledgeDocumentSchema,
  KnowledgeSearchScopeSchema
} from '../src/documents.ts'
import type { IndexedKnowledgeDocument, KnowledgeDocument } from '../src/documents.ts'
import { packKnowledgeSearchContext, searchKnowledge } from '../src/search.ts'
import {
  KnowledgeChunkingError,
  KnowledgeSearchError,
  SearchIndexStoreError
} from '../src/errors.ts'
import { KnowledgeSummarizer } from '../src/summarization.ts'
import type { SearchIndexStoreApi } from '../src/store.ts'

const document: IndexedKnowledgeDocument = {
  id: 'doc_1',
  scopeId: 'scope_1',
  source: { _tag: 'Text', label: 'note' },
  status: 'ready'
}

const durableDocument: KnowledgeDocument = {
  id: 'doc_1',
  slug: 'project.memory',
  title: 'Project memory',
  purpose: 'Answer project questions.',
  origin: 'test',
  content: 'durable fact',
  status: 'ready',
  availability: 'searchable',
  createdAt: DateTime.nowUnsafe(),
  updatedAt: DateTime.nowUnsafe()
}

describe('knowledge searching', () => {
  it('imports public foundations', async () => {
    const [chunking, documents, embeddings, errors, extraction, store] = await Promise.all([
      import('../src/chunking.ts'),
      import('../src/documents.ts'),
      import('../src/embeddings.ts'),
      import('../src/errors.ts'),
      import('../src/extraction.ts'),
      import('../src/store.ts')
    ])

    expect(chunking.makeDefaultKnowledgeChunker).toBeDefined()
    expect(documents.KnowledgeDocumentSchema).toBeDefined()
    expect(embeddings.KnowledgeEmbedder).toBeDefined()
    expect(errors.SearchIndexStoreError).toBeDefined()
    expect(extraction.KnowledgeExtractor).toBeDefined()
    expect(store.SearchIndexStore).toBeDefined()
  })

  it.effect('rejects invalid schema boundary values', () =>
    Effect.gen(function* () {
      const invalidDocument = yield* Schema.decodeUnknownEffect(KnowledgeDocumentSchema)({
        id: 'doc_1',
        slug: '',
        title: 'Title',
        purpose: 'Purpose',
        origin: 'Origin',
        content: 'Content',
        status: 'ready',
        availability: 'searchable',
        createdAt: new Date(),
        updatedAt: new Date()
      }).pipe(Effect.result)
      const invalidChunk = yield* Schema.decodeUnknownEffect(KnowledgeChunkSchema)({
        id: 'chunk_1',
        scopeId: 'scope_1',
        documentId: 'doc_1',
        content: '',
        position: -1,
        tokenCount: 0
      }).pipe(Effect.result)
      const invalidScope = yield* Schema.decodeUnknownEffect(KnowledgeSearchScopeSchema)({
        _tag: 'KnowledgeScope',
        id: ' scope_1 '
      }).pipe(Effect.result)

      expect(invalidDocument._tag).toBe('Failure')
      expect(invalidChunk._tag).toBe('Failure')
      expect(invalidScope._tag).toBe('Failure')
    })
  )

  it.effect('chunks sentence-first with token bounds', () =>
    Effect.gen(function* () {
      const chunks = yield* chunkKnowledgeText(
        {
          scopeId: 'scope_1',
          documentId: 'doc_1',
          content: 'Alpha beta. Gamma delta. Epsilon zeta.'
        },
        5
      )

      expect(chunks.map(chunk => chunk.content)).toEqual([
        'Alpha beta.',
        'Gamma delta.',
        'Epsilon zeta.'
      ])
      expect(chunks.every(chunk => chunk.tokenCount <= 5)).toBe(true)
    })
  )

  it.effect('rejects invalid chunking config', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        chunkKnowledgeText({ scopeId: 'scope_1', documentId: 'doc_1', content: 'text' }, 0)
      )

      expect(result).toBeInstanceOf(KnowledgeChunkingError)
    })
  )

  it.effect('ingests extracted documents through package services', () => {
    let replacedChunkCount = 0

    const store = {
      upsertDocument: (input: { readonly document: IndexedKnowledgeDocument }) =>
        Effect.succeed(input.document),
      markDocumentProcessing: () => Effect.succeed({ ...document, status: 'processing' }),
      replaceDocumentChunks: (input: { readonly chunks: ReadonlyArray<unknown> }) =>
        Effect.sync(() => {
          replacedChunkCount = input.chunks.length
        }),
      markDocumentReady: (input: {
        readonly title?: string
        readonly summary?: string
        readonly chunkCount: number
      }) =>
        Effect.succeed({
          ...document,
          title: input.title,
          summary: input.summary,
          chunkCount: input.chunkCount
        }),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies SearchIndexStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(SearchIndexStore, store),
      Layer.succeed(KnowledgeExtractor, {
        extract: () => Effect.succeed({ content: 'Alpha beta. Gamma delta.', title: 'Doc title' })
      }),
      Layer.succeed(KnowledgeSummarizer, {
        summarize: () => Effect.succeed({ title: 'Doc title', summary: 'Doc summary' })
      }),
      Layer.succeed(KnowledgeChunker, makeDefaultKnowledgeChunker({ maxTokens: 8 })),
      Layer.succeed(KnowledgeEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const indexed = yield* ingestKnowledgeDocument({
        scopeId: 'scope_1',
        documentId: 'doc_1',
        source: { source: { _tag: 'Text', label: 'note' }, content: 'ignored' }
      })

      expect(indexed.status).toBe('ready')
      expect(indexed.summary).toBe('Doc summary')
      expect(replacedChunkCount).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect('searches vector matches with adjacent context', () => {
    const store = {
      upsertDocument: (input: { readonly document: IndexedKnowledgeDocument }) =>
        Effect.succeed(input.document),
      markDocumentProcessing: () => Effect.succeed(document),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () => Effect.succeed(document),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () =>
        Effect.succeed([
          {
            chunk: {
              id: 'chunk_2',
              scopeId: 'scope_1',
              documentId: 'doc_1',
              content: 'match',
              position: 1,
              tokenCount: 1
            },
            score: 0.9,
            document
          }
        ]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () =>
        Effect.succeed([
          {
            id: 'chunk_1',
            scopeId: 'scope_1',
            documentId: 'doc_1',
            content: 'before',
            position: 0,
            tokenCount: 1
          },
          {
            id: 'chunk_2',
            scopeId: 'scope_1',
            documentId: 'doc_1',
            content: 'match',
            position: 1,
            tokenCount: 1
          }
        ])
    } satisfies SearchIndexStoreApi
    const layer = Layer.mergeAll(
      Layer.succeed(SearchIndexStore, store),
      Layer.succeed(KnowledgeEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const results = yield* searchKnowledge({
        scope: { _tag: 'KnowledgeScope', id: 'scope_1' },
        query: 'alpha',
        mode: 'vector',
        contextChunks: 1
      })
      expect(packKnowledgeSearchContext('alpha', results).text).toBe('before\n\nmatch')
    }).pipe(Effect.provide(layer))
  })

  it.effect('rejects invalid search inputs before services are required', () =>
    Effect.gen(function* () {
      const store = {
        upsertDocument: () => Effect.die(new Error('unused')),
        markDocumentProcessing: () => Effect.die(new Error('unused')),
        replaceDocumentChunks: () => Effect.die(new Error('unused')),
        markDocumentReady: () => Effect.die(new Error('unused')),
        markDocumentError: () => Effect.die(new Error('unused')),
        deleteDocument: () => Effect.die(new Error('unused')),
        searchChunks: () => Effect.die(new Error('unused')),
        searchChunksByText: () => Effect.die(new Error('unused')),
        getContextChunks: () => Effect.die(new Error('unused'))
      } satisfies SearchIndexStoreApi
      const layer = Layer.mergeAll(
        Layer.succeed(SearchIndexStore, store),
        Layer.succeed(KnowledgeEmbedder, {
          embedTexts: () => Effect.die(new Error('unused')),
          embedQuery: () => Effect.die(new Error('unused'))
        })
      )
      const error = yield* searchKnowledge({
        scope: { _tag: 'KnowledgeScopes', ids: [] },
        query: 'alpha'
      }).pipe(Effect.flip, Effect.provide(layer))

      expect(error).toBeInstanceOf(KnowledgeSearchError)
      expect(error.message).toBe('Search scope is empty')
      expect(new SearchIndexStoreError({ message: 'store' })._tag).toBe('SearchIndexStoreError')
    })
  )

  it.effect('adapts lookup as an agent tool', () => {
    const tool = makeKnowledgeLookupTool<{ readonly userId: string }>({
      search: input =>
        Effect.succeed([
          { document: { ...durableDocument, content: `result for ${input.query}` }, score: 0.9 }
        ]),
      get: () =>
        Effect.fail(
          new ToolError({ tool: 'knowledge_lookup', message: 'unused', cause: 'execution' })
        )
    })

    return Effect.gen(function* () {
      const result = yield* tool.execute({
        context: { userId: 'user_1' },
        call: ToolCall.make({
          id: 'call_1',
          name: 'knowledge_lookup',
          params: { operation: 'search', query: 'docs' }
        })
      })

      expect(result.content).toContain('result for docs')
    })
  })
})
