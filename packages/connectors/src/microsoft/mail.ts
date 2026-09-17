import { Chunk, Effect, Match, Predicate, SchemaTransformation } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { optionalStringConfig } from '../config.ts'
import { resolveCredential } from '../credential.ts'
import type { RuntimeCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  MicrosoftOAuthCredentialSlot,
  MicrosoftOutlookReadOAuthCredentialSlot,
  MicrosoftOutlookSendOAuthCredentialSlot,
  MicrosoftOutlookSharedReadOAuthCredentialSlot,
  MicrosoftOutlookSharedSendOAuthCredentialSlot,
  MicrosoftOutlookSharedWriteOAuthCredentialSlot,
  MicrosoftOutlookWriteOAuthCredentialSlot
} from './oauth.ts'
import {
  isMicrosoftSuccessStatus,
  microsoftGraphApiBaseUrl,
  microsoftProviderFailure,
  resolveMicrosoftAccessToken
} from './shared.ts'

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

const outlookAttachmentSelect = [
  'id',
  'name',
  'contentType',
  'size',
  'isInline',
  'lastModifiedDateTime'
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

// Models use null/blank placeholders for absent read options. Normalize at
// decoding, not in URL construction; never trim or rewrite a real cursor.
const OptionalOutlookReadString = Schema.optional(
  Schema.NullOr(Schema.String).pipe(
    Schema.decodeTo(
      Schema.UndefinedOr(Schema.String),
      SchemaTransformation.transform({
        decode: value => (value === null || value.trim() === '' ? undefined : value),
        encode: value => value ?? null
      })
    )
  )
)

const OptionalOutlookPageSize = Schema.optional(
  Schema.NullOr(OutlookPageSize).pipe(
    Schema.decodeTo(
      Schema.UndefinedOr(OutlookPageSize),
      SchemaTransformation.transform({
        decode: value => value ?? undefined,
        encode: value => value ?? null
      })
    )
  )
)

const outlookReadPaginationFields = {
  mailbox: OptionalOutlookReadString.annotate({
    description: 'Mailbox address or ID. Omit or use null for the connected user.'
  }),
  folderId: OptionalOutlookReadString.annotate({
    description: 'Folder ID or well-known name. Omit or use null to read the entire mailbox.'
  }),
  top: OptionalOutlookPageSize,
  nextLink: OptionalOutlookReadString.annotate({
    description:
      'Omit or use null for the first page. For another page, copy nextLink from the previous result unchanged and keep the same mailbox and folderId. Do not invent a URL.'
  })
}

export class OutlookListMessagesInput extends Schema.Class<OutlookListMessagesInput>(
  'OutlookListMessagesInput'
)({
  ...outlookReadPaginationFields,
  filter: OptionalOutlookReadString,
  orderBy: OptionalOutlookReadString
}) {}

export class OutlookSearchMessagesInput extends Schema.Class<OutlookSearchMessagesInput>(
  'OutlookSearchMessagesInput'
)({
  query: Schema.String,
  ...outlookReadPaginationFields
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

const OutlookNonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())

export class OutlookSetReadInput extends Schema.Class<OutlookSetReadInput>('OutlookSetReadInput')({
  messageId: OutlookNonEmptyString,
  mailbox: Schema.optional(OutlookNonEmptyString),
  isRead: Schema.Boolean
}) {}

export class OutlookTrashInput extends Schema.Class<OutlookTrashInput>('OutlookTrashInput')({
  messageId: OutlookNonEmptyString,
  mailbox: Schema.optional(OutlookNonEmptyString)
}) {}

export class OutlookUntrashInput extends Schema.Class<OutlookUntrashInput>('OutlookUntrashInput')({
  messageId: OutlookNonEmptyString,
  mailbox: Schema.optional(OutlookNonEmptyString),
  destinationFolderId: Schema.optional(OutlookNonEmptyString)
}) {}

export const OutlookAttachmentKind = Schema.Literals(['file', 'item', 'reference', 'unknown'])

export type OutlookAttachmentKind = typeof OutlookAttachmentKind.Type

const OutlookAttachmentSize = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

const OutlookAttachmentBase64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
)

export class OutlookAttachmentMetadata extends Schema.Class<OutlookAttachmentMetadata>(
  'OutlookAttachmentMetadata'
)({
  id: Schema.String,
  kind: OutlookAttachmentKind,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  contentType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(OutlookAttachmentSize),
  isInline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.NullOr(Schema.String)),
  lastModifiedDateTime: Schema.optional(Schema.NullOr(Schema.String))
}) {}

