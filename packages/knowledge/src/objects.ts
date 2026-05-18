import * as Schema from 'effect/Schema'

export const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
export const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

export const KnowledgeMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)
export type KnowledgeMetadata = Schema.Schema.Type<typeof KnowledgeMetadataSchema>

export const KnowledgeObjectRoleSchema = Schema.Literals([
  'source',
  'note',
  'operating_protocol',
  'knowledge_map',
  'compiled_truth',
  'decision'
])
export type KnowledgeObjectRole = Schema.Schema.Type<typeof KnowledgeObjectRoleSchema>

export const KnowledgeContextPolicySchema = Schema.Literals([
  'pinned',
  'routable',
  'searchable',
  'archival'
])
export type KnowledgeContextPolicy = Schema.Schema.Type<typeof KnowledgeContextPolicySchema>

export const KnowledgeLifecycleStatusSchema = Schema.Literals([
  'draft',
  'processing',
  'ready',
  'error',
  'archived',
  'deleted'
])
export type KnowledgeLifecycleStatus = Schema.Schema.Type<typeof KnowledgeLifecycleStatusSchema>

export const KnowledgeScopeSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  kind: Schema.optional(NonEmptyTrimmedString)
})
export type KnowledgeScope = Schema.Schema.Type<typeof KnowledgeScopeSchema>

export const KnowledgeObjectSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  role: KnowledgeObjectRoleSchema,
  title: NonEmptyTrimmedString,
  status: KnowledgeLifecycleStatusSchema,
  contextPolicy: KnowledgeContextPolicySchema,
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type KnowledgeObject = Schema.Schema.Type<typeof KnowledgeObjectSchema>

export const CreateKnowledgeObjectInputSchema = Schema.Struct({
  scope: KnowledgeScopeSchema,
  role: KnowledgeObjectRoleSchema,
  title: NonEmptyTrimmedString,
  contextPolicy: KnowledgeContextPolicySchema,
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type CreateKnowledgeObjectInput = Schema.Schema.Type<typeof CreateKnowledgeObjectInputSchema>

export const UpdateKnowledgeObjectInputSchema = Schema.Struct({
  scope: KnowledgeScopeSchema,
  id: NonEmptyTrimmedString,
  title: Schema.optional(NonEmptyTrimmedString),
  status: Schema.optional(KnowledgeLifecycleStatusSchema),
  contextPolicy: Schema.optional(KnowledgeContextPolicySchema),
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type UpdateKnowledgeObjectInput = Schema.Schema.Type<typeof UpdateKnowledgeObjectInputSchema>
