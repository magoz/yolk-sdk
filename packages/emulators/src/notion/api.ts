/**
 * Notion emulator API: the route table (evidence, request-shape checks, and stateful handlers),
 * the fixture error envelopes, object rendering, and cursor paging (internal; re-exported by
 * `src/notion.ts`).
 *
 * Only the `/v1` routes the eight Notion conformance cases (and their cleanup and leftover lookup)
 * send are emulated, at API version 2025-09-03, with the wire shapes of their synthetic fixtures:
 * search, the bot user, page read, create, and archive, block children, paginated property items,
 * and the database / data source split (the database lists its data sources; the data source
 * holds the schema and the rows). List cursors are the next result's id, as the search, block, and
 * query fixtures show; property item cursors are opaque. Anything no fixture shows is not
 * emulated (400, nothing written).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactObject,
  integerIn,
  isJsonObject,
  isNotEmulated,
  notEmulated,
  statefulRoute,
  type EmulatedRequest,
  type NotEmulated,
  type StatefulRoute
} from '../stateful-emulator.ts'
import {
  notionPageUrl,
  plainRichText,
  titleProperty,
  type NotionEmulatorPage,
  type NotionEmulatorState
} from './state.ts'

/** API version prefix of every Notion route. */
export const notionEmulatorBasePath = '/v1'

/** The only `Notion-Version` the emulator answers (every fixture sends it). */
export const notionEmulatorVersion = '2025-09-03'

/** Content type of every Notion response, as the fixtures record it. */
const notionContentType = 'application/json; charset=utf-8'

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type NotionEmulatorDrills = {
  /** A later search page starts one result early, repeating the previous page's last result. */
  readonly searchRepeatsResults?: boolean
  /** `GET /v1/users/me` answers a person instead of the bot user. */
  readonly botUserAsPerson?: boolean
  /** Error envelopes carry a `status` other than the HTTP status. */
  readonly envelopeStatusMismatch?: boolean
  /** Page reads answer title rich text without `plain_text`. */
  readonly omitTitlePlainText?: boolean
  /** A later block children page starts one block early, repeating a block. */
  readonly blockCursorRepeats?: boolean
  /** The property id path segment is decoded twice, so a re-encoded id is not found. */
  readonly rejectDoubleEncodedPropertyId?: boolean
  /** Data source rows answer a `database_id` parent instead of their data source. */
  readonly rowParentAsDatabase?: boolean
  /** A trashed page reads back as 404 `object_not_found`. */
  readonly trashedPageNotFound?: boolean
}

export const notionEmulatorDrillKnobs: ReadonlyArray<keyof NotionEmulatorDrills> = [
  'searchRepeatsResults',
  'botUserAsPerson',
  'envelopeStatusMismatch',
  'omitTitlePlainText',
  'blockCursorRepeats',
  'rejectDoubleEncodedPropertyId',
  'rowParentAsDatabase',
  'trashedPageNotFound'
]

export type NotionApiEnv = {
  /** Clock in epoch milliseconds (created page timestamps only). */
  readonly now: () => number
  /** Origin of property item `next_url` values, for example `https://api.notion.com`. */
  readonly origin: string
  readonly drills: Readonly<Record<keyof NotionEmulatorDrills, boolean>>
}

type Route = StatefulRoute<NotionEmulatorState, NotionApiEnv>

const searchCase = 'notion.search.cursor-paging'

const versionCase = 'notion.api.pinned-version-accepted'

const errorCase = 'notion.errors.error-envelope'

const titleCase = 'notion.pages.title-plain-text'

const blocksCase = 'notion.blocks.children-cursor-paging'

const propertyCase = 'notion.pages.property-item-paging'

const dataSourceCase = 'notion.data-sources.database-split'

const archiveCase = 'notion.pages.archive-in-trash'

const evidence = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>
) => ({
  method,
  path: `${notionEmulatorBasePath}${path}`,
  kind: 'connector' as const,
  write,
  caseIds,
  evidence: 'unverified' as const
})

// Responses.

