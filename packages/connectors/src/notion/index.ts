import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const notionConnectorId = 'notion'
export const notionApiTokenSlotId = 'notion.api_token'
export const notionApiBaseUrl = 'https://api.notion.com/v1'
export const notionVersion = '2025-09-03'

export const NotionApiTokenSlot = CredentialSlot.make({
  id: notionApiTokenSlotId,
  kind: 'api_key'
})

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const isJsonObject = Schema.is(JsonObject)

export const notionAuthorizationHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'notion-version': notionVersion
})

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const notionProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  ActionResult.failure(
    new ProviderFailure({
      code: providerCode(input.code, input.status),
      message: providerMessage(input.message, input.body),
      status: input.status,
      underlying: input.body
    })
  )

const resolveNotionToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, NotionApiTokenSlot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
    }
  })

export const NotionRichText = Schema.Struct({
  type: Schema.optional(Schema.String),
  plain_text: Schema.optional(Schema.String),
  href: Schema.optional(Schema.NullOr(Schema.String))
})

export const NotionTitleProperty = Schema.Struct({
  title: Schema.Array(NotionRichText)
})

export const NotionProperties = Schema.Record(Schema.String, Schema.Unknown)

export class NotionPage extends Schema.Class<NotionPage>('NotionPage')({
  id: Schema.String,
  object: Schema.String,
  url: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
  properties: Schema.optional(NotionProperties)
}) {}

