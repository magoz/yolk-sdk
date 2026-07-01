import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { DefaultKnowledgeChunkerLive } from '@yolk-sdk/knowledge/chunking'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { KnowledgeFileError } from '@yolk-sdk/knowledge/errors'
import type { PutKnowledgeFileInput } from '@yolk-sdk/knowledge/files'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { FileExtractionError } from '@/lib/services/file-extractor/errors'
import { createFileKnowledgeDocument } from './create-file-knowledge-document'
import { deleteKnowledgeDocument } from './delete-knowledge-document'
import { getKnowledgeContext } from './get-knowledge-context'
import { searchUserKnowledge } from './search-user-knowledge'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip
const embedding = (activeIndex: 0 | 1) =>
  Array.from({ length: 1536 }, (_, index) => (index === activeIndex ? 1 : 0))

describeWithDb('createFileKnowledgeDocument', () => {
  it.effect('stores original file and chunks extracted content', () => {
    const userId = createId()
    const puts: Array<PutKnowledgeFileInput> = []

    const cleanup = Effect.gen(function* () {
      const db = yield* Db
      yield* db.delete(schema.user).where(eq(schema.user.id, userId))
    }).pipe(Effect.catch(() => Effect.void))

    return Effect.gen(function* () {
      const db = yield* Db
      yield* cleanup
      yield* db.insert(schema.user).values({
        id: userId,
        name: 'Knowledge file test user',
        email: `${userId}@example.test`,
        emailVerified: true
      })

      const bytes = new TextEncoder().encode('  Alpha file knowledge.  ')
      const document = yield* createFileKnowledgeDocument({
        userId,
        filename: 'alpha.txt',
        mediaType: 'text/plain',
        bytes,
        pinned: true
      })

      const files = yield* db
        .select()
        .from(schema.userKnowledgeFile)
        .where(eq(schema.userKnowledgeFile.documentId, document.id))
      const chunks = yield* db
        .select()
        .from(schema.userKnowledgeChunk)
        .where(eq(schema.userKnowledgeChunk.documentId, document.id))
      const results = yield* searchUserKnowledge({ userId, query: 'Alpha file knowledge', limit: 4 })
      const context = yield* getKnowledgeContext({ userId, documentId: document.id, position: 0, before: 2, after: 2 })
      const otherUserResults = yield* searchUserKnowledge({ userId: createId(), query: 'Alpha file knowledge', limit: 4 })
      yield* db
        .update(schema.userKnowledgeDocument)
        .set({ availability: 'archived' })
        .where(eq(schema.userKnowledgeDocument.id, document.id))
      const archivedResults = yield* searchUserKnowledge({ userId, query: 'Alpha file knowledge', limit: 4 })

      expect(document.userId).toBe(userId)
      expect(document.status).toBe('ready')
      expect(document.availability).toBe('pinned')
      expect(document.title).toBe('alpha.txt')
      expect(document.origin).toBe('file_upload')
      expect(document.content).toBe('Alpha file knowledge.')
      expect(puts).toHaveLength(1)
      expect(puts[0]?.mediaType).toBe('text/plain')
      expect(Array.from(puts[0]?.bytes ?? [])).toEqual(Array.from(bytes))
      expect(puts[0]?.storageKey).toMatch(new RegExp(`^knowledge/${document.id}/original/`))
      expect(files).toHaveLength(1)
      expect(files[0]?.storageKey).toBe(puts[0]?.storageKey)
      expect(files[0]?.byteSize).toBe(bytes.byteLength)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]?.content).toBe('Alpha file knowledge.')
      expect(results.map(result => result.document.id)).toEqual([document.id])
      expect(context.document.id).toBe(document.id)
      expect(context.anchor.position).toBe(0)
      expect(context.text).toBe('Alpha file knowledge.')
      expect(otherUserResults).toEqual([])
      expect(archivedResults).toEqual([])
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(
        Layer.succeed(KnowledgeFileBlobStore, {
          putFile: input => Effect.sync(() => {
            puts.push(input)
          }),
          getFile: input => Effect.fail(new KnowledgeFileError({ message: `Unexpected getFile ${input.storageKey}` })),
          deleteFile: input => Effect.fail(new KnowledgeFileError({ message: `Unexpected deleteFile ${input.storageKey}` }))
        })
      ),
      Effect.provide(
        Layer.succeed(KnowledgeEmbedder, {
          embedTexts: texts => Effect.succeed(texts.map(() => embedding(0))),
          embedQuery: () => Effect.succeed(embedding(0))
        })
      ),
      Effect.provide(DefaultKnowledgeChunkerLive()),
      Effect.provide(FileExtractor.layer),
      Effect.provide(Db.layer),
      Effect.scoped
    )
  }, 30_000)

  it.effect('keeps upload bytes when extraction detaches its input buffer', () => {
    const userId = createId()
    const puts: Array<PutKnowledgeFileInput> = []

    const cleanup = Effect.gen(function* () {
      const db = yield* Db
      yield* db.delete(schema.user).where(eq(schema.user.id, userId))
    }).pipe(Effect.catch(() => Effect.void))

    return Effect.gen(function* () {
      const db = yield* Db
      yield* cleanup
      yield* db.insert(schema.user).values({
        id: userId,
        name: 'Knowledge detached buffer test user',
        email: `${userId}@example.test`,
        emailVerified: true
      })

      const bytes = new Uint8Array([37, 80, 68, 70])
      const document = yield* createFileKnowledgeDocument({
        userId,
        filename: 'detached.pdf',
        mediaType: 'application/pdf',
        bytes,
        pinned: false
      })

      const files = yield* db
        .select()
        .from(schema.userKnowledgeFile)
        .where(eq(schema.userKnowledgeFile.documentId, document.id))

      expect(puts).toHaveLength(1)
      expect(Array.from(puts[0]?.bytes ?? [])).toEqual([37, 80, 68, 70])
      expect(files[0]?.byteSize).toBe(4)
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(
        Layer.succeed(KnowledgeFileBlobStore, {
          putFile: input => Effect.sync(() => {
            puts.push(input)
          }),
          getFile: input => Effect.fail(new KnowledgeFileError({ message: `Unexpected getFile ${input.storageKey}` })),
          deleteFile: input => Effect.fail(new KnowledgeFileError({ message: `Unexpected deleteFile ${input.storageKey}` }))
        })
      ),
      Effect.provide(
        Layer.succeed(FileExtractor, {
          extract: input => Effect.sync(() => {
            if (input.bytes.buffer instanceof ArrayBuffer) {
              structuredClone(input.bytes.buffer, { transfer: [input.bytes.buffer] })
              return { content: 'Detached PDF text.', metadata: { format: 'pdf', title: input.filename } }
            }

            throw new FileExtractionError({ message: 'Expected ArrayBuffer input', format: 'pdf' })
          })
        })
      ),
      Effect.provide(
        Layer.succeed(KnowledgeEmbedder, {
          embedTexts: texts => Effect.succeed(texts.map(() => embedding(0))),
          embedQuery: () => Effect.succeed(embedding(0))
        })
      ),
      Effect.provide(DefaultKnowledgeChunkerLive()),
      Effect.provide(Db.layer),
      Effect.scoped
    )
  }, 30_000)

  it.effect('deletes owned files before deleting document rows', () => {
    const userId = createId()
    const documentId = createId()
    const fileId = createId()
    const storageKey = `knowledge/${documentId}/original/${fileId}`
    const deleted: Array<string> = []

    const cleanup = Effect.gen(function* () {
      const db = yield* Db
      yield* db.delete(schema.user).where(eq(schema.user.id, userId))
    }).pipe(Effect.catch(() => Effect.void))

    return Effect.gen(function* () {
      const db = yield* Db
      yield* cleanup
      yield* db.insert(schema.user).values({
        id: userId,
        name: 'Knowledge delete test user',
        email: `${userId}@example.test`,
        emailVerified: true
      })
      yield* db.insert(schema.userKnowledgeDocument).values({
        id: documentId,
        userId,
        slug: `delete-me-${documentId}`,
        title: 'Delete me',
        purpose: 'Delete test',
        origin: 'test',
        content: 'Delete me',
        status: 'ready',
        availability: 'searchable',
        metadata: {}
      })
      yield* db.insert(schema.userKnowledgeFile).values({
        id: fileId,
        documentId,
        storageKey,
        mediaType: 'text/plain',
        byteSize: 5,
        metadata: {}
      })

      yield* deleteKnowledgeDocument({ userId, id: documentId })

      const documents = yield* db
        .select()
        .from(schema.userKnowledgeDocument)
        .where(eq(schema.userKnowledgeDocument.id, documentId))
      const files = yield* db
        .select()
        .from(schema.userKnowledgeFile)
        .where(eq(schema.userKnowledgeFile.id, fileId))

      expect(deleted).toEqual([storageKey])
      expect(documents).toEqual([])
      expect(files).toEqual([])
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(
        Layer.succeed(KnowledgeFileBlobStore, {
          putFile: input => Effect.fail(new KnowledgeFileError({ message: `Unexpected putFile ${input.storageKey}` })),
          getFile: input => Effect.fail(new KnowledgeFileError({ message: `Unexpected getFile ${input.storageKey}` })),
          deleteFile: input => Effect.sync(() => {
            deleted.push(input.storageKey)
          })
        })
      ),
      Effect.provide(Db.layer),
      Effect.scoped
    )
  }, 30_000)
})
