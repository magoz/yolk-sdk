import { defineRelations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  vector
} from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'

export const storageSourceType = pgEnum('StorageSourceType', ['file', 'url', 'text'])
export const knowledgeDocumentStatus = pgEnum('KnowledgeDocumentStatus', [
  'pending',
  'processing',
  'ready',
  'error'
])
export const knowledgeChunkingStrategy = pgEnum('KnowledgeChunkingStrategy', ['sentence-token'])
export const knowledgeRecordRole = pgEnum('KnowledgeRecordRole', [
  'source',
  'note',
  'operating_protocol',
  'knowledge_map',
  'compiled_truth',
  'decision'
])
export const knowledgeContextPolicy = pgEnum('KnowledgeContextPolicy', [
  'pinned',
  'routable',
  'searchable',
  'archival'
])
export const knowledgeLifecycleStatus = pgEnum('KnowledgeLifecycleStatus', [
  'draft',
  'processing',
  'ready',
  'error',
  'archived',
  'deleted'
])
export const knowledgeArtifactKind = pgEnum('KnowledgeArtifactKind', [
  'original',
  'extracted_text',
  'thumbnail',
  'transcript',
  'caption',
  'structured'
])
export const knowledgeRepresentationModality = pgEnum('KnowledgeRepresentationModality', [
  'text',
  'image',
  'audio',
  'video',
  'table'
])
export const knowledgeRepresentationStatus = pgEnum('KnowledgeRepresentationStatus', [
  'pending',
  'processing',
  'ready',
  'error'
])
export const knowledgeProvenanceSourceKind = pgEnum('KnowledgeProvenanceSourceKind', [
  'upload',
  'user_statement',
  'url',
  'generated',
  'imported',
  'external_api'
])
export const knowledgeLinkType = pgEnum('KnowledgeLinkType', [
  'cites',
  'supports',
  'contradicts',
  'supersedes',
  'mentions',
  'derived_from',
  'related_to'
])

////////////////////////////////////////////////////////////////////////
// AUTH - Better-auth expects singular model names
////////////////////////////////////////////////////////////////////////
export const user = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  // Better Auth
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),

  role: text('role', {
    enum: ['USER', 'ADMIN']
  })
    .notNull()
    .default('USER'),

  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
})
export type User = typeof user.$inferSelect
export type InsertUser = typeof user.$inferInsert

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
})

////////////////////////////////////////////////////////////////////////
// AGENT SKILLS
////////////////////////////////////////////////////////////////////////

export const agentSkill = pgTable(
  'agentSkill',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    content: text('content').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    uniqueIndex('agentSkill_userId_name_key').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.name.asc().nullsLast()
    ),
    index('agentSkill_userId_enabled_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.enabled.asc().nullsLast()
    ),
    check('agentSkill_name_nonempty_check', sql`length(${table.name}) > 0`),
    check('agentSkill_description_nonempty_check', sql`length(${table.description}) > 0`),
    check('agentSkill_content_nonempty_check', sql`length(${table.content}) > 0`)
  ]
)
export type AgentSkill = typeof agentSkill.$inferSelect
export type InsertAgentSkill = typeof agentSkill.$inferInsert

export const agentCommand = pgTable(
  'agentCommand',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    template: text('template').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    uniqueIndex('agentCommand_userId_name_key').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.name.asc().nullsLast()
    ),
    index('agentCommand_userId_enabled_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.enabled.asc().nullsLast()
    ),
    check('agentCommand_name_nonempty_check', sql`length(${table.name}) > 0`),
    check('agentCommand_template_nonempty_check', sql`length(${table.template}) > 0`)
  ]
)
export type AgentCommand = typeof agentCommand.$inferSelect
export type InsertAgentCommand = typeof agentCommand.$inferInsert

