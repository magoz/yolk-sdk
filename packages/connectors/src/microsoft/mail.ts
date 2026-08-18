import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { optionalStringConfig } from '../config.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  MicrosoftOutlookReadOAuthCredentialSlot,
  MicrosoftOutlookSendOAuthCredentialSlot,
  MicrosoftOutlookSharedReadOAuthCredentialSlot,
  MicrosoftOutlookSharedSendOAuthCredentialSlot,
  MicrosoftOutlookSharedWriteOAuthCredentialSlot,
  MicrosoftOutlookWriteOAuthCredentialSlot
} from './oauth.ts'
import {
  isMicrosoftSuccessStatus,
  microsoftProviderFailure,
  resolveMicrosoftAccessToken
} from './shared.ts'

export const microsoftGraphApiBaseUrl = 'https://graph.microsoft.com/v1.0'
export const microsoftMailboxAccessModeConfigKey = 'mailboxAccessMode'
export const MicrosoftMailboxAccessMode = Schema.Literals(['delegated', 'application'])
export type MicrosoftMailboxAccessMode = typeof MicrosoftMailboxAccessMode.Type

const OutlookPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))

const outlookListSelect = [
  'id',
  'subject',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'isRead',
  'isDraft',
  'importance',
  'conversationId',
  'internetMessageId',
  'webLink'
].join(',')

const outlookMessageSelect = [
  outlookListSelect,
  'body',
  'bccRecipients',
  'replyTo',
  'categories',
  'parentFolderId',
  'sender'
].join(',')

export class OutlookEmailAddress extends Schema.Class<OutlookEmailAddress>('OutlookEmailAddress')({
  address: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String))
}) {}

export class OutlookRecipient extends Schema.Class<OutlookRecipient>('OutlookRecipient')({
  emailAddress: OutlookEmailAddress
}) {}

export class OutlookMessageBody extends Schema.Class<OutlookMessageBody>('OutlookMessageBody')({
  contentType: Schema.Literals(['text', 'html']),
  content: Schema.String
}) {}

export class OutlookMessage extends Schema.Class<OutlookMessage>('OutlookMessage')({
  id: Schema.String,
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  bodyPreview: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(OutlookMessageBody)),
  sender: Schema.optional(Schema.NullOr(OutlookRecipient)),
  from: Schema.optional(Schema.NullOr(OutlookRecipient)),
  toRecipients: Schema.optional(Schema.Array(OutlookRecipient)),
  ccRecipients: Schema.optional(Schema.Array(OutlookRecipient)),
  bccRecipients: Schema.optional(Schema.Array(OutlookRecipient)),
  replyTo: Schema.optional(Schema.Array(OutlookRecipient)),
  receivedDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  sentDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  hasAttachments: Schema.optional(Schema.Boolean),
  isRead: Schema.optional(Schema.Boolean),
  isDraft: Schema.optional(Schema.Boolean),
  importance: Schema.optional(Schema.String),
  conversationId: Schema.optional(Schema.NullOr(Schema.String)),
  internetMessageId: Schema.optional(Schema.NullOr(Schema.String)),
  parentFolderId: Schema.optional(Schema.String),
  categories: Schema.optional(Schema.Array(Schema.String)),
  webLink: Schema.optional(Schema.String)
}) {}

export class OutlookListMessagesInput extends Schema.Class<OutlookListMessagesInput>(
  'OutlookListMessagesInput'
)({
  mailbox: Schema.optional(Schema.String),
  folderId: Schema.optional(Schema.String),
  top: Schema.optional(OutlookPageSize),
  filter: Schema.optional(Schema.String),
  orderBy: Schema.optional(Schema.String),
  nextLink: Schema.optional(Schema.String)
}) {}

export class OutlookSearchMessagesInput extends Schema.Class<OutlookSearchMessagesInput>(
  'OutlookSearchMessagesInput'
)({
  query: Schema.String,
  mailbox: Schema.optional(Schema.String),
  folderId: Schema.optional(Schema.String),
  top: Schema.optional(OutlookPageSize),
  nextLink: Schema.optional(Schema.String)
}) {}

export class OutlookListMessagesOutput extends Schema.Class<OutlookListMessagesOutput>(
  'OutlookListMessagesOutput'
)({
  messages: Schema.Array(OutlookMessage),
  nextLink: Schema.optional(Schema.String)
}) {}

const OutlookMessagesApiOutput = Schema.Struct({
  value: Schema.Array(OutlookMessage),
  '@odata.nextLink': Schema.optional(Schema.String)
})

export class OutlookMessageIdInput extends Schema.Class<OutlookMessageIdInput>(
  'OutlookMessageIdInput'
)({
  messageId: Schema.String,
  mailbox: Schema.optional(Schema.String)
}) {}