const ok = (body: Schema.JsonObject): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': notionContentType }
  })

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** A synthetic request id for ledger sequence `seq`. */
const requestId = (seq: number): string =>
  `00000000-0000-4000-8000-${pad(seq % 1_000_000_000_000, 12)}`

/** The fixture error envelope `{ object: "error", status, code, message, request_id }`. */
const errorEnvelope = (
  env: NotionApiEnv,
  seq: number,
  status: number,
  code: string,
  message: string
): Response =>
  new Response(
    JSON.stringify({
      object: 'error',
      status: env.drills.envelopeStatusMismatch ? 500 : status,
      code,
      message,
      request_id: requestId(seq)
    }),
    { status, headers: { 'content-type': notionContentType } }
  )

/** The error-envelope fixture's 404 for a well-formed id that addresses no page. */
const pageNotFound = (env: NotionApiEnv, seq: number, id: string): Response =>
  errorEnvelope(
    env,
    seq,
    404,
    'object_not_found',
    `Could not find page with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`
  )

/** The error-envelope fixture's 400 for a malformed page id. */
const malformedPageId = (env: NotionApiEnv, seq: number, raw: string): Response =>
  errorEnvelope(
    env,
    seq,
    400,
    'validation_error',
    `path failed validation: path.page_id should be a valid uuid, instead was \`${JSON.stringify(raw)}\`.`
  )

// Ids, queries, and bodies.

const compactIdPattern = /^[0-9a-f]{32}$/i

const dashedIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A Notion id with or without dashes, in any case, as stored (dashed, lower case). */
const normalizeId = (raw: string): string | undefined => {
  if (dashedIdPattern.test(raw)) return raw.toLowerCase()

  if (!compactIdPattern.test(raw)) return undefined

  const hex = raw.toLowerCase()

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const idParam = (request: EmulatedRequest, name: string): string | NotEmulated =>
  normalizeId(request.params[name] ?? '') ??
  notEmulated(`a malformed ${name} is not emulated on this route`)

const withoutQuery = (request: EmulatedRequest): NotEmulated | undefined =>
  request.query.size > 0
    ? notEmulated('query parameters are not emulated on this route')
    : undefined

type ListQuery = { readonly pageSize: number; readonly startCursor: string | undefined }

/** `page_size` (required, 1-100) and an optional `start_cursor`, as the list fixtures send them. */
const listQuery = (request: EmulatedRequest): ListQuery | NotEmulated => {
  const keys = [...request.query.keys()]
  const unknown = keys.find(key => key !== 'page_size' && key !== 'start_cursor')

  if (unknown !== undefined) return notEmulated(`query parameter ${unknown} is not emulated`)

  if (keys.length !== new Set(keys).size) {
    return notEmulated('repeated query parameters are not emulated')
  }

  const raw = request.query.get('page_size')

  if (raw === null) return notEmulated('requests without page_size are not emulated')

  const pageSize = integerIn(/^\d+$/.test(raw) ? Number(raw) : null, 'page_size', 1, 100)

  if (isNotEmulated(pageSize)) return pageSize

  const startCursor = request.query.get('start_cursor') ?? undefined

  return startCursor === ''
    ? notEmulated('an empty start_cursor is not emulated')
    : { pageSize, startCursor }
}

const jsonBody = (
  request: EmulatedRequest,
  label: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Schema.JsonObject | NotEmulated =>
  withoutQuery(request) ?? exactObject(request.json, label, required, optional)

// Rendering, in the fixture key order.

/** The plain text of a page's `title` property (empty without one). */
const pageTitle = (page: NotionEmulatorPage): string => {
  const title = Object.values(page.properties).find(
    property => isJsonObject(property) && property.type === 'title'
  )

  const items = isJsonObject(title) && Array.isArray(title.title) ? title.title : []

  return items
    .map(item => (isJsonObject(item) && Predicate.isString(item.plain_text) ? item.plain_text : ''))
    .join('')
}

/** Title items without `plain_text` (the `omitTitlePlainText` drill). */
const withoutTitlePlainText = (properties: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      isJsonObject(property) && property.type === 'title' && Array.isArray(property.title)
        ? {
            ...property,
            title: property.title.map(item =>
              isJsonObject(item)
                ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'plain_text'))
                : item
            )
          }
        : property
    ])
  )