export class OutlookListAttachmentsInput extends Schema.Class<OutlookListAttachmentsInput>(
  'OutlookListAttachmentsInput'
)({
  messageId: Schema.String,
  mailbox: Schema.optional(Schema.String),
  top: Schema.optional(OutlookPageSize),
  nextLink: Schema.optional(Schema.String)
}) {}

export class OutlookListAttachmentsOutput extends Schema.Class<OutlookListAttachmentsOutput>(
  'OutlookListAttachmentsOutput'
)({
  attachments: Schema.Chunk(OutlookAttachmentMetadata),
  nextLink: Schema.optional(Schema.String)
}) {}

export class OutlookGetAttachmentInput extends Schema.Class<OutlookGetAttachmentInput>(
  'OutlookGetAttachmentInput'
)({
  messageId: Schema.String,
  attachmentId: Schema.String,
  mailbox: Schema.optional(Schema.String)
}) {}

export class OutlookAttachment extends Schema.Class<OutlookAttachment>('OutlookAttachment')({
  id: Schema.String,
  kind: Schema.Literal('file'),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  contentType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(OutlookAttachmentSize),
  isInline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.NullOr(Schema.String)),
  lastModifiedDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  contentBase64: OutlookAttachmentBase64
}) {}

export class OutlookGetAttachmentOutput extends Schema.Class<OutlookGetAttachmentOutput>(
  'OutlookGetAttachmentOutput'
)({
  attachment: OutlookAttachment
}) {}

const OutlookAttachmentApi = Schema.Struct({
  '@odata.type': Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  contentType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(OutlookAttachmentSize),
  isInline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.NullOr(Schema.String)),
  lastModifiedDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  contentBytes: Schema.optional(Schema.String)
})

const OutlookFileAttachmentApi = Schema.Struct({
  '@odata.type': Schema.Literal('#microsoft.graph.fileAttachment'),
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  contentType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(OutlookAttachmentSize),
  isInline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.NullOr(Schema.String)),
  lastModifiedDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  contentBytes: OutlookAttachmentBase64
})

const OutlookAttachmentsApiOutput = Schema.Struct({
  value: Schema.Array(OutlookAttachmentApi),
  '@odata.nextLink': Schema.optional(Schema.String)
})

const outlookAttachmentKind = (
  odataType: string | undefined
): typeof OutlookAttachmentKind.Type => {
  switch (odataType) {
    case '#microsoft.graph.fileAttachment':
      return 'file'
    case '#microsoft.graph.itemAttachment':
      return 'item'
    case '#microsoft.graph.referenceAttachment':
      return 'reference'
    default:
      return 'unknown'
  }
}

type OutlookAttachmentMetadataFields = {
  readonly id: string
  readonly kind: OutlookAttachmentKind
  name?: string | null
  contentType?: string | null
  size?: number
  isInline?: boolean
  contentId?: string | null
  lastModifiedDateTime?: string | null
}

type OutlookFileAttachmentFields = {
  readonly id: string
  readonly kind: 'file'
  name?: string | null
  contentType?: string | null
  size?: number
  isInline?: boolean
  contentId?: string | null
  lastModifiedDateTime?: string | null
}

const outlookAttachmentMetadata = (
  attachment: typeof OutlookAttachmentApi.Type
): OutlookAttachmentMetadata =>
  OutlookAttachmentMetadata.make(
    (() => {
      const fields: OutlookAttachmentMetadataFields = {
        id: attachment.id,
        kind: outlookAttachmentKind(attachment['@odata.type'])
      }

      if (attachment.name !== undefined) {
        fields.name = attachment.name
      }

      if (attachment.contentType !== undefined) {
        fields.contentType = attachment.contentType
      }

      if (attachment.size !== undefined) {
        fields.size = attachment.size
      }

      if (attachment.isInline !== undefined) {
        fields.isInline = attachment.isInline
      }

      if (attachment.contentId !== undefined) {
        fields.contentId = attachment.contentId
      }

      if (attachment.lastModifiedDateTime !== undefined) {
        fields.lastModifiedDateTime = attachment.lastModifiedDateTime
      }

      return fields
    })()
  )