export class OutlookComposeInput extends Schema.Class<OutlookComposeInput>('OutlookComposeInput')({
  mailbox: Schema.optional(Schema.String),
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  contentType: Schema.optional(Schema.Literals(['text', 'html'])),
  cc: Schema.optional(Schema.Array(Schema.String)),
  bcc: Schema.optional(Schema.Array(Schema.String))
}) {}

export class OutlookCreateReplyDraftInput extends Schema.Class<OutlookCreateReplyDraftInput>(
  'OutlookCreateReplyDraftInput'
)({
  messageId: Schema.String,
  mailbox: Schema.optional(Schema.String),
  body: Schema.String,
  contentType: Schema.optional(Schema.Literals(['text', 'html']))
}) {}

export class OutlookSendMailInput extends Schema.Class<OutlookSendMailInput>(
  'OutlookSendMailInput'
)({
  mailbox: Schema.optional(Schema.String),
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  contentType: Schema.optional(Schema.Literals(['text', 'html'])),
  cc: Schema.optional(Schema.Array(Schema.String)),
  bcc: Schema.optional(Schema.Array(Schema.String)),
  saveToSentItems: Schema.optional(Schema.Boolean)
}) {}

export class OutlookSendOutput extends Schema.Class<OutlookSendOutput>('OutlookSendOutput')({
  accepted: Schema.Boolean
}) {}

const outlookContentType = (contentType: 'text' | 'html' | undefined) =>
  contentType === 'html' ? 'HTML' : 'Text'

const outlookRecipients = (addresses: ReadonlyArray<string>) =>
  addresses.map(address => ({ emailAddress: { address } }))

const outlookMessageBody = (input: OutlookComposeInput | OutlookSendMailInput) => ({
  subject: input.subject,
  body: {
    contentType: outlookContentType(input.contentType),
    content: input.body
  },
  toRecipients: outlookRecipients(input.to),
  ...(input.mailbox === undefined ? {} : { from: { emailAddress: { address: input.mailbox } } }),
  ...(input.cc === undefined ? {} : { ccRecipients: outlookRecipients(input.cc) }),
  ...(input.bcc === undefined ? {} : { bccRecipients: outlookRecipients(input.bcc) })
})

const outlookReadHeaders = (token: string, includeBody: boolean) => ({
  ...microsoftAuthorizationHeaders(token),
  accept: 'application/json',
  prefer: includeBody
    ? 'IdType="ImmutableId", outlook.body-content-type="text"'
    : 'IdType="ImmutableId"'
})

const outlookWriteHeaders = (token: string) => ({
  ...microsoftAuthorizationHeaders(token),
  accept: 'application/json',
  'content-type': 'application/json'
})

const outlookDraftWriteHeaders = (token: string) => ({
  ...outlookWriteHeaders(token),
  prefer: 'IdType="ImmutableId"'
})

const outlookMailboxPath = (mailbox: string | undefined) =>
  mailbox === undefined ? '/me' : `/users/${encodeURIComponent(mailbox)}`

const invalidNextLink = (actionId: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Microsoft Graph nextLink must target a message collection in the selected v1.0 mailbox',
    connectorId: microsoftConnectorId,
    actionId
  })

const requireMicrosoftNextLink = (
  nextLink: string,
  actionId: string,
  mailbox: string | undefined
) => {
  if (!URL.canParse(nextLink)) return Effect.fail(invalidNextLink(actionId))

  const parsed = new URL(nextLink)
  const mailboxRoot = `/v1.0${outlookMailboxPath(mailbox)}`
  const directMessagesPath = `${mailboxRoot}/messages`
  const folderMessagesPrefix = `${mailboxRoot}/mailFolders/`
  const isSelectedMailCollection =
    parsed.pathname === directMessagesPath ||
    (parsed.pathname.startsWith(folderMessagesPrefix) && parsed.pathname.endsWith('/messages'))
  const isGraphV1Url =
    parsed.protocol === 'https:' &&
    parsed.hostname === 'graph.microsoft.com' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''

  return isGraphV1Url && isSelectedMailCollection
    ? Effect.succeed(nextLink)
    : Effect.fail(invalidNextLink(actionId))
}

const outlookMessagesPath = (mailbox: string | undefined, folderId: string | undefined) => {
  const mailboxPath = outlookMailboxPath(mailbox)
  return folderId === undefined
    ? `${mailboxPath}/messages`
    : `${mailboxPath}/mailFolders/${encodeURIComponent(folderId)}/messages`
}