const renderPage = (
  env: NotionApiEnv,
  page: NotionEmulatorPage,
  read: 'page' | 'list'
): Schema.JsonObject => {
  const parent: Schema.JsonObject =
    page.parent.type === 'data_source_id' && env.drills.rowParentAsDatabase
      ? { type: 'database_id', database_id: page.parent.database_id }
      : page.parent

  const properties =
    read === 'page' && env.drills.omitTitlePlainText
      ? withoutTitlePlainText(page.properties)
      : page.properties

  const head = { object: 'page', id: page.id }

  const tail = {
    parent,
    archived: page.archived,
    in_trash: page.inTrash,
    properties,
    url: page.url
  }

  // In fixture key order; data source rows carry no timestamps, as their fixture records.
  return page.times === null
    ? { ...head, ...tail }
    : {
        ...head,
        created_time: page.times.created,
        last_edited_time: page.times.lastEdited,
        ...tail
      }
}

const isTrashed = (page: NotionEmulatorPage): boolean => page.archived || page.inTrash

/** One cursor page of `items` whose cursors are item ids (search, blocks, data source rows). */
const idPage = <A extends { readonly id: string }>(
  items: ReadonlyArray<A>,
  query: ListQuery,
  repeats: boolean
): { readonly page: ReadonlyArray<A>; readonly nextCursor: string | null } | NotEmulated => {
  const index =
    query.startCursor === undefined ? 0 : items.findIndex(item => item.id === query.startCursor)

  if (index === -1) return notEmulated('a start_cursor that names no result is not emulated')

  const start = repeats && index > 0 ? index - 1 : index
  const page = items.slice(start, start + query.pageSize)

  return { page, nextCursor: items[start + query.pageSize]?.id ?? null }
}

const list = (
  results: ReadonlyArray<Schema.Json>,
  nextCursor: string | null,
  type: 'page_or_data_source' | 'block'
): Schema.JsonObject => ({
  object: 'list',
  results: [...results],
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
  type,
  [type]: {}
})

// Routes.

type SearchInput = { readonly query: string; readonly list: ListQuery }

const search: Route = statefulRoute(
  evidence('POST', '/search', false, [searchCase]),
  'json',
  (request): SearchInput | NotEmulated => {
    const body = jsonBody(
      request,
      'the search body',
      ['query', 'filter', 'page_size'],
      ['start_cursor']
    )

    if (isNotEmulated(body)) return body

    if (!Predicate.isString(body.query)) return notEmulated('query must be a string')

    const filter = exactObject(body.filter, 'filter', ['property', 'value'])

    if (isNotEmulated(filter)) return filter

    if (filter.property !== 'object' || filter.value !== 'page') {
      return notEmulated(
        'filters other than { property: "object", value: "page" } are not emulated'
      )
    }

    const pageSize = integerIn(body.page_size, 'page_size', 1, 100)

    if (isNotEmulated(pageSize)) return pageSize

    if (
      body.start_cursor !== undefined &&
      (!Predicate.isString(body.start_cursor) || body.start_cursor.length === 0)
    ) {
      return notEmulated('start_cursor must be a non-empty string')
    }

    return {
      query: body.query,
      list: {
        pageSize,
        startCursor: Predicate.isString(body.start_cursor) ? body.start_cursor : undefined
      }
    }
  },
  (state, input, { env }) => {
    const query = input.query.toLowerCase()

    const matches = state.pages.filter(
      page => !isTrashed(page) && pageTitle(page).toLowerCase().includes(query)
    )

    const found = idPage(matches, input.list, env.drills.searchRepeatsResults)

    if (isNotEmulated(found)) return found

    return ok(
      list(
        found.page.map(page => renderPage(env, page, 'list')),
        found.nextCursor,
        'page_or_data_source'
      )
    )
  }
)

