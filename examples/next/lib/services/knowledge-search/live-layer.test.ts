import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { KnowledgeExtractor } from '@yolk-sdk/knowledge/extraction'
import { SearchIndexStore } from '@yolk-sdk/knowledge/store'
import { NoopKnowledgeSummarizerLive } from '@yolk-sdk/knowledge/summarization'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { getKnowledgeChunks } from './get-knowledge-chunks'
import { getKnowledgeDocument } from './get-knowledge-document'
import { getKnowledgeDocuments } from './get-knowledge-documents'
import { getKnowledgeDocumentsContent } from './get-knowledge-documents-content'
import { DrizzleSearchIndexStoreLayer, TextKnowledgeExtractorLayer } from './live-layer'
import { searchAppKnowledge } from './search-app-knowledge'
import { updateKnowledgeDocument } from './update-knowledge-document'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

const embedding = (activeIndex: 0 | 1) =>
  Array.from({ length: 1536 }, (_, index) => (index === activeIndex ? 1 : 0))

describe('TextKnowledgeExtractorLayer', () => {
  it.effect('extracts trimmed text and source title', () =>
    Effect.gen(function* () {
      const extractor = yield* KnowledgeExtractor
      const extracted = yield* extractor.extract({
        source: { _tag: 'Text', label: 'Original title' },
        content: '  Alpha beta.  ',
        metadata: { title: 'Original title' }
      })

      expect(extracted).toEqual({
        content: 'Alpha beta.',
        title: 'Original title',
        metadata: { title: 'Original title' }
      })
    }).pipe(
      Effect.provide(TextKnowledgeExtractorLayer),
      Effect.provide(NoopKnowledgeSummarizerLive)
    )
  )
})