export const agentConnector = pgTable(
  'agentConnector',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    connectorId: text('connectorId').notNull(),
    chatId: text('chatId').notNull(),
    credentialSecret: text('credentialSecret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    uniqueIndex('agentConnector_userId_connectorId_key').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.connectorId.asc().nullsLast()
    ),
    index('agentConnector_userId_enabled_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.enabled.asc().nullsLast()
    ),
    check('agentConnector_connectorId_nonempty_check', sql`length(${table.connectorId}) > 0`),
    check('agentConnector_chatId_nonempty_check', sql`length(${table.chatId}) > 0`),
    check('agentConnector_credentialSecret_nonempty_check', sql`length(${table.credentialSecret}) > 0`)
  ]
)
export type AgentConnector = typeof agentConnector.$inferSelect
export type InsertAgentConnector = typeof agentConnector.$inferInsert

////////////////////////////////////////////////////////////////////////
// STORAGE / KNOWLEDGE SEARCH
////////////////////////////////////////////////////////////////////////

export const storageObject = pgTable(
  'storageObject',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceType: storageSourceType('sourceType').notNull(),
    r2Key: text('r2Key'),
    url: text('url'),
    textContent: text('textContent'),
    filename: text('filename'),
    mediaType: text('mediaType'),
    byteSize: integer('byteSize'),
    contentHash: text('contentHash'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    index('storageObject_userId_createdAt_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.createdAt.asc().nullsLast()
    ),
    check('storageObject_byteSize_check', sql`${table.byteSize} IS NULL OR ${table.byteSize} >= 0`)
  ]
)
export type StorageObject = typeof storageObject.$inferSelect
export type InsertStorageObject = typeof storageObject.$inferInsert

export const knowledgeCollection = pgTable(
  'knowledgeCollection',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    label: text('label'),
    embeddingModel: text('embeddingModel').notNull().default('text-embedding-3-small'),
    embeddingDimensions: integer('embeddingDimensions').notNull().default(1536),
    chunkingStrategy: knowledgeChunkingStrategy('chunkingStrategy').notNull().default('sentence-token'),
    chunkMaxTokens: integer('chunkMaxTokens').notNull().default(512),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    uniqueIndex('knowledgeCollection_userId_label_key').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.label.asc().nullsLast()
    ),
    check('knowledgeCollection_embeddingDimensions_check', sql`${table.embeddingDimensions} > 0`),
    check('knowledgeCollection_chunkMaxTokens_check', sql`${table.chunkMaxTokens} > 0`)
  ]
)
export type KnowledgeCollection = typeof knowledgeCollection.$inferSelect
export type InsertKnowledgeCollection = typeof knowledgeCollection.$inferInsert

export const knowledgeDocument = pgTable(
  'knowledgeDocument',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    collectionId: text('collectionId')
      .notNull()
      .references(() => knowledgeCollection.id, { onDelete: 'cascade' }),
    storageObjectId: text('storageObjectId')
      .notNull()
      .references(() => storageObject.id, { onDelete: 'cascade' }),
    sourceType: storageSourceType('sourceType').notNull(),
    status: knowledgeDocumentStatus('status').notNull().default('pending'),
    title: text('title'),
    summary: text('summary'),
    errorMessage: text('errorMessage'),
    contentHash: text('contentHash'),
    tokenCount: integer('tokenCount').notNull().default(0),
    chunkCount: integer('chunkCount').notNull().default(0),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    processedAt: timestamp('processedAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    index('knowledgeDocument_collectionId_createdAt_idx').using(
      'btree',
      table.collectionId.asc().nullsLast(),
      table.createdAt.asc().nullsLast()
    ),
    unique('knowledgeDocument_id_collectionId_key').on(table.id, table.collectionId),
    unique('knowledgeDocument_collectionId_storageObjectId_key').on(table.collectionId, table.storageObjectId),
    check('knowledgeDocument_tokenCount_check', sql`${table.tokenCount} >= 0`),
    check('knowledgeDocument_chunkCount_check', sql`${table.chunkCount} >= 0`)
  ]
)
export type KnowledgeDocument = typeof knowledgeDocument.$inferSelect
export type InsertKnowledgeDocument = typeof knowledgeDocument.$inferInsert

