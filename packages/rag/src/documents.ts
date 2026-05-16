import { Schema } from 'effect'

export const RagMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)
export type RagMetadata = Schema.Schema.Type<typeof RagMetadataSchema>

export const RagDocumentStatusSchema = Schema.Literals(['pending', 'processing', 'ready', 'error'])
export type RagDocumentStatus = Schema.Schema.Type<typeof RagDocumentStatusSchema>

export const RagSourceSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('File'),
    ref: Schema.String,
    name: Schema.optional(Schema.String),
    mediaType: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    _tag: Schema.Literal('Url'),
    url: Schema.String
  }),
  Schema.Struct({
    _tag: Schema.Literal('Text'),
    label: Schema.optional(Schema.String)
  })
])
export type RagSource = Schema.Schema.Type<typeof RagSourceSchema>

export const RagEmbeddingConfigSchema = Schema.Struct({
  model: Schema.String,
  dimensions: Schema.Number
})
export type RagEmbeddingConfig = Schema.Schema.Type<typeof RagEmbeddingConfigSchema>

export const RagChunkingConfigSchema = Schema.Struct({
  strategy: Schema.Literal('sentence-token'),
  maxTokens: Schema.Number
})
export type RagChunkingConfig = Schema.Schema.Type<typeof RagChunkingConfigSchema>

export const RagSetSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  embeddingConfig: RagEmbeddingConfigSchema,
  chunkingConfig: RagChunkingConfigSchema,
  metadata: Schema.optional(RagMetadataSchema)
})
export type RagSet = Schema.Schema.Type<typeof RagSetSchema>

export const RagDocumentSchema = Schema.Struct({
  id: Schema.String,
  ragSetId: Schema.String,
  source: RagSourceSchema,
  status: RagDocumentStatusSchema,
  title: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String),
  tokenCount: Schema.optional(Schema.Number),
  chunkCount: Schema.optional(Schema.Number),
  metadata: Schema.optional(RagMetadataSchema)
})
export type RagDocument = Schema.Schema.Type<typeof RagDocumentSchema>

export const RagChunkSchema = Schema.Struct({
  id: Schema.String,
  ragSetId: Schema.String,
  documentId: Schema.String,
  content: Schema.String,
  position: Schema.Number,
  tokenCount: Schema.Number,
  metadata: Schema.optional(RagMetadataSchema)
})
export type RagChunk = Schema.Schema.Type<typeof RagChunkSchema>

export const ExtractedRagDocumentSchema = Schema.Struct({
  content: Schema.String,
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(RagMetadataSchema)
})
export type ExtractedRagDocument = Schema.Schema.Type<typeof ExtractedRagDocumentSchema>

export const RagSearchScopeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('RagSet'), id: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('RagSets'), ids: Schema.Array(Schema.String) })
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
