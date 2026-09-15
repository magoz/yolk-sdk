import { DateTime, Effect, Layer, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { expectTypeOf } from 'vitest'
import {
  chunkKnowledgeText,
  KnowledgeChunker,
  makeDefaultKnowledgeChunker
} from '../src/chunking.ts'
import {
  KnowledgeDocumentId,
  KnowledgeDocumentSchema,
  KnowledgeScopeId,
  KnowledgeSearchScope,
  KnowledgeSearchScopes,
  KnowledgeTextSource
} from '../src/documents.ts'
import { KnowledgeEmbedder } from '../src/embeddings.ts'
import { KnowledgeExtractor } from '../src/extraction.ts'
import { ingestKnowledgeDocument } from '../src/ingestion.ts'
import { SearchIndexStore, type SearchIndexStoreApi } from '../src/store.ts'
import { searchKnowledge } from '../src/search.ts'
import { KnowledgeSummarizer } from '../src/summarization.ts'

describe('knowledge branded ids', () => {
  it('keeps KnowledgeScopeId and KnowledgeDocumentId nominally incompatible', () => {
    const scopeId = KnowledgeScopeId.make('scope_1')
    const documentId = KnowledgeDocumentId.make('doc_1')

    // Brands keep their string wire representation.
    const scopeWire: string = scopeId
    expect(scopeWire).toBe('scope_1')
    const documentWire: string = documentId
    expect(documentWire).toBe('doc_1')

    const backToScope: KnowledgeScopeId = scopeId
    expect(backToScope).toBe('scope_1')

    // @ts-expect-error - KnowledgeScopeId is not a KnowledgeDocumentId
    const mismatchDocument: KnowledgeDocumentId = scopeId
    // @ts-expect-error - KnowledgeDocumentId is not a KnowledgeScopeId
    const mismatchScope: KnowledgeScopeId = documentId
    // @ts-expect-error - unbranded strings require minting through the canonical schema
    const scopeFromString: KnowledgeScopeId = 'scope_1'
    // @ts-expect-error - unbranded strings require minting through the canonical schema
    const documentFromString: KnowledgeDocumentId = 'doc_1'

    expect([mismatchDocument, mismatchScope, scopeFromString, documentFromString]).toHaveLength(4)
  })

  it.effect('roundtrips id brands through their encoded string form', () =>
    Effect.gen(function* () {
      const scopeId = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)('scope_1')
      expect(yield* Schema.encodeEffect(KnowledgeScopeId)(scopeId)).toBe('scope_1')

      const documentId = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)('doc_1')
      expect(yield* Schema.encodeEffect(KnowledgeDocumentId)(documentId)).toBe('doc_1')

      // Non-empty trimmed validation is preserved: empty, blank, padded, and
      // non-string ids fail instead of coercing.
      for (const raw of ['', '   ', ' scope_1 ', 42, null]) {
        const scopeResult = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)(raw).pipe(
          Effect.result
        )

        expect(Result.isFailure(scopeResult)).toBe(true)

        const documentResult = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(raw).pipe(
          Effect.result
        )

        expect(Result.isFailure(documentResult)).toBe(true)
      }

      const document = yield* Schema.decodeUnknownEffect(KnowledgeDocumentSchema)({
        id: 'doc_1',
        slug: 'notes',
        title: 'Notes',
        purpose: 'Remember.',
        origin: 'test',
        content: 'durable fact',
        status: 'ready',
        availability: 'searchable',
        createdAt: DateTime.nowUnsafe(),
        updatedAt: DateTime.nowUnsafe()
      })

      expect(document.id).toBe('doc_1')
      const wire: string = document.id
      expect(wire).toBe('doc_1')
    })
  )

  it.effect('requires branded ids at chunk, ingest, and search contracts', () => {
    const scopeId = KnowledgeScopeId.make('scope_1')
    const documentId = KnowledgeDocumentId.make('doc_1')

    const indexed = {
      id: documentId,
      scopeId,
      source: KnowledgeTextSource.make({ label: 'note' }),
      status: 'ready' as const
    }

    const store = {
      upsertDocument: () => Effect.succeed(indexed),
      markDocumentProcessing: () => Effect.succeed({ ...indexed, status: 'processing' as const }),
      replaceDocumentChunks: () => Effect.void,
      markDocumentReady: () => Effect.succeed(indexed),
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
      const chunks = yield* chunkKnowledgeText(
        { scopeId, documentId, content: 'Alpha beta. Gamma delta.' },
        8
      )

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.every(chunk => chunk.scopeId === 'scope_1')).toBe(true)
      expect(chunks.every(chunk => chunk.documentId === 'doc_1')).toBe(true)

      // These assertions are checked by root pnpm tsc, not Vitest transpilation.
      expectTypeOf<
        Parameters<typeof chunkKnowledgeText>[0]['scopeId']
      >().toEqualTypeOf<KnowledgeScopeId>()
      expectTypeOf<
        Parameters<typeof chunkKnowledgeText>[0]['documentId']
      >().toEqualTypeOf<KnowledgeDocumentId>()
      expectTypeOf<
        Parameters<typeof ingestKnowledgeDocument>[0]['scopeId']
      >().toEqualTypeOf<KnowledgeScopeId>()
      expectTypeOf<
        Parameters<typeof ingestKnowledgeDocument>[0]['documentId']
      >().toEqualTypeOf<KnowledgeDocumentId>()
      expectTypeOf<
        Parameters<typeof KnowledgeSearchScope.make>[0]['id']
      >().toEqualTypeOf<KnowledgeScopeId>()
      expectTypeOf<
        Parameters<typeof KnowledgeSearchScopes.make>[0]['ids'][number]
      >().toEqualTypeOf<KnowledgeScopeId>()
      expectTypeOf<
        Parameters<SearchIndexStoreApi['deleteDocument']>[0]['scopeId']
      >().toEqualTypeOf<KnowledgeScopeId>()
      expectTypeOf<
        Parameters<SearchIndexStoreApi['deleteDocument']>[0]['documentId']
      >().toEqualTypeOf<KnowledgeDocumentId>()

      expect(
        yield* searchKnowledge({
          scope: KnowledgeSearchScope.make({ id: scopeId }),
          query: 'alpha',
          mode: 'vector'
        })
      ).toEqual([])
      expect(
        yield* searchKnowledge({
          scope: KnowledgeSearchScopes.make({ ids: [scopeId] }),
          query: 'alpha',
          mode: 'vector'
        })
      ).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect('ingests through branded ids without widening the store wire', () => {
    const scopeId = KnowledgeScopeId.make('scope_1')
    const documentId = KnowledgeDocumentId.make('doc_1')
    let replacedScopeId: unknown = undefined
    let replacedDocumentId: unknown = undefined

    const store = {
      upsertDocument: () =>
        Effect.succeed({
          id: documentId,
          scopeId,
          source: KnowledgeTextSource.make({ label: 'note' }),
          status: 'ready' as const
        }),
      markDocumentProcessing: () =>
        Effect.succeed({
          id: documentId,
          scopeId,
          source: KnowledgeTextSource.make({ label: 'note' }),
          status: 'processing' as const
        }),
      replaceDocumentChunks: (input: {
        readonly scopeId: unknown
        readonly documentId: unknown
        readonly chunks: ReadonlyArray<unknown>
      }) =>
        Effect.sync(() => {
          replacedScopeId = input.scopeId
          replacedDocumentId = input.documentId
        }),
      markDocumentReady: () =>
        Effect.succeed({
          id: documentId,
          scopeId,
          source: KnowledgeTextSource.make({ label: 'note' }),
          status: 'ready' as const
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
        scopeId,
        documentId,
        source: { source: KnowledgeTextSource.make({ label: 'note' }), content: 'ignored' }
      })

      expect(indexed.id).toBe('doc_1')
      expect(indexed.scopeId).toBe('scope_1')
      // Branded ids stay plain strings on the wire passed to the store adapter.
      expect(replacedScopeId).toBe('scope_1')
      expect(replacedDocumentId).toBe('doc_1')
    }).pipe(Effect.provide(layer))
  })
})
