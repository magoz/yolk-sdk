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

export class GmailGetMessageInput extends Schema.Class<GmailGetMessageInput>(
  'GmailGetMessageInput'
)({
  id: Schema.String,
  format: Schema.optional(Schema.Literals(['minimal', 'full', 'raw', 'metadata']))
}) {}

export class GmailMessageIdInput extends Schema.Class<GmailMessageIdInput>('GmailMessageIdInput')({
  messageId: Schema.String
}) {}

export class GmailDraftIdInput extends Schema.Class<GmailDraftIdInput>('GmailDraftIdInput')({
  draftId: Schema.String
}) {}

export class GmailListInput extends Schema.Class<GmailListInput>('GmailListInput')({
  query: Schema.optional(Schema.String),
  labelId: Schema.optional(Schema.String),
  maxResults: Schema.optional(Schema.Number),
  pageToken: Schema.optional(Schema.String)
}) {}

export class GmailDraftComposeInput extends Schema.Class<GmailDraftComposeInput>(
  'GmailDraftComposeInput'
)({
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  cc: Schema.optional(Schema.Array(Schema.String)),
  bcc: Schema.optional(Schema.Array(Schema.String))
}) {}

export class GmailDraftReplyInput extends Schema.Class<GmailDraftReplyInput>(
  'GmailDraftReplyInput'
)({
  messageId: Schema.String,
  body: Schema.String
}) {}

export class GmailDraftUpdateInput extends Schema.Class<GmailDraftUpdateInput>(
  'GmailDraftUpdateInput'
)({
  draftId: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  cc: Schema.optional(Schema.Array(Schema.String)),
  bcc: Schema.optional(Schema.Array(Schema.String))
}) {}

export class GmailGetAttachmentInput extends Schema.Class<GmailGetAttachmentInput>(
  'GmailGetAttachmentInput'
)({
  messageId: Schema.String,
  attachmentId: Schema.String
}) {}

export class GmailModifyLabelsInput extends Schema.Class<GmailModifyLabelsInput>(
  'GmailModifyLabelsInput'
)({
  messageId: Schema.String,
  addLabelIds: Schema.optional(Schema.Array(Schema.String)),
  removeLabelIds: Schema.optional(Schema.Array(Schema.String))
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

export const GmailUnknownOutput = Schema.Unknown

const gmailProviderFailure = (code: string, message: string, status: number, body: string) =>
  providerFailureFromResponse({ code, message, status, body })

const gmailRequest = (input: {
  readonly token: string
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly body?: unknown
}) => {
  const headers =
    input.body === undefined
      ? googleAuthorizationHeaders(input.token)
      : { ...googleAuthorizationHeaders(input.token), 'content-type': 'application/json' }

  return ConnectorHttpRequest.make({
    method: input.method,
    url: `${googleGmailApiBaseUrl}${input.path}`,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  })
}

const rawEmail = (input: {
  readonly to: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
  readonly cc?: ReadonlyArray<string>
  readonly bcc?: ReadonlyArray<string>
  readonly from?: string
  readonly inReplyTo?: string
  readonly references?: string
}) => {
  const headers = [
    ...(input.from === undefined ? [] : [`From: ${input.from}`]),
    ...(input.to.length === 0 ? [] : [`To: ${input.to.join(', ')}`]),
    ...(input.cc === undefined ? [] : [`Cc: ${input.cc.join(', ')}`]),
    ...(input.bcc === undefined ? [] : [`Bcc: ${input.bcc.join(', ')}`]),
    `Subject: ${input.subject}`,
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: ${input.inReplyTo}`]),
    ...(input.references === undefined ? [] : [`References: ${input.references}`]),
    'Content-Type: text/plain; charset=utf-8'
  ]

  return base64UrlEncode(`${headers.join('\r\n')}\r\n\r\n${input.body}`)
}

const base64UrlEncode = (value: string) => {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const headerValue = (message: GmailMessageOutput, name: string) =>
  message.payload?.headers?.find(header => header.name.toLowerCase() === name.toLowerCase())?.value

const splitAddresses = (value: string | undefined) =>
  value === undefined
    ? []
    : value
        .split(',')
        .map(address => address.trim())
        .filter(address => address !== '')

const replySubject = (subject: string | undefined) => {
  if (subject === undefined || subject.trim() === '') {
    return 'Re:'
  }

  return subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`
}

const runGmailJsonAction = (
  integration: Parameters<typeof resolveGoogleAccessToken>[0],
  request: (token: string) => ConnectorHttpRequest,
  errorCode: string,
  errorMessage: string
) =>
  Effect.gen(function* () {
    const token = yield* resolveGoogleAccessToken(integration)
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(request(token))

    if (!isSuccessStatus(response.status)) {
      return gmailProviderFailure(errorCode, errorMessage, response.status, response.body)
    }

    const output = yield* decodeJsonResponse(GmailUnknownOutput, response)
    return ActionResult.success(output)
  })

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

export const gmailListAction = defineAction({
  id: 'gmail.list',
  description: 'List Gmail messages for the integration account.',
  inputSchema: GmailListInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token => {
        const params = new URLSearchParams()
        appendSearchParam(params, 'q', input.query)
        appendSearchParam(params, 'labelIds', input.labelId)
        appendNumberSearchParam(params, 'maxResults', input.maxResults)
        appendSearchParam(params, 'pageToken', input.pageToken)
        const query = params.toString()
        return gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/messages${query === '' ? '' : `?${query}`}`
        })
      },
      'gmail_list_failed',
      'Gmail list failed'
    )
})

export const gmailListDraftsAction = defineAction({
  id: 'gmail.list_drafts',
  description: 'List Gmail drafts for the integration account.',
  inputSchema: GmailListInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token => {
        const params = new URLSearchParams()
        appendNumberSearchParam(params, 'maxResults', input.maxResults)
        appendSearchParam(params, 'pageToken', input.pageToken)
        const query = params.toString()
        return gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/drafts${query === '' ? '' : `?${query}`}`
        })
      },
      'gmail_list_drafts_failed',
      'Gmail list drafts failed'
    )
})

