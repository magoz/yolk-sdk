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
export const ragDocumentStatus = pgEnum('RagDocumentStatus', [
  'pending',
  'processing',
  'ready',
  'error'
])
export const ragChunkingStrategy = pgEnum('RagChunkingStrategy', ['sentence-token'])

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

////////////////////////////////////////////////////////////////////////
// STORAGE / RAG
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

export const ragSet = pgTable(
  'ragSet',
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
    chunkingStrategy: ragChunkingStrategy('chunkingStrategy').notNull().default('sentence-token'),
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
    uniqueIndex('ragSet_userId_label_key').using(
      'btree',
      table.userId.asc().nullsLast(),
      table.label.asc().nullsLast()
    ),
    check('ragSet_embeddingDimensions_check', sql`${table.embeddingDimensions} > 0`),
    check('ragSet_chunkMaxTokens_check', sql`${table.chunkMaxTokens} > 0`)
  ]
)
export type RagSet = typeof ragSet.$inferSelect
export type InsertRagSet = typeof ragSet.$inferInsert

export const ragDocument = pgTable(
  'ragDocument',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    ragSetId: text('ragSetId')
      .notNull()
      .references(() => ragSet.id, { onDelete: 'cascade' }),
    storageObjectId: text('storageObjectId')
      .notNull()
      .references(() => storageObject.id, { onDelete: 'cascade' }),
    sourceType: storageSourceType('sourceType').notNull(),
    status: ragDocumentStatus('status').notNull().default('pending'),
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
    index('ragDocument_ragSetId_createdAt_idx').using(
      'btree',
      table.ragSetId.asc().nullsLast(),
      table.createdAt.asc().nullsLast()
    ),
    unique('ragDocument_id_ragSetId_key').on(table.id, table.ragSetId),
    unique('ragDocument_ragSetId_storageObjectId_key').on(table.ragSetId, table.storageObjectId),
    check('ragDocument_tokenCount_check', sql`${table.tokenCount} >= 0`),
    check('ragDocument_chunkCount_check', sql`${table.chunkCount} >= 0`)
  ]
)
export type RagDocument = typeof ragDocument.$inferSelect
export type InsertRagDocument = typeof ragDocument.$inferInsert

export const ragChunk = pgTable(
  'ragChunk',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    ragSetId: text('ragSetId').notNull(),
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
      name: 'ragChunk_documentId_ragSetId_fkey',
      columns: [table.documentId, table.ragSetId],
      foreignColumns: [ragDocument.id, ragDocument.ragSetId]
    }).onDelete('cascade'),
    index('ragChunk_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('ragChunk_ragSetId_idx').using('btree', table.ragSetId.asc().nullsLast()),
    unique('ragChunk_documentId_position_key').on(table.documentId, table.position),
    check('ragChunk_position_check', sql`${table.position} >= 0`),
    check('ragChunk_tokenCount_check', sql`${table.tokenCount} >= 0`)
  ]
)
export type RagChunk = typeof ragChunk.$inferSelect
export type InsertRagChunk = typeof ragChunk.$inferInsert

export const relations = defineRelations(
  {
    user,
    session,
    account,
    verification,
    agentSkill,
    agentCommand,
    storageObject,
    ragSet,
    ragDocument,
    ragChunk
  },
  () => ({})
)
