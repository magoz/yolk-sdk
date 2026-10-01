/**
 * Notion emulator state: the typed bot user, pages, blocks, paginated property items, databases,
 * and data sources, the seed input, the default seed, and the profiles (internal; re-exported by
 * `src/notion.ts`).
 *
 * Entity shapes and the default entities follow the synthetic Notion conformance fixtures (API
 * version 2025-09-03), copied as data (the same ids, titles, properties, timestamps, and URLs as
 * the fixtures and `notionConformanceFixtureSeeds`), never imported from SDK code. Where no
 * fixture records a value, the default is synthesized and says so below: the blocks page itself,
 * the parent page of the write case, the database's parent page, and the second data source row
 * (the query fixture's `next_cursor` names it; no fixture shows it).
 *
 * Pages and other objects are stored with their wire fields (`properties`, `parent`, rich text)
 * as JSON, answered as stored. A page's `properties` value is what the page object answers; the
 * items the property endpoint pages through are stored separately (`propertyItems`), as the
 * fixtures show them (the page object of the property page carries only the first segment).
 *
 * @experimental
 */
import { Result } from 'effect'
import * as Schema from 'effect/Schema'

/** A Notion id as stored and answered: a lower-case dashed UUID. */
export const notionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const NotionId = Schema.String.check(Schema.isPattern(notionIdPattern))

const Timestamp = Schema.String

const JsonObject = Schema.Record(Schema.String, Schema.Json)

/** The integration's bot user (`GET /v1/users/me`). */
export const NotionEmulatorBotUser = Schema.Struct({
  id: NotionId,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  workspaceName: Schema.String
})

export type NotionEmulatorBotUser = typeof NotionEmulatorBotUser.Type

/** A page parent as Notion answers it. */
export const NotionEmulatorParent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('workspace'), workspace: Schema.Literal(true) }),
  Schema.Struct({ type: Schema.Literal('page_id'), page_id: NotionId }),
  Schema.Struct({
    type: Schema.Literal('data_source_id'),
    data_source_id: NotionId,
    database_id: NotionId
  })
])

export type NotionEmulatorParent = typeof NotionEmulatorParent.Type

/** A stored page. `times` is `null` where the fixture omits both timestamps (data source rows). */
export const NotionEmulatorPage = Schema.Struct({
  id: NotionId,
  times: Schema.NullOr(Schema.Struct({ created: Timestamp, lastEdited: Timestamp })),
  parent: NotionEmulatorParent,
  archived: Schema.Boolean,
  inTrash: Schema.Boolean,
  /** The page object's `properties`, answered as stored. */
  properties: JsonObject,
  url: Schema.String
})

export type NotionEmulatorPage = typeof NotionEmulatorPage.Type

/** A stored block, a child of a page. */
export const NotionEmulatorBlock = Schema.Struct({
  id: NotionId,
  pageId: NotionId,
  createdTime: Timestamp,
  lastEditedTime: Timestamp,
  hasChildren: Schema.Boolean,
  archived: Schema.Boolean,
  inTrash: Schema.Boolean,
  /** Block type, for example `paragraph`. */
  type: Schema.String,
  /** The type-specific value (`paragraph: { rich_text, color }`). */
  value: JsonObject
})

export type NotionEmulatorBlock = typeof NotionEmulatorBlock.Type

/**
 * The items of one paginated page property, as the property endpoint pages through them. Each
 * item answers `{ object: "property_item", id, type, [type]: value }`.
 */
export const NotionEmulatorPropertyItems = Schema.Struct({
  pageId: NotionId,
  /** The property id exactly as the page object returns it (for example `Syn%3Ap`). */
  propertyId: Schema.String,
  type: Schema.String,
  values: Schema.Array(Schema.Json)
})

export type NotionEmulatorPropertyItems = typeof NotionEmulatorPropertyItems.Type

export const NotionEmulatorDatabase = Schema.Struct({
  id: NotionId,
  title: Schema.Array(Schema.Json),
  description: Schema.Array(Schema.Json),
  parent: Schema.Struct({ type: Schema.Literal('page_id'), page_id: NotionId }),
  isInline: Schema.Boolean,
  inTrash: Schema.Boolean,
  archived: Schema.Boolean,
  createdTime: Timestamp,
  lastEditedTime: Timestamp,
  url: Schema.String
})