const outlookAttachment = (attachment: typeof OutlookFileAttachmentApi.Type): OutlookAttachment =>
  OutlookAttachment.make(
    (() => {
      const fields: OutlookFileAttachmentFields = {
        id: attachment.id,
        kind: 'file'
      }

      if (attachment.name !== undefined) {
        fields.name = attachment.name
      }

      if (attachment.contentType !== undefined) {
        fields.contentType = attachment.contentType
      }

      if (attachment.size !== undefined) {
        fields.size = attachment.size
      }

      if (attachment.isInline !== undefined) {
        fields.isInline = attachment.isInline
      }

      if (attachment.contentId !== undefined) {
        fields.contentId = attachment.contentId
      }

      if (attachment.lastModifiedDateTime !== undefined) {
        fields.lastModifiedDateTime = attachment.lastModifiedDateTime
      }

      return { ...fields, contentBase64: attachment.contentBytes }
    })()
  )

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

type OutlookGraphRecipientFields = {
  readonly emailAddress: {
    readonly address: string
  }
}

type OutlookGraphMessageBodyFields = {
  readonly contentType: 'HTML' | 'Text'
  readonly content: string
}

type OutlookGraphMessageFields = {
  readonly subject: string
  readonly body: OutlookGraphMessageBodyFields
  readonly toRecipients: ReadonlyArray<OutlookGraphRecipientFields>
  from?: {
    readonly emailAddress: {
      readonly address: string
    }
  }
  ccRecipients?: ReadonlyArray<OutlookGraphRecipientFields>
  bccRecipients?: ReadonlyArray<OutlookGraphRecipientFields>
}

const outlookMessageBody = (
  input: OutlookComposeInput | OutlookSendMailInput
): OutlookGraphMessageFields => {
  const message: OutlookGraphMessageFields = {
    subject: input.subject,
    body: {
      contentType: outlookContentType(input.contentType),
      content: input.body
    },
    toRecipients: outlookRecipients(input.to)
  }

  if (input.mailbox !== undefined) {
    message.from = { emailAddress: { address: input.mailbox } }
  }

  if (input.cc !== undefined) {
    message.ccRecipients = outlookRecipients(input.cc)
  }

  if (input.bcc !== undefined) {
    message.bccRecipients = outlookRecipients(input.bcc)
  }

  return message
}

type OutlookSendMailPayloadFields = {
  readonly message: OutlookGraphMessageFields
  saveToSentItems?: boolean
}

type OutlookListMessagesOutputFields = {
  readonly messages: ReadonlyArray<OutlookMessage>
  nextLink?: string
}

type OutlookListAttachmentsOutputFields = {
  readonly attachments: Chunk.Chunk<OutlookAttachmentMetadata>
  nextLink?: string
}

const outlookReadHeaders = (
  token: string,
  includeBody: boolean,
  bodyContentType: 'text' | 'html' = 'text'
) => ({
  ...microsoftAuthorizationHeaders(token),
  accept: 'application/json',
  prefer: includeBody
    ? `IdType="ImmutableId", outlook.body-content-type="${bodyContentType}"`
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

const outlookDraftPostHeaders = (token: string) => ({
  ...microsoftAuthorizationHeaders(token),
  accept: 'application/json',
  prefer: 'IdType="ImmutableId"'
})

const outlookMailboxPath = (mailbox: string | undefined) =>
  mailbox === undefined ? '/me' : `/users/${encodeURIComponent(mailbox)}`

const invalidNextLink = (
  actionId: string,
  collection:
    | 'mailbox folder collection'
    | 'message attachment collection' = 'mailbox folder collection'
) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: `Microsoft Graph nextLink must target the selected v1.0 ${collection}`,
    connectorId: microsoftConnectorId,
    actionId
  })

const requireMicrosoftNextLink = (
  nextLink: string,
  actionId: string,
  mailbox: string | undefined,
  folderId: string | undefined
) => {
  if (!URL.canParse(nextLink)) return Effect.fail(invalidNextLink(actionId))

  const parsed = new URL(nextLink)
  const mailboxRoot = `/v1.0${outlookMailboxPath(mailbox)}`

  const selectedMessagesPath =
    folderId === undefined
      ? `${mailboxRoot}/messages`
      : `${mailboxRoot}/mailFolders/${encodeURIComponent(folderId)}/messages`

  const isGraphV1Url =
    parsed.protocol === 'https:' &&
    parsed.hostname === 'graph.microsoft.com' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''

  return isGraphV1Url && parsed.pathname === selectedMessagesPath
    ? Effect.succeed(nextLink)
    : Effect.fail(invalidNextLink(actionId))
}