describeWithDb('DrizzleSearchIndexStoreLayer', () => {
  it.effect(
    'stores, searches, expands, and deletes knowledge search chunks',
    () => {
      const userId = createId()
      const otherUserId = createId()
      const collectionId = createId()
      const storageObjectId = createId()
      const documentId = createId()

      const cleanup = Effect.gen(function* () {
        const db = yield* Db
        yield* db.delete(schema.user).where(eq(schema.user.id, userId))
      }).pipe(Effect.catch(() => Effect.void))

      return Effect.gen(function* () {
        const db = yield* Db
        const store = yield* SearchIndexStore

        yield* cleanup
        yield* db.insert(schema.user).values({
          id: userId,
          name: 'knowledge search test user',
          email: `${userId}@example.test`,
          emailVerified: true
        })

        yield* db.insert(schema.knowledgeCollection).values({
          id: collectionId,
          userId,
          label: 'test storage',
          embeddingModel: 'test-embedding',
          embeddingDimensions: 1536,
          chunkingStrategy: 'sentence-token',
          chunkMaxTokens: 8,
          metadata: { userId }
        })

        const [storageObject] = yield* db
          .insert(schema.storageObject)
          .values({
            id: storageObjectId,
            userId,
            sourceType: 'text',
            textContent: 'alpha before\n\nalpha match\n\nbeta after',
            filename: 'Test note',
            mediaType: 'text/plain',
            metadata: { title: 'Test note' }
          })
          .returning()

        if (storageObject === undefined) {
          return yield* Effect.die(new Error('Could not create test storage object'))
        }

        const processing = yield* store.upsertDocument({
          document: {
            id: documentId,
            scopeId: collectionId,
            source: { _tag: 'Text', label: 'Test note' },
            status: 'processing',
            metadata: { storageObjectId }
          }
        })

        yield* store.replaceDocumentChunks({
          scopeId: collectionId,
          documentId,
          chunks: [
            {
              chunk: {
                id: `${documentId}:chunk:0`,
                scopeId: collectionId,
                documentId,
                content: 'alpha before',
                position: 0,
                tokenCount: 2
              },
              embedding: embedding(0)
            },
            {
              chunk: {
                id: `${documentId}:chunk:1`,
                scopeId: collectionId,
                documentId,
                content: 'alpha match',
                position: 1,
                tokenCount: 2
              },
              embedding: embedding(0)
            },
            {
              chunk: {
                id: `${documentId}:chunk:2`,
                scopeId: collectionId,
                documentId,
                content: 'beta after',
                position: 2,
                tokenCount: 2
              },
              embedding: embedding(1)
            }
          ]
        })

        const ready = yield* store.markDocumentReady({
          scopeId: collectionId,
          documentId,
          title: 'Test note',
          summary: 'Test summary',
          contentHash: 'hash',
          tokenCount: 6,
          chunkCount: 3
        })

        const results = yield* store.searchChunks({
          scope: { _tag: 'KnowledgeScope', id: collectionId },
          embedding: embedding(0),
          limit: 2,
          minScore: 0.8
        })
        const textResults = yield* store.searchChunksByText({
          scope: { _tag: 'KnowledgeScope', id: collectionId },
          query: 'beta after',
          limit: 2
        })

        const context = yield* store.getContextChunks({
          scopeId: collectionId,
          documentId,
          position: 1,
          contextChunks: 1
        })
        const listed = yield* getKnowledgeDocuments({ userId, collectionId })
        const document = yield* getKnowledgeDocument({ userId, documentId })
        const withContent = yield* getKnowledgeDocumentsContent({ userId, collectionId })
        const chunks = yield* getKnowledgeChunks({ userId, chunkIds: [`${documentId}:chunk:1`] })
        const updated = yield* updateKnowledgeDocument({
          userId,
          documentId,
          fields: { title: 'Updated note', metadata: { storageObjectId, updated: true } }
        })
        const appSearchResults = yield* searchAppKnowledge({
          userId,
          scope: { _tag: 'KnowledgeScope', id: collectionId },
          query: 'alpha',
          options: { limit: 1, contextChunks: 1 }
        })
        const otherUserDocumentError = yield* getKnowledgeDocument({
          userId: otherUserId,
          documentId
        }).pipe(Effect.flip)
        const otherUserUpdateError = yield* updateKnowledgeDocument({
          userId: otherUserId,
          documentId,
          fields: { title: 'Should not update' }
        }).pipe(Effect.flip)
        const otherUserChunks = yield* getKnowledgeChunks({
          userId: otherUserId,
          chunkIds: [`${documentId}:chunk:1`]
        })

        yield* store.deleteDocument({ scopeId: collectionId, documentId })
        const afterDelete = yield* store.searchChunks({
          scope: { _tag: 'KnowledgeScope', id: collectionId },
          embedding: embedding(0),
          limit: 2,
          minScore: 0.8
        })

        expect(processing.status).toBe('processing')
        expect(ready.status).toBe('ready')
        expect(ready.title).toBe('Test note')
        expect(results.map(result => result.chunk.content)).toEqual(['alpha before', 'alpha match'])
        expect(textResults.map(result => result.chunk.content)).toEqual(['beta after'])
        expect(results.every(result => result.document.id === documentId)).toBe(true)
        expect(context.map(chunk => chunk.content)).toEqual([
          'alpha before',
          'alpha match',
          'beta after'
        ])
        expect(listed.map(item => item.document.id)).toEqual([documentId])
        expect(document.document.id).toBe(documentId)
        expect(withContent.map(item => item.content)).toEqual([
          'alpha before\n\nalpha match\n\nbeta after'
        ])
        expect(chunks.map(item => item.chunk.content)).toEqual(['alpha match'])
        expect(updated.document.title).toBe('Updated note')
        expect(updated.document.metadata.updated).toBe(true)
        expect(appSearchResults.map(result => result.chunk.content)).toEqual(['alpha before'])
        expect(appSearchResults[0]?.context?.map(chunk => chunk.content)).toEqual([
          'alpha before',
          'alpha match'
        ])
        expect(otherUserDocumentError._tag).toBe('AppKnowledgeDocumentNotFoundError')
        expect(otherUserUpdateError._tag).toBe('AppKnowledgeDocumentNotFoundError')
        expect(otherUserChunks).toEqual([])
        expect(afterDelete).toEqual([])
      }).pipe(
        Effect.ensuring(cleanup),
        Effect.provide(
          Layer.succeed(KnowledgeEmbedder, {
            embedTexts: texts => Effect.succeed(texts.map(() => embedding(0))),
            embedQuery: () => Effect.succeed(embedding(0))
          })
        ),
        Effect.provide(DrizzleSearchIndexStoreLayer),
        Effect.provide(Db.layer),
        Effect.scoped
      )
    },
    30_000
  )
})