export type NotionEmulatorDatabase = typeof NotionEmulatorDatabase.Type

/** A data source of a database: its schema; its rows are pages with a `data_source_id` parent. */
export const NotionEmulatorDataSource = Schema.Struct({
  id: NotionId,
  databaseId: NotionId,
  /** Rich text title; its plain text is the name the database lists. */
  title: Schema.Array(Schema.Json),
  properties: JsonObject,
  archived: Schema.Boolean,
  inTrash: Schema.Boolean
})

export type NotionEmulatorDataSource = typeof NotionEmulatorDataSource.Type

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Counters = Schema.Struct({
  /** Next number in created page ids (`1f0000e0-0000-4000-8000-000000000001`). */
  nextPageNumber: Counter
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const NotionEmulatorStateSchema = Schema.Struct({
  botUser: NotionEmulatorBotUser,
  pages: Schema.Array(NotionEmulatorPage),
  blocks: Schema.Array(NotionEmulatorBlock),
  propertyItems: Schema.Array(NotionEmulatorPropertyItems),
  databases: Schema.Array(NotionEmulatorDatabase),
  dataSources: Schema.Array(NotionEmulatorDataSource),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (routes replace whole lists); every entity is
 * replaced, never edited in place.
 */
export type NotionEmulatorState = {
  botUser: NotionEmulatorBotUser
  pages: ReadonlyArray<NotionEmulatorPage>
  blocks: ReadonlyArray<NotionEmulatorBlock>
  propertyItems: ReadonlyArray<NotionEmulatorPropertyItems>
  databases: ReadonlyArray<NotionEmulatorDatabase>
  dataSources: ReadonlyArray<NotionEmulatorDataSource>
  counters: typeof Counters.Type
}

/** Account-variance profiles for the default seed. */
export const NotionEmulatorProfile = Schema.Literals(['default', 'empty'])

export type NotionEmulatorProfile = typeof NotionEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities); every other key,
 * when given, replaces that part of the profile.
 */
export const NotionEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(NotionEmulatorProfile),
  botUser: Schema.optionalKey(NotionEmulatorBotUser),
  pages: Schema.optionalKey(Schema.Array(NotionEmulatorPage)),
  blocks: Schema.optionalKey(Schema.Array(NotionEmulatorBlock)),
  propertyItems: Schema.optionalKey(Schema.Array(NotionEmulatorPropertyItems)),
  databases: Schema.optionalKey(Schema.Array(NotionEmulatorDatabase)),
  dataSources: Schema.optionalKey(Schema.Array(NotionEmulatorDataSource))
})

export type NotionEmulatorSeed = typeof NotionEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(NotionEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(NotionEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

/** A plain rich text item as the fixtures write it (no annotations). */
export const plainRichText = (text: string): Schema.JsonObject => ({
  type: 'text',
  text: { content: text, link: null },
  plain_text: text,
  href: null
})

/** A page `title` property as the fixtures write it. */
export const titleProperty = (items: ReadonlyArray<Schema.Json>): Schema.JsonObject => ({
  id: 'title',
  type: 'title',
  title: [...items]
})

/** `https://www.notion.so/<Title-Slug>-<id without dashes>`, as the fixtures write page URLs. */
export const notionPageUrl = (title: string, id: string): string => {
  const slug = title
    .split(/[^A-Za-z0-9]+/)
    .filter(part => part.length > 0)
    .join('-')

  const compact = id.replaceAll('-', '')

  return `https://www.notion.so/${slug.length === 0 ? compact : `${slug}-${compact}`}`
}

// Default entities. Fixture-derived: the bot user, the two search pages, the title page with its
// two annotated title items, the three paragraph blocks, the property page with its `Notes`
// property and three rich-text segments, the database, its data source and first row. Synthesized:
// the blocks page itself, the write case's parent page, the database's parent page, and the second
// row (only the query fixture's `next_cursor` names it).

const seededAt = '2026-09-20T09:00:00.000Z'

const workspace: NotionEmulatorParent = { type: 'workspace', workspace: true }

const annotations = (bold: boolean): Schema.JsonObject => ({
  bold,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default'
})

const workspacePage = (
  id: string,
  title: ReadonlyArray<Schema.Json>,
  plainTitle: string,
  extra: Schema.JsonObject = {}
): NotionEmulatorPage => ({
  id,
  times: { created: seededAt, lastEdited: seededAt },
  parent: workspace,
  archived: false,
  inTrash: false,
  properties: { ...extra, title: titleProperty(title) },
  url: notionPageUrl(plainTitle, id)
})

const searchPage = (index: number): NotionEmulatorPage => ({
  ...workspacePage(
    `1f0000a0-0000-4000-8000-00000000000${index}`,
    [plainRichText(`yolk-search-probe ${index}`)],
    `yolk-search-probe ${index}`
  ),
  // The search fixture's URL carries a shortened id (30 hex digits); copied as is.
  url: `https://www.notion.so/yolk-search-probe-${index}-1f0000a0000040008000000000000${index}`
})

/** A rich text item with annotations, as the title fixture writes it. */
const annotatedRichText = (text: string, bold: boolean): Schema.JsonObject => ({
  type: 'text',
  text: { content: text, link: null },
  annotations: annotations(bold),
  plain_text: text,
  href: null
})

const titlePage = workspacePage(
  '1f000000-0000-4000-8000-000000000001',
  [annotatedRichText('Synthetic ', false), annotatedRichText('Title Page', true)],
  'Synthetic Title Page'
)

const blocksPageId = '1f000000-0000-4000-8000-000000000002'

const blocksPage = workspacePage(
  blocksPageId,
  [plainRichText('Synthetic Blocks Page')],
  'Synthetic Blocks Page'
)

const propertyPageId = '1f000000-0000-4000-8000-000000000003'

const propertyId = 'Syn%3Ap'

const segment = (index: number) => plainRichText(`Synthetic segment ${index} `)

const propertyPage = workspacePage(
  propertyPageId,
  [plainRichText('Synthetic Property Page')],
  'Synthetic Property Page',
  { Notes: { id: propertyId, type: 'rich_text', rich_text: [segment(1)] } }
)

const parentPage = workspacePage(
  '1f000000-0000-4000-8000-000000000005',
  [plainRichText('Synthetic Parent Page')],
  'Synthetic Parent Page'
)

const databaseId = '1f000000-0000-4000-8000-000000000004'

const dataSourceId = '1f0000d0-0000-4000-8000-000000000001'

const databaseParentId = '1f0000d0-0000-4000-8000-0000000000aa'

const databaseParentPage = workspacePage(
  databaseParentId,
  [plainRichText('Synthetic Database Parent')],
  'Synthetic Database Parent'
)

const row = (number: number): NotionEmulatorPage => {
  const id = `1f0000d0-0000-4000-8000-000000000${number}`
  const title = `Synthetic task ${number - 100}`

  return {
    id,
    times: null,
    parent: { type: 'data_source_id', data_source_id: dataSourceId, database_id: databaseId },
    archived: false,
    inTrash: false,
    properties: {
      Name: { id: 'title', type: 'title', title: [plainRichText(title)] },
      Done: { id: 'Syn%3Ad', type: 'checkbox', checkbox: false }
    },
    url: notionPageUrl(title, id)
  }
}

const paragraph = (index: number): NotionEmulatorBlock => ({
  id: `1f0000c0-0000-4000-8000-00000000000${index}`,
  pageId: blocksPageId,
  createdTime: seededAt,
  lastEditedTime: seededAt,
  hasChildren: false,
  archived: false,
  inTrash: false,
  type: 'paragraph',
  value: { rich_text: [plainRichText(`Synthetic paragraph ${index}`)], color: 'default' }
})

const defaultBotUser: NotionEmulatorBotUser = {
  id: '1f0000b0-0000-4000-8000-000000000001',
  name: 'Synthetic Integration',
  avatarUrl: null,
  workspaceName: 'Synthetic Workspace'
}

const tasksTitle = [plainRichText('Synthetic Tasks')]

type ProfileEntities = Omit<NotionEmulatorState, 'counters'>

const profileEntities = (profile: NotionEmulatorProfile): ProfileEntities =>
  profile === 'default'
    ? {
        botUser: defaultBotUser,
        pages: [
          searchPage(1),
          searchPage(2),
          titlePage,
          blocksPage,
          propertyPage,
          parentPage,
          databaseParentPage,
          row(101),
          row(102)
        ],
        blocks: [paragraph(1), paragraph(2), paragraph(3)],
        propertyItems: [
          {
            pageId: propertyPageId,
            propertyId,
            type: 'rich_text',
            values: [segment(1), segment(2), segment(3)]
          }
        ],
        databases: [
          {
            id: databaseId,
            title: tasksTitle,
            description: [],
            parent: { type: 'page_id', page_id: databaseParentId },
            isInline: false,
            inTrash: false,
            archived: false,
            createdTime: seededAt,
            lastEditedTime: seededAt,
            url: `https://www.notion.so/${databaseId.replaceAll('-', '')}`
          }
        ],
        dataSources: [
          {
            id: dataSourceId,
            databaseId,
            title: tasksTitle,
            properties: {
              Name: { id: 'title', name: 'Name', type: 'title', title: {} },
              Done: { id: 'Syn%3Ad', name: 'Done', type: 'checkbox', checkbox: {} }
            },
            archived: false,
            inTrash: false
          }
        ]
      }
    : {
        botUser: defaultBotUser,
        pages: [],
        blocks: [],
        propertyItems: [],
        databases: [],
        dataSources: []
      }

const duplicate = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

/** Integrity problems a decoded seed can still have (duplicates, dangling references). */
const seedProblem = (entities: ProfileEntities): string | undefined => {
  const pageIds = entities.pages.map(page => page.id)
  const databaseIds = entities.databases.map(database => database.id)
  const dataSourceIds = entities.dataSources.map(source => source.id)

  const duplicates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['object id', duplicate([...pageIds, ...databaseIds, ...dataSourceIds])],
    ['block id', duplicate(entities.blocks.map(block => block.id))],
    [
      'property item list',
      duplicate(entities.propertyItems.map(items => `${items.pageId} ${items.propertyId}`))
    ]
  ]

  for (const [label, value] of duplicates) {
    if (value !== undefined) return `duplicate ${label} ${value}`
  }

  for (const page of entities.pages) {
    const parent = page.parent

    if (parent.type === 'page_id' && !pageIds.includes(parent.page_id)) {
      return `page ${page.id} references missing parent page ${parent.page_id}`
    }

    if (
      parent.type === 'data_source_id' &&
      !entities.dataSources.some(
        source => source.id === parent.data_source_id && source.databaseId === parent.database_id
      )
    ) {
      return `page ${page.id} references missing data source ${parent.data_source_id}`
    }
  }

  const block = entities.blocks.find(candidate => !pageIds.includes(candidate.pageId))

  if (block !== undefined) return `block ${block.id} references missing page ${block.pageId}`

  const items = entities.propertyItems.find(candidate => !pageIds.includes(candidate.pageId))

  if (items !== undefined) return `property items reference missing page ${items.pageId}`

  const database = entities.databases.find(candidate => !pageIds.includes(candidate.parent.page_id))

  if (database !== undefined) {
    return `database ${database.id} references missing parent page ${database.parent.page_id}`
  }

  const source = entities.dataSources.find(candidate => !databaseIds.includes(candidate.databaseId))

  return source === undefined
    ? undefined
    : `data source ${source.id} references missing database ${source.databaseId}`
}

/** Build the emulator state for a decoded seed; a string is an integrity problem. */
const stateFromSeed = (seed: NotionEmulatorSeed): NotionEmulatorState | string => {
  const profile = profileEntities(seed.profile ?? 'default')

  const entities: ProfileEntities = {
    botUser: seed.botUser ?? profile.botUser,
    pages: seed.pages ?? profile.pages,
    blocks: seed.blocks ?? profile.blocks,
    propertyItems: seed.propertyItems ?? profile.propertyItems,
    databases: seed.databases ?? profile.databases,
    dataSources: seed.dataSources ?? profile.dataSources
  }

  const problem = seedProblem(entities)

  return problem ?? { ...entities, counters: { nextPageNumber: 1 } }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildSeedState = (input: unknown): NotionEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): NotionEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
