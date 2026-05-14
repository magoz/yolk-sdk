import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/agent/protocol'
import { makeRagDocument as makeRootRagDocument } from '@yolk/rag'
import { makeCharacterChunker } from '@yolk/rag/chunking'
import { makeRagDocument } from '@yolk/rag/documents'
import { EmbedderError } from '@yolk/rag/embeddings'
import { makeIngestionPipeline } from '@yolk/rag/ingestion'
import { makeRagTool } from '@yolk/rag/agent'
import { packRagContext, type Retriever } from '@yolk/rag/retrieval'
import { VectorStoreError } from '@yolk/rag/vector-store'

describe('@yolk/rag', () => {
  it('imports every public subpath', async () => {
    const [root, agent, chunking, documents, embeddings, ingestion, retrieval, vectorStore] =
      await Promise.all([
        import('@yolk/rag'),
        import('@yolk/rag/agent'),
        import('@yolk/rag/chunking'),
        import('@yolk/rag/documents'),
        import('@yolk/rag/embeddings'),
        import('@yolk/rag/ingestion'),
        import('@yolk/rag/retrieval'),
        import('@yolk/rag/vector-store')
      ])

    expect(root.makeRagDocument).toBeDefined()
    expect(agent.makeRagTool).toBeDefined()
    expect(chunking.makeCharacterChunker).toBeDefined()
    expect(documents.makeRagDocument).toBeDefined()
    expect(embeddings.EmbedderError).toBeDefined()
    expect(ingestion.makeIngestionPipeline).toBeDefined()
    expect(retrieval.packRagContext).toBeDefined()
    expect(vectorStore.VectorStoreError).toBeDefined()
  })

  it('chunks documents deterministically', () => {
    const document = makeRagDocument({ id: 'doc_1', text: 'abcdef', metadata: { source: 'test' } })
    const chunks = makeCharacterChunker({ size: 3, overlap: 1 }).chunk(document)

    expect(chunks.map(chunk => chunk.text)).toEqual(['abc', 'cde', 'ef'])
    expect(chunks.map(chunk => chunk.id)).toEqual([
      'doc_1:chunk:0',
      'doc_1:chunk:1',
      'doc_1:chunk:2'
    ])
    expect(makeRootRagDocument({ id: 'doc_2', text: 'x', metadata: {} }).id).toBe('doc_2')
    expect(packRagContext('q', []).text).toBe('')
    expect(new EmbedderError('embed')._tag).toBe('EmbedderError')
    expect(new VectorStoreError('vector')._tag).toBe('VectorStoreError')
    expect(makeIngestionPipeline).toBeDefined()
  })

  it.effect('exposes a RAG agent tool adapter', () => {
    const retriever: Retriever = {
      retrieve: query =>
        Effect.succeed([
          {
            chunk: {
              id: 'chunk_1',
              documentId: 'doc_1',
              text: `result for ${query.query}`,
              index: 0,
              metadata: {}
            },
            score: 0.9
          }
        ])
    }
    const tool = makeRagTool<unknown>(retriever)

    return Effect.gen(function* () {
      const result = yield* tool.execute({
        context: undefined,
        call: ToolCall.make({ id: 'call_1', name: 'search_knowledge', params: { query: 'docs' } })
      })

      expect(result.content).toBe('result for docs')
      expect(result.structuredContent).toMatchObject({ query: 'docs' })
    })
  })
})
