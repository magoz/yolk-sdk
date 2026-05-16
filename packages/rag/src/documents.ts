import { Schema } from 'effect'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

export const RagMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)
export type RagMetadata = Schema.Schema.Type<typeof RagMetadataSchema>

export const RagDocumentStatusSchema = Schema.Literals(['pending', 'processing', 'ready', 'error'])
export type RagDocumentStatus = Schema.Schema.Type<typeof RagDocumentStatusSchema>

export const RagSourceSchema = Schema.Union([
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
export type RagSource = Schema.Schema.Type<typeof RagSourceSchema>

export const RagEmbeddingConfigSchema = Schema.Struct({
  model: NonEmptyTrimmedString,
  dimensions: PositiveInteger
})
export type RagEmbeddingConfig = Schema.Schema.Type<typeof RagEmbeddingConfigSchema>

export const RagChunkingConfigSchema = Schema.Struct({
  strategy: Schema.Literal('sentence-token'),
  maxTokens: PositiveInteger
})
export type RagChunkingConfig = Schema.Schema.Type<typeof RagChunkingConfigSchema>

export const RagSetSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  label: Schema.optional(NonEmptyTrimmedString),
  embeddingConfig: RagEmbeddingConfigSchema,
  chunkingConfig: RagChunkingConfigSchema,
  metadata: Schema.optional(RagMetadataSchema)
})
export type RagSet = Schema.Schema.Type<typeof RagSetSchema>

export const RagDocumentSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  ragSetId: NonEmptyTrimmedString,
  source: RagSourceSchema,
  status: RagDocumentStatusSchema,
  title: Schema.optional(NonEmptyTrimmedString),
  summary: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  contentHash: Schema.optional(NonEmptyTrimmedString),
  tokenCount: Schema.optional(NonNegativeInteger),
  chunkCount: Schema.optional(NonNegativeInteger),
  metadata: Schema.optional(RagMetadataSchema)
})
export type RagDocument = Schema.Schema.Type<typeof RagDocumentSchema>

export const RagChunkSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  ragSetId: NonEmptyTrimmedString,
  documentId: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString,
  position: NonNegativeInteger,
  tokenCount: PositiveInteger,
  metadata: Schema.optional(RagMetadataSchema)
})
export type RagChunk = Schema.Schema.Type<typeof RagChunkSchema>

export const ExtractedRagDocumentSchema = Schema.Struct({
  content: NonEmptyTrimmedString,
  title: Schema.optional(NonEmptyTrimmedString),
  metadata: Schema.optional(RagMetadataSchema)
})
export type ExtractedRagDocument = Schema.Schema.Type<typeof ExtractedRagDocumentSchema>

export const RagSearchScopeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('RagSet'), id: NonEmptyTrimmedString }),
  Schema.Struct({ _tag: Schema.Literal('RagSets'), ids: Schema.Array(NonEmptyTrimmedString) })
])
export type RagSearchScope = Schema.Schema.Type<typeof RagSearchScopeSchema>

export const defaultRagChunkingConfig: RagChunkingConfig = {
  strategy: 'sentence-token',
  maxTokens: 512
}

export const makeRagSet = (input: {
  readonly id: string
  readonly label?: string
  readonly embeddingConfig: RagEmbeddingConfig
  readonly chunkingConfig?: RagChunkingConfig
  readonly metadata?: RagMetadata
}): RagSet => ({
  id: input.id,
  label: input.label,
  embeddingConfig: input.embeddingConfig,
  chunkingConfig: input.chunkingConfig ?? defaultRagChunkingConfig,
  metadata: input.metadata
})
