import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { defaultRagChunkingConfig, makeRagSet } from '@yolk/rag/documents'
import { RagChunker, chunkRagText, makeDefaultRagChunker } from '@yolk/rag/chunking'
import { RagChunkingError, RagStoreError } from '@yolk/rag/errors'

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
})