export class NotionSearchInput extends Schema.Class<NotionSearchInput>('NotionSearchInput')({
  query: Schema.optional(Schema.String),
  filter: Schema.optional(Schema.Unknown),
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionSearchOutput extends Schema.Class<NotionSearchOutput>('NotionSearchOutput')({
  results: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  hasMore: Schema.Boolean
}) {}

const NotionSearchApiOutput = Schema.Struct({
  results: Schema.Array(Schema.Unknown),
  next_cursor: Schema.NullOr(Schema.String),
  has_more: Schema.Boolean
})

export class NotionGetPageInput extends Schema.Class<NotionGetPageInput>('NotionGetPageInput')({
  pageId: Schema.String
}) {}

export class NotionCreatePageInput extends Schema.Class<NotionCreatePageInput>(
  'NotionCreatePageInput'
)({
  parent: Schema.optional(Schema.Unknown),
  properties: Schema.optional(NotionProperties),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
  parentPageId: Schema.optional(Schema.String),
  parentDatabaseId: Schema.optional(Schema.String),
  parentDataSourceId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  titlePropertyName: Schema.optional(Schema.String)
}) {}

export class NotionPageIdInput extends Schema.Class<NotionPageIdInput>('NotionPageIdInput')({
  pageId: Schema.String
}) {}

export class NotionBlockIdInput extends Schema.Class<NotionBlockIdInput>('NotionBlockIdInput')({
  blockId: Schema.String,
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionDatabaseIdInput extends Schema.Class<NotionDatabaseIdInput>(
  'NotionDatabaseIdInput'
)({
  databaseId: Schema.String
}) {}

export class NotionDataSourceIdInput extends Schema.Class<NotionDataSourceIdInput>(
  'NotionDataSourceIdInput'
)({
  dataSourceId: Schema.optional(Schema.String),
  data_source_id: Schema.optional(Schema.String)
}) {}

export class NotionUpdatePageInput extends Schema.Class<NotionUpdatePageInput>(
  'NotionUpdatePageInput'
)({
  pageId: Schema.String,
  properties: Schema.optional(NotionProperties),
  archived: Schema.optional(Schema.Boolean),
  icon: Schema.optional(Schema.Unknown),
  cover: Schema.optional(Schema.Unknown)
}) {}

export class NotionQueryDatabaseInput extends Schema.Class<NotionQueryDatabaseInput>(
  'NotionQueryDatabaseInput'
)({
  databaseId: Schema.String,
  filter: Schema.optional(Schema.Unknown),
  sorts: Schema.optional(Schema.Array(Schema.Unknown)),
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionCreateDatabaseInput extends Schema.Class<NotionCreateDatabaseInput>(
  'NotionCreateDatabaseInput'
)({
  parent: Schema.Unknown,
  title: Schema.Array(Schema.Unknown),
  properties: NotionProperties
}) {}

export class NotionUpdateDatabaseInput extends Schema.Class<NotionUpdateDatabaseInput>(
  'NotionUpdateDatabaseInput'
)({
  databaseId: Schema.String,
  title: Schema.optional(Schema.Array(Schema.Unknown)),
  description: Schema.optional(Schema.Array(Schema.Unknown)),
  properties: Schema.optional(NotionProperties),
  isInline: Schema.optional(Schema.Boolean),
  is_inline: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean)
}) {}

export class NotionAppendBlocksInput extends Schema.Class<NotionAppendBlocksInput>(
  'NotionAppendBlocksInput'
)({
  blockId: Schema.String,
  children: Schema.Array(Schema.Unknown)
}) {}

export class NotionUpdateBlockInput extends Schema.Class<NotionUpdateBlockInput>(
  'NotionUpdateBlockInput'
)({
  blockId: Schema.String,
  block: Schema.optional(NotionProperties),
  archived: Schema.optional(Schema.Boolean)
}) {}

export class NotionQueryDataSourceInput extends Schema.Class<NotionQueryDataSourceInput>(
  'NotionQueryDataSourceInput'
)({
  dataSourceId: Schema.optional(Schema.String),
  data_source_id: Schema.optional(Schema.String),
  filter: Schema.optional(Schema.Unknown),
  sorts: Schema.optional(Schema.Array(Schema.Unknown)),
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionCreateDataSourceInput extends Schema.Class<NotionCreateDataSourceInput>(
  'NotionCreateDataSourceInput'
)({
  databaseId: Schema.String,
  title: Schema.Array(Schema.Unknown),
  properties: NotionProperties
}) {}

export class NotionUpdateDataSourceInput extends Schema.Class<NotionUpdateDataSourceInput>(
  'NotionUpdateDataSourceInput'
)({
  dataSourceId: Schema.optional(Schema.String),
  data_source_id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.Array(Schema.Unknown)),
  properties: Schema.optional(NotionProperties),
  archived: Schema.optional(Schema.Boolean)
}) {}

export class NotionGetPagePropertyInput extends Schema.Class<NotionGetPagePropertyInput>(
  'NotionGetPagePropertyInput'
)({
  pageId: Schema.String,
  propertyId: Schema.String,
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionUserIdInput extends Schema.Class<NotionUserIdInput>('NotionUserIdInput')({
  userId: Schema.String
}) {}

export class NotionPaginationInput extends Schema.Class<NotionPaginationInput>(
  'NotionPaginationInput'
)({
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionCreateCommentInput extends Schema.Class<NotionCreateCommentInput>(
  'NotionCreateCommentInput'
)({
  parent: Schema.optional(Schema.Unknown),
  discussion_id: Schema.optional(Schema.String),
  discussionId: Schema.optional(Schema.String),
  rich_text: Schema.optional(Schema.Array(Schema.Unknown)),
  richText: Schema.optional(Schema.Array(Schema.Unknown))
}) {}

export class NotionListCommentsInput extends Schema.Class<NotionListCommentsInput>(
  'NotionListCommentsInput'
)({
  blockId: Schema.String,
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

const pageParent = (input: NotionCreatePageInput) => {
  if (input.parent !== undefined) {
    return input.parent
  }

  if (input.parentDataSourceId !== undefined) {
    return { data_source_id: input.parentDataSourceId }
  }

  if (input.parentDatabaseId !== undefined) {
    return { database_id: input.parentDatabaseId }
  }

  if (input.parentPageId !== undefined) {
    return { page_id: input.parentPageId }
  }

  return undefined
}

const unknownField = (value: unknown, key: string) => {
  if (!isJsonObject(value)) return undefined
  return value[key]
}

const pageProperties = (propertyName: string, title: string | undefined) => ({
  [propertyName]: {
    title: [
      {
        text: {
          content: title ?? 'Untitled'
        }
      }
    ]
  }
})

const hasDatabaseLikeParent = (input: NotionCreatePageInput) =>
  input.parentDatabaseId !== undefined ||
  input.parentDataSourceId !== undefined ||
  unknownField(input.parent, 'database_id') !== undefined ||
  unknownField(input.parent, 'data_source_id') !== undefined

const createPageProperties = (input: NotionCreatePageInput) =>
  Effect.gen(function* () {
    if (input.properties !== undefined) {
      return input.properties
    }

    if (hasDatabaseLikeParent(input) && input.titlePropertyName === undefined) {
      return yield* Effect.fail(
        new ConnectorError({
          cause: 'validation_failed',
          message:
            'Notion database/data-source pages require properties or titlePropertyName when using title',
          connectorId: notionConnectorId,
          actionId: 'notion.create_page'
        })
      )
    }

    return pageProperties(input.titlePropertyName ?? 'title', input.title)
  })

const requireNotionDataSourceId = (
  input: NotionDataSourceIdInput | NotionQueryDataSourceInput | NotionUpdateDataSourceInput,
  actionId: string
) =>
  Effect.gen(function* () {
    const dataSourceId = input.data_source_id ?? input.dataSourceId
    if (dataSourceId !== undefined) return dataSourceId

    return yield* Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message: 'Notion action requires dataSourceId or data_source_id',
        connectorId: notionConnectorId,
        actionId
      })
    )
  })

const requireNotionRichText = (input: NotionCreateCommentInput) =>
  Effect.gen(function* () {
    const richText = input.rich_text ?? input.richText
    if (richText !== undefined) return richText

    return yield* Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message: 'Notion create comment requires rich_text or richText',
        connectorId: notionConnectorId,
        actionId: 'notion.create_comment'
      })
    )
  })

const jsonMessageField = (body: string, keys: ReadonlyArray<string>) => {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)
  if (Option.isNone(parsed) || !isJsonObject(parsed.value)) return undefined
  for (const key of keys) {
    const value = parsed.value[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

const providerMessage = (fallback: string, body: string) => {
  const detail = jsonMessageField(body, ['message', 'error_description', 'error'])
  return detail === undefined ? fallback : `${fallback}: ${detail}`
}

const providerCode = (fallback: string, status: number) => {
  switch (status) {
    case 401:
    case 403:
      return 'notion_unauthorized'
    case 404:
      return 'notion_not_found'
    case 429:
      return 'notion_rate_limited'
    default:
      return fallback
  }
}

const notionJsonAction = (
  integration: ConnectorIntegration,
  request: (token: string) => ConnectorHttpRequest,
  errorCode: string,
  errorMessage: string
) =>
  Effect.gen(function* () {
    const token = yield* resolveNotionToken(integration)
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(request(token))

    if (!isSuccessStatus(response.status)) {
      return notionProviderFailure({
        code: errorCode,
        message: errorMessage,
        status: response.status,
        body: response.body
      })
    }

    const output = yield* decodeJsonResponse(Schema.Unknown, response)
    return ActionResult.success(output)
  })

const notionRequest = (input: {
  readonly token: string
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body?: unknown
}) => {
  const headers =
    input.body === undefined
      ? notionAuthorizationHeaders(input.token)
      : { ...notionAuthorizationHeaders(input.token), 'content-type': 'application/json' }

  return ConnectorHttpRequest.make({
    method: input.method,
    url: `${notionApiBaseUrl}${input.path}`,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  })
}

export const notionSearchAction = defineAction({
  id: 'notion.search',
  description: 'Search pages and databases available to the Notion integration.',
  inputSchema: NotionSearchInput,
  outputSchema: NotionSearchOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveNotionToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${notionApiBaseUrl}/search`,
          headers: {
            ...notionAuthorizationHeaders(token),
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            query: input.query,
            filter: input.filter,
            page_size: input.pageSize,
            start_cursor: input.startCursor
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return notionProviderFailure({
          code: 'notion_search_failed',
          message: 'Notion search failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(NotionSearchApiOutput, response)
      return ActionResult.success(
        NotionSearchOutput.make({
          results: output.results,
          nextCursor: output.next_cursor,
          hasMore: output.has_more
        })
      )
    })
})

export const notionGetPageAction = defineAction({
  id: 'notion.get_page',
  description: 'Get a Notion page by id.',
  inputSchema: NotionGetPageInput,
  outputSchema: NotionPage,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveNotionToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${notionApiBaseUrl}/pages/${encodeURIComponent(input.pageId)}`,
          headers: notionAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return notionProviderFailure({
          code: 'notion_get_page_failed',
          message: 'Notion get page failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(NotionPage, response)
      return ActionResult.success(output)
    })
})

export const notionCreatePageAction = defineAction({
  id: 'notion.create_page',
  description: 'Create a Notion page under a parent page or database.',
  inputSchema: NotionCreatePageInput,
  outputSchema: NotionPage,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const parent = pageParent(input)
      if (parent === undefined) {
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'validation_failed',
            message: 'Notion create page requires a parent, parentPageId, or parentDatabaseId',
            connectorId: notionConnectorId,
            actionId: 'notion.create_page'
          })
        )
      }

      const token = yield* resolveNotionToken(integration)
      const http = yield* ConnectorHttpClient
      const properties = yield* createPageProperties(input)
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${notionApiBaseUrl}/pages`,
          headers: {
            ...notionAuthorizationHeaders(token),
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            parent,
            properties,
            children: input.children
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return notionProviderFailure({
          code: 'notion_create_page_failed',
          message: 'Notion create page failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(NotionPage, response)
      return ActionResult.success(output)
    })
})

export const notionUpdatePageAction = defineAction({
  id: 'notion.update_page',
  description: 'Update a Notion page by id.',
  inputSchema: NotionUpdatePageInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'PATCH',
          path: `/pages/${encodeURIComponent(input.pageId)}`,
          body: {
            properties: input.properties,
            archived: input.archived,
            icon: input.icon,
            cover: input.cover
          }
        }),
      'notion_update_page_failed',
      'Notion update page failed'
    )
})

export const notionGetPageContentAction = defineAction({
  id: 'notion.get_page_content',
  description: 'List child blocks for a Notion page or block.',
  inputSchema: NotionBlockIdInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'GET',
          path: `/blocks/${encodeURIComponent(input.blockId)}/children${(() => {
            const params = new URLSearchParams()
            if (input.pageSize !== undefined) params.set('page_size', String(input.pageSize))
            if (input.startCursor !== undefined) params.set('start_cursor', input.startCursor)
            const query = params.toString()
            return query === '' ? '' : `?${query}`
          })()}`
        }),
      'notion_get_page_content_failed',
      'Notion get page content failed'
    )
})

export const notionGetDatabaseAction = defineAction({
  id: 'notion.get_database',
  description: 'Get a Notion database by id.',
  inputSchema: NotionDatabaseIdInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'GET',
          path: `/databases/${encodeURIComponent(input.databaseId)}`
        }),
      'notion_get_database_failed',
      'Notion get database failed'
    )
})

export const notionQueryDatabaseAction = defineAction({
  id: 'notion.query_database',
  description: 'Query a Notion database.',
  inputSchema: NotionQueryDatabaseInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'POST',
          path: `/databases/${encodeURIComponent(input.databaseId)}/query`,
          body: {
            filter: input.filter,
            sorts: input.sorts,
            page_size: input.pageSize,
            start_cursor: input.startCursor
          }
        }),
      'notion_query_database_failed',
      'Notion query database failed'
    )
})

export const notionCreateDatabaseAction = defineAction({
  id: 'notion.create_database',
  description: 'Create a Notion database.',
  inputSchema: NotionCreateDatabaseInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'POST',
          path: '/databases',
          body: {
            parent: input.parent,
            title: input.title,
            initial_data_source: { properties: input.properties }
          }
        }),
      'notion_create_database_failed',
      'Notion create database failed'
    )
})

export const notionUpdateDatabaseAction = defineAction({
  id: 'notion.update_database',
  description: 'Update a Notion database.',
  inputSchema: NotionUpdateDatabaseInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'PATCH',
          path: `/databases/${encodeURIComponent(input.databaseId)}`,
          body: {
            title: input.title,
            description: input.description,
            properties: input.properties,
            is_inline: input.is_inline ?? input.isInline,
            archived: input.archived
          }
        }),
      'notion_update_database_failed',
      'Notion update database failed'
    )
})

export const notionAppendBlocksAction = defineAction({
  id: 'notion.append_blocks',
  description: 'Append child blocks to a Notion block.',
  inputSchema: NotionAppendBlocksInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'PATCH',
          path: `/blocks/${encodeURIComponent(input.blockId)}/children`,
          body: { children: input.children }
        }),
      'notion_append_blocks_failed',
      'Notion append blocks failed'
    )
})

export const notionUpdateBlockAction = defineAction({
  id: 'notion.update_block',
  description: 'Update a Notion block.',
  inputSchema: NotionUpdateBlockInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'PATCH',
          path: `/blocks/${encodeURIComponent(input.blockId)}`,
          body: { ...input.block, archived: input.archived }
        }),
      'notion_update_block_failed',
      'Notion update block failed'
    )
})

export const notionDeleteBlockAction = defineAction({
  id: 'notion.delete_block',
  description: 'Delete/archive a Notion block.',
  inputSchema: NotionBlockIdInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'DELETE',
          path: `/blocks/${encodeURIComponent(input.blockId)}`
        }),
      'notion_delete_block_failed',
      'Notion delete block failed'
    )
})

export const notionGetBlockAction = defineAction({
  id: 'notion.get_block',
  description: 'Get a Notion block.',
  inputSchema: NotionBlockIdInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'GET',
          path: `/blocks/${encodeURIComponent(input.blockId)}`
        }),
      'notion_get_block_failed',
      'Notion get block failed'
    )
})

export const notionGetDataSourceAction = defineAction({
  id: 'notion.get_data_source',
  description: 'Get a Notion data source.',
  inputSchema: NotionDataSourceIdInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const dataSourceId = yield* requireNotionDataSourceId(input, 'notion.get_data_source')
      return yield* notionJsonAction(
        integration,
        token =>
          notionRequest({
            token,
            method: 'GET',
            path: `/data_sources/${encodeURIComponent(dataSourceId)}`
          }),
        'notion_get_data_source_failed',
        'Notion get data source failed'
      )
    })
})

export const notionQueryDataSourceAction = defineAction({
  id: 'notion.query_data_source',
  description: 'Query a Notion data source.',
  inputSchema: NotionQueryDataSourceInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const dataSourceId = yield* requireNotionDataSourceId(input, 'notion.query_data_source')
      return yield* notionJsonAction(
        integration,
        token =>
          notionRequest({
            token,
            method: 'POST',
            path: `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
            body: {
              filter: input.filter,
              sorts: input.sorts,
              page_size: input.pageSize,
              start_cursor: input.startCursor
            }
          }),
        'notion_query_data_source_failed',
        'Notion query data source failed'
      )
    })
})

