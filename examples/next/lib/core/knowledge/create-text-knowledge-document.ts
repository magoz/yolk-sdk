import { createId } from '@paralleldrive/cuid2'
import { Effect } from 'effect'
import { PersistenceError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { indexKnowledgeDocument } from './index-knowledge-document'
import { knowledgeSlugFromTitle } from './slug'

export const createTextKnowledgeDocument = (input: {
  readonly userId: string
  readonly title: string
  readonly content: string
  readonly pinned: boolean
}) =>
  Effect.gen(function* () {
    const title = input.title.trim()
    const content = input.content.trim()

    if (title.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ message: 'Knowledge title is empty', field: 'title' })
      )
    }

    if (content.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ message: 'Knowledge content is empty', field: 'content' })
      )
    }

    const db = yield* Db
    const documentId = createId()
    const [document] = yield* db
      .insert(schema.userKnowledgeDocument)
      .values({
        id: documentId,
        userId: input.userId,
        slug: knowledgeSlugFromTitle(title, documentId),
        title,
        purpose: input.pinned ? 'Pinned agent context' : 'User knowledge note',
        origin: 'manual_text',
        content,
        status: 'processing',
        availability: input.pinned ? 'pinned' : 'searchable',
        summary: content.length <= 500 ? content : `${content.slice(0, 500)}…`,
        metadata: { source: 'manual_text' }
      })
      .returning()

    if (document === undefined) {
      return yield* Effect.fail(
        new PersistenceError({
          message: 'Could not create knowledge document',
          entity: 'userKnowledgeDocument'
        })
      )
    }

    return yield* indexKnowledgeDocument({
      userId: input.userId,
      documentId: document.id,
      content,
      metadata: { source: 'manual_text' }
    })
  }).pipe(Effect.withSpan('knowledge.createTextKnowledgeDocument'))
