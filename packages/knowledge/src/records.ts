import * as Schema from 'effect/Schema'

export const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
export const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

export const KnowledgeMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)
export type KnowledgeMetadata = Schema.Schema.Type<typeof KnowledgeMetadataSchema>

export const KnowledgeRecordRoleSchema = Schema.Literals([
  'source',
  'note',
  'operating_protocol',
  'knowledge_map',
  'compiled_truth',
  'decision'
])
export type KnowledgeRecordRole = Schema.Schema.Type<typeof KnowledgeRecordRoleSchema>

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

export const KnowledgeRecordSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  role: KnowledgeRecordRoleSchema,
  title: NonEmptyTrimmedString,
  status: KnowledgeLifecycleStatusSchema,
  contextPolicy: KnowledgeContextPolicySchema,
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type KnowledgeRecord = Schema.Schema.Type<typeof KnowledgeRecordSchema>

export const CreateKnowledgeRecordInputSchema = Schema.Struct({
  scope: KnowledgeScopeSchema,
  role: KnowledgeRecordRoleSchema,
  title: NonEmptyTrimmedString,
  contextPolicy: KnowledgeContextPolicySchema,
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type CreateKnowledgeRecordInput = Schema.Schema.Type<typeof CreateKnowledgeRecordInputSchema>

export const UpdateKnowledgeRecordInputSchema = Schema.Struct({
  scope: KnowledgeScopeSchema,
  id: NonEmptyTrimmedString,
  title: Schema.optional(NonEmptyTrimmedString),
  status: Schema.optional(KnowledgeLifecycleStatusSchema),
  contextPolicy: Schema.optional(KnowledgeContextPolicySchema),
  summary: Schema.optional(Schema.String),
  metadata: Schema.optional(KnowledgeMetadataSchema)
})
export type UpdateKnowledgeRecordInput = Schema.Schema.Type<typeof UpdateKnowledgeRecordInputSchema>