export const notionCreateDataSourceAction = defineAction({
  id: 'notion.create_data_source',
  description: 'Create a Notion data source.',
  inputSchema: NotionCreateDataSourceInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({
          token,
          method: 'POST',
          path: '/data_sources',
          body: {
            parent: { type: 'database_id', database_id: input.databaseId },
            title: input.title,
            properties: input.properties
          }
        }),
      'notion_create_data_source_failed',
      'Notion create data source failed'
    )
})

export const notionUpdateDataSourceAction = defineAction({
  id: 'notion.update_data_source',
  description: 'Update a Notion data source.',
  inputSchema: NotionUpdateDataSourceInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const dataSourceId = yield* requireNotionDataSourceId(input, 'notion.update_data_source')
      return yield* notionJsonAction(
        integration,
        token =>
          notionRequest({
            token,
            method: 'PATCH',
            path: `/data_sources/${encodeURIComponent(dataSourceId)}`,
            body: { title: input.title, properties: input.properties, archived: input.archived }
          }),
        'notion_update_data_source_failed',
        'Notion update data source failed'
      )
    })
})

export const notionGetPagePropertyAction = defineAction({
  id: 'notion.get_page_property',
  description: 'Get a Notion page property item.',
  inputSchema: NotionGetPagePropertyInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token => {
        const params = new URLSearchParams()
        if (input.pageSize !== undefined) params.set('page_size', String(input.pageSize))
        if (input.startCursor !== undefined) params.set('start_cursor', input.startCursor)
        const query = params.toString()
        return notionRequest({
          token,
          method: 'GET',
          path: `/pages/${encodeURIComponent(input.pageId)}/properties/${encodeURIComponent(input.propertyId)}${query === '' ? '' : `?${query}`}`
        })
      },
      'notion_get_page_property_failed',
      'Notion get page property failed'
    )
})

