import * as Schema from 'effect/Schema'
import { KnowledgeMetadataSchema, NonEmptyTrimmedString } from './records.ts'

export const KnowledgeLinkTypeSchema = Schema.Literals([
  'cites',
  'supports',
  'contradicts',
  'supersedes',
  'mentions',
  'derived_from',
  'related_to'
])
export type KnowledgeLinkType = Schema.Schema.Type<typeof KnowledgeLinkTypeSchema>

export const KnowledgeLinkSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  fromRecordId: NonEmptyTrimmedString,
  toRecordId: NonEmptyTrimmedString,
  type: KnowledgeLinkTypeSchema,
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc
})
export type KnowledgeLink = Schema.Schema.Type<typeof KnowledgeLinkSchema>