const mailboxAccessMode = (integration: ConnectorIntegration) => {
  const configured = optionalStringConfig(integration, microsoftMailboxAccessModeConfigKey)
  if (configured === undefined) return Effect.succeed<MicrosoftMailboxAccessMode>('delegated')

  return Schema.decodeUnknownEffect(MicrosoftMailboxAccessMode)(configured).pipe(
    Effect.mapError(
      error =>
        new ConnectorError({
          cause: 'validation_failed',
          message: `Invalid integration config: ${microsoftMailboxAccessModeConfigKey}`,
          connectorId: integration.connectorId,
          underlying: error
        })
    )
  )
}

const requireMailboxForApplicationAccess = (
  integration: ConnectorIntegration,
  mailbox: string | undefined,
  accessMode: MicrosoftMailboxAccessMode
) =>
  accessMode !== 'application' || mailbox !== undefined
    ? Effect.void
    : Effect.fail(
        new ConnectorError({
          cause: 'validation_failed',
          message: 'Microsoft application mailbox access requires an explicit mailbox',
          connectorId: integration.connectorId
        })
      )

const outlookReadSlot = (integration: ConnectorIntegration, mailbox: string | undefined) =>
  Effect.gen(function* () {
    const accessMode = yield* mailboxAccessMode(integration)
    yield* requireMailboxForApplicationAccess(integration, mailbox, accessMode)
    return mailbox === undefined || accessMode === 'application'
      ? MicrosoftOutlookReadOAuthCredentialSlot
      : MicrosoftOutlookSharedReadOAuthCredentialSlot
  })

const outlookWriteSlot = (integration: ConnectorIntegration, mailbox: string | undefined) =>
  Effect.gen(function* () {
    const accessMode = yield* mailboxAccessMode(integration)
    yield* requireMailboxForApplicationAccess(integration, mailbox, accessMode)
    return mailbox === undefined || accessMode === 'application'
      ? MicrosoftOutlookWriteOAuthCredentialSlot
      : MicrosoftOutlookSharedWriteOAuthCredentialSlot
  })

const outlookSendSlot = (integration: ConnectorIntegration, mailbox: string | undefined) =>
  Effect.gen(function* () {
    const accessMode = yield* mailboxAccessMode(integration)
    yield* requireMailboxForApplicationAccess(integration, mailbox, accessMode)
    return mailbox === undefined || accessMode === 'application'
      ? MicrosoftOutlookSendOAuthCredentialSlot
      : MicrosoftOutlookSharedSendOAuthCredentialSlot
  })

const outlookListUrl = (input: OutlookListMessagesInput) => {
  if (input.nextLink !== undefined) {
    return requireMicrosoftNextLink(input.nextLink, 'outlook.list_messages', input.mailbox)
  }

  const params = new URLSearchParams()
  params.set('$select', outlookListSelect)
  if (input.top !== undefined) params.set('$top', String(input.top))
  if (input.filter !== undefined && input.filter.trim() !== '') params.set('$filter', input.filter)
  if (input.orderBy !== undefined && input.orderBy.trim() !== '') {
    params.set('$orderby', input.orderBy)
  }
  return Effect.succeed(
    `${microsoftGraphApiBaseUrl}${outlookMessagesPath(input.mailbox, input.folderId)}?${params.toString()}`
  )
}

const escapedSearchQuery = (query: string) => query.replaceAll('\\', '\\\\').replaceAll('"', '\\"')

const outlookSearchUrl = (input: OutlookSearchMessagesInput) => {
  if (input.nextLink !== undefined) {
    return requireMicrosoftNextLink(input.nextLink, 'outlook.search_messages', input.mailbox)
  }

  const params = new URLSearchParams()
  params.set('$search', `"${escapedSearchQuery(input.query)}"`)
  params.set('$select', outlookListSelect)
  if (input.top !== undefined) params.set('$top', String(input.top))
  return Effect.succeed(
    `${microsoftGraphApiBaseUrl}${outlookMessagesPath(input.mailbox, input.folderId)}?${params.toString()}`
  )
}

