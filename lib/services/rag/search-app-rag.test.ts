import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { RagEmbedder } from '@yolk/rag/embeddings'
import type { RagDocument, RagSet } from '@yolk/rag/documents'
import { makeRagSet } from '@yolk/rag/documents'
import { RagStore } from '@yolk/rag/store'
import type { RagStoreApi } from '@yolk/rag/store'
import { searchAppRag } from './search-app-rag'

describe('searchAppRag', () => {
  it.effect('applies retrieval defaults and context expansion', () => {
    const document: RagDocument = {
      id: 'doc_1',
      ragSetId: 'set_1',
      source: { _tag: 'Text', label: 'note' },
      status: 'ready'
    }
    let contextCalls = 0
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
      searchChunks: input =>
        Effect.succeed([
          {
            chunk: {
              id: 'chunk_1',
              ragSetId: input.scope._tag === 'RagSet' ? input.scope.id : 'set_1',
              documentId: 'doc_1',
              content: `score ${input.minScore ?? 0}`,
              position: 1,
              tokenCount: 3
            },
            score: 0.9,
            document
          }
        ]),
      getContextChunks: () =>
        Effect.sync(() => {
          contextCalls += 1
          return [
            {
              id: 'chunk_0',
              ragSetId: 'set_1',
              documentId: 'doc_1',
              content: 'before',
              position: 0,
              tokenCount: 1
            },
            {
              id: 'chunk_1',
              ragSetId: 'set_1',
              documentId: 'doc_1',
              content: 'match',
              position: 1,
              tokenCount: 1
            }
          ]
        })
    } satisfies RagStoreApi

    const layer = Layer.mergeAll(
      Layer.succeed(RagStore, store),
      Layer.succeed(RagEmbedder, {
        embedTexts: texts => Effect.succeed(texts.map(() => [1, 0])),
        embedQuery: () => Effect.succeed([1, 0])
      })
    )

    return Effect.gen(function* () {
      const results = yield* searchAppRag({ _tag: 'RagSet', id: 'set_1' }, 'alpha', {
        contextChunks: 1
      })

      expect(results[0]?.score).toBe(0.9)
      expect(results[0]?.chunk.content).toBe('score 0.5')
      expect(contextCalls).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
