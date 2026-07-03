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
  'processing',
  'ready',
  'error'
])
export const knowledgeChunkingStrategy = pgEnum('KnowledgeChunkingStrategy', ['sentence-token'])
export const knowledgeAvailability = pgEnum('KnowledgeAvailability', [
  'pinned',
  'searchable',
  'archived'
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
    check(
      'agentConnector_credentialSecret_nonempty_check',
      sql`length(${table.credentialSecret}) > 0`
    )
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
    chunkingStrategy: knowledgeChunkingStrategy('chunkingStrategy')
      .notNull()
      .default('sentence-token'),
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
    status: knowledgeDocumentStatus('status').notNull().default('processing'),
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
    unique('knowledgeDocument_collectionId_storageObjectId_key').on(
      table.collectionId,
      table.storageObjectId
    ),
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

export const userKnowledgeDocument = pgTable(
  'userKnowledgeDocument',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    purpose: text('purpose').notNull(),
    origin: text('origin').notNull(),
    content: text('content').notNull(),
    status: knowledgeDocumentStatus('status').notNull().default('ready'),
    availability: knowledgeAvailability('availability').notNull().default('searchable'),
    summary: text('summary'),
    errorMessage: text('errorMessage'),
    reviewedAt: timestamp('reviewedAt'),
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
    index('userKnowledgeDocument_userId_createdAt_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.createdAt.asc().nullsLast()
    ),
    index('userKnowledgeDocument_userId_availability_idx').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.availability.asc().nullsLast()
    ),
    uniqueIndex('userKnowledgeDocument_userId_slug_key').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.slug.asc().nullsLast()
    ),
    check('userKnowledgeDocument_slug_nonempty_check', sql`length(${table.slug}) > 0`),
    check('userKnowledgeDocument_title_nonempty_check', sql`length(${table.title}) > 0`),
    check('userKnowledgeDocument_purpose_nonempty_check', sql`length(${table.purpose}) > 0`),
    check('userKnowledgeDocument_origin_nonempty_check', sql`length(${table.origin}) > 0`),
    check('userKnowledgeDocument_content_nonempty_check', sql`length(${table.content}) > 0`)
  ]
)
export type UserKnowledgeDocument = typeof userKnowledgeDocument.$inferSelect
export type InsertUserKnowledgeDocument = typeof userKnowledgeDocument.$inferInsert

export const userKnowledgeFile = pgTable(
  'userKnowledgeFile',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    documentId: text('documentId')
      .notNull()
      .references(() => userKnowledgeDocument.id, { onDelete: 'cascade' }),
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
    index('userKnowledgeFile_documentId_idx').using('btree', table.documentId.asc().nullsLast()),
    uniqueIndex('userKnowledgeFile_storageKey_key').using(
      'btree',
      table.storageKey.asc().nullsLast()
    ),
    check('userKnowledgeFile_storageKey_nonempty_check', sql`length(${table.storageKey}) > 0`),
    check(
      'userKnowledgeFile_byteSize_check',
      sql`${table.byteSize} IS NULL OR ${table.byteSize} >= 0`
    )
  ]
)
export type UserKnowledgeFile = typeof userKnowledgeFile.$inferSelect
export type InsertUserKnowledgeFile = typeof userKnowledgeFile.$inferInsert

export const userKnowledgeChunk = pgTable(
  'userKnowledgeChunk',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    scopeId: text('scopeId').notNull(),
    documentId: text('documentId')
      .notNull()
      .references(() => userKnowledgeDocument.id, { onDelete: 'cascade' }),
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
    index('userKnowledgeChunk_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    index('userKnowledgeChunk_content_fts_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`
    ),
    index('userKnowledgeChunk_scopeId_idx').using('btree', table.scopeId.asc().nullsLast()),
    index('userKnowledgeChunk_documentId_idx').using('btree', table.documentId.asc().nullsLast()),
    unique('userKnowledgeChunk_documentId_position_key').on(table.documentId, table.position),
    check('userKnowledgeChunk_content_nonempty_check', sql`length(${table.content}) > 0`),
    check('userKnowledgeChunk_position_check', sql`${table.position} >= 0`),
    check('userKnowledgeChunk_tokenCount_check', sql`${table.tokenCount} >= 0`)
  ]
)
export type UserKnowledgeChunk = typeof userKnowledgeChunk.$inferSelect
export type InsertUserKnowledgeChunk = typeof userKnowledgeChunk.$inferInsert

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
    userKnowledgeDocument,
    userKnowledgeFile,
    userKnowledgeChunk
  },
  () => ({})
)