const botUser: Route = statefulRoute(
  evidence('GET', '/users/me', false, [versionCase]),
  'none',
  request => withoutQuery(request) ?? {},
  (state, _input, { env, seq }) => {
    const user = state.botUser

    const kind: Schema.JsonObject = env.drills.botUserAsPerson
      ? { type: 'person', person: {} }
      : {
          type: 'bot',
          bot: { owner: { type: 'workspace', workspace: true }, workspace_name: user.workspaceName }
        }

    return ok({
      object: 'user',
      id: user.id,
      name: user.name,
      avatar_url: user.avatarUrl,
      ...kind,
      request_id: requestId(seq)
    })
  }
)

type PageRead = { readonly raw: string; readonly id: string | undefined }

const getPage: Route = statefulRoute(
  evidence('GET', '/pages/{pageId}', false, [errorCase, titleCase, propertyCase, archiveCase]),
  'none',
  (request): PageRead | NotEmulated => {
    const raw = request.params.pageId ?? ''

    return withoutQuery(request) ?? { raw, id: normalizeId(raw) }
  },
  (state, input, { env, seq }) => {
    if (input.id === undefined) return malformedPageId(env, seq, input.raw)

    const page = state.pages.find(candidate => candidate.id === input.id)

    if (page === undefined || (env.drills.trashedPageNotFound && isTrashed(page))) {
      return pageNotFound(env, seq, input.id)
    }

    return ok(renderPage(env, page, 'page'))
  }
)

type CreateInput = { readonly parentId: string; readonly title: string }

const createPage: Route = statefulRoute(
  evidence('POST', '/pages', true, [archiveCase]),
  'json',
  (request): CreateInput | NotEmulated => {
    const body = jsonBody(request, 'the create page body', ['parent', 'properties'])

    if (isNotEmulated(body)) return body

    const parent = exactObject(body.parent, 'parent', ['page_id'])

    if (isNotEmulated(parent)) return parent

    const parentId = Predicate.isString(parent.page_id) ? normalizeId(parent.page_id) : undefined

    if (parentId === undefined) return notEmulated('parent.page_id must be a Notion id')

    const properties = exactObject(body.properties, 'properties', ['title'])

    if (isNotEmulated(properties)) return properties

    const title = exactObject(properties.title, 'properties.title', ['title'])

    if (isNotEmulated(title)) return title

    const items = title.title

    if (!Array.isArray(items) || items.length !== 1) {
      return notEmulated('a title of other than one text item is not emulated')
    }

    const item = exactObject(items[0], 'the title item', ['text'])

    if (isNotEmulated(item)) return item

    const text = exactObject(item.text, 'the title item text', ['content'])

    if (isNotEmulated(text)) return text

    return Predicate.isString(text.content)
      ? { parentId, title: text.content }
      : notEmulated('the title text content must be a string')
  },
  (state, input, { env }) => {
    const parent = state.pages.find(page => page.id === input.parentId)

    if (parent === undefined || isTrashed(parent)) {
      return notEmulated('creating a page under a missing or trashed page is not emulated')
    }

    // Read the clock before any write: a failing clock writes nothing.
    const at = new Date(env.now()).toISOString()
    const number = state.counters.nextPageNumber
    const id = `1f0000e0-0000-4000-8000-${pad(number, 12)}`

    const page: NotionEmulatorPage = {
      id,
      times: { created: at, lastEdited: at },
      parent: { type: 'page_id', page_id: parent.id },
      archived: false,
      inTrash: false,
      properties: { title: titleProperty([plainRichText(input.title)]) },
      url: notionPageUrl(input.title, id)
    }

    state.counters = { ...state.counters, nextPageNumber: number + 1 }
    state.pages = [...state.pages, page]

    return ok(renderPage(env, page, 'page'))
  }
)

const archivePage: Route = statefulRoute(
  evidence('PATCH', '/pages/{pageId}', true, [archiveCase]),
  'json',
  (request): string | NotEmulated => {
    const id = idParam(request, 'pageId')

    if (isNotEmulated(id)) return id

    const body = jsonBody(request, 'the update page body', ['archived'])

    if (isNotEmulated(body)) return body

    return body.archived === true
      ? id
      : notEmulated('page updates other than { archived: true } are not emulated')
  },
  (state, id, { env }) => {
    const page = state.pages.find(candidate => candidate.id === id)

    if (page === undefined || isTrashed(page)) {
      return notEmulated('archiving a missing or already trashed page is not emulated')
    }

    // The archive fixture keeps `last_edited_time` unchanged.
    const archived: NotionEmulatorPage = { ...page, archived: true, inTrash: true }

    state.pages = state.pages.map(candidate => (candidate.id === id ? archived : candidate))

    return ok(renderPage(env, archived, 'page'))
  }
)

