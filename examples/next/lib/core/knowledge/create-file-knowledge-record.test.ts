import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { DefaultKnowledgeChunkerLive } from '@yolk-sdk/knowledge/chunking'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { KnowledgeArtifactStore } from '@yolk-sdk/knowledge/artifacts'
import { KnowledgeArtifactError } from '@yolk-sdk/knowledge/errors'
import type { PutKnowledgeArtifactInput } from '@yolk-sdk/knowledge/artifacts'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { FileExtractionError } from '@/lib/services/file-extractor/errors'
import { createFileKnowledgeRecord } from './create-file-knowledge-record'
import { deleteKnowledgeRecord } from './delete-knowledge-record'
import { getKnowledgeContext } from './get-knowledge-context'
import { searchUserKnowledge } from './search-user-knowledge'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip
const embedding = (activeIndex: 0 | 1) =>
  Array.from({ length: 1536 }, (_, index) => (index === activeIndex ? 1 : 0))

describeWithDb('createFileKnowledgeRecord', () => {
  it.effect('stores original artifact and extracted representation', () => {
    const userId = createId()
    const puts: Array<PutKnowledgeArtifactInput> = []

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
      const object = yield* createFileKnowledgeRecord({
        userId,
        filename: 'alpha.txt',
        mediaType: 'text/plain',
        bytes,
        pinned: true
      })

      const artifacts = yield* db
        .select()
        .from(schema.knowledgeArtifact)
        .where(eq(schema.knowledgeArtifact.recordId, object.id))
      const representations = yield* db
        .select()
        .from(schema.knowledgeRepresentation)
        .where(eq(schema.knowledgeRepresentation.recordId, object.id))
      const provenance = yield* db
        .select()
        .from(schema.knowledgeProvenance)
        .where(eq(schema.knowledgeProvenance.recordId, object.id))
      const chunks = yield* db
        .select()
        .from(schema.knowledgeRepresentationChunk)
        .where(eq(schema.knowledgeRepresentationChunk.recordId, object.id))
      const results = yield* searchUserKnowledge({ userId, query: 'Alpha file knowledge', limit: 4 })
      const context = yield* getKnowledgeContext({ userId, recordId: object.id, position: 0, before: 2, after: 2 })
      const otherUserResults = yield* searchUserKnowledge({ userId: createId(), query: 'Alpha file knowledge', limit: 4 })
      yield* db
        .update(schema.knowledgeRecord)
        .set({ contextPolicy: 'archival' })
        .where(eq(schema.knowledgeRecord.id, object.id))
      const archivalResults = yield* searchUserKnowledge({ userId, query: 'Alpha file knowledge', limit: 4 })

      expect(object.userId).toBe(userId)
      expect(object.role).toBe('source')
      expect(object.status).toBe('ready')
      expect(object.contextPolicy).toBe('pinned')
      expect(object.title).toBe('alpha.txt')
      expect(puts).toHaveLength(1)
      expect(puts[0]?.mediaType).toBe('text/plain')
      expect(Array.from(puts[0]?.bytes ?? [])).toEqual(Array.from(bytes))
      expect(puts[0]?.storageKey).toMatch(new RegExp(`^knowledge/${object.id}/original/`))
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]?.kind).toBe('original')
      expect(artifacts[0]?.storageKey).toBe(puts[0]?.storageKey)
      expect(artifacts[0]?.byteSize).toBe(bytes.byteLength)
      expect(representations).toHaveLength(1)
      expect(representations[0]?.artifactId).toBe(artifacts[0]?.id)
      expect(representations[0]?.contentText).toBe('Alpha file knowledge.')
      expect(representations[0]?.status).toBe('ready')
      expect(chunks).toHaveLength(1)
      expect(chunks[0]?.content).toBe('Alpha file knowledge.')
      expect(results.map(result => result.record.id)).toEqual([object.id])
      expect(context.record.id).toBe(object.id)
      expect(context.anchor.position).toBe(0)
      expect(context.text).toBe('Alpha file knowledge.')
      expect(otherUserResults).toEqual([])
      expect(archivalResults).toEqual([])
      expect(provenance).toHaveLength(1)
      expect(provenance[0]?.artifactId).toBe(artifacts[0]?.id)
      expect(provenance[0]?.sourceKind).toBe('upload')
      expect(provenance[0]?.sourceLabel).toBe('alpha.txt')
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(
        Layer.succeed(KnowledgeArtifactStore, {
          putArtifact: input => Effect.sync(() => {
            puts.push(input)
          }),
          getArtifact: input => Effect.fail(new KnowledgeArtifactError({ message: `Unexpected getArtifact ${input.storageKey}` })),
          deleteArtifact: input => Effect.fail(new KnowledgeArtifactError({ message: `Unexpected deleteArtifact ${input.storageKey}` }))
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
    const puts: Array<PutKnowledgeArtifactInput> = []

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
      const object = yield* createFileKnowledgeRecord({
        userId,
        filename: 'detached.pdf',
        mediaType: 'application/pdf',
        bytes,
        pinned: false
      })

      const artifacts = yield* db
        .select()
        .from(schema.knowledgeArtifact)
        .where(eq(schema.knowledgeArtifact.recordId, object.id))

      expect(puts).toHaveLength(1)
      expect(Array.from(puts[0]?.bytes ?? [])).toEqual([37, 80, 68, 70])
      expect(artifacts[0]?.byteSize).toBe(4)
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(
        Layer.succeed(KnowledgeArtifactStore, {
          putArtifact: input => Effect.sync(() => {
            puts.push(input)
          }),
          getArtifact: input => Effect.fail(new KnowledgeArtifactError({ message: `Unexpected getArtifact ${input.storageKey}` })),
          deleteArtifact: input => Effect.fail(new KnowledgeArtifactError({ message: `Unexpected deleteArtifact ${input.storageKey}` }))
        })
      ),
      Effect.provide(
        Layer.succeed(FileExtractor, {
          extract: input => Effect.sync(() => {
            if (input.bytes.buffer instanceof ArrayBuffer) {
              structuredClone(input.bytes.buffer, { transfer: [input.bytes.buffer] })
              return { content: 'Detached PDF text.', metadata: { format: 'pdf' as const, title: input.filename } }
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

  it.effect('deletes owned artifacts before deleting object rows', () => {
    const userId = createId()
    const recordId = createId()
    const artifactId = createId()
    const storageKey = `knowledge/${recordId}/original/${artifactId}`
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
      yield* db.insert(schema.knowledgeRecord).values({
        id: recordId,
        userId,
        role: 'source',
        title: 'Delete me',
        status: 'ready',
        contextPolicy: 'searchable',
        metadata: {}
      })
      yield* db.insert(schema.knowledgeArtifact).values({
        id: artifactId,
        recordId,
        kind: 'original',
        storageKey,
        mediaType: 'text/plain',
        byteSize: 5,
        metadata: {}
      })

      yield* deleteKnowledgeRecord({ userId, id: recordId })

      const objects = yield* db
        .select()
        .from(schema.knowledgeRecord)
        .where(eq(schema.knowledgeRecord.id, recordId))
      const artifacts = yield* db
        .select()
        .from(schema.knowledgeArtifact)
        .where(eq(schema.knowledgeArtifact.id, artifactId))

      expect(deleted).toEqual([storageKey])
      expect(objects).toEqual([])
      expect(artifacts).toEqual([])
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.provide(
        Layer.succeed(KnowledgeArtifactStore, {
          putArtifact: input => Effect.fail(new KnowledgeArtifactError({ message: `Unexpected putArtifact ${input.storageKey}` })),
          getArtifact: input => Effect.fail(new KnowledgeArtifactError({ message: `Unexpected getArtifact ${input.storageKey}` })),
          deleteArtifact: input => Effect.sync(() => {
            deleted.push(input.storageKey)
          })
        })
      ),
      Effect.provide(Db.layer),
      Effect.scoped
    )
  }, 30_000)
})
