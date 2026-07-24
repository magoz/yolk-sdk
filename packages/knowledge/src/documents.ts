import * as Schema from 'effect/Schema'

export const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
export const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

export const KnowledgeMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)
export type KnowledgeMetadata = Schema.Schema.Type<typeof KnowledgeMetadataSchema>

export const KnowledgeAvailabilitySchema = Schema.Literals(['pinned', 'searchable', 'archived'])
export type KnowledgeAvailability = Schema.Schema.Type<typeof KnowledgeAvailabilitySchema>

export const KnowledgeDocumentStatusSchema = Schema.Literals(['processing', 'ready', 'error'])
export type KnowledgeDocumentStatus = Schema.Schema.Type<typeof KnowledgeDocumentStatusSchema>

export const KnowledgeScopeSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  kind: Schema.optional(NonEmptyTrimmedString)
})
export type KnowledgeScope = Schema.Schema.Type<typeof KnowledgeScopeSchema>

export const KnowledgeDocumentSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  slug: NonEmptyTrimmedString,
  title: NonEmptyTrimmedString,
  purpose: NonEmptyTrimmedString,
  origin: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString,
  status: KnowledgeDocumentStatusSchema,
  availability: KnowledgeAvailabilitySchema,
  summary: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  reviewedAt: Schema.optional(Schema.DateTimeUtc),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type KnowledgeDocument = Schema.Schema.Type<typeof KnowledgeDocumentSchema>

export const CreateKnowledgeDocumentInputSchema = Schema.Struct({
  scope: KnowledgeScopeSchema,
  slug: NonEmptyTrimmedString,
  title: NonEmptyTrimmedString,
  purpose: NonEmptyTrimmedString,
  origin: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString,
  availability: KnowledgeAvailabilitySchema,
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type CreateKnowledgeDocumentInput = Schema.Schema.Type<
  typeof CreateKnowledgeDocumentInputSchema
>

export const UpdateKnowledgeDocumentInputSchema = Schema.Struct({
  scope: KnowledgeScopeSchema,
  id: NonEmptyTrimmedString,
  slug: Schema.optional(NonEmptyTrimmedString),
  title: Schema.optional(NonEmptyTrimmedString),
  purpose: Schema.optional(NonEmptyTrimmedString),
  origin: Schema.optional(NonEmptyTrimmedString),
  content: Schema.optional(NonEmptyTrimmedString),
  status: Schema.optional(KnowledgeDocumentStatusSchema),
  availability: Schema.optional(KnowledgeAvailabilitySchema),
  summary: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  reviewedAt: Schema.optional(Schema.DateTimeUtc),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type UpdateKnowledgeDocumentInput = Schema.Schema.Type<
  typeof UpdateKnowledgeDocumentInputSchema
>

export const KnowledgeFileSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  documentId: NonEmptyTrimmedString,
  storageKey: NonEmptyTrimmedString,
  mediaType: Schema.optional(NonEmptyTrimmedString),
  byteSize: Schema.optional(NonNegativeInteger),
  checksum: Schema.optional(NonEmptyTrimmedString),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc
})
export type KnowledgeFile = Schema.Schema.Type<typeof KnowledgeFileSchema>

export const KnowledgeChunkSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  scopeId: NonEmptyTrimmedString,
  documentId: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString,
  position: NonNegativeInteger,
  tokenCount: PositiveInteger,
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type KnowledgeChunk = Schema.Schema.Type<typeof KnowledgeChunkSchema>

export const KnowledgeSearchScopeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('KnowledgeScope'), id: NonEmptyTrimmedString }),
  Schema.Struct({
    _tag: Schema.Literal('KnowledgeScopes'),
    ids: Schema.NonEmptyArray(NonEmptyTrimmedString)
  })
])
export type KnowledgeSearchScope = Schema.Schema.Type<typeof KnowledgeSearchScopeSchema>

export const KnowledgeSourceSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('File'),
    ref: NonEmptyTrimmedString,
    name: Schema.optional(NonEmptyTrimmedString),
    mediaType: Schema.optional(NonEmptyTrimmedString)
  }),
  Schema.Struct({
    _tag: Schema.Literal('Url'),
    url: NonEmptyTrimmedString
  }),
  Schema.Struct({
    _tag: Schema.Literal('Text'),
    label: Schema.optional(NonEmptyTrimmedString)
  })
])
export type KnowledgeSource = Schema.Schema.Type<typeof KnowledgeSourceSchema>

export const IndexedKnowledgeDocumentSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  scopeId: NonEmptyTrimmedString,
  source: KnowledgeSourceSchema,
  status: KnowledgeDocumentStatusSchema,
  title: Schema.optional(NonEmptyTrimmedString),
  summary: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  contentHash: Schema.optional(NonEmptyTrimmedString),
  tokenCount: Schema.optional(NonNegativeInteger),
  chunkCount: Schema.optional(NonNegativeInteger),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type IndexedKnowledgeDocument = Schema.Schema.Type<typeof IndexedKnowledgeDocumentSchema>

export const ExtractedKnowledgeDocumentSchema = Schema.Struct({
  content: NonEmptyTrimmedString,
  title: Schema.optional(NonEmptyTrimmedString),
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type ExtractedKnowledgeDocument = Schema.Schema.Type<typeof ExtractedKnowledgeDocumentSchema>

export const defaultKnowledgeChunkMaxTokens = 512
