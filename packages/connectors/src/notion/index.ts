import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const notionConnectorId = 'notion'
export const notionApiTokenSlotId = 'notion.api_token'
export const notionApiBaseUrl = 'https://api.notion.com/v1'
export const notionVersion = '2022-06-28'

export const NotionApiTokenSlot = CredentialSlot.make({
  id: notionApiTokenSlotId,
  kind: 'api_key'
})

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
      code: input.code,
      message: input.message,
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
  pageSize: Schema.optional(Schema.Number),
  startCursor: Schema.optional(Schema.String)
}) {}

export class NotionSearchOutput extends Schema.Class<NotionSearchOutput>('NotionSearchOutput')({
  results: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  hasMore: Schema.Boolean
}) {}

export class NotionGetPageInput extends Schema.Class<NotionGetPageInput>('NotionGetPageInput')({
  pageId: Schema.String
}) {}

export class NotionCreatePageInput extends Schema.Class<NotionCreatePageInput>('NotionCreatePageInput')({
  parentPageId: Schema.optional(Schema.String),
  parentDatabaseId: Schema.optional(Schema.String),
  title: Schema.String,
  properties: Schema.optional(NotionProperties)
}) {}

const pageParent = (input: NotionCreatePageInput) => {
  if (input.parentDatabaseId !== undefined) {
    return { database_id: input.parentDatabaseId }
  }

  return { page_id: input.parentPageId ?? '' }
}

const pageProperties = (input: NotionCreatePageInput) => ({
  ...input.properties,
  title: {
    title: [
      {
        text: {
          content: input.title
        }
      }
    ]
  }
})

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

      const output = yield* decodeJsonResponse(NotionSearchOutput, response)
      return ActionResult.success(output)
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
      const token = yield* resolveNotionToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${notionApiBaseUrl}/pages`,
          headers: {
            ...notionAuthorizationHeaders(token),
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            parent: pageParent(input),
            properties: pageProperties(input)
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

export const notionActions = [notionSearchAction, notionGetPageAction, notionCreatePageAction]

export const NotionConnector = defineConnector({
  id: notionConnectorId,
  description: 'Notion page and search connector actions.',
  actions: notionActions
})
