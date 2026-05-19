import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { makeRagTool } from '@yolk-sdk/rag/agent'
import {
  defaultRagChunkingConfig,
  makeRagSet,
  RagChunkSchema,
  RagSearchScopeSchema,
  RagSetSchema
} from '@yolk-sdk/rag/documents'
import type { RagDocument, RagSet } from '@yolk-sdk/rag/documents'
import { RagChunker, chunkRagText, makeDefaultRagChunker } from '@yolk-sdk/rag/chunking'
import { RagEmbedder } from '@yolk-sdk/rag/embeddings'
import { RagExtractor } from '@yolk-sdk/rag/extraction'
import { ingestRagDocument } from '@yolk-sdk/rag/ingestion'
import { RagSummarizer } from '@yolk-sdk/rag/summarization'
import { packRagContext, retrieveRag } from '@yolk-sdk/rag/retrieval'
import type { RagRetriever } from '@yolk-sdk/rag/retrieval'
import {
  RagChunkingError,
  RagEmbeddingError,
  RagExtractionError,
  RagRetrievalError,
  RagStoreError
} from '@yolk-sdk/rag/errors'
import { RagStore } from '@yolk-sdk/rag/store'
import type { RagStoreApi } from '@yolk-sdk/rag/store'

describe('@yolk-sdk/rag', () => {
  it('imports public foundations', async () => {
    const [root, chunking, documents, embeddings, errors, extraction, store] = await Promise.all([
      import('@yolk-sdk/rag'),
      import('@yolk-sdk/rag/chunking'),
      import('@yolk-sdk/rag/documents'),
      import('@yolk-sdk/rag/embeddings'),
      import('@yolk-sdk/rag/errors'),
      import('@yolk-sdk/rag/extraction'),
      import('@yolk-sdk/rag/store')
    ])

    expect(root.RagChunker).toBeDefined()
    expect(chunking.makeDefaultRagChunker).toBeDefined()
    expect(documents.makeRagSet).toBeDefined()
    expect(embeddings.RagEmbedder).toBeDefined()
    expect(errors.RagStoreError).toBeDefined()
    expect(extraction.RagExtractor).toBeDefined()
    expect(store.RagStore).toBeDefined()
  })

  it('builds rag sets with default chunking config', () => {
    const set = makeRagSet({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 3 }
    })

    expect(set.chunkingConfig).toEqual(defaultRagChunkingConfig)
    expect(new RagStoreError({ message: 'store' })._tag).toBe('RagStoreError')
  })

  it.effect('rejects invalid document schema boundary values', () =>
    Effect.gen(function* () {
      const invalidSet = yield* Schema.decodeUnknownEffect(RagSetSchema)({
        id: 'set_1',
        embeddingConfig: { model: 'test-embedding', dimensions: 0 },
        chunkingConfig: { strategy: 'sentence-token', maxTokens: 8 }
      }).pipe(Effect.result)
      const invalidChunk = yield* Schema.decodeUnknownEffect(RagChunkSchema)({
        id: 'chunk_1',
        ragSetId: 'set_1',
        documentId: 'doc_1',
        content: '',
        position: -1,
        tokenCount: 0
      }).pipe(Effect.result)
      const invalidScope = yield* Schema.decodeUnknownEffect(RagSearchScopeSchema)({
        _tag: 'RagSet',
        id: ' set_1 '
      }).pipe(Effect.result)

      expect(invalidSet._tag).toBe('Failure')
      expect(invalidChunk._tag).toBe('Failure')
      expect(invalidScope._tag).toBe('Failure')
    }))

  it.effect('chunks sentence-first with token bounds', () =>
    Effect.gen(function* () {
      const chunks = yield* chunkRagText(
        {
          ragSetId: 'set_1',
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
      expect(chunks.map(chunk => chunk.position)).toEqual([0, 1, 2])
      expect(chunks.every(chunk => chunk.tokenCount <= 5)).toBe(true)
    }))

  it.effect('provides the default chunker as an Effect service', () =>
    Effect.gen(function* () {
      const chunker = yield* RagChunker
      const chunks = yield* chunker.chunk({
        ragSetId: 'set_1',
        documentId: 'doc_1',
        content: 'One sentence. Two sentence.'
      })

      expect(chunks.map(chunk => chunk.documentId)).toEqual(['doc_1'])
    }).pipe(Effect.provideService(RagChunker, makeDefaultRagChunker({ maxTokens: 32 }))))

  it.effect('rejects invalid chunking config', () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        chunkRagText({ ragSetId: 'set_1', documentId: 'doc_1', content: 'text' }, 0)
      )

      expect(result).toBeInstanceOf(RagChunkingError)
    }))

  it.effect('chunks large documents without exceeding token bounds', () =>
    Effect.gen(function* () {
      const content = Array.from({ length: 200 }, (_, index) => `Sentence ${index} has useful searchable content.`).join(' ')
      const chunks = yield* chunkRagText(
        { ragSetId: 'set_1', documentId: 'large_doc', content },
        32
      )

      expect(chunks.length).toBeGreaterThan(10)
      expect(chunks.every(chunk => chunk.tokenCount <= 32)).toBe(true)
      expect(chunks.map(chunk => chunk.position)).toEqual(chunks.map((_, index) => index))
    }))

  it.effect('splits oversized tokens for very long unbroken text', () =>
    Effect.gen(function* () {
      const chunks = yield* chunkRagText(
        { ragSetId: 'set_1', documentId: 'long_word_doc', content: 'a'.repeat(20_000) },
        128
      )

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.every(chunk => chunk.tokenCount <= 128)).toBe(true)
    }))

  it.effect('ingests extracted documents through package services', () => {
    const ragSet: RagSet = makeRagSet({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 2 },
      chunkingConfig: { strategy: 'sentence-token', maxTokens: 8 }
    })
    const documents: Array<RagDocument> = []
    let replacedChunkCount = 0

    const store = {
      upsertSet: (set: RagSet) => Effect.succeed(set),
      getSet: () => Effect.succeed(ragSet),
      upsertDocument: (input: { readonly document: RagDocument }) =>
        Effect.sync(() => {
          documents.push(input.document)
          return input.document
        }),
      markDocumentProcessing: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'processing'
        }),
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
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'ready',
          title: input.title,
          summary: input.summary,
          chunkCount: input.chunkCount
        }),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagExtractor, {
        extract: () =>
          Effect.succeed({
            content: 'Alpha beta. Gamma delta.',
            title: 'Doc title'
          })
      }),
      Layer.succeed(RagSummarizer, {
        summarize: () => Effect.succeed({ title: 'Doc title', summary: 'Doc summary' })
      }),
      Layer.succeed(RagChunker, makeDefaultRagChunker({ maxTokens: 8 })),
      Layer.succeed(RagEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const document = yield* ingestRagDocument({
        ragSetId: 'set_1',
        documentId: 'doc_1',
        source: {
          source: { _tag: 'Text', label: 'note' },
          content: 'ignored by fake extractor'
        }
      })

      expect(document.status).toBe('ready')
      expect(document.title).toBe('Doc title')
      expect(document.summary).toBe('Doc summary')
      expect(documents.map(item => item.status)).toEqual(['processing'])
      expect(replacedChunkCount).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect('marks documents errored when extraction fails', () => {
    const ragSet: RagSet = makeRagSet({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 2 }
    })
    const errorMessages: Array<string> = []
    const extractionError = new RagExtractionError({ message: 'extract failed' })

    const store = {
      upsertSet: (set: RagSet) => Effect.succeed(set),
      getSet: () => Effect.succeed(ragSet),
      upsertDocument: (input: { readonly document: RagDocument }) => Effect.succeed(input.document),
      markDocumentProcessing: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'processing'
        }),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'ready'
        }),
      markDocumentError: (input: { readonly message: string }) =>
        Effect.sync(() => {
          errorMessages.push(input.message)
        }),
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagExtractor, { extract: () => Effect.fail(extractionError) }),
      Layer.succeed(RagSummarizer, { summarize: () => Effect.succeed({}) }),
      Layer.succeed(RagChunker, makeDefaultRagChunker({ maxTokens: 8 })),
      Layer.succeed(RagEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const error = yield* ingestRagDocument({
        ragSetId: 'set_1',
        documentId: 'doc_1',
        source: { source: { _tag: 'Text', label: 'note' }, content: 'ignored' }
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error.stage).toBe('extract')
      expect(error.cause).toBe(extractionError)
      expect(errorMessages).toEqual(['extract failed'])
    })
  })

  it.effect('maps embedding failures and marks document errored', () => {
    const ragSet: RagSet = makeRagSet({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 2 }
    })
    const errorMessages: Array<string> = []
    const embeddingError = new RagEmbeddingError({ message: 'embed failed' })

    const store = {
      upsertSet: (set: RagSet) => Effect.succeed(set),
      getSet: () => Effect.succeed(ragSet),
      upsertDocument: (input: { readonly document: RagDocument }) => Effect.succeed(input.document),
      markDocumentProcessing: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'processing'
        }),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'ready'
        }),
      markDocumentError: (input: { readonly message: string }) =>
        Effect.sync(() => {
          errorMessages.push(input.message)
        }),
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagExtractor, {
        extract: () => Effect.succeed({ content: 'ignored', title: 'Doc title' })
      }),
      Layer.succeed(RagSummarizer, { summarize: () => Effect.succeed({ title: 'Doc title' }) }),
      Layer.succeed(RagChunker, {
        chunk: () =>
          Effect.succeed([
            {
              id: 'chunk_1',
              ragSetId: 'set_1',
              documentId: 'doc_1',
              content: 'one',
              position: 0,
              tokenCount: 1
            },
            {
              id: 'chunk_2',
              ragSetId: 'set_1',
              documentId: 'doc_1',
              content: 'two',
              position: 1,
              tokenCount: 1
            }
          ])
      }),
      Layer.succeed(RagEmbedder, {
        embedTexts: () => Effect.fail(embeddingError),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const error = yield* ingestRagDocument({
        ragSetId: 'set_1',
        documentId: 'doc_1',
        source: { source: { _tag: 'Text', label: 'note' }, content: 'ignored' }
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error.stage).toBe('embed')
      expect(error.cause).toBe(embeddingError)
      expect(errorMessages).toEqual(['embed failed'])
    })
  })

  it.effect('rejects mismatched embedding counts and marks document errored', () => {
    const ragSet: RagSet = makeRagSet({
      id: 'set_1',
      embeddingConfig: { model: 'test-embedding', dimensions: 2 }
    })
    const errorMessages: Array<string> = []

    const store = {
      upsertSet: (set: RagSet) => Effect.succeed(set),
      getSet: () => Effect.succeed(ragSet),
      upsertDocument: (input: { readonly document: RagDocument }) => Effect.succeed(input.document),
      markDocumentProcessing: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'processing'
        }),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'ready'
        }),
      markDocumentError: (input: { readonly message: string }) =>
        Effect.sync(() => {
          errorMessages.push(input.message)
        }),
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      searchChunksByText: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagExtractor, {
        extract: () => Effect.succeed({ content: 'ignored', title: 'Doc title' })
      }),
      Layer.succeed(RagSummarizer, { summarize: () => Effect.succeed({ title: 'Doc title' }) }),
      Layer.succeed(RagChunker, {
        chunk: () =>
          Effect.succeed([
            {
              id: 'chunk_1',
              ragSetId: 'set_1',
              documentId: 'doc_1',
              content: 'one',
              position: 0,
              tokenCount: 1
            },
            {
              id: 'chunk_2',
              ragSetId: 'set_1',
              documentId: 'doc_1',
              content: 'two',
              position: 1,
              tokenCount: 1
            }
          ])
      }),
      Layer.succeed(RagEmbedder, {
        embedTexts: () => Effect.succeed([[1, 0]]),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const error = yield* ingestRagDocument({
        ragSetId: 'set_1',
        documentId: 'doc_1',
        source: { source: { _tag: 'Text', label: 'note' }, content: 'ignored' }
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error.stage).toBe('embed')
      expect(error.message).toBe('Embedding count did not match chunk count')
      expect(errorMessages).toEqual(['Embedding count did not match chunk count'])
    })
  })

  it.effect('retrieves vector matches with adjacent context', () => {
    const document: RagDocument = {
      id: 'doc_1',
      ragSetId: 'set_1',
      source: { _tag: 'Text', label: 'note' },
      status: 'ready'
    }
    const store = {
      upsertSet: (set: RagSet) => Effect.succeed(set),
      getSet: () =>
        Effect.succeed(
          makeRagSet({ id: 'set_1', embeddingConfig: { model: 'test-embedding', dimensions: 2 } })
        ),
      upsertDocument: (input: { readonly document: RagDocument }) => Effect.succeed(input.document),
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
              ragSetId: 'set_1',
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
            ragSetId: 'set_1',
            documentId: 'doc_1',
            content: 'before',
            position: 0,
            tokenCount: 1
          },
          {
            id: 'chunk_2',
            ragSetId: 'set_1',
            documentId: 'doc_1',
            content: 'match',
            position: 1,
            tokenCount: 1
          }
        ])
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const results = yield* retrieveRag({
        scope: { _tag: 'RagSet', id: 'set_1' },
        query: 'alpha',
        mode: 'vector',
        contextChunks: 1
      })
      const context = packRagContext('alpha', results)

      expect(results[0]?.score).toBe(0.9)
      expect(context.text).toBe('before\n\nmatch')
    }).pipe(Effect.provide(layer))
  })

  it.effect('fuses vector and text results with reciprocal rank fusion', () => {
    const document: RagDocument = {
      id: 'doc_1',
      ragSetId: 'set_1',
      source: { _tag: 'Text', label: 'note' },
      status: 'ready'
    }
    const alphaChunk = {
      id: 'chunk_alpha',
      ragSetId: 'set_1',
      documentId: 'doc_1',
      content: 'alpha semantic match',
      position: 0,
      tokenCount: 3
    }
    const rareChunk = {
      id: 'chunk_rare',
      ragSetId: 'set_1',
      documentId: 'doc_1',
      content: 'rare exact symbol',
      position: 1,
      tokenCount: 3
    }
    const betaChunk = {
      id: 'chunk_beta',
      ragSetId: 'set_1',
      documentId: 'doc_1',
      content: 'beta text match',
      position: 2,
      tokenCount: 3
    }
    const store = {
      upsertSet: (set: RagSet) => Effect.succeed(set),
      getSet: () =>
        Effect.succeed(
          makeRagSet({ id: 'set_1', embeddingConfig: { model: 'test-embedding', dimensions: 2 } })
        ),
      upsertDocument: (input: { readonly document: RagDocument }) => Effect.succeed(input.document),
      markDocumentProcessing: () => Effect.succeed(document),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () => Effect.succeed(document),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () =>
        Effect.succeed([
          { chunk: alphaChunk, score: 0.92, document },
          { chunk: rareChunk, score: 0.72, document }
        ]),
      searchChunksByText: () =>
        Effect.succeed([
          { chunk: rareChunk, score: 0.44, document },
          { chunk: betaChunk, score: 0.31, document }
        ]),
      getContextChunks: () => Effect.succeed([])
    } satisfies RagStoreApi
    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const results = yield* retrieveRag({
        scope: { _tag: 'RagSet', id: 'set_1' },
        query: 'rare alpha',
        limit: 3,
        vectorLimit: 2,
        textLimit: 2
      })

      expect(results.map(result => result.chunk.id)).toEqual(['chunk_rare', 'chunk_alpha', 'chunk_beta'])
      expect(results[0]?.scores).toEqual({ vector: 0.72, text: 0.44, fused: results[0]?.score })
    }).pipe(Effect.provide(layer))
  })

  it.effect('rejects invalid retrieval inputs before services are required', () =>
    Effect.gen(function* () {
      const unusedStore = {
        upsertSet: () => Effect.die(new Error('unused')),
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
      } satisfies RagStoreApi
      const unusedLayer = Layer.mergeAll(
        Layer.succeed(RagStore, unusedStore),
        Layer.succeed(RagEmbedder, {
          embedTexts: () => Effect.die(new Error('unused')),
          embedQuery: () => Effect.die(new Error('unused'))
        })
      )
      const emptyQuery = yield* retrieveRag({
        scope: { _tag: 'RagSet', id: 'set_1' },
        query: '   '
      }).pipe(Effect.flip, Effect.provide(unusedLayer))
      const emptyScope = yield* retrieveRag({
        scope: { _tag: 'RagSets', ids: [] },
        query: 'alpha'
      }).pipe(Effect.flip, Effect.provide(unusedLayer))
      const invalidMinScore = yield* retrieveRag({
        scope: { _tag: 'RagSet', id: 'set_1' },
        query: 'alpha',
        minScore: Number.NaN
      }).pipe(Effect.flip, Effect.provide(unusedLayer))

      expect(emptyQuery).toBeInstanceOf(RagRetrievalError)
      expect(emptyQuery.message).toBe('Search query is empty')
      expect(emptyScope.message).toBe('Search scope is empty')
      expect(invalidMinScore.message).toBe('Search minScore must be finite')
    }))

  it.effect('adapts retrieval as an agent tool', () => {
    const document: RagDocument = {
      id: 'doc_1',
      ragSetId: 'set_1',
      source: { _tag: 'Text', label: 'note' },
      status: 'ready'
    }
    const retriever: RagRetriever = {
      retrieve: input =>
        Effect.succeed([
          {
            chunk: {
              id: 'chunk_1',
              ragSetId: input.scope._tag === 'RagSet' ? input.scope.id : 'set_1',
              documentId: 'doc_1',
              content: `result for ${input.query}`,
              position: 0,
              tokenCount: 3
            },
            score: 0.9,
            document
          }
        ])
    }
    const tool = makeRagTool<{ readonly ragSetId: string }>(retriever, {
      scope: context => Effect.succeed({ _tag: 'RagSet', id: context.ragSetId }),
      limit: 3,
      contextChunks: 1
    })

    return Effect.gen(function* () {
      const result = yield* tool.execute({
        context: { ragSetId: 'set_1' },
        call: ToolCall.make({ id: 'call_1', name: 'search_knowledge', params: { query: 'docs' } })
      })

      expect(result.content).toBe('result for docs')
      expect(result.structuredContent).toMatchObject({ query: 'docs' })
    })
  })

  it.effect('rejects blank agent tool queries at the boundary', () => {
    const retriever: RagRetriever = {
      retrieve: () => Effect.succeed([])
    }
    const tool = makeRagTool<Record<never, never>>(retriever, {
      scope: { _tag: 'RagSet', id: 'set_1' }
    })

    return Effect.gen(function* () {
      const error = yield* tool
        .execute({
          context: {},
          call: ToolCall.make({ id: 'call_1', name: 'search_knowledge', params: { query: '   ' } })
        })
        .pipe(Effect.flip)

      expect(error.cause).toBe('validation')
    })
  })
})