export const gmailGetThreadAction = defineAction({
  id: 'gmail.get_thread',
  description: 'Get a Gmail thread by id.',
  inputSchema: Schema.Struct({ threadId: Schema.String }),
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/threads/${encodeURIComponent(input.threadId)}`
        }),
      'gmail_get_thread_failed',
      'Gmail get thread failed'
    )
})

export const gmailListLabelsAction = defineAction({
  id: 'gmail.list_labels',
  description: 'List Gmail labels.',
  inputSchema: Schema.Struct({}),
  outputSchema: GmailUnknownOutput,
  execute: ({ integration }) =>
    runGmailJsonAction(
      integration,
      token => gmailRequest({ token, method: 'GET', path: '/users/me/labels' }),
      'gmail_list_labels_failed',
      'Gmail list labels failed'
    )
})

export const gmailModifyLabelsAction = defineAction({
  id: 'gmail.modify_labels',
  description: 'Add or remove labels on a Gmail message.',
  inputSchema: GmailModifyLabelsInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'POST',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}/modify`,
          body: { addLabelIds: input.addLabelIds, removeLabelIds: input.removeLabelIds }
        }),
      'gmail_modify_labels_failed',
      'Gmail modify labels failed'
    )
})

export const gmailTrashAction = defineAction({
  id: 'gmail.trash',
  description: 'Move a Gmail message to trash.',
  inputSchema: GmailMessageIdInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'POST',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}/trash`
        }),
      'gmail_trash_failed',
      'Gmail trash failed'
    )
})

export const gmailUntrashAction = defineAction({
  id: 'gmail.untrash',
  description: 'Restore a Gmail message from trash.',
  inputSchema: GmailMessageIdInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'POST',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}/untrash`
        }),
      'gmail_untrash_failed',
      'Gmail untrash failed'
    )
})

export const gmailDraftComposeAction = defineAction({
  id: 'gmail.draft_compose',
  description: 'Create a Gmail draft message.',
  inputSchema: GmailDraftComposeInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'POST',
          path: '/users/me/drafts',
          body: { message: { raw: rawEmail(input) } }
        }),
      'gmail_draft_compose_failed',
      'Gmail draft compose failed'
    )
})

export const gmailDraftUpdateAction = defineAction({
  id: 'gmail.draft_update',
  description: 'Update a Gmail draft message.',
  inputSchema: GmailDraftUpdateInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'PUT',
          path: `/users/me/drafts/${encodeURIComponent(input.draftId)}`,
          body: { id: input.draftId, message: { raw: rawEmail(input) } }
        }),
      'gmail_draft_update_failed',
      'Gmail draft update failed'
    )
})