type ChildrenInput = { readonly blockId: string; readonly list: ListQuery }

const blockChildren: Route = statefulRoute(
  evidence('GET', '/blocks/{blockId}/children', false, [blocksCase]),
  'none',
  (request): ChildrenInput | NotEmulated => {
    const blockId = idParam(request, 'blockId')

    if (isNotEmulated(blockId)) return blockId

    const query = listQuery(request)

    return isNotEmulated(query) ? query : { blockId, list: query }
  },
  (state, input, { env }) => {
    if (!state.pages.some(page => page.id === input.blockId)) {
      return notEmulated('children of anything but a page are not emulated')
    }

    const blocks = state.blocks.filter(block => block.pageId === input.blockId)
    const found = idPage(blocks, input.list, env.drills.blockCursorRepeats)

    if (isNotEmulated(found)) return found

    return ok(
      list(
        found.page.map(block => ({
          object: 'block',
          id: block.id,
          parent: { type: 'page_id', page_id: block.pageId },
          created_time: block.createdTime,
          last_edited_time: block.lastEditedTime,
          has_children: block.hasChildren,
          archived: block.archived,
          in_trash: block.inTrash,
          type: block.type,
          [block.type]: block.value
        })),
        found.nextCursor,
        'block'
      )
    )
  }
)

// Property item cursors: opaque base64url of `<offset>|<pageId>|<encoded property id>`.

const base64url = (text: string): string =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

const propertyCursor = (pageId: string, propertyId: string, offset: number): string =>
  base64url(`${offset}|${pageId}|${encodeURIComponent(propertyId)}`)

const cursorOffset = (cursor: string, pageId: string, propertyId: string): number | undefined => {
  try {
    const [offset, page, property] = atob(cursor.replaceAll('-', '+').replaceAll('_', '/')).split(
      '|'
    )

    return page === pageId &&
      property === encodeURIComponent(propertyId) &&
      offset !== undefined &&
      /^\d+$/.test(offset)
      ? Number(offset)
      : undefined
  } catch {
    return undefined
  }
}

type PropertyInput = {
  readonly pageId: string
  readonly propertyId: string
  readonly list: ListQuery
}

const decodeAgain = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const propertyItems: Route = statefulRoute(
  evidence('GET', '/pages/{pageId}/properties/{propertyId}', false, [propertyCase]),
  'none',
  (request, env): PropertyInput | NotEmulated => {
    const pageId = idParam(request, 'pageId')

    if (isNotEmulated(pageId)) return pageId

    const once = request.params.propertyId ?? ''
    const propertyId = env.drills.rejectDoubleEncodedPropertyId ? decodeAgain(once) : once

    if (propertyId === undefined) return notEmulated('a malformed property id is not emulated')

    const query = listQuery(request)

    return isNotEmulated(query) ? query : { pageId, propertyId, list: query }
  },
  (state, input, { env }) => {
    const items = state.propertyItems.find(
      candidate => candidate.pageId === input.pageId && candidate.propertyId === input.propertyId
    )

    if (items === undefined || !state.pages.some(page => page.id === input.pageId)) {
      return notEmulated('items of a property with no seeded item list are not emulated')
    }

    const offset =
      input.list.startCursor === undefined
        ? 0
        : cursorOffset(input.list.startCursor, input.pageId, input.propertyId)

    if (offset === undefined || offset >= items.values.length) {
      return notEmulated(
        'a start_cursor this emulator did not issue for the property is not emulated'
      )
    }

    const end = Math.min(offset + input.list.pageSize, items.values.length)

    const nextCursor =
      end < items.values.length ? propertyCursor(input.pageId, input.propertyId, end) : null

    return ok({
      object: 'list',
      results: items.values.slice(offset, end).map(value => ({
        object: 'property_item',
        id: items.propertyId,
        type: items.type,
        [items.type]: value
      })),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      type: 'property_item',
      property_item: {
        id: items.propertyId,
        // The fixture's next_url names the property id as the page object returns it.
        next_url:
          nextCursor === null
            ? null
            : `${env.origin}${notionEmulatorBasePath}/pages/${items.pageId}/properties/${items.propertyId}?start_cursor=${nextCursor}`,
        type: items.type,
        [items.type]: {}
      }
    })
  }
)