export const notionListUsersAction = defineAction({
  id: 'notion.list_users',
  description: 'List Notion users.',
  inputSchema: NotionPaginationInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token => {
        const params = new URLSearchParams()
        if (input.pageSize !== undefined) params.set('page_size', String(input.pageSize))
        if (input.startCursor !== undefined) params.set('start_cursor', input.startCursor)
        const query = params.toString()
        return notionRequest({
          token,
          method: 'GET',
          path: `/users${query === '' ? '' : `?${query}`}`
        })
      },
      'notion_list_users_failed',
      'Notion list users failed'
    )
})

export const notionGetUserAction = defineAction({
  id: 'notion.get_user',
  description: 'Get a Notion user.',
  inputSchema: NotionUserIdInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token =>
        notionRequest({ token, method: 'GET', path: `/users/${encodeURIComponent(input.userId)}` }),
      'notion_get_user_failed',
      'Notion get user failed'
    )
})

export const notionGetBotUserAction = defineAction({
  id: 'notion.get_bot_user',
  description: 'Get the Notion bot user.',
  inputSchema: Schema.Struct({}),
  outputSchema: Schema.Unknown,
  execute: ({ integration }) =>
    notionJsonAction(
      integration,
      token => notionRequest({ token, method: 'GET', path: '/users/me' }),
      'notion_get_bot_user_failed',
      'Notion get bot user failed'
    )
})

