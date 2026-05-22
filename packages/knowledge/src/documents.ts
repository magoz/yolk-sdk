import { Schema } from 'effect'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

export const KnowledgeMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)
export type KnowledgeMetadata = Schema.Schema.Type<typeof KnowledgeMetadataSchema>

export const KnowledgeDocumentStatusSchema = Schema.Literals(['pending', 'processing', 'ready', 'error'])
export type KnowledgeDocumentStatus = Schema.Schema.Type<typeof KnowledgeDocumentStatusSchema>

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

export const KnowledgeEmbeddingConfigSchema = Schema.Struct({
  model: NonEmptyTrimmedString,
  dimensions: PositiveInteger
})
export type KnowledgeEmbeddingConfig = Schema.Schema.Type<typeof KnowledgeEmbeddingConfigSchema>

export const KnowledgeChunkingConfigSchema = Schema.Struct({
  strategy: Schema.Literal('sentence-token'),
  maxTokens: PositiveInteger
})
export type KnowledgeChunkingConfig = Schema.Schema.Type<typeof KnowledgeChunkingConfigSchema>

export const KnowledgeCollectionSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  label: Schema.optional(NonEmptyTrimmedString),
  embeddingConfig: KnowledgeEmbeddingConfigSchema,
  chunkingConfig: KnowledgeChunkingConfigSchema,
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type KnowledgeCollection = Schema.Schema.Type<typeof KnowledgeCollectionSchema>

export const KnowledgeDocumentSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  collectionId: NonEmptyTrimmedString,
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
export type KnowledgeDocument = Schema.Schema.Type<typeof KnowledgeDocumentSchema>

export const KnowledgeChunkSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  collectionId: NonEmptyTrimmedString,
  documentId: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString,
  position: NonNegativeInteger,
  tokenCount: PositiveInteger,
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type KnowledgeChunk = Schema.Schema.Type<typeof KnowledgeChunkSchema>

export const ExtractedKnowledgeDocumentSchema = Schema.Struct({
  content: NonEmptyTrimmedString,
  title: Schema.optional(NonEmptyTrimmedString),
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type ExtractedKnowledgeDocument = Schema.Schema.Type<typeof ExtractedKnowledgeDocumentSchema>

export const KnowledgeSearchScopeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('KnowledgeCollection'), id: NonEmptyTrimmedString }),
  Schema.Struct({ _tag: Schema.Literal('KnowledgeCollections'), ids: Schema.Array(NonEmptyTrimmedString) })
])
export type KnowledgeSearchScope = Schema.Schema.Type<typeof KnowledgeSearchScopeSchema>

export const defaultKnowledgeChunkingConfig: KnowledgeChunkingConfig = {
  strategy: 'sentence-token',
  maxTokens: 512
}

export const makeKnowledgeCollection = (input: {
  readonly id: string
  readonly label?: string
  readonly embeddingConfig: KnowledgeEmbeddingConfig
  readonly chunkingConfig?: KnowledgeChunkingConfig
  readonly metadata?: KnowledgeMetadata
}): KnowledgeCollection => ({
  id: input.id,
  label: input.label,
  embeddingConfig: input.embeddingConfig,
  chunkingConfig: input.chunkingConfig ?? defaultKnowledgeChunkingConfig,
  metadata: input.metadata
})