export const knowledgeChunk = pgTable(
  'knowledgeChunk',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    collectionId: text('collectionId').notNull(),
    documentId: text('documentId').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    position: integer('position').notNull(),
    tokenCount: integer('tokenCount').notNull().default(0),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow()
  },
  table => [
    foreignKey({
      name: 'knowledgeChunk_documentId_collectionId_fkey',
      columns: [table.documentId, table.collectionId],
      foreignColumns: [knowledgeDocument.id, knowledgeDocument.collectionId]
    }).onDelete('cascade'),
    index('knowledgeChunk_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('knowledgeChunk_content_fts_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`
    ),
    index('knowledgeChunk_collectionId_idx').using('btree', table.collectionId.asc().nullsLast()),
    unique('knowledgeChunk_documentId_position_key').on(table.documentId, table.position),
    check('knowledgeChunk_position_check', sql`${table.position} >= 0`),
    check('knowledgeChunk_tokenCount_check', sql`${table.tokenCount} >= 0`)
  ]
)
export type KnowledgeChunk = typeof knowledgeChunk.$inferSelect
export type InsertKnowledgeChunk = typeof knowledgeChunk.$inferInsert

////////////////////////////////////////////////////////////////////////
// KNOWLEDGE
////////////////////////////////////////////////////////////////////////

export const knowledgeRecord = pgTable(
  'knowledgeRecord',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: knowledgeRecordRole('role').notNull(),
    title: text('title').notNull(),
    status: knowledgeLifecycleStatus('status').notNull().default('draft'),
    contextPolicy: knowledgeContextPolicy('contextPolicy').notNull().default('searchable'),
    summary: text('summary'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    index('knowledgeRecord_userId_createdAt_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.createdAt.asc().nullsLast()
    ),
    index('knowledgeRecord_userId_contextPolicy_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.contextPolicy.asc().nullsLast()
    ),
    check('knowledgeRecord_title_nonempty_check', sql`length(${table.title}) > 0`)
  ]
)
export type KnowledgeRecord = typeof knowledgeRecord.$inferSelect
export type InsertKnowledgeRecord = typeof knowledgeRecord.$inferInsert

export const knowledgeArtifact = pgTable(
  'knowledgeArtifact',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    recordId: text('recordId')
      .notNull()
      .references(() => knowledgeRecord.id, { onDelete: 'cascade' }),
    kind: knowledgeArtifactKind('kind').notNull(),
    storageKey: text('storageKey').notNull(),
    mediaType: text('mediaType'),
    byteSize: integer('byteSize'),
    checksum: text('checksum'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow()
  },
  table => [
    index('knowledgeArtifact_recordId_idx').using('btree', table.recordId.asc().nullsLast()),
    uniqueIndex('knowledgeArtifact_storageKey_key').using('btree', table.storageKey.asc().nullsLast()),
    check('knowledgeArtifact_storageKey_nonempty_check', sql`length(${table.storageKey}) > 0`),
    check('knowledgeArtifact_byteSize_check', sql`${table.byteSize} IS NULL OR ${table.byteSize} >= 0`)
  ]
)
export type KnowledgeArtifact = typeof knowledgeArtifact.$inferSelect
export type InsertKnowledgeArtifact = typeof knowledgeArtifact.$inferInsert

export const knowledgeRepresentation = pgTable(
  'knowledgeRepresentation',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    recordId: text('recordId')
      .notNull()
      .references(() => knowledgeRecord.id, { onDelete: 'cascade' }),
    artifactId: text('artifactId').references(() => knowledgeArtifact.id, { onDelete: 'set null' }),
    modality: knowledgeRepresentationModality('modality').notNull(),
    status: knowledgeRepresentationStatus('status').notNull().default('pending'),
    contentText: text('contentText'),
    summary: text('summary'),
    model: text('model'),
    errorMessage: text('errorMessage'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date())
  },
  table => [
    index('knowledgeRepresentation_recordId_status_idx').using(
      'btree',
      table.recordId.asc().nullsLast(),
      table.status.asc().nullsLast()
    ),
    index('knowledgeRepresentation_artifactId_idx').using('btree', table.artifactId.asc().nullsLast())
  ]
)
export type KnowledgeRepresentation = typeof knowledgeRepresentation.$inferSelect
export type InsertKnowledgeRepresentation = typeof knowledgeRepresentation.$inferInsert

export const knowledgeRepresentationChunk = pgTable(
  'knowledgeRepresentationChunk',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    recordId: text('recordId')
      .notNull()
      .references(() => knowledgeRecord.id, { onDelete: 'cascade' }),
    representationId: text('representationId')
      .notNull()
      .references(() => knowledgeRepresentation.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    position: integer('position').notNull(),
    tokenCount: integer('tokenCount').notNull().default(0),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow()
  },
  table => [
    index('knowledgeRepresentationChunk_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('knowledgeRepresentationChunk_content_fts_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`
    ),
    index('knowledgeRepresentationChunk_recordId_idx').using('btree', table.recordId.asc().nullsLast()),
    unique('knowledgeRepresentationChunk_representationId_position_key').on(table.representationId, table.position),
    check('knowledgeRepresentationChunk_content_nonempty_check', sql`length(${table.content}) > 0`),
    check('knowledgeRepresentationChunk_position_check', sql`${table.position} >= 0`),
    check('knowledgeRepresentationChunk_tokenCount_check', sql`${table.tokenCount} >= 0`)
  ]
)
export type KnowledgeRepresentationChunk = typeof knowledgeRepresentationChunk.$inferSelect
export type InsertKnowledgeRepresentationChunk = typeof knowledgeRepresentationChunk.$inferInsert

