import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/agent/protocol'
import { makeCharacterChunker } from '@yolk/rag/chunking'
import { makeRagDocument } from '@yolk/rag/documents'
import { makeRagTool } from '@yolk/rag/agent'
import type { Retriever } from '@yolk/rag/retrieval'

describe('@yolk/rag', () => {
  it('chunks documents deterministically', () => {
    const document = makeRagDocument({ id: 'doc_1', text: 'abcdef', metadata: { source: 'test' } })
    const chunks = makeCharacterChunker({ size: 3, overlap: 1 }).chunk(document)

    expect(chunks.map(chunk => chunk.text)).toEqual(['abc', 'cde', 'ef'])
    expect(chunks.map(chunk => chunk.id)).toEqual([
      'doc_1:chunk:0',
      'doc_1:chunk:1',
      'doc_1:chunk:2'
    ])
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
