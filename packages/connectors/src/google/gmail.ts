import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import { googleAuthorizationHeaders } from './oauth.ts'
import {
  appendNumberSearchParam,
  appendSearchParam,
  isSuccessStatus,
  providerFailureFromResponse,
  resolveGoogleAccessToken
} from './shared.ts'

export const googleGmailApiBaseUrl = 'https://gmail.googleapis.com/gmail/v1'

export class GmailMessageRef extends Schema.Class<GmailMessageRef>('GmailMessageRef')({
  id: Schema.String,
  threadId: Schema.optional(Schema.String)
}) {}

export class GmailSearchInput extends Schema.Class<GmailSearchInput>('GmailSearchInput')({
  query: Schema.optional(Schema.String),
  maxResults: Schema.optional(Schema.Number)
}) {}

export class GmailSearchOutput extends Schema.Class<GmailSearchOutput>('GmailSearchOutput')({
  messages: Schema.optional(Schema.Array(GmailMessageRef)),
  nextPageToken: Schema.optional(Schema.String),
  resultSizeEstimate: Schema.optional(Schema.Number)
}) {}

export class GmailGetMessageInput extends Schema.Class<GmailGetMessageInput>('GmailGetMessageInput')({
  id: Schema.String,
  format: Schema.optional(Schema.Literals(['minimal', 'full', 'raw', 'metadata']))
}) {}

export const GmailMessagePayloadHeader = Schema.Struct({
  name: Schema.String,
  value: Schema.String
})

export class GmailMessageOutput extends Schema.Class<GmailMessageOutput>('GmailMessageOutput')({
  id: Schema.String,
  threadId: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  payload: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Array(GmailMessagePayloadHeader))
    })
  ),
  raw: Schema.optional(Schema.String)
}) {}

export const gmailSearchAction = defineAction({
  id: 'gmail.search',
  description: 'Search Gmail messages for the integration account.',
  inputSchema: GmailSearchInput,
  outputSchema: GmailSearchOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'q', input.query)
      appendNumberSearchParam(params, 'maxResults', input.maxResults)
      const query = params.toString()
      const url = `${googleGmailApiBaseUrl}/users/me/messages${query === '' ? '' : `?${query}`}`
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url,
          headers: googleAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return providerFailureFromResponse({
          code: 'gmail_search_failed',
          message: 'Gmail search failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GmailSearchOutput, response)
      return ActionResult.success(output)
    })
})

export const gmailGetMessageAction = defineAction({
  id: 'gmail.get_message',
  description: 'Get a Gmail message by id for the integration account.',
  inputSchema: GmailGetMessageInput,
  outputSchema: GmailMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'format', input.format)
      const query = params.toString()
      const url = `${googleGmailApiBaseUrl}/users/me/messages/${encodeURIComponent(input.id)}${query === '' ? '' : `?${query}`}`
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url,
          headers: googleAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return providerFailureFromResponse({
          code: 'gmail_get_message_failed',
          message: 'Gmail get message failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GmailMessageOutput, response)
      return ActionResult.success(output)
    })
})

export const gmailActions = [gmailSearchAction, gmailGetMessageAction]