export const knowledgeProvenance = pgTable(
  'knowledgeProvenance',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    recordId: text('recordId')
      .notNull()
      .references(() => knowledgeRecord.id, { onDelete: 'cascade' }),
    artifactId: text('artifactId').references(() => knowledgeArtifact.id, { onDelete: 'set null' }),
    sourceKind: knowledgeProvenanceSourceKind('sourceKind').notNull(),
    sourceLabel: text('sourceLabel').notNull(),
    sourceUrl: text('sourceUrl'),
    observedAt: timestamp('observedAt'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow()
  },
  table => [
    index('knowledgeProvenance_recordId_idx').using('btree', table.recordId.asc().nullsLast()),
    check('knowledgeProvenance_sourceLabel_nonempty_check', sql`length(${table.sourceLabel}) > 0`)
  ]
)
export type KnowledgeProvenance = typeof knowledgeProvenance.$inferSelect
export type InsertKnowledgeProvenance = typeof knowledgeProvenance.$inferInsert

export const knowledgeLink = pgTable(
  'knowledgeLink',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    fromRecordId: text('fromRecordId')
      .notNull()
      .references(() => knowledgeRecord.id, { onDelete: 'cascade' }),
    toRecordId: text('toRecordId')
      .notNull()
      .references(() => knowledgeRecord.id, { onDelete: 'cascade' }),
    type: knowledgeLinkType('type').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow()
  },
  table => [
    index('knowledgeLink_fromRecordId_idx').using('btree', table.fromRecordId.asc().nullsLast()),
    index('knowledgeLink_toRecordId_idx').using('btree', table.toRecordId.asc().nullsLast()),
    unique('knowledgeLink_edge_key').on(table.fromRecordId, table.toRecordId, table.type),
    check('knowledgeLink_no_self_link_check', sql`${table.fromRecordId} <> ${table.toRecordId}`)
  ]
)
export type KnowledgeLink = typeof knowledgeLink.$inferSelect
export type InsertKnowledgeLink = typeof knowledgeLink.$inferInsert

export const relations = defineRelations(
  {
    user,
    session,
    account,
    verification,
    agentSkill,
    agentCommand,
    agentConnector,
    storageObject,
    knowledgeCollection,
    knowledgeDocument,
    knowledgeChunk,
    knowledgeRecord,
    knowledgeArtifact,
    knowledgeRepresentation,
    knowledgeRepresentationChunk,
    knowledgeProvenance,
    knowledgeLink
  },
  () => ({})
)