const getDatabase: Route = statefulRoute(
  evidence('GET', '/databases/{databaseId}', false, [dataSourceCase]),
  'none',
  request => withoutQuery(request) ?? idParam(request, 'databaseId'),
  (state, id) => {
    const database = state.databases.find(candidate => candidate.id === id)

    if (database === undefined) return notEmulated('a missing database is not emulated')

    return ok({
      object: 'database',
      id: database.id,
      title: [...database.title],
      description: [...database.description],
      parent: database.parent,
      is_inline: database.isInline,
      in_trash: database.inTrash,
      archived: database.archived,
      created_time: database.createdTime,
      last_edited_time: database.lastEditedTime,
      data_sources: state.dataSources
        .filter(source => source.databaseId === database.id)
        .map(source => ({
          id: source.id,
          name: source.title
            .map(item =>
              isJsonObject(item) && Predicate.isString(item.plain_text) ? item.plain_text : ''
            )
            .join('')
        })),
      url: database.url
    })
  }
)

const getDataSource: Route = statefulRoute(
  evidence('GET', '/data_sources/{dataSourceId}', false, [dataSourceCase]),
  'none',
  request => withoutQuery(request) ?? idParam(request, 'dataSourceId'),
  (state, id) => {
    const source = state.dataSources.find(candidate => candidate.id === id)
    const database = state.databases.find(candidate => candidate.id === source?.databaseId)

    if (source === undefined || database === undefined) {
      return notEmulated('a missing data source is not emulated')
    }

    return ok({
      object: 'data_source',
      id: source.id,
      parent: { type: 'database_id', database_id: database.id },
      database_parent: database.parent,
      title: [...source.title],
      properties: source.properties,
      archived: source.archived,
      in_trash: source.inTrash
    })
  }
)

type QueryInput = { readonly dataSourceId: string; readonly pageSize: number }

const queryDataSource: Route = statefulRoute(
  evidence('POST', '/data_sources/{dataSourceId}/query', false, [dataSourceCase]),
  'json',
  (request): QueryInput | NotEmulated => {
    const dataSourceId = idParam(request, 'dataSourceId')

    if (isNotEmulated(dataSourceId)) return dataSourceId

    const body = jsonBody(request, 'the query body', ['page_size'])

    if (isNotEmulated(body)) return body

    const pageSize = integerIn(body.page_size, 'page_size', 1, 100)

    return isNotEmulated(pageSize) ? pageSize : { dataSourceId, pageSize }
  },
  (state, input, { env }) => {
    if (!state.dataSources.some(source => source.id === input.dataSourceId)) {
      return notEmulated('a missing data source is not emulated')
    }

    const rows = state.pages.filter(
      page =>
        !isTrashed(page) &&
        page.parent.type === 'data_source_id' &&
        page.parent.data_source_id === input.dataSourceId
    )

    const found = idPage(rows, { pageSize: input.pageSize, startCursor: undefined }, false)

    if (isNotEmulated(found)) return found

    return ok(
      list(
        found.page.map(page => renderPage(env, page, 'list')),
        found.nextCursor,
        'page_or_data_source'
      )
    )
  }
)

/** The route table: evidence plus handlers. `notionEmulatorRoutes` is its evidence part. */
export const notionApiRoutes: ReadonlyArray<Route> = [
  search,
  botUser,
  getPage,
  createPage,
  archivePage,
  blockChildren,
  propertyItems,
  getDatabase,
  getDataSource,
  queryDataSource
]
