import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeRagSet } from '@yolk/rag/documents'
import { RagStore } from '@yolk/rag/store'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { DrizzleRagStoreLayer } from './live-layer'

const describeWithDb = process.env.RAG_STORE_DB_TESTS === '1' ? describe : describe.skip

const embedding = (activeIndex: 0 | 1) =>
  Array.from({ length: 1536 }, (_, index) => (index === activeIndex ? 1 : 0))

describeWithDb('DrizzleRagStoreLayer', () => {
  it.effect('stores, searches, expands, and deletes RAG chunks', () => {
    const userId = createId()
    const ragSetId = createId()
    const storageObjectId = createId()
    const documentId = createId()

    const cleanup = Effect.gen(function* () {
      const db = yield* Db
      yield* db.delete(schema.user).where(eq(schema.user.id, userId))
    }).pipe(Effect.catch(() => Effect.void))

    return Effect.gen(function* () {
      const db = yield* Db
      const store = yield* RagStore

      yield* cleanup
      yield* db.insert(schema.user).values({
        id: userId,
        name: 'RAG test user',
        email: `${userId}@example.test`,
        emailVerified: true
      })

      const set = yield* store.upsertSet(
        makeRagSet({
          id: ragSetId,
          label: 'test storage',
          embeddingConfig: { model: 'test-embedding', dimensions: 1536 },
          chunkingConfig: { strategy: 'sentence-token', maxTokens: 8 },
          metadata: { userId }
        })
      )

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
          ragSetId: set.id,
          source: { _tag: 'Text', label: 'Test note' },
          status: 'processing',
          metadata: { storageObjectId }
        }
      })

      yield* store.replaceDocumentChunks({
        ragSetId: set.id,
        documentId,
        chunks: [
          {
            chunk: {
              id: `${documentId}:chunk:0`,
              ragSetId: set.id,
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
              ragSetId: set.id,
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
              ragSetId: set.id,
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
        ragSetId: set.id,
        documentId,
        title: 'Test note',
        summary: 'Test summary',
        contentHash: 'hash',
        tokenCount: 6,
        chunkCount: 3
      })

      const results = yield* store.searchChunks({
        scope: { _tag: 'RagSet', id: set.id },
        embedding: embedding(0),
        limit: 2,
        minScore: 0.8
      })

      const context = yield* store.getContextChunks({
        ragSetId: set.id,
        documentId,
        position: 1,
        contextChunks: 1
      })

      yield* store.deleteDocument({ ragSetId: set.id, documentId })
      const afterDelete = yield* store.searchChunks({
        scope: { _tag: 'RagSet', id: set.id },
        embedding: embedding(0),
        limit: 2,
        minScore: 0.8
      })

      expect(processing.status).toBe('processing')
      expect(ready.status).toBe('ready')
      expect(ready.title).toBe('Test note')
      expect(results.map(result => result.chunk.content)).toEqual(['alpha before', 'alpha match'])
      expect(results.every(result => result.document.id === documentId)).toBe(true)
      expect(context.map(chunk => chunk.content)).toEqual(['alpha before', 'alpha match', 'beta after'])
      expect(afterDelete).toEqual([])
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(DrizzleRagStoreLayer),
      Effect.provide(Db.layer),
      Effect.scoped
    )
  })
})