const outlookMessagesAction = (input: {
  readonly integration: ConnectorIntegration
  readonly url: Effect.Effect<string, ConnectorError>
  readonly mailbox: string | undefined
  readonly errorCode: string
  readonly errorMessage: string
}) =>
  Effect.gen(function* () {
    const slot = yield* outlookReadSlot(input.integration, input.mailbox)
    const token = yield* resolveMicrosoftAccessToken(input.integration, slot)
    const url = yield* input.url
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url,
        headers: outlookReadHeaders(token, false)
      })
    )

    if (!isMicrosoftSuccessStatus(response.status)) {
      return yield* microsoftProviderFailure({
        code: input.errorCode,
        message: input.errorMessage,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    const output = yield* decodeJsonResponse(OutlookMessagesApiOutput, response)
    return ActionResult.success(
      OutlookListMessagesOutput.make({
        messages: output.value,
        ...(output['@odata.nextLink'] === undefined ? {} : { nextLink: output['@odata.nextLink'] })
      })
    )
  })

export const outlookListMessagesAction = defineAction({
  id: 'outlook.list_messages',
  description: 'List messages in a Microsoft Outlook mailbox or one mail folder.',
  inputSchema: OutlookListMessagesInput,
  outputSchema: OutlookListMessagesOutput,
  execute: ({ integration, input }) =>
    outlookMessagesAction({
      integration,
      url: outlookListUrl(input),
      mailbox: input.mailbox,
      errorCode: 'outlook_list_messages_failed',
      errorMessage: 'Microsoft Outlook list messages failed'
    })
})

export const outlookSearchMessagesAction = defineAction({
  id: 'outlook.search_messages',
  description: 'Search a Microsoft Outlook mailbox with the Microsoft Graph mail search syntax.',
  inputSchema: OutlookSearchMessagesInput,
  outputSchema: OutlookListMessagesOutput,
  execute: ({ integration, input }) =>
    outlookMessagesAction({
      integration,
      url: outlookSearchUrl(input),
      mailbox: input.mailbox,
      errorCode: 'outlook_search_messages_failed',
      errorMessage: 'Microsoft Outlook search messages failed'
    })
})

export const outlookGetMessageAction = defineAction({
  id: 'outlook.get_message',
  description: 'Get one Microsoft Outlook message with its body normalized to text.',
  inputSchema: OutlookMessageIdInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookReadSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams({ $select: outlookMessageSelect })
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/messages/${encodeURIComponent(input.messageId)}?${params.toString()}`,
          headers: outlookReadHeaders(token, true)
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_get_message_failed',
          message: 'Microsoft Outlook get message failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OutlookMessage, response)
      return ActionResult.success(output)
    })
})

export const outlookCreateDraftAction = defineAction({
  id: 'outlook.create_draft',
  description: 'Create a new Microsoft Outlook message draft.',
  inputSchema: OutlookComposeInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookWriteSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/messages`,
          headers: outlookDraftWriteHeaders(token),
          body: JSON.stringify(outlookMessageBody(input))
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_create_draft_failed',
          message: 'Microsoft Outlook create draft failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OutlookMessage, response)
      return ActionResult.success(output)
    })
})

export const outlookCreateReplyDraftAction = defineAction({
  id: 'outlook.create_reply_draft',
  description: 'Create a Microsoft Outlook reply draft for an existing message.',
  inputSchema: OutlookCreateReplyDraftInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookWriteSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/messages/${encodeURIComponent(input.messageId)}/createReply`,
          headers: outlookDraftWriteHeaders(token),
          body: JSON.stringify({
            message: {
              body: {
                contentType: outlookContentType(input.contentType),
                content: input.body
              }
            }
          })
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_create_reply_draft_failed',
          message: 'Microsoft Outlook create reply draft failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OutlookMessage, response)
      return ActionResult.success(output)
    })
})

export const outlookSendMailAction = defineAction({
  id: 'outlook.send_mail',
  description: 'Submit a new Microsoft Outlook message for sending.',
  inputSchema: OutlookSendMailInput,
  outputSchema: OutlookSendOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookSendSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/sendMail`,
          headers: outlookWriteHeaders(token),
          body: JSON.stringify({
            message: outlookMessageBody(input),
            ...(input.saveToSentItems === undefined
              ? {}
              : { saveToSentItems: input.saveToSentItems })
          })
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_send_mail_failed',
          message: 'Microsoft Outlook send mail failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      return ActionResult.success(OutlookSendOutput.make({ accepted: true }))
    })
})

export const outlookSendDraftAction = defineAction({
  id: 'outlook.send_draft',
  description: 'Submit an existing Microsoft Outlook draft for sending.',
  inputSchema: OutlookMessageIdInput,
  outputSchema: OutlookSendOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookSendSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/messages/${encodeURIComponent(input.messageId)}/send`,
          headers: microsoftAuthorizationHeaders(token)
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_send_draft_failed',
          message: 'Microsoft Outlook send draft failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      return ActionResult.success(OutlookSendOutput.make({ accepted: true }))
    })
})

export const outlookMailActions = [
  outlookListMessagesAction,
  outlookSearchMessagesAction,
  outlookGetMessageAction,
  outlookCreateDraftAction,
  outlookCreateReplyDraftAction,
  outlookSendMailAction,
  outlookSendDraftAction
]