const requireMicrosoftAttachmentNextLink = (
  nextLink: string,
  mailbox: string | undefined,
  messageId: string
) => {
  if (!URL.canParse(nextLink)) {
    return Effect.fail(invalidNextLink('outlook.list_attachments', 'message attachment collection'))
  }

  const parsed = new URL(nextLink)
  const selectedAttachmentsPath = `/v1.0${outlookMailboxPath(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`

  const isGraphV1Url =
    parsed.protocol === 'https:' &&
    parsed.hostname === 'graph.microsoft.com' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''

  return isGraphV1Url && parsed.pathname === selectedAttachmentsPath
    ? Effect.succeed(nextLink)
    : Effect.fail(invalidNextLink('outlook.list_attachments', 'message attachment collection'))
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

// Preserve whitespace just like the /users path; only case is insignificant.
const normalizeMailboxIdentity = (mailbox: string) => mailbox.toLowerCase()

const isOwnMailboxCredential = (mailbox: string, credential: RuntimeCredential) =>
  Match.value(credential).pipe(
    Match.tag('OAuthCredential', oauth => {
      const accountId = oauth.accountId

      if (accountId === undefined) return false

      const normalizedAccountId = normalizeMailboxIdentity(accountId)

      return normalizedAccountId !== '' && normalizedAccountId === normalizeMailboxIdentity(mailbox)
    }),
    Match.orElse(() => false)
  )

const outlookPermissionSlots = {
  read: {
    ordinary: MicrosoftOutlookReadOAuthCredentialSlot,
    shared: MicrosoftOutlookSharedReadOAuthCredentialSlot
  },
  write: {
    ordinary: MicrosoftOutlookWriteOAuthCredentialSlot,
    shared: MicrosoftOutlookSharedWriteOAuthCredentialSlot
  },
  send: {
    ordinary: MicrosoftOutlookSendOAuthCredentialSlot,
    shared: MicrosoftOutlookSharedSendOAuthCredentialSlot
  }
}

type OutlookPermissionKind = keyof typeof outlookPermissionSlots

const outlookSlotFor = (
  kind: OutlookPermissionKind,
  integration: ConnectorIntegration,
  mailbox: string | undefined
) =>
  Effect.gen(function* () {
    const accessMode = yield* mailboxAccessMode(integration)
    yield* requireMailboxForApplicationAccess(integration, mailbox, accessMode)

    const slots = outlookPermissionSlots[kind]

    if (mailbox === undefined || accessMode === 'application') return slots.ordinary

    // Delegated access to an explicit mailbox is shared access unless the
    // credential identifies the mailbox as the connected user. Identity
    // resolution uses the scope-free binding slot and never authorizes the
    // operation itself; the selected operation slot still enforces its scopes.
    const credential = yield* resolveCredential(integration, MicrosoftOAuthCredentialSlot).pipe(
      Effect.mapError(
        error =>
          new ConnectorError({
            cause: error.cause,
            message: error.message,
            connectorId: integration.connectorId,
            slotId: MicrosoftOAuthCredentialSlot.id
          })
      )
    )

    return isOwnMailboxCredential(mailbox, credential) ? slots.ordinary : slots.shared
  })

export const outlookReadSlot = (integration: ConnectorIntegration, mailbox: string | undefined) =>
  outlookSlotFor('read', integration, mailbox)

const outlookWriteSlot = (integration: ConnectorIntegration, mailbox: string | undefined) =>
  outlookSlotFor('write', integration, mailbox)

const outlookSendSlot = (integration: ConnectorIntegration, mailbox: string | undefined) =>
  outlookSlotFor('send', integration, mailbox)

const outlookListUrl = (input: OutlookListMessagesInput) => {
  if (input.nextLink !== undefined) {
    return requireMicrosoftNextLink(
      input.nextLink,
      'outlook.list_messages',
      input.mailbox,
      input.folderId
    )
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
    return requireMicrosoftNextLink(
      input.nextLink,
      'outlook.search_messages',
      input.mailbox,
      input.folderId
    )
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
      OutlookListMessagesOutput.make(
        (() => {
          const fields: OutlookListMessagesOutputFields = {
            messages: output.value
          }

          if (output['@odata.nextLink'] !== undefined) {
            fields.nextLink = output['@odata.nextLink']
          }

          return fields
        })()
      )
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

export const outlookListAttachmentsAction = defineAction({
  id: 'outlook.list_attachments',
  description: 'List attachment metadata for one Microsoft Outlook message.',
  inputSchema: OutlookListAttachmentsInput,
  outputSchema: OutlookListAttachmentsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookReadSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient

      const url = yield* (() => {
        if (input.nextLink !== undefined) {
          return requireMicrosoftAttachmentNextLink(input.nextLink, input.mailbox, input.messageId)
        }

        const params = new URLSearchParams({ $select: outlookAttachmentSelect })

        if (input.top !== undefined) params.set('$top', String(input.top))

        return Effect.succeed(
          `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/messages/${encodeURIComponent(input.messageId)}/attachments?${params.toString()}`
        )
      })()

      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url,
          headers: outlookReadHeaders(token, false)
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_list_attachments_failed',
          message: 'Microsoft Outlook list attachments failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OutlookAttachmentsApiOutput, response)

      return ActionResult.success(
        OutlookListAttachmentsOutput.make(
          (() => {
            const fields: OutlookListAttachmentsOutputFields = {
              attachments: Chunk.fromIterable(output.value.map(outlookAttachmentMetadata))
            }

            if (output['@odata.nextLink'] !== undefined) {
              fields.nextLink = output['@odata.nextLink']
            }

            return fields
          })()
        )
      )
    })
})

export const outlookGetAttachmentAction = defineAction({
  id: 'outlook.get_attachment',
  description: 'Get one Microsoft Outlook file attachment with base64 content.',
  inputSchema: OutlookGetAttachmentInput,
  outputSchema: OutlookGetAttachmentOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookReadSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${microsoftGraphApiBaseUrl}${outlookMailboxPath(input.mailbox)}/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
          headers: outlookReadHeaders(token, false)
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_get_attachment_failed',
          message: 'Microsoft Outlook get attachment failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OutlookFileAttachmentApi, response)

      return ActionResult.success(
        OutlookGetAttachmentOutput.make({ attachment: outlookAttachment(output) })
      )
    })
})

