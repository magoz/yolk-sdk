import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { makeKnowledgeSearchTool } from '../src/agent.ts'
import { KnowledgeChunker, chunkKnowledgeText, makeDefaultKnowledgeChunker } from '../src/chunking.ts'
import { KnowledgeEmbedder } from '../src/embeddings.ts'
import { KnowledgeExtractor } from '../src/extraction.ts'
import { ingestKnowledgeDocument } from '../src/ingestion.ts'
import { SearchIndexStore } from '../src/search-store.ts'
import {
  defaultKnowledgeChunkingConfig,
  makeKnowledgeCollection,
  KnowledgeChunkSchema,
  KnowledgeSearchScopeSchema,
  KnowledgeCollectionSchema
} from '../src/documents.ts'
import type { KnowledgeDocument, KnowledgeCollection } from '../src/documents.ts'
import { packKnowledgeSearchContext, searchKnowledge } from '../src/retrieval.ts'
import type { KnowledgeRetriever } from '../src/retrieval.ts'
import { KnowledgeChunkingError, KnowledgeRetrievalError, SearchIndexStoreError } from '../src/errors.ts'
import { KnowledgeSummarizer } from '../src/summarization.ts'
import type { SearchIndexStoreApi } from '../src/search-store.ts'

describe('knowledge searching', () => {
  it('imports public indexing foundations', async () => {
    const [chunking, indexing, embeddings, errors, extraction, store] = await Promise.all([
      import('../src/chunking.ts'),
      import('../src/documents.ts'),
      import('../src/embeddings.ts'),
      import('../src/errors.ts'),
      import('../src/extraction.ts'),
      import('../src/search-store.ts')
    ])

    expect(chunking.makeDefaultKnowledgeChunker).toBeDefined()
    expect(indexing.makeKnowledgeCollection).toBeDefined()
    expect(embeddings.KnowledgeEmbedder).toBeDefined()
    expect(errors.SearchIndexStoreError).toBeDefined()
    expect(extraction.KnowledgeExtractor).toBeDefined()
    expect(store.SearchIndexStore).toBeDefined()
  })

  it('builds collections with default chunking config', () => {
    const set = makeKnowledgeCollection({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 3 }
    })

    expect(set.chunkingConfig).toEqual(defaultKnowledgeChunkingConfig)
    expect(new SearchIndexStoreError({ message: 'store' })._tag).toBe('SearchIndexStoreError')
  })

  it.effect('rejects invalid indexing schema boundary values', () =>
    Effect.gen(function* () {
      const invalidSet = yield* Schema.decodeUnknownEffect(KnowledgeCollectionSchema)({
        id: 'set_1',
        embeddingConfig: { model: 'test-embedding', dimensions: 0 },
        chunkingConfig: { strategy: 'sentence-token', maxTokens: 8 }
      }).pipe(Effect.result)
      const invalidChunk = yield* Schema.decodeUnknownEffect(KnowledgeChunkSchema)({
        id: 'chunk_1',
        collectionId: 'set_1',
        documentId: 'doc_1',
        content: '',
        position: -1,
        tokenCount: 0
      }).pipe(Effect.result)
      const invalidScope = yield* Schema.decodeUnknownEffect(KnowledgeSearchScopeSchema)({
        _tag: 'KnowledgeCollection',
        id: ' set_1 '
      }).pipe(Effect.result)

      expect(invalidSet._tag).toBe('Failure')
      expect(invalidChunk._tag).toBe('Failure')
      expect(invalidScope._tag).toBe('Failure')
    }))

  it.effect('chunks sentence-first with token bounds', () =>
    Effect.gen(function* () {
      const chunks = yield* chunkKnowledgeText(
        {
          collectionId: 'set_1',
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
    }))

  it.effect('rejects invalid chunking config', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        chunkKnowledgeText({ collectionId: 'set_1', documentId: 'doc_1', content: 'text' }, 0)
      )

      expect(result).toBeInstanceOf(KnowledgeChunkingError)
    }))

  it.effect('ingests extracted documents through package services', () => {
    const collection: KnowledgeCollection = makeKnowledgeCollection({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 2 },
      chunkingConfig: { strategy: 'sentence-token', maxTokens: 8 }
    })
    let replacedChunkCount = 0

    const store = {
      upsertSet: (set: KnowledgeCollection) => Effect.succeed(set),
      getSet: () => Effect.succeed(collection),
      upsertDocument: (input: { readonly document: KnowledgeDocument }) => Effect.succeed(input.document),
      markDocumentProcessing: () => Effect.succeed({ id: 'doc_1', collectionId: 'set_1', source: { _tag: 'Text', label: 'note' }, status: 'processing' }),
      replaceDocumentChunks: (input: { readonly chunks: ReadonlyArray<unknown> }) => Effect.sync(() => { replacedChunkCount = input.chunks.length }),
      markDocumentReady: (input: { readonly title?: string; readonly summary?: string; readonly chunkCount: number }) => Effect.succeed({ id: 'doc_1', collectionId: 'set_1', source: { _tag: 'Text', label: 'note' }, status: 'ready', title: input.title, summary: input.summary, chunkCount: input.chunkCount }),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies SearchIndexStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(SearchIndexStore, store),
      Layer.succeed(KnowledgeExtractor, { extract: () => Effect.succeed({ content: 'Alpha beta. Gamma delta.', title: 'Doc title' }) }),
      Layer.succeed(KnowledgeSummarizer, { summarize: () => Effect.succeed({ title: 'Doc title', summary: 'Doc summary' }) }),
      Layer.succeed(KnowledgeChunker, makeDefaultKnowledgeChunker({ maxTokens: 8 })),
      Layer.succeed(KnowledgeEmbedder, { embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])), embedQuery: () => Effect.succeed([1, 0]) })
    )

    return Effect.gen(function* () {
      const document = yield* ingestKnowledgeDocument({
        collectionId: 'set_1',
        documentId: 'doc_1',
        source: { source: { _tag: 'Text', label: 'note' }, content: 'ignored' }
      })

      expect(document.status).toBe('ready')
      expect(document.summary).toBe('Doc summary')
      expect(replacedChunkCount).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect('retrieves vector matches with adjacent context', () => {
    const document: KnowledgeDocument = { id: 'doc_1', collectionId: 'set_1', source: { _tag: 'Text', label: 'note' }, status: 'ready' }
    const store = {
      upsertSet: (set: KnowledgeCollection) => Effect.succeed(set),
      getSet: () => Effect.succeed(makeKnowledgeCollection({ id: 'set_1', embeddingConfig: { model: 'test-embedding', dimensions: 2 } })),
      upsertDocument: (input: { readonly document: KnowledgeDocument }) => Effect.succeed(input.document),
      markDocumentProcessing: () => Effect.succeed(document),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () => Effect.succeed(document),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([{ chunk: { id: 'chunk_2', collectionId: 'set_1', documentId: 'doc_1', content: 'match', position: 1, tokenCount: 1 }, score: 0.9, document }]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([{ id: 'chunk_1', collectionId: 'set_1', documentId: 'doc_1', content: 'before', position: 0, tokenCount: 1 }, { id: 'chunk_2', collectionId: 'set_1', documentId: 'doc_1', content: 'match', position: 1, tokenCount: 1 }])
    } satisfies SearchIndexStoreApi
    const layer = Layer.mergeAll(
      Layer.succeed(SearchIndexStore, store),
      Layer.succeed(KnowledgeEmbedder, { embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])), embedQuery: () => Effect.succeed([1, 0]) })
    )

    return Effect.gen(function* () {
      const results = yield* searchKnowledge({ scope: { _tag: 'KnowledgeCollection', id: 'set_1' }, query: 'alpha', mode: 'vector', contextChunks: 1 })
      expect(packKnowledgeSearchContext('alpha', results).text).toBe('before\n\nmatch')
    }).pipe(Effect.provide(layer))
  })

  it.effect('rejects invalid retrieval inputs before services are required', () =>
    Effect.gen(function* () {
      const store = {
        upsertSet: (set: KnowledgeCollection) => Effect.succeed(set),
        getSet: () => Effect.die(new Error('unused')),
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
      const error = yield* searchKnowledge({ scope: { _tag: 'KnowledgeCollections', ids: [] }, query: 'alpha' }).pipe(
        Effect.flip,
        Effect.provide(layer)
      )

      expect(error).toBeInstanceOf(KnowledgeRetrievalError)
      expect(error.message).toBe('Search scope is empty')
    }))

  it.effect('adapts retrieval as an agent tool', () => {
    const document: KnowledgeDocument = { id: 'doc_1', collectionId: 'set_1', source: { _tag: 'Text', label: 'note' }, status: 'ready' }
    const retriever: KnowledgeRetriever = {
      retrieve: input => Effect.succeed([{ chunk: { id: 'chunk_1', collectionId: input.scope._tag === 'KnowledgeCollection' ? input.scope.id : 'set_1', documentId: 'doc_1', content: `result for ${input.query}`, position: 0, tokenCount: 3 }, score: 0.9, document }])
    }
    const tool = makeKnowledgeSearchTool<{ readonly collectionId: string }>(retriever, {
      scope: context => Effect.succeed({ _tag: 'KnowledgeCollection', id: context.collectionId })
    })

    return Effect.gen(function* () {
      const result = yield* tool.execute({
        context: { collectionId: 'set_1' },
        call: ToolCall.make({ id: 'call_1', name: 'search_knowledge', params: { query: 'docs' } })
      })

      expect(result.content).toBe('result for docs')
    })
  })
})