export const notionCreateCommentAction = defineAction({
  id: 'notion.create_comment',
  description: 'Create a Notion comment.',
  inputSchema: NotionCreateCommentInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const richText = yield* requireNotionRichText(input)
      return yield* notionJsonAction(
        integration,
        token =>
          notionRequest({
            token,
            method: 'POST',
            path: '/comments',
            body: {
              parent: input.parent,
              discussion_id: input.discussion_id ?? input.discussionId,
              rich_text: richText
            }
          }),
        'notion_create_comment_failed',
        'Notion create comment failed'
      )
    })
})

export const notionListCommentsAction = defineAction({
  id: 'notion.list_comments',
  description: 'List Notion comments for a block.',
  inputSchema: NotionListCommentsInput,
  outputSchema: Schema.Unknown,
  execute: ({ integration, input }) =>
    notionJsonAction(
      integration,
      token => {
        const params = new URLSearchParams()
        params.set('block_id', input.blockId)
        if (input.pageSize !== undefined) params.set('page_size', String(input.pageSize))
        if (input.startCursor !== undefined) params.set('start_cursor', input.startCursor)
        return notionRequest({ token, method: 'GET', path: `/comments?${params.toString()}` })
      },
      'notion_list_comments_failed',
      'Notion list comments failed'
    )
})

export const notionActions = [
  notionSearchAction,
  notionGetPageAction,
  notionGetPageContentAction,
  notionCreatePageAction,
  notionUpdatePageAction,
  notionGetDatabaseAction,
  notionQueryDatabaseAction,
  notionCreateDatabaseAction,
  notionAppendBlocksAction,
  notionUpdateBlockAction,
  notionDeleteBlockAction,
  notionGetDataSourceAction,
  notionQueryDataSourceAction,
  notionCreateDataSourceAction,
  notionUpdateDataSourceAction,
  notionGetBlockAction,
  notionUpdateDatabaseAction,
  notionGetPagePropertyAction,
  notionListUsersAction,
  notionGetUserAction,
  notionGetBotUserAction,
  notionCreateCommentAction,
  notionListCommentsAction
]

export const NotionConnector = defineConnector({
  id: notionConnectorId,
  description: 'Notion page and search connector actions.',
  actions: notionActions
})
