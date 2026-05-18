import * as Schema from 'effect/Schema'
import {
  KnowledgeMetadataSchema,
  NonEmptyTrimmedString,
  NonNegativeInteger
} from './objects.ts'

export const KnowledgeRepresentationModalitySchema = Schema.Literals([
  'text',
  'image',
  'audio',
  'video',
  'table'
])
export type KnowledgeRepresentationModality = Schema.Schema.Type<typeof KnowledgeRepresentationModalitySchema>

export const KnowledgeRepresentationStatusSchema = Schema.Literals([
  'pending',
  'processing',
  'ready',
  'error'
])
export type KnowledgeRepresentationStatus = Schema.Schema.Type<typeof KnowledgeRepresentationStatusSchema>

export const KnowledgeRepresentationSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  objectId: NonEmptyTrimmedString,
  artifactId: Schema.optional(NonEmptyTrimmedString),
  modality: KnowledgeRepresentationModalitySchema,
  status: KnowledgeRepresentationStatusSchema,
  contentText: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  model: Schema.optional(NonEmptyTrimmedString),
  errorMessage: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type KnowledgeRepresentation = Schema.Schema.Type<typeof KnowledgeRepresentationSchema>

export const KnowledgeChunkSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  objectId: NonEmptyTrimmedString,
  representationId: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString,
  position: NonNegativeInteger,
  tokenCount: NonNegativeInteger,
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc
})
export type KnowledgeChunk = Schema.Schema.Type<typeof KnowledgeChunkSchema>