export const outlookCreateDraftAction = defineAction({
  id: 'outlook.create_draft',
  description: 'Create a new Microsoft Outlook message draft.',
  access: 'write',
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

const combineReplyText = (reply: string, generated: string) => {
  if (reply.trim() === '') return generated

  if (generated.trim() === '') return reply

  return `${reply}\n\n${generated}`
}

const combineReplyHtml = (reply: string, generated: string) => {
  if (reply.trim() === '') return generated

  if (generated.trim() === '') return reply

  const bodyOpen = /<body(?:\s[^>]*)?>/i.exec(generated)

  if (bodyOpen !== null) {
    const insertAt = bodyOpen.index + bodyOpen[0].length

    return `${generated.slice(0, insertAt)}${reply}${generated.slice(insertAt)}`
  }

  return `${reply}${generated}`
}

const outlookReplyDraftRecovery = (draftId: string) => ({
  draftId,
  retryable: false,
  recovery: 'read_edit_existing_draft'
})

const outlookReplyDraftError = (
  draftId: string,
  integration: ConnectorIntegration,
  error: ConnectorError
) =>
  new ConnectorError({
    cause: error.cause,
    message: `Microsoft Outlook reply draft ${draftId} was created, but its final content could not be confirmed. Read and edit that existing draft instead of creating another reply draft`,
    connectorId: integration.connectorId,
    actionId: 'outlook.create_reply_draft',
    underlying: outlookReplyDraftRecovery(draftId)
  })

const outlookReplyDraftPartialFailure = (input: {
  readonly draftId: string
  readonly operation: string
  readonly status: number
}) =>
  // Do not map this to a generic retryable provider code or expose retryAfterMs:
  // retrying the whole action would create another draft.
  ActionResult.failure({
    code: 'outlook_create_reply_draft_partial',
    message: `Microsoft Outlook create reply draft preserved draft ${input.draftId} but ${input.operation} failed. Read and edit that existing draft instead of creating another reply draft`,
    status: input.status,
    underlying: outlookReplyDraftRecovery(input.draftId)
  })

export const outlookCreateReplyDraftAction = defineAction({
  id: 'outlook.create_reply_draft',
  description:
    'Create a Microsoft Outlook reply draft for an existing message. Preserves the Graph-generated quoted history and prepends the supplied reply body.',
  access: 'write',
  inputSchema: OutlookCreateReplyDraftInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* outlookWriteSlot(integration, input.mailbox)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const mailboxPath = outlookMailboxPath(input.mailbox)
      const desiredBodyType = input.contentType === 'html' ? 'html' : 'text'

      // Create the reply draft without a replacement body so Microsoft Graph
      // generates the quoted history server-side. Supplying message.body here
      // would replace the generated history.
      const createResponse = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}${mailboxPath}/messages/${encodeURIComponent(input.messageId)}/createReply`,
          headers: outlookDraftPostHeaders(token)
        })
      )

      if (!isMicrosoftSuccessStatus(createResponse.status)) {
        return yield* microsoftProviderFailure({
          code: 'outlook_create_reply_draft_failed',
          message: 'Microsoft Outlook create reply draft failed',
          status: createResponse.status,
          headers: createResponse.headers,
          body: createResponse.body
        })
      }

      const created = yield* decodeJsonResponse(OutlookMessage, createResponse).pipe(
        Effect.catch(error =>
          Effect.gen(function* () {
            // Only decode again on failure, retaining identity even when another
            // field is malformed. A lost/invalid id still requires reconciliation.
            const identity = yield* decodeJsonResponse(
              Schema.Struct({ id: Schema.String }),
              createResponse
            )

            return yield* Effect.fail(outlookReplyDraftError(identity.id, integration, error))
          })
        )
      )

      return yield* Effect.gen(function* () {
        if (created.isDraft === false) {
          return yield* Effect.fail(
            new ConnectorError({
              cause: 'validation_failed',
              message: 'Microsoft Outlook create reply draft returned a non-draft message',
              connectorId: integration.connectorId,
              actionId: 'outlook.create_reply_draft'
            })
          )
        }

        // Reuse the generated body when it already matches the desired format;
        // otherwise read it back in the desired format instead of relabeling it.
        const generatedBody = yield* Effect.gen(function* () {
          if (
            created.body !== undefined &&
            created.body !== null &&
            created.body.contentType === desiredBodyType
          ) {
            return ActionResult.success(created.body.content)
          }

          const params = new URLSearchParams({ $select: outlookMessageSelect })

          const readResponse = yield* http.request(
            ConnectorHttpRequest.make({
              method: 'GET',
              url: `${microsoftGraphApiBaseUrl}${mailboxPath}/messages/${encodeURIComponent(created.id)}?${params.toString()}`,
              headers: outlookReadHeaders(token, true, desiredBodyType)
            })
          )

          if (!isMicrosoftSuccessStatus(readResponse.status)) {
            return outlookReplyDraftPartialFailure({
              draftId: created.id,
              operation: 'reading the generated reply body',
              status: readResponse.status
            })
          }

          const fetched = yield* decodeJsonResponse(OutlookMessage, readResponse)

          if (fetched.id !== created.id || fetched.isDraft === false) {
            return yield* Effect.fail(
              new ConnectorError({
                cause: 'validation_failed',
                message: 'Microsoft Outlook create reply draft read back an unexpected message',
                connectorId: integration.connectorId,
                actionId: 'outlook.create_reply_draft'
              })
            )
          }

          if (
            fetched.body === undefined ||
            fetched.body === null ||
            fetched.body.contentType !== desiredBodyType
          ) {
            return outlookReplyDraftPartialFailure({
              draftId: created.id,
              operation: 'reading the generated reply body in the requested format',
              status: readResponse.status
            })
          }

          return ActionResult.success(fetched.body.content)
        })

        if (Predicate.isTagged(generatedBody, 'Failure')) return generatedBody

        const combined =
          desiredBodyType === 'html'
            ? combineReplyHtml(input.body, generatedBody.value)
            : combineReplyText(input.body, generatedBody.value)

        const patchResponse = yield* http.request(
          ConnectorHttpRequest.make({
            method: 'PATCH',
            url: `${microsoftGraphApiBaseUrl}${mailboxPath}/messages/${encodeURIComponent(created.id)}`,
            headers: outlookDraftWriteHeaders(token),
            body: JSON.stringify({
              body: {
                contentType: outlookContentType(input.contentType),
                content: combined
              }
            })
          })
        )

        if (!isMicrosoftSuccessStatus(patchResponse.status)) {
          return outlookReplyDraftPartialFailure({
            draftId: created.id,
            operation: 'saving the reply content',
            status: patchResponse.status
          })
        }

        const output = yield* decodeJsonResponse(OutlookMessage, patchResponse)

        return ActionResult.success(output)
      }).pipe(Effect.mapError(error => outlookReplyDraftError(created.id, integration, error)))
    })
})

export const outlookSendMailAction = defineAction({
  id: 'outlook.send_mail',
  description: 'Submit a new Microsoft Outlook message for sending.',
  access: 'destructive',
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
          body: JSON.stringify(
            (() => {
              const payload: OutlookSendMailPayloadFields = {
                message: outlookMessageBody(input)
              }

              if (input.saveToSentItems !== undefined) {
                payload.saveToSentItems = input.saveToSentItems
              }

              return payload
            })()
          )
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
  access: 'destructive',
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

const outlookMutateMessage = (input: {
  readonly integration: ConnectorIntegration
  readonly mailbox: string | undefined
  readonly messageId: string
  readonly operation: 'set_read' | 'trash' | 'untrash'
  readonly body: { readonly isRead: boolean } | { readonly destinationId: string }
}) =>
  Effect.gen(function* () {
    const slot = yield* outlookWriteSlot(input.integration, input.mailbox)
    const token = yield* resolveMicrosoftAccessToken(input.integration, slot)
    const http = yield* ConnectorHttpClient
    const mailboxPath = outlookMailboxPath(input.mailbox)

    const collection =
      input.operation === 'untrash' ? `${mailboxPath}/mailFolders/deleteditems` : mailboxPath

    const suffix = input.operation === 'set_read' ? '' : '/move'

    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: input.operation === 'set_read' ? 'PATCH' : 'POST',
        url: `${microsoftGraphApiBaseUrl}${collection}/messages/${encodeURIComponent(input.messageId)}${suffix}`,
        headers: outlookDraftWriteHeaders(token),
        body: JSON.stringify(input.body)
      })
    )

    if (!isMicrosoftSuccessStatus(response.status)) {
      return yield* microsoftProviderFailure({
        code: `outlook_${input.operation}_failed`,
        message: `Microsoft Outlook ${input.operation} failed`,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    const output = yield* decodeJsonResponse(OutlookMessage, response)

    return ActionResult.success(output)
  })

export const outlookSetReadAction = defineAction({
  id: 'outlook.set_read',
  description: 'Mark an Outlook message read (isRead: true) or unread (isRead: false).',
  access: 'write',
  inputSchema: OutlookSetReadInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    outlookMutateMessage({
      integration,
      mailbox: input.mailbox,
      messageId: input.messageId,
      operation: 'set_read',
      body: { isRead: input.isRead }
    })
})

export const outlookTrashAction = defineAction({
  id: 'outlook.trash',
  description: 'Move an Outlook message to Deleted Items without permanently deleting it.',
  access: 'destructive',
  inputSchema: OutlookTrashInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    outlookMutateMessage({
      integration,
      mailbox: input.mailbox,
      messageId: input.messageId,
      operation: 'trash',
      body: { destinationId: 'deleteditems' }
    })
})

export const outlookUntrashAction = defineAction({
  id: 'outlook.untrash',
  description:
    'Move an Outlook message from Deleted Items to destinationFolderId (default: inbox), not its original folder.',
  access: 'write',
  inputSchema: OutlookUntrashInput,
  outputSchema: OutlookMessage,
  execute: ({ integration, input }) =>
    outlookMutateMessage({
      integration,
      mailbox: input.mailbox,
      messageId: input.messageId,
      operation: 'untrash',
      body: { destinationId: input.destinationFolderId ?? 'inbox' }
    })
})

export const outlookMailActions = [
  outlookListMessagesAction,
  outlookSearchMessagesAction,
  outlookGetMessageAction,
  outlookListAttachmentsAction,
  outlookGetAttachmentAction,
  outlookCreateDraftAction,
  outlookCreateReplyDraftAction,
  outlookSendMailAction,
  outlookSendDraftAction,
  outlookSetReadAction,
  outlookTrashAction,
  outlookUntrashAction
]