export const gmailDraftDeleteAction = defineAction({
  id: 'gmail.draft_delete',
  description: 'Delete a Gmail draft.',
  inputSchema: GmailDraftIdInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'DELETE',
          path: `/users/me/drafts/${encodeURIComponent(input.draftId)}`
        }),
      'gmail_draft_delete_failed',
      'Gmail draft delete failed'
    )
})

export const gmailDraftReplyAction = defineAction({
  id: 'gmail.draft_reply',
  description: 'Create a simple Gmail reply draft.',
  inputSchema: GmailDraftReplyInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration)
      const http = yield* ConnectorHttpClient
      const messageResponse = yield* http.request(
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}?format=metadata`
        })
      )

      if (!isSuccessStatus(messageResponse.status)) {
        return gmailProviderFailure(
          'gmail_draft_reply_failed',
          'Gmail draft reply failed',
          messageResponse.status,
          messageResponse.body
        )
      }

      const profileResponse = yield* http.request(
        gmailRequest({ token, method: 'GET', path: '/users/me/profile' })
      )

      if (!isSuccessStatus(profileResponse.status)) {
        return gmailProviderFailure(
          'gmail_draft_reply_failed',
          'Gmail draft reply failed',
          profileResponse.status,
          profileResponse.body
        )
      }

      const original = yield* decodeJsonResponse(GmailMessageOutput, messageResponse)
      const profile = yield* decodeJsonResponse(
        Schema.Struct({ emailAddress: Schema.optional(Schema.String) }),
        profileResponse
      )
      const ownEmail = profile.emailAddress?.toLowerCase()
      const recipients = splitAddresses(headerValue(original, 'From'))
        .concat(splitAddresses(headerValue(original, 'To')))
        .concat(splitAddresses(headerValue(original, 'Cc')))
        .filter(address => ownEmail === undefined || !address.toLowerCase().includes(ownEmail))
      const messageId = headerValue(original, 'Message-ID')
      const references = [headerValue(original, 'References'), messageId]
        .filter((value): value is string => value !== undefined && value.trim() !== '')
        .join(' ')
      const draftResponse = yield* http.request(
        gmailRequest({
          token,
          method: 'POST',
          path: '/users/me/drafts',
          body: {
            message: {
              threadId: original.threadId,
              raw: rawEmail({
                to: recipients,
                subject: replySubject(headerValue(original, 'Subject')),
                body: input.body,
                inReplyTo: messageId,
                references: references === '' ? undefined : references
              })
            }
          }
        })
      )

      if (!isSuccessStatus(draftResponse.status)) {
        return gmailProviderFailure(
          'gmail_draft_reply_failed',
          'Gmail draft reply failed',
          draftResponse.status,
          draftResponse.body
        )
      }

      const output = yield* decodeJsonResponse(GmailUnknownOutput, draftResponse)
      return ActionResult.success(output)
    })
})

export const gmailGetAttachmentAction = defineAction({
  id: 'gmail.get_attachment',
  description: 'Get a Gmail attachment by message and attachment id.',
  inputSchema: GmailGetAttachmentInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`
        }),
      'gmail_get_attachment_failed',
      'Gmail get attachment failed'
    )
})

export const gmailListAccountsAction = defineAction({
  id: 'gmail.list_accounts',
  description: 'List the configured Gmail account.',
  inputSchema: Schema.Struct({}),
  outputSchema: GmailUnknownOutput,
  execute: ({ integration }) =>
    Effect.succeed(
      ActionResult.success({
        accounts: [{ id: integration.id, connectorId: integration.connectorId }]
      })
    )
})

export const gmailActions = [
  gmailSearchAction,
  gmailListAction,
  gmailListDraftsAction,
  gmailGetMessageAction,
  gmailDraftReplyAction,
  gmailGetAttachmentAction,
  gmailDraftComposeAction,
  gmailDraftUpdateAction,
  gmailGetThreadAction,
  gmailListLabelsAction,
  gmailModifyLabelsAction,
  gmailTrashAction,
  gmailUntrashAction,
  gmailDraftDeleteAction,
  gmailListAccountsAction
]
