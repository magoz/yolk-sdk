import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { defaultRagChunkingConfig, makeRagSet } from '@yolk/rag/documents'
import type { RagDocument, RagSet } from '@yolk/rag/documents'
import { RagChunker, chunkRagText, makeDefaultRagChunker } from '@yolk/rag/chunking'
import { RagEmbedder } from '@yolk/rag/embeddings'
import { RagExtractor } from '@yolk/rag/extraction'
import { ingestRagDocument } from '@yolk/rag/ingestion'
import { packRagContext, retrieveRag } from '@yolk/rag/retrieval'
import { RagChunkingError, RagStoreError } from '@yolk/rag/errors'
import { RagStore } from '@yolk/rag/store'
import type { RagStoreApi } from '@yolk/rag/store'

describe('@yolk/rag', () => {
  it('imports public foundations', async () => {
    const [root, chunking, documents, embeddings, errors, extraction, store] = await Promise.all([
      import('@yolk/rag'),
      import('@yolk/rag/chunking'),
      import('@yolk/rag/documents'),
      import('@yolk/rag/embeddings'),
      import('@yolk/rag/errors'),
      import('@yolk/rag/extraction'),
      import('@yolk/rag/store')
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
      markDocumentReady: (input: { readonly title?: string; readonly chunkCount: number }) =>
        Effect.succeed({
          id: 'doc_1',
          ragSetId: 'set_1',
          source: { _tag: 'Text', label: 'note' },
          status: 'ready',
          title: input.title,
          chunkCount: input.chunkCount
        }),
      markDocumentError: () => Effect.void,
      deleteDocument: () => Effect.void,
      searchChunks: () => Effect.succeed([]),
      getContextChunks: () => Effect.succeed([])
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagExtractor, {
        extract: () => Effect.succeed({ content: 'Alpha beta. Gamma delta.', title: 'Doc title' })
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
      expect(documents.map(item => item.status)).toEqual(['processing'])
      expect(replacedChunkCount).toBe(1)
    }).pipe(Effect.provide(layer))
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
        contextChunks: 1
      })
      const context = packRagContext('alpha', results)

      expect(results[0]?.score).toBe(0.9)
      expect(context.text).toBe('before\n\nmatch')
    }).pipe(Effect.provide(layer))
  })
})
