import { eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagDocumentNotFoundError, AppRagStoreError } from './errors'
import { getRagDocument } from './get-rag-document'

export type UpdateRagDocumentFields = {
  readonly title?: string | null
  readonly summary?: string | null
  readonly metadata?: Record<string, unknown>
}

const mapUpdateError = (error: unknown) => {
  if (error instanceof AppRagDocumentNotFoundError || error instanceof AppRagStoreError) {
    return error
  }

  return new AppRagStoreError({ message: 'Could not update RAG document', cause: error })
}

const updateWithTitleSummaryMetadata = (documentId: string, fields: UpdateRagDocumentFields) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [document] = yield* db
      .update(schema.ragDocument)
      .set({
        title: fields.title,
        summary: fields.summary,
        metadata: fields.metadata,
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(eq(schema.ragDocument.id, documentId))
      .returning({ id: schema.ragDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId })
      )
    }

    return yield* getRagDocument(document.id)
  })

const updateWithTitleSummary = (documentId: string, fields: UpdateRagDocumentFields) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [document] = yield* db
      .update(schema.ragDocument)
      .set({ title: fields.title, summary: fields.summary, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.ragDocument.id, documentId))
      .returning({ id: schema.ragDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId })
      )
    }

    return yield* getRagDocument(document.id)
  })

const updateWithTitle = (documentId: string, fields: UpdateRagDocumentFields) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [document] = yield* db
      .update(schema.ragDocument)
      .set({ title: fields.title, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.ragDocument.id, documentId))
      .returning({ id: schema.ragDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId })
      )
    }

    return yield* getRagDocument(document.id)
  })

const updateWithSummary = (documentId: string, fields: UpdateRagDocumentFields) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [document] = yield* db
      .update(schema.ragDocument)
      .set({ summary: fields.summary, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.ragDocument.id, documentId))
      .returning({ id: schema.ragDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId })
      )
    }

    return yield* getRagDocument(document.id)
  })

const updateWithMetadata = (documentId: string, fields: UpdateRagDocumentFields) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [document] = yield* db
      .update(schema.ragDocument)
      .set({ metadata: fields.metadata, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.ragDocument.id, documentId))
      .returning({ id: schema.ragDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId })
      )
    }

    return yield* getRagDocument(document.id)
  })

export const updateRagDocument = (documentId: string, fields: UpdateRagDocumentFields) =>
  Effect.gen(function* () {
    if (fields.title !== undefined && fields.summary !== undefined && fields.metadata !== undefined) {
      return yield* updateWithTitleSummaryMetadata(documentId, fields)
    }

    if (fields.title !== undefined && fields.summary !== undefined) {
      return yield* updateWithTitleSummary(documentId, fields)
    }

    if (fields.title !== undefined) {
      return yield* updateWithTitle(documentId, fields)
    }

    if (fields.summary !== undefined) {
      return yield* updateWithSummary(documentId, fields)
    }

    if (fields.metadata !== undefined) {
      return yield* updateWithMetadata(documentId, fields)
    }

    return yield* getRagDocument(documentId)
  }).pipe(Effect.withSpan('rag.document.update'), Effect.mapError(mapUpdateError))
