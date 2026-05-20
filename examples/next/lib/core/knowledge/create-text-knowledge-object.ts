import { Effect } from 'effect'
import { PersistenceError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { indexKnowledgeRepresentation } from './index-knowledge-representation'

export const createTextKnowledgeObject = (input: {
  readonly userId: string
  readonly title: string
  readonly content: string
  readonly pinned: boolean
}) =>
  Effect.gen(function* () {
    const title = input.title.trim()
    const content = input.content.trim()

    if (title.length === 0) {
      return yield* Effect.fail(new ValidationError({ message: 'Knowledge title is empty', field: 'title' }))
    }

    if (content.length === 0) {
      return yield* Effect.fail(new ValidationError({ message: 'Knowledge content is empty', field: 'content' }))
    }

    const db = yield* Db
    const [object] = yield* db
      .insert(schema.knowledgeObject)
      .values({
        userId: input.userId,
        role: input.pinned ? 'operating_protocol' : 'note',
        title,
        status: 'ready',
        contextPolicy: input.pinned ? 'pinned' : 'searchable',
        summary: content.length <= 500 ? content : `${content.slice(0, 500)}…`,
        metadata: { source: 'manual_text' }
      })
      .returning()

    if (object === undefined) {
      return yield* Effect.fail(new PersistenceError({ message: 'Could not create knowledge object', entity: 'knowledgeObject' }))
    }

    const [representation] = yield* db.insert(schema.knowledgeRepresentation).values({
      objectId: object.id,
      modality: 'text',
      status: 'pending',
      contentText: content,
      summary: object.summary,
      metadata: { source: 'manual_text' }
    }).returning()

    if (representation === undefined) {
      return yield* Effect.fail(new PersistenceError({ message: 'Could not create knowledge representation', entity: 'knowledgeRepresentation' }))
    }

    yield* db.insert(schema.knowledgeProvenance).values({
      objectId: object.id,
      sourceKind: 'user_statement',
      sourceLabel: 'Manual text entry',
      observedAt: new Date(),
      metadata: {}
    })

    yield* indexKnowledgeRepresentation({
      objectId: object.id,
      representationId: representation.id,
      content,
      metadata: { source: 'manual_text' }
    })

    return object
  }).pipe(Effect.withSpan('knowledge.createTextKnowledgeObject'))
