import * as Schema from 'effect/Schema'
import { KnowledgeMetadataSchema, NonEmptyTrimmedString } from './objects.ts'

export const KnowledgeProvenanceSourceKindSchema = Schema.Literals([
  'upload',
  'user_statement',
  'url',
  'generated',
  'imported',
  'external_api'
])
export type KnowledgeProvenanceSourceKind = Schema.Schema.Type<typeof KnowledgeProvenanceSourceKindSchema>

export const KnowledgeProvenanceSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  objectId: NonEmptyTrimmedString,
  artifactId: Schema.optional(NonEmptyTrimmedString),
  sourceKind: KnowledgeProvenanceSourceKindSchema,
  sourceLabel: NonEmptyTrimmedString,
  sourceUrl: Schema.optional(NonEmptyTrimmedString),
  observedAt: Schema.optional(Schema.DateTimeUtc),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc
})
export type KnowledgeProvenance = Schema.Schema.Type<typeof KnowledgeProvenanceSchema>
