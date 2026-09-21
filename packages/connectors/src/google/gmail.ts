import { Chunk, Effect, Match, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmailBatchOperationOutput,
  EmailBatchResultItem,
  makeEmailBatchSummary,
  type EmailBatchResultCode
} from '../email-batch.ts'
import { defineAction } from '../action.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import {
  ConnectorHttpClient,
  ConnectorHttpRequest,
  decodeJsonResponse,
  type ConnectorHttpClientApi
} from '../http.ts'
import { ActionResult } from '../result.ts'
import {
  GoogleGmailComposeOAuthCredentialSlot,
  GoogleGmailDraftReplyOAuthCredentialSlot,
  GoogleGmailFullMailOAuthCredentialSlot,
  GoogleGmailModifyOAuthCredentialSlot,
  GoogleGmailReadonlyOAuthCredentialSlot,
  GoogleGmailSettingsOAuthCredentialSlot,
  GoogleGmailSendOAuthCredentialSlot,
  GoogleOAuthCredentialSlot,
  googleGmailSendScope,
  googleGmailComposeScope,
  googleGmailModifyScope,
  googleAuthorizationHeaders
} from './oauth.ts'
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
  maxResults: Schema.optional(Schema.Number),
  isRead: Schema.optional(Schema.Boolean),
  isFlagged: Schema.optional(Schema.Boolean)
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

export class GmailGetThreadInput extends Schema.Class<GmailGetThreadInput>('GmailGetThreadInput')({
  threadId: Schema.String,
  format: Schema.Literals(['full', 'metadata', 'minimal'])
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
  pageToken: Schema.optional(Schema.String),
  isRead: Schema.optional(Schema.Boolean),
  isFlagged: Schema.optional(Schema.Boolean)
}) {}

/** A complete host-generated RFC 5322 MIME message, not a model-authored form.
 * Accept padded or unpadded canonical base64url; never rewrite consent-bearing bytes. */
export const GmailRawMessage = Schema.NonEmptyString.check(
  Schema.isPattern(
    /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw](?:==)?|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]=?)?$/
  )
)

export type GmailRawMessage = typeof GmailRawMessage.Type

export class GmailSendMessageInput extends Schema.Class<GmailSendMessageInput>(
  'GmailSendMessageInput'
)({
  raw: GmailRawMessage,
  threadId: Schema.optional(Schema.NonEmptyString)
}) {}

const GmailSentMessage = Schema.Struct({
  id: Schema.NonEmptyString,
  threadId: Schema.optional(Schema.NonEmptyString)
})

export class GmailSendMessageOutput extends Schema.Class<GmailSendMessageOutput>(
  'GmailSendMessageOutput'
)({
  accepted: Schema.Literal(true),
  ...GmailSentMessage.fields
}) {}

export class GmailDraftComposeInput extends Schema.Class<GmailDraftComposeInput>(
  'GmailDraftComposeInput'
)({
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  cc: Schema.optional(Schema.Array(Schema.String)),
  bcc: Schema.optional(Schema.Array(Schema.String)),
  from: Schema.optional(Schema.String)
}) {}

export class GmailDraftReplyInput extends Schema.Class<GmailDraftReplyInput>(
  'GmailDraftReplyInput'
)({
  messageId: Schema.String,
  body: Schema.String,
  from: Schema.optional(Schema.String)
}) {}

export class GmailDraftUpdateInput extends Schema.Class<GmailDraftUpdateInput>(
  'GmailDraftUpdateInput'
)({
  draftId: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
  cc: Schema.optional(Schema.Array(Schema.String)),
  bcc: Schema.optional(Schema.Array(Schema.String)),
  from: Schema.optional(Schema.String)
}) {}

export class GmailListAttachmentsInput extends Schema.Class<GmailListAttachmentsInput>(
  'GmailListAttachmentsInput'
)({
  messageId: Schema.String
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

export class GmailSetStarredInput extends Schema.Class<GmailSetStarredInput>(
  'GmailSetStarredInput'
)({
  messageId: Schema.String,
  isStarred: Schema.Boolean
}) {}

const GmailLabelName = Schema.Trimmed.check(Schema.isNonEmpty())

// URL parsers normalize even percent-encoded dot segments. Reject rather than change identity.
const GmailLabelId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^(?!\.+$)[^\u0000-\u0020\u007f]+$/)
)

export const GmailLabelMessageListVisibility = Schema.Literals(['show', 'hide'])

export type GmailLabelMessageListVisibility = typeof GmailLabelMessageListVisibility.Type

export const GmailLabelListVisibility = Schema.Literals([
  'labelShow',
  'labelShowIfUnread',
  'labelHide'
])

export type GmailLabelListVisibility = typeof GmailLabelListVisibility.Type

export const GmailLabelType = Schema.Literals(['system', 'user'])

export type GmailLabelType = typeof GmailLabelType.Type

export class GmailLabel extends Schema.Class<GmailLabel>('GmailLabel')({
  id: Schema.String,
  name: Schema.String,
  messageListVisibility: Schema.optional(GmailLabelMessageListVisibility),
  labelListVisibility: Schema.optional(GmailLabelListVisibility),
  type: Schema.optional(GmailLabelType),
  messagesTotal: Schema.optional(Schema.Number),
  messagesUnread: Schema.optional(Schema.Number),
  threadsTotal: Schema.optional(Schema.Number),
  threadsUnread: Schema.optional(Schema.Number)
}) {}

export class GmailCreateLabelInput extends Schema.Class<GmailCreateLabelInput>(
  'GmailCreateLabelInput'
)({
  name: GmailLabelName,
  messageListVisibility: Schema.optional(GmailLabelMessageListVisibility),
  labelListVisibility: Schema.optional(GmailLabelListVisibility)
}) {}

export class GmailLabelIdInput extends Schema.Class<GmailLabelIdInput>('GmailLabelIdInput')({
  id: GmailLabelId
}) {}

export class GmailUpdateLabelInput extends Schema.Class<GmailUpdateLabelInput>(
  'GmailUpdateLabelInput'
)({
  id: GmailLabelId,
  name: Schema.optional(GmailLabelName),
  messageListVisibility: Schema.optional(GmailLabelMessageListVisibility),
  labelListVisibility: Schema.optional(GmailLabelListVisibility)
}) {}

const updateLabelRequiresField = Schema.makeFilter<{
  readonly name?: string
  readonly messageListVisibility?: string
  readonly labelListVisibility?: string
}>(input =>
  input.name === undefined &&
  input.messageListVisibility === undefined &&
  input.labelListVisibility === undefined
    ? {
        path: ['name'],
        issue: 'update requires name, messageListVisibility, or labelListVisibility'
      }
    : undefined
)

const GmailUpdateLabelActionInput = GmailUpdateLabelInput.check(updateLabelRequiresField)

export class GmailDeleteLabelOutput extends Schema.Class<GmailDeleteLabelOutput>(
  'GmailDeleteLabelOutput'
)({
  id: Schema.String,
  deleted: Schema.Literal(true)
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
  /** Derived from `labelIds` only: `!includes('UNREAD')`. Absent when labels are omitted. */
  isRead: Schema.optional(Schema.Boolean),
  /** Derived from `labelIds` only: `includes('STARRED')`. Absent when labels are omitted. */
  isFlagged: Schema.optional(Schema.Boolean),
  payload: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Array(GmailMessagePayloadHeader))
    })
  ),
  raw: Schema.optional(Schema.String)
}) {}

const {
  isRead: _gmailMessageIsRead,
  isFlagged: _gmailMessageIsFlagged,
  ...GmailMessageWireFields
} = GmailMessageOutput.fields

const GmailMessageWire = Schema.Struct(GmailMessageWireFields)

type GmailMessageWireType = typeof GmailMessageWire.Type

const GmailAttachmentSize = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

const isGmailAttachmentSize = Schema.is(GmailAttachmentSize)

export class GmailThreadAttachment extends Schema.Class<GmailThreadAttachment>(
  'GmailThreadAttachment'
)({
  partId: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(GmailAttachmentSize),
  attachmentId: Schema.optional(Schema.String),
  inline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.String)
}) {}

export class GmailThreadMessage extends Schema.Class<GmailThreadMessage>('GmailThreadMessage')({
  id: Schema.String,
  threadId: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  /** Derived from `labelIds` only: `!includes('UNREAD')`. Absent when labels are omitted. */
  isRead: Schema.optional(Schema.Boolean),
  /** Derived from `labelIds` only: `includes('STARRED')`. Absent when labels are omitted. */
  isFlagged: Schema.optional(Schema.Boolean),
  snippet: Schema.optional(Schema.String),
  internalDate: Schema.optional(Schema.String),
  headers: Schema.Array(GmailMessagePayloadHeader),
  body: Schema.optional(Schema.String),
  bodyMimeType: Schema.optional(Schema.Literals(['text/plain', 'text/html'])),
  attachments: Schema.Array(GmailThreadAttachment)
}) {}

export class GmailThreadOutput extends Schema.Class<GmailThreadOutput>('GmailThreadOutput')({
  id: Schema.String,
  historyId: Schema.optional(Schema.String),
  messages: Schema.Array(GmailThreadMessage)
}) {}

export class GmailListAttachmentsOutput extends Schema.Class<GmailListAttachmentsOutput>(
  'GmailListAttachmentsOutput'
)({
  attachments: Schema.Chunk(GmailThreadAttachment)
}) {}

export const GmailAttachmentBase64Url = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/)
)

export type GmailAttachmentBase64Url = typeof GmailAttachmentBase64Url.Type

export const GmailAttachmentBase64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
)

export type GmailAttachmentBase64 = typeof GmailAttachmentBase64.Type

export class GmailGetAttachmentOutput extends Schema.Class<GmailGetAttachmentOutput>(
  'GmailGetAttachmentOutput'
)({
  messageId: Schema.String,
  attachmentId: Schema.String,
  size: GmailAttachmentSize,
  data: GmailAttachmentBase64Url,
  contentBase64: GmailAttachmentBase64
}) {}

const GmailAttachmentWireOutput = Schema.Struct({
  size: GmailAttachmentSize,
  data: GmailAttachmentBase64Url
})

const GmailThreadWireMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  snippet: Schema.optional(Schema.String),
  internalDate: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Json)
})

const GmailThreadWireOutput = Schema.Struct({
  id: Schema.String,
  historyId: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(GmailThreadWireMessage))
})

export class GmailSendAs extends Schema.Class<GmailSendAs>('GmailSendAs')({
  sendAsEmail: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  isDefault: Schema.optional(Schema.Boolean),
  verificationStatus: Schema.optional(Schema.String)
}) {}

export class GmailListSendAsOutput extends Schema.Class<GmailListSendAsOutput>(
  'GmailListSendAsOutput'
)({
  sendAs: Schema.optional(Schema.Array(GmailSendAs))
}) {}

export const GmailUnknownOutput = Schema.Unknown

const isGmailJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const gmailJsonField = (value: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined

const gmailJsonStringField = (value: Schema.JsonObject, key: string) => {
  const field = gmailJsonField(value, key)

  return Predicate.isString(field) ? field : undefined
}

const gmailJsonArrayField = (value: Schema.JsonObject, key: string): ReadonlyArray<Schema.Json> => {
  const field = gmailJsonField(value, key)

  return Array.isArray(field) ? field : []
}

const gmailThreadHeaderNames = new Set([
  'bcc',
  'cc',
  'date',
  'delivered-to',
  'from',
  'in-reply-to',
  'message-id',
  'references',
  'reply-to',
  'subject',
  'to'
])

type GmailThreadHeaderFields = {
  readonly name: string
  readonly value: string
}

const gmailPartHeaders = (part: Schema.Json | undefined) => {
  if (!isGmailJsonObject(part)) return []

  return gmailJsonArrayField(part, 'headers').flatMap(header => {
    if (!isGmailJsonObject(header)) return []

    const name = gmailJsonStringField(header, 'name')
    const value = gmailJsonStringField(header, 'value')

    return name === undefined || value === undefined ? [] : [{ name, value }]
  })
}

const selectedGmailPartHeaders = (headers: ReadonlyArray<GmailThreadHeaderFields>) =>
  headers.filter(header => gmailThreadHeaderNames.has(header.name.toLowerCase()))

const gmailPartHeader = (headers: ReadonlyArray<GmailThreadHeaderFields>, name: string) =>
  headers.find(header => header.name.toLowerCase() === name.toLowerCase())?.value

const decodeBase64Bytes = (value: string, urlEncoded: boolean) => {
  const compact = value.replaceAll(/\s/g, '')

  const normalized = urlEncoded ? compact.replaceAll('-', '+').replaceAll('_', '/') : compact

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return undefined
  }

  const unpadded = normalized.replaceAll(/=+$/g, '')
  const padded = `${unpadded}${'='.repeat((4 - (unpadded.length % 4)) % 4)}`
  const decoded = Result.try(() => atob(padded))

  if (Result.isFailure(decoded)) return undefined

  const binary = decoded.success
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const decodeQuotedPrintable = (value: string) => {
  const withoutSoftBreaks = value.replaceAll(/=\r?\n/g, '')
  const bytes: Array<number> = []
  const encoder = new TextEncoder()

  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const character = withoutSoftBreaks[index]
    const pair = withoutSoftBreaks.slice(index + 1, index + 3)

    if (character === '=' && /^[A-Fa-f0-9]{2}$/.test(pair)) {
      bytes.push(Number.parseInt(pair, 16))
      index += 2
      continue
    }

    if (character !== undefined) {
      bytes.push(...encoder.encode(character))
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

const decodeCapturedGmailTextBody = (value: string, transferEncoding: string | undefined) => {
  if (transferEncoding === 'quoted-printable') return decodeQuotedPrintable(value)

  if (transferEncoding === 'base64') {
    const transferredBytes = decodeBase64Bytes(value, false)

    return transferredBytes === undefined ? undefined : new TextDecoder().decode(transferredBytes)
  }

  return value
}

const decodeGmailTextBody = (part: Schema.JsonObject) => {
  const body = gmailJsonField(part, 'body')

  if (!isGmailJsonObject(body)) return undefined

  const data = gmailJsonStringField(body, 'data')

  if (data === undefined) return undefined

  const bytes = decodeBase64Bytes(data, true)

  if (bytes === undefined) return undefined

  const value = new TextDecoder().decode(bytes)

  const transferEncoding = gmailPartHeader(
    gmailPartHeaders(part),
    'content-transfer-encoding'
  )?.toLowerCase()

  return decodeCapturedGmailTextBody(value, transferEncoding)
}

type GmailThreadAttachmentFields = {
  partId?: string
  filename?: string
  mimeType?: string
  size?: number
  attachmentId?: string
  inline?: boolean
  contentId?: string
}

type GmailThreadMessagePrefixFields = {
  readonly id: string
  threadId?: string
  labelIds?: ReadonlyArray<string>
  snippet?: string
  internalDate?: string
}

type GmailThreadMessageWithHeadersFields = {
  readonly id: string
  threadId?: string
  labelIds?: ReadonlyArray<string>
  snippet?: string
  internalDate?: string
  readonly headers: ReadonlyArray<GmailThreadHeaderFields>
  body?: string
  bodyMimeType?: 'text/plain' | 'text/html'
  isRead?: boolean
  isFlagged?: boolean
}

type GmailThreadOutputFields = {
  readonly id: string
  historyId?: string
}

type GmailCollectedParts = {
  readonly plain: Array<string>
  readonly html: Array<string>
  readonly attachments: Array<GmailThreadAttachment>
}

const collectGmailParts = (part: Schema.Json | undefined, collected: GmailCollectedParts): void => {
  if (!isGmailJsonObject(part)) return

  const partId = gmailJsonStringField(part, 'partId')
  const filename = gmailJsonStringField(part, 'filename')
  const mimeType = gmailJsonStringField(part, 'mimeType')
  const body = gmailJsonField(part, 'body')
  const bodyObject = isGmailJsonObject(body) ? body : undefined

  // MIME discovery is best-effort; invalid optional sizes must not become byte budgets.
  const rawSize = bodyObject === undefined ? undefined : gmailJsonField(bodyObject, 'size')
  const size = isGmailAttachmentSize(rawSize) ? rawSize : undefined

  const attachmentId =
    bodyObject === undefined ? undefined : gmailJsonStringField(bodyObject, 'attachmentId')

  const hasFilename = filename !== undefined && filename.trim() !== ''

  const contentDisposition = gmailPartHeader(gmailPartHeaders(part), 'content-disposition')
    ?.trim()
    .toLowerCase()

  const contentId = gmailPartHeader(gmailPartHeaders(part), 'content-id')
  const isInline = contentDisposition?.startsWith('inline') === true || contentId !== undefined
  const isTextBody = mimeType === 'text/plain' || mimeType === 'text/html'

  const isAttachment =
    hasFilename ||
    attachmentId !== undefined ||
    contentDisposition?.startsWith('attachment') === true ||
    (isInline && !isTextBody) ||
    mimeType === 'message/rfc822'

  if (isAttachment) {
    collected.attachments.push(
      GmailThreadAttachment.make(
        (() => {
          const fields: GmailThreadAttachmentFields = {}

          if (partId !== undefined) {
            fields.partId = partId
          }

          if (hasFilename) {
            fields.filename = filename
          }

          if (mimeType !== undefined) {
            fields.mimeType = mimeType
          }

          if (size !== undefined) {
            fields.size = size
          }

          if (attachmentId !== undefined) {
            fields.attachmentId = attachmentId
          }

          if (isInline) {
            fields.inline = true
          }

          if (contentId !== undefined) {
            fields.contentId = contentId
          }

          return fields
        })()
      )
    )

    return
  }

  if (mimeType === 'text/plain' || mimeType === 'text/html') {
    const decoded = decodeGmailTextBody(part)

    if (decoded !== undefined && decoded.trim() !== '') {
      if (mimeType === 'text/plain') collected.plain.push(decoded)
      else collected.html.push(decoded)
    }
  }

  for (const child of gmailJsonArrayField(part, 'parts')) {
    collectGmailParts(child, collected)
  }
}

const gmailAttachmentsFromPayload = (payload: Schema.Json | undefined) => {
  const collected: GmailCollectedParts = { plain: [], html: [], attachments: [] }
  collectGmailParts(payload, collected)

  return collected.attachments
}

const normalizeGmailThreadMessage = (
  message: typeof GmailThreadWireMessage.Type
): GmailThreadMessage => {
  const collected: GmailCollectedParts = { plain: [], html: [], attachments: [] }
  collectGmailParts(message.payload, collected)
  const usesPlain = collected.plain.length > 0
  const bodies = usesPlain ? collected.plain : collected.html
  const body = bodies.length === 0 ? undefined : bodies.join('\n\n')

  return new GmailThreadMessage(
    (() => {
      const prefix: GmailThreadMessagePrefixFields = {
        id: message.id
      }

      if (message.threadId !== undefined) {
        prefix.threadId = message.threadId
      }

      if (message.labelIds !== undefined) {
        prefix.labelIds = message.labelIds
      }

      if (message.snippet !== undefined) {
        prefix.snippet = message.snippet
      }

      if (message.internalDate !== undefined) {
        prefix.internalDate = message.internalDate
      }

      const fields: GmailThreadMessageWithHeadersFields = {
        ...prefix,
        headers: selectedGmailPartHeaders(gmailPartHeaders(message.payload))
      }

      if (body !== undefined) {
        fields.body = body
      }

      if (body !== undefined) {
        fields.bodyMimeType = usesPlain ? 'text/plain' : 'text/html'
      }

      // Normalize read/flag state from labels only. An empty array establishes
      // read/unflagged; omitted labels establish neither. Provider-supplied
      // lookalike fields are never trusted.
      if (message.labelIds !== undefined) {
        fields.isRead = !message.labelIds.includes('UNREAD')
        fields.isFlagged = message.labelIds.includes('STARRED')
      }

      return { ...fields, attachments: collected.attachments }
    })()
  )
}

const normalizeGmailThread = (thread: typeof GmailThreadWireOutput.Type) =>
  new GmailThreadOutput(
    (() => {
      const fields: GmailThreadOutputFields = {
        id: thread.id
      }

      if (thread.historyId !== undefined) {
        fields.historyId = thread.historyId
      }

      return { ...fields, messages: (thread.messages ?? []).map(normalizeGmailThreadMessage) }
    })()
  )

const base64UrlToBase64 = (value: string) => {
  const withoutPadding = value.replace(/=+$/, '')
  const base64 = withoutPadding.replaceAll('-', '+').replaceAll('_', '/')

  return `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
}

const gmailProviderFailure = (code: string, message: string, status: number, body: string) =>
  providerFailureFromResponse({ code, message, status, body })

const gmailRequest = (input: {
  readonly token: string
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
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

/**
 * Normalize Gmail read/flag discovery from `labelIds` only. An empty array
 * establishes `isRead: true`, `isFlagged: false`; omitted labels establish
 * neither. Any provider-supplied lookalike fields are discarded, never trusted.
 */
const withGmailReadState = (message: GmailMessageWireType): GmailMessageOutput => {
  if (message.labelIds === undefined) return GmailMessageOutput.make({ ...message })

  return GmailMessageOutput.make({
    ...message,
    labelIds: [...message.labelIds],
    isRead: !message.labelIds.includes('UNREAD'),
    isFlagged: message.labelIds.includes('STARRED')
  })
}

/**
 * Compose one Gmail `q` value from an optional raw query plus typed read/flag
 * filters. A nonblank existing query is grouped before typed predicates are
 * appended with conjunction semantics; grouping preserves ordinary `OR`
 * expressions. The raw query stays Gmail syntax. Returns the query unchanged
 * when neither typed filter is supplied.
 */
const composeGmailQuery = (input: {
  readonly query?: string | undefined
  readonly isRead?: boolean | undefined
  readonly isFlagged?: boolean | undefined
}): string | undefined => {
  const predicates: Array<string> = []

  if (input.isRead !== undefined) predicates.push(input.isRead ? 'is:read' : 'is:unread')

  if (input.isFlagged !== undefined) {
    predicates.push(input.isFlagged ? 'is:starred' : '-is:starred')
  }

  if (predicates.length === 0) return input.query

  const suffix = predicates.join(' ')

  if (input.query === undefined || input.query.trim() === '') return suffix

  return `(${input.query}) ${suffix}`
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
    ...(input.from === undefined ? [] : [`From: ${encodeEmailAddress(input.from)}`]),
    ...(input.to.length === 0 ? [] : [`To: ${encodeAddressList(input.to)}`]),
    ...(input.cc === undefined ? [] : [`Cc: ${encodeAddressList(input.cc)}`]),
    ...(input.bcc === undefined ? [] : [`Bcc: ${encodeAddressList(input.bcc)}`]),
    `Subject: ${encodeRfc2047(input.subject)}`,
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: ${sanitizeHeader(input.inReplyTo)}`]),
    ...(input.references === undefined ? [] : [`References: ${sanitizeHeader(input.references)}`]),
    'Content-Type: text/plain; charset=utf-8'
  ]

  return base64UrlEncode(`${headers.join('\r\n')}\r\n\r\n${input.body}`)
}

const sanitizeHeader = (value: string) => value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim()

const hasOnlyAscii = (value: string) => /^[\u0000-\u007f]*$/.test(value)

const base64Encode = (value: string) => {
  const bytes = new TextEncoder().encode(value)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

const encodeRfc2047 = (value: string) => {
  const safeValue = sanitizeHeader(value)

  return hasOnlyAscii(safeValue) ? safeValue : `=?UTF-8?B?${base64Encode(safeValue)}?=`
}

const encodeEmailAddress = (address: string) => {
  const trimmed = sanitizeHeader(address)
  const angleIndex = trimmed.lastIndexOf('<')

  if (angleIndex <= 0) return trimmed

  const displayPart = trimmed.slice(0, angleIndex).trim()
  const emailPart = trimmed.slice(angleIndex)

  if (displayPart === '') return emailPart

  const name = displayPart.replace(/^"(.*)"$/, '$1')

  return hasOnlyAscii(name) ? trimmed : `${encodeRfc2047(name)} ${emailPart}`
}

const encodeAddressList = (addresses: ReadonlyArray<string>) =>
  addresses
    .flatMap(address => splitAddresses(address))
    .map(encodeEmailAddress)
    .join(', ')

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

const splitAddresses = (value: string | undefined) => {
  if (value === undefined) return []

  const result: Array<string> = []
  let current = ''
  let inQuotes = false
  let inAngle = false

  for (const char of value) {
    if (char === '"' && !inAngle) {
      inQuotes = !inQuotes
    } else if (char === '<' && !inQuotes) {
      inAngle = true
    } else if (char === '>' && !inQuotes) {
      inAngle = false
    }

    if (char === ',' && !inQuotes && !inAngle) {
      const address = current.trim()

      if (address !== '') result.push(address)
      current = ''
    } else {
      current += char
    }
  }

  const address = current.trim()

  if (address !== '') result.push(address)

  return result
}

const extractEmailAddress = (value: string) => {
  const match = /<([^<>]+)>/.exec(value)

  return (match?.[1] ?? value).trim().toLowerCase()
}

const sendAsEmailsFromOutput = (output: GmailListSendAsOutput) =>
  new Set(
    (output.sendAs ?? [])
      .flatMap(sendAs => (sendAs.sendAsEmail === undefined ? [] : [sendAs.sendAsEmail]))
      .map(extractEmailAddress)
  )

const fetchSendAsOutput = (token: string) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient

    const response = yield* http.request(
      gmailRequest({ token, method: 'GET', path: '/users/me/settings/sendAs' })
    )

    if (!isSuccessStatus(response.status)) {
      return yield* gmailProviderFailure(
        'gmail_list_send_as_failed',
        'Gmail list send-as aliases failed',
        response.status,
        response.body
      )
    }

    const output = yield* decodeJsonResponse(GmailListSendAsOutput, response)

    return ActionResult.success(output)
  })

const fetchSendAsEmails = (token: string) =>
  Effect.gen(function* () {
    const result = yield* fetchSendAsOutput(token)

    return Match.value(result).pipe(
      Match.tag('Failure', current => current),
      Match.tag('Success', current => ActionResult.success(sendAsEmailsFromOutput(current.value))),
      Match.exhaustive
    )
  })

const fetchOptionalSendAsEmails = (token: string) =>
  fetchSendAsEmails(token).pipe(
    Effect.map(result => (Predicate.isTagged(result, 'Success') ? result.value : new Set<string>()))
  )

const validateFromAddress = (fromAddress: string, sendAsEmails: ReadonlySet<string>) => {
  const email = extractEmailAddress(fromAddress)

  if (sendAsEmails.has(email)) return ActionResult.success(fromAddress)

  const available = [...sendAsEmails].sort().join(', ')
  const suffix = available === '' ? '' : ` Available addresses: ${available}`

  return ActionResult.failure({
    code: 'gmail_from_not_configured',
    message: `"${fromAddress}" is not a configured Gmail send-as address.${suffix}`
  })
}

const validateOptionalFromAddress = (token: string, fromAddress: string | undefined) =>
  Effect.gen(function* () {
    if (fromAddress === undefined) return ActionResult.success(undefined)

    const sendAsEmails = yield* fetchSendAsEmails(token)

    if (Predicate.isTagged(sendAsEmails, 'Failure')) return sendAsEmails

    return validateFromAddress(fromAddress, sendAsEmails.value)
  })

const detectReplyFromAddress = (
  original: GmailMessageOutput,
  sendAsEmails: ReadonlySet<string>
): string | undefined => {
  for (const headerName of ['Delivered-To', 'To', 'Cc']) {
    const header = headerValue(original, headerName)

    for (const address of splitAddresses(header)) {
      const email = extractEmailAddress(address)

      if (sendAsEmails.has(email)) return email
    }
  }

  return undefined
}

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
  errorMessage: string,
  credentialSlot: CredentialSlot = GoogleGmailReadonlyOAuthCredentialSlot
) =>
  Effect.gen(function* () {
    const token = yield* resolveGoogleAccessToken(integration, credentialSlot)
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(request(token))

    if (!isSuccessStatus(response.status)) {
      return yield* gmailProviderFailure(errorCode, errorMessage, response.status, response.body)
    }

    const output = yield* decodeJsonResponse(GmailUnknownOutput, response)

    return ActionResult.success(output)
  })

export const gmailSearchAction = defineAction({
  id: 'gmail.search',
  description:
    'Search Gmail messages for the integration account. Optional isRead/isFlagged filters are composed into the Gmail query as is:read/is:unread and is:starred/-is:starred.',
  inputSchema: GmailSearchInput,
  outputSchema: GmailSearchOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailReadonlyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'q', composeGmailQuery(input))
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
        return yield* providerFailureFromResponse({
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
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailReadonlyOAuthCredentialSlot
      )

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
        return yield* providerFailureFromResponse({
          code: 'gmail_get_message_failed',
          message: 'Gmail get message failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GmailMessageWire, response)

      return ActionResult.success(withGmailReadState(output))
    })
})

export const gmailListAction = defineAction({
  id: 'gmail.list',
  description:
    'List Gmail messages for the integration account. Optional isRead/isFlagged filters are composed into the Gmail query; labelId, page token, and limits are preserved.',
  inputSchema: GmailListInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token => {
        const params = new URLSearchParams()
        appendSearchParam(params, 'q', composeGmailQuery(input))
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
        appendSearchParam(params, 'q', input.query)
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
      'Gmail list drafts failed',
      GoogleGmailComposeOAuthCredentialSlot
    )
})

export const gmailGetThreadAction = defineAction({
  id: 'gmail.get_thread',
  description:
    'Get normalized Gmail thread messages; full adds decoded bodies. Attachments are metadata-only; fetch entries with attachmentId via gmail.get_attachment.',
  inputSchema: GmailGetThreadInput,
  outputSchema: GmailThreadOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailReadonlyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'format', input.format)

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/threads/${encodeURIComponent(input.threadId)}?${params.toString()}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_get_thread_failed',
          'Gmail get thread failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailThreadWireOutput, response)

      return ActionResult.success(normalizeGmailThread(output))
    })
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

export const gmailCreateLabelAction = defineAction({
  id: 'gmail.create_label',
  description: 'Create a Gmail user label.',
  access: 'write',
  inputSchema: GmailCreateLabelInput,
  outputSchema: GmailLabel,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailModifyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'POST',
          path: '/users/me/labels',
          body: {
            name: input.name,
            messageListVisibility: input.messageListVisibility,
            labelListVisibility: input.labelListVisibility
          }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_create_label_failed',
          'Gmail create label failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailLabel, response)

      return ActionResult.success(output)
    })
})

export const gmailGetLabelAction = defineAction({
  id: 'gmail.get_label',
  description: 'Get a Gmail label by id.',
  access: 'read',
  inputSchema: GmailLabelIdInput,
  outputSchema: GmailLabel,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailReadonlyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/labels/${encodeURIComponent(input.id)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_get_label_failed',
          'Gmail get label failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailLabel, response)

      return ActionResult.success(output)
    })
})

export const gmailUpdateLabelAction = defineAction({
  id: 'gmail.update_label',
  description:
    'Rename a Gmail user label or update its visibility. System labels cannot be renamed.',
  access: 'write',
  inputSchema: GmailUpdateLabelActionInput,
  outputSchema: GmailLabel,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailModifyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'PATCH',
          path: `/users/me/labels/${encodeURIComponent(input.id)}`,
          body: {
            name: input.name,
            messageListVisibility: input.messageListVisibility,
            labelListVisibility: input.labelListVisibility
          }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_update_label_failed',
          'Gmail update label failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailLabel, response)

      return ActionResult.success(output)
    })
})

export const gmailDeleteLabelAction = defineAction({
  id: 'gmail.delete_label',
  description: 'Delete a Gmail user label. System labels cannot be deleted.',
  access: 'destructive',
  inputSchema: GmailLabelIdInput,
  outputSchema: GmailDeleteLabelOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailModifyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'DELETE',
          path: `/users/me/labels/${encodeURIComponent(input.id)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_delete_label_failed',
          'Gmail delete label failed',
          response.status,
          response.body
        )
      }

      // Gmail answers label deletes with 204 and an empty body: no JSON to decode.
      return ActionResult.success(GmailDeleteLabelOutput.make({ id: input.id, deleted: true }))
    })
})

export const gmailModifyLabelsAction = defineAction({
  id: 'gmail.modify_labels',
  description: 'Add or remove labels on a Gmail message.',
  access: 'write',
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
      'Gmail modify labels failed',
      GoogleGmailModifyOAuthCredentialSlot
    )
})

export const gmailSetStarredAction = defineAction({
  id: 'gmail.set_starred',
  description:
    'Star (isStarred: true) or unstar (isStarred: false) a Gmail message via the STARRED system label.',
  access: 'write',
  inputSchema: GmailSetStarredInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    runGmailJsonAction(
      integration,
      token =>
        gmailRequest({
          token,
          method: 'POST',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}/modify`,
          body: input.isStarred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }
        }),
      'gmail_set_starred_failed',
      'Gmail set starred failed',
      GoogleGmailModifyOAuthCredentialSlot
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
      'Gmail trash failed',
      GoogleGmailModifyOAuthCredentialSlot
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
      'Gmail untrash failed',
      GoogleGmailModifyOAuthCredentialSlot
    )
})

export const gmailSendMessageAction = defineAction({
  id: 'gmail.send_message',
  description:
    'Submit a complete host-generated base64url MIME message to Gmail. Success is submission, not delivery. For replies, the host supplies matching Subject, In-Reply-To and References headers plus threadId. Never automatically retry an unconfirmed send.',
  access: 'destructive',
  // Recheck fields of mutable decoded instances on the typed path as well.
  inputSchema: Schema.Struct(GmailSendMessageInput.fields),
  outputSchema: GmailSendMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      // Scope inspection is not authorization. Re-resolve through the selected operation
      // slot so strict host resolvers can enforce an existing sufficient grant, including
      // compose-only credentials, without requesting additional consent.
      const credential = yield* resolveCredential(integration, GoogleOAuthCredentialSlot)

      const sendScope = Predicate.isTagged(credential, 'OAuthCredential')
        ? [
            googleGmailSendScope,
            googleGmailComposeScope,
            googleGmailModifyScope,
            'https://mail.google.com/'
          ].find(scope => credential.scopes?.includes(scope))
        : undefined

      const slot =
        sendScope === undefined || sendScope === googleGmailSendScope
          ? GoogleGmailSendOAuthCredentialSlot
          : CredentialSlot.make({
              id: GoogleGmailSendOAuthCredentialSlot.id,
              kind: 'oauth',
              requiredScopes: [sendScope]
            })

      const token = yield* resolveGoogleAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient

      return yield* Effect.gen(function* () {
        const response = yield* http.request(
          ConnectorHttpRequest.make({
            method: 'POST',
            url: `${googleGmailApiBaseUrl}/users/me/messages/send`,
            headers: { ...googleAuthorizationHeaders(token), 'content-type': 'application/json' },
            body: JSON.stringify(input)
          })
        )

        if (!isSuccessStatus(response.status)) {
          const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)

          return ActionResult.failure({
            code: rejected ? 'gmail_send_message_rejected' : 'gmail_send_message_unknown',
            message: rejected
              ? 'Gmail rejected the submission. Do not automatically resend.'
              : 'Gmail submission was not confirmed. Reconcile before considering another send.',
            status: response.status,
            underlying: { outcome: rejected ? 'rejected' : 'unknown', retryable: false }
          })
        }

        const message = yield* decodeJsonResponse(GmailSentMessage, response)

        return ActionResult.success(GmailSendMessageOutput.make({ accepted: true, ...message }))
      }).pipe(
        Effect.mapError(
          error =>
            new ConnectorError({
              cause: error.cause,
              connectorId: integration.connectorId,
              actionId: 'gmail.send_message',
              message:
                'Gmail submission was not confirmed. Reconcile before considering another send.',
              underlying: { outcome: 'unknown', retryable: false }
            })
        )
      )
    })
})

export const gmailDraftComposeAction = defineAction({
  id: 'gmail.draft_compose',
  description: 'Create a Gmail draft message.',
  inputSchema: GmailDraftComposeInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailComposeOAuthCredentialSlot
      )

      const fromValidation = yield* validateOptionalFromAddress(token, input.from)

      if (Predicate.isTagged(fromValidation, 'Failure')) return fromValidation

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'POST',
          path: '/users/me/drafts',
          body: { message: { raw: rawEmail(input) } }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_draft_compose_failed',
          'Gmail draft compose failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailUnknownOutput, response)

      return ActionResult.success(output)
    })
})

export const gmailDraftUpdateAction = defineAction({
  id: 'gmail.draft_update',
  description: 'Update a Gmail draft message.',
  inputSchema: GmailDraftUpdateInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailComposeOAuthCredentialSlot
      )

      const fromValidation = yield* validateOptionalFromAddress(token, input.from)

      if (Predicate.isTagged(fromValidation, 'Failure')) return fromValidation

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'PUT',
          path: `/users/me/drafts/${encodeURIComponent(input.draftId)}`,
          body: { id: input.draftId, message: { raw: rawEmail(input) } }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_draft_update_failed',
          'Gmail draft update failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailUnknownOutput, response)

      return ActionResult.success(output)
    })
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
      'Gmail draft delete failed',
      GoogleGmailComposeOAuthCredentialSlot
    )
})

export const gmailDraftReplyAction = defineAction({
  id: 'gmail.draft_reply',
  description: 'Create a simple Gmail reply draft.',
  inputSchema: GmailDraftReplyInput,
  outputSchema: GmailUnknownOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailDraftReplyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const messageResponse = yield* http.request(
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}?format=metadata`
        })
      )

      if (!isSuccessStatus(messageResponse.status)) {
        return yield* gmailProviderFailure(
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
        return yield* gmailProviderFailure(
          'gmail_draft_reply_failed',
          'Gmail draft reply failed',
          profileResponse.status,
          profileResponse.body
        )
      }

      const original = withGmailReadState(
        yield* decodeJsonResponse(GmailMessageWire, messageResponse)
      )

      const profile = yield* decodeJsonResponse(
        Schema.Struct({ emailAddress: Schema.optional(Schema.String) }),
        profileResponse
      )

      const requestedFrom = input.from

      const sendAsEmailsResult =
        requestedFrom === undefined
          ? ActionResult.success(yield* fetchOptionalSendAsEmails(token))
          : yield* fetchSendAsEmails(token).pipe(
              Effect.flatMap(result => {
                if (Predicate.isTagged(result, 'Failure')) return Effect.succeed(result)

                const fromValidation = validateFromAddress(requestedFrom, result.value)

                return Effect.succeed(
                  Predicate.isTagged(fromValidation, 'Failure')
                    ? fromValidation
                    : ActionResult.success(result.value)
                )
              })
            )

      if (Predicate.isTagged(sendAsEmailsResult, 'Failure')) return sendAsEmailsResult

      const ownEmails = new Set([
        ...sendAsEmailsResult.value,
        ...(profile.emailAddress === undefined ? [] : [extractEmailAddress(profile.emailAddress)])
      ])

      const fromAddress =
        requestedFrom ?? detectReplyFromAddress(original, sendAsEmailsResult.value)

      const recipients = splitAddresses(headerValue(original, 'From'))
        .concat(splitAddresses(headerValue(original, 'To')))
        .concat(splitAddresses(headerValue(original, 'Cc')))
        .filter(address => !ownEmails.has(extractEmailAddress(address)))

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
                from: fromAddress,
                inReplyTo: messageId,
                references: references === '' ? undefined : references
              })
            }
          }
        })
      )

      if (!isSuccessStatus(draftResponse.status)) {
        return yield* gmailProviderFailure(
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

export const gmailListAttachmentsAction = defineAction({
  id: 'gmail.list_attachments',
  description:
    'List normalized Gmail attachment metadata for one message without returning attachment content.',
  inputSchema: GmailListAttachmentsInput,
  outputSchema: GmailListAttachmentsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailReadonlyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}?format=full`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_list_attachments_failed',
          'Gmail list attachments failed',
          response.status,
          response.body
        )
      }

      const message = yield* decodeJsonResponse(GmailThreadWireMessage, response)

      return ActionResult.success(
        GmailListAttachmentsOutput.make({
          attachments: Chunk.fromIterable(gmailAttachmentsFromPayload(message.payload))
        })
      )
    })
})

export const gmailGetAttachmentAction = defineAction({
  id: 'gmail.get_attachment',
  description:
    'Get Gmail attachment content as standard base64 while preserving Gmail base64url data.',
  inputSchema: GmailGetAttachmentInput,
  outputSchema: GmailGetAttachmentOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailReadonlyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        gmailRequest({
          token,
          method: 'GET',
          path: `/users/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* gmailProviderFailure(
          'gmail_get_attachment_failed',
          'Gmail get attachment failed',
          response.status,
          response.body
        )
      }

      const output = yield* decodeJsonResponse(GmailAttachmentWireOutput, response)

      return ActionResult.success(
        GmailGetAttachmentOutput.make({
          messageId: input.messageId,
          attachmentId: input.attachmentId,
          size: output.size,
          data: output.data,
          contentBase64: base64UrlToBase64(output.data)
        })
      )
    })
})

export const gmailListSendAsAction = defineAction({
  id: 'gmail.list_send_as',
  description: 'List configured Gmail send-as addresses.',
  inputSchema: Schema.Struct({}),
  outputSchema: GmailListSendAsOutput,
  execute: ({ integration }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailSettingsOAuthCredentialSlot
      )

      return yield* fetchSendAsOutput(token)
    })
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

// Path-bound Gmail message IDs: URL parsers normalize even percent-encoded dot
// segments, so reject dot-only IDs, surrounding whitespace, control/space
// characters, and lone UTF-16
// surrogates (encodeURIComponent throws) before credentials or HTTP.
const GmailBatchMessageId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^(?!\.+$)[^\u0000-\u0020\u007f\uD800-\uDFFF]+$/u)
)

const GmailBatchMessageIds = Schema.Array(GmailBatchMessageId).check(
  Schema.isLengthBetween(1, 100),
  Schema.isUnique()
)

export class GmailSetReadInput extends Schema.Class<GmailSetReadInput>('GmailSetReadInput')({
  messageId: GmailBatchMessageId,
  isRead: Schema.Boolean
}) {}

export class GmailBatchSetReadInput extends Schema.Class<GmailBatchSetReadInput>(
  'GmailBatchSetReadInput'
)({
  messageIds: GmailBatchMessageIds,
  isRead: Schema.Boolean
}) {}

export class GmailBatchSetStarredInput extends Schema.Class<GmailBatchSetStarredInput>(
  'GmailBatchSetStarredInput'
)({
  messageIds: GmailBatchMessageIds,
  isStarred: Schema.Boolean
}) {}

const GmailLabelIdDelta = Schema.NonEmptyString

const GmailLabelDeltaArray = Schema.Array(GmailLabelIdDelta).check(Schema.isLengthBetween(1, 100))

export class GmailBatchModifyLabelsInput extends Schema.Class<GmailBatchModifyLabelsInput>(
  'GmailBatchModifyLabelsInput'
)({
  messageIds: GmailBatchMessageIds,
  addLabelIds: Schema.optional(GmailLabelDeltaArray),
  removeLabelIds: Schema.optional(GmailLabelDeltaArray)
}) {}

class GmailModifyLabelsRequestBody extends Schema.Class<GmailModifyLabelsRequestBody>(
  'GmailModifyLabelsRequestBody'
)({
  addLabelIds: Schema.optional(Schema.Array(Schema.String)),
  removeLabelIds: Schema.optional(Schema.Array(Schema.String))
}) {}

const gmailBatchModifyLabelsActionInput = Schema.Struct(GmailBatchModifyLabelsInput.fields).check(
  Schema.makeFilter<{
    readonly addLabelIds?: ReadonlyArray<string>
    readonly removeLabelIds?: ReadonlyArray<string>
  }>(input =>
    input.addLabelIds === undefined && input.removeLabelIds === undefined
      ? {
          path: ['addLabelIds'],
          issue: 'modify requires addLabelIds or removeLabelIds'
        }
      : undefined
  )
)

export class GmailBatchTrashInput extends Schema.Class<GmailBatchTrashInput>(
  'GmailBatchTrashInput'
)({
  messageIds: GmailBatchMessageIds
}) {}

export class GmailBatchUntrashInput extends Schema.Class<GmailBatchUntrashInput>(
  'GmailBatchUntrashInput'
)({
  messageIds: GmailBatchMessageIds
}) {}

export class GmailDeletePermanentlyInput extends Schema.Class<GmailDeletePermanentlyInput>(
  'GmailDeletePermanentlyInput'
)({
  messageIds: GmailBatchMessageIds
}) {}

type GmailBatchItemOutcome = {
  readonly item: EmailBatchResultItem
  /** True when later IDs must not be attempted (auth, throttling, transport, 5xx). */
  readonly stop: boolean
}

const gmailQuotaReasons = new Set([
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'sharingRateLimitExceeded',
  'userRateLimitExceeded'
])

const GmailQuotaErrorWire = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      errors: Schema.optional(
        Schema.Array(Schema.Struct({ reason: Schema.optional(Schema.String) }))
      )
    })
  )
})

// Parse fixed quota reasons internally; all provider text is discarded and
// never surfaces in batch codes, messages, or failures.
const gmailBodyHasQuotaReason = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GmailQuotaErrorWire))(body).pipe(
    Effect.result,
    Effect.map(result => {
      if (Result.isFailure(result)) return false

      const errors = result.success.error?.errors ?? []

      return errors.some(entry => entry.reason !== undefined && gmailQuotaReasons.has(entry.reason))
    })
  )

const gmailItemFailure = (input: {
  readonly messageId: string
  readonly status: number
  readonly quota: boolean
}): GmailBatchItemOutcome => {
  const failed = (code: EmailBatchResultCode): GmailBatchItemOutcome => ({
    item: EmailBatchResultItem.make({ messageId: input.messageId, status: 'failed', code }),
    stop: false
  })

  const stoppedFailure = (code: EmailBatchResultCode): GmailBatchItemOutcome => ({
    item: EmailBatchResultItem.make({ messageId: input.messageId, status: 'failed', code }),
    stop: true
  })

  const ambiguous = (): GmailBatchItemOutcome => ({
    item: EmailBatchResultItem.make({
      messageId: input.messageId,
      status: 'unknown',
      code: 'outcome_ambiguous'
    }),
    stop: true
  })

  if (input.status === 401) return stoppedFailure('unauthorized')

  if (input.status === 403) {
    return input.quota ? stoppedFailure('rate_limited') : stoppedFailure('forbidden')
  }

  if (input.status === 429) return stoppedFailure('rate_limited')

  if (input.status === 408 || input.status >= 500) return ambiguous()

  if (input.status === 404) return failed('not_found')

  if (input.status === 400 || input.status === 422) return failed('invalid_request')

  if (input.status === 409) return failed('conflict')

  if (input.status === 412) return failed('precondition_failed')

  if (input.status === 413) return failed('payload_too_large')

  if (input.status === 423) return failed('locked')

  if (input.status >= 400 && input.status < 500) return failed('provider_rejected')

  return {
    item: EmailBatchResultItem.make({
      messageId: input.messageId,
      status: 'unknown',
      code: 'invalid_response'
    }),
    stop: false
  }
}

const gmailBatchFailureMessage = (code: EmailBatchResultCode | undefined): string => {
  switch (code) {
    case 'unauthorized':
      return 'Gmail rejected the request: unauthorized'
    case 'forbidden':
      return 'Gmail rejected the request: permission denied'
    case 'not_found':
      return 'Gmail rejected the request: message not found'
    case 'rate_limited':
      return 'Gmail rejected the request: rate limited'
    case 'invalid_request':
      return 'Gmail rejected the request: invalid request'
    case 'conflict':
      return 'Gmail rejected the request: conflict'
    case 'precondition_failed':
      return 'Gmail rejected the request: precondition failed'
    case 'payload_too_large':
      return 'Gmail rejected the request: payload too large'
    case 'locked':
      return 'Gmail rejected the request: locked'
    case 'outcome_ambiguous':
      return 'Gmail outcome is ambiguous; reconcile before retrying'
    case 'invalid_response':
      return 'Gmail returned an invalid response; outcome is unknown'
    default:
      return 'Gmail rejected the request'
  }
}

const GmailMutationIdentity = Schema.Struct({ id: Schema.String })

type GmailBatchOperation = {
  readonly build: (messageId: string) => ConnectorHttpRequest
  /** JSON-returning mutations require a 2xx plus an identified matching message. */
  readonly expectJson: boolean
}

const executeGmailBatchItem = (input: {
  readonly http: ConnectorHttpClientApi
  readonly messageId: string
  readonly operation: GmailBatchOperation
}): Effect.Effect<GmailBatchItemOutcome, never> =>
  Effect.gen(function* () {
    const response = yield* Effect.catch(
      input.http.request(input.operation.build(input.messageId)),
      () => Effect.succeed(undefined)
    )

    // Transport problems after dispatch cannot establish the outcome.
    if (response === undefined) {
      return {
        item: EmailBatchResultItem.make({
          messageId: input.messageId,
          status: 'unknown',
          code: 'outcome_ambiguous'
        }),
        stop: true
      } satisfies GmailBatchItemOutcome
    }

    if (!input.operation.expectJson) {
      // Individually addressed deletes establish success only with 204 and no
      // JSON body. A 404 is a definitive rejection, not success.
      if (response.status === 204) {
        return {
          item: EmailBatchResultItem.make({
            messageId: input.messageId,
            status: 'succeeded'
          }),
          stop: false
        } satisfies GmailBatchItemOutcome
      }

      return gmailItemFailure({
        messageId: input.messageId,
        status: response.status,
        quota: yield* gmailBodyHasQuotaReason(response.body)
      })
    }

    if (response.status !== 200) {
      return gmailItemFailure({
        messageId: input.messageId,
        status: response.status,
        quota: yield* gmailBodyHasQuotaReason(response.body)
      })
    }

    // Never treat an unexpected 2xx, {}, malformed JSON, or an unrelated
    // message as success.
    const identity = yield* decodeJsonResponse(GmailMutationIdentity, response).pipe(Effect.result)

    if (Result.isFailure(identity) || identity.success.id !== input.messageId) {
      return {
        item: EmailBatchResultItem.make({
          messageId: input.messageId,
          status: 'unknown',
          code: 'invalid_response'
        }),
        stop: false
      } satisfies GmailBatchItemOutcome
    }

    return {
      item: EmailBatchResultItem.make({ messageId: input.messageId, status: 'succeeded' }),
      stop: false
    } satisfies GmailBatchItemOutcome
  })

// Individually addressed requests, executed sequentially: Gmail bulk endpoints
// return no per-ID results, so envelope success must never expand into
// per-ID success. Later IDs become not_attempted after a stop condition.
const runGmailBatch = (input: {
  readonly messageIds: ReadonlyArray<string>
  readonly operation: GmailBatchOperation
}): Effect.Effect<EmailBatchOperationOutput, never, ConnectorHttpClient> =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const items: Array<EmailBatchResultItem> = []
    let stopped = false

    for (const messageId of input.messageIds) {
      if (stopped) {
        items.push(
          EmailBatchResultItem.make({
            messageId,
            status: 'not_attempted',
            code: 'batch_stopped'
          })
        )
        continue
      }

      const outcome = yield* executeGmailBatchItem({ http, messageId, operation: input.operation })
      items.push(outcome.item)

      if (outcome.stop) stopped = true
    }

    return EmailBatchOperationOutput.make({
      results: items,
      summary: makeEmailBatchSummary(items)
    })
  })

type GmailBatchExecutorInput = {
  readonly integration: Parameters<typeof resolveGoogleAccessToken>[0]
  readonly messageIds: ReadonlyArray<string>
  readonly operation: (token: string) => GmailBatchOperation
  readonly slot?: CredentialSlot
}

const executeGmailBatch = (input: GmailBatchExecutorInput) =>
  Effect.gen(function* () {
    const token = yield* resolveGoogleAccessToken(
      input.integration,
      input.slot ?? GoogleGmailModifyOAuthCredentialSlot
    )

    const output = yield* runGmailBatch({
      messageIds: input.messageIds,
      operation: input.operation(token)
    })

    return ActionResult.success(output)
  })

export const gmailSetReadAction = defineAction({
  id: 'gmail.set_read',
  description:
    'Mark a Gmail message read (isRead: true) or unread (isRead: false) via the UNREAD system label. Returns the normalized message.',
  access: 'write',
  inputSchema: Schema.Struct(GmailSetReadInput.fields),
  outputSchema: GmailMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleGmailModifyOAuthCredentialSlot
      )

      const http = yield* ConnectorHttpClient

      return yield* Effect.gen(function* () {
        const response = yield* http.request(
          gmailRequest({
            token,
            method: 'POST',
            path: `/users/me/messages/${encodeURIComponent(input.messageId)}/modify`,
            body: input.isRead ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }
          })
        )

        if (response.status !== 200) {
          const outcome = gmailItemFailure({
            messageId: input.messageId,
            status: response.status,
            quota: yield* gmailBodyHasQuotaReason(response.body)
          })

          return ActionResult.failure({
            code: 'gmail_set_read_failed',
            message: gmailBatchFailureMessage(outcome.item.code),
            status: response.status
          })
        }

        const output = yield* decodeJsonResponse(GmailMessageWire, response)

        if (output.id !== input.messageId) {
          return ActionResult.failure({
            code: 'gmail_set_read_failed',
            message: gmailBatchFailureMessage('invalid_response'),
            status: response.status
          })
        }

        return ActionResult.success(withGmailReadState(output))
      }).pipe(
        Effect.mapError(
          error =>
            new ConnectorError({
              cause: error.cause,
              connectorId: integration.connectorId,
              actionId: 'gmail.set_read',
              message: 'Gmail read-state mutation failed without a confirmed outcome'
            })
        )
      )
    })
})

export const gmailBatchSetReadAction = defineAction({
  id: 'gmail.batch_set_read',
  description:
    'Mark 1-100 unique Gmail messages read or unread with individually addressed modify requests. Returns complete per-ID outcomes with exact counts.',
  access: 'write',
  inputSchema: Schema.Struct(GmailBatchSetReadInput.fields),
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeGmailBatch({
      integration,
      messageIds: input.messageIds,
      operation: token => ({
        expectJson: true,
        build: messageId =>
          gmailRequest({
            token,
            method: 'POST',
            path: `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
            body: input.isRead ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }
          })
      })
    })
})

export const gmailBatchSetStarredAction = defineAction({
  id: 'gmail.batch_set_starred',
  description:
    'Star or unstar 1-100 unique Gmail messages with individually addressed modify requests on the STARRED system label. Returns complete per-ID outcomes with exact counts.',
  access: 'write',
  inputSchema: Schema.Struct(GmailBatchSetStarredInput.fields),
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeGmailBatch({
      integration,
      messageIds: input.messageIds,
      operation: token => ({
        expectJson: true,
        build: messageId =>
          gmailRequest({
            token,
            method: 'POST',
            path: `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
            body: input.isStarred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }
          })
      })
    })
})

export const gmailBatchModifyLabelsAction = defineAction({
  id: 'gmail.batch_modify_labels',
  description:
    'Add or remove Gmail label IDs on 1-100 unique messages with individually addressed modify requests. Removals win on overlap; labels are never created. Returns complete per-ID outcomes with exact counts.',
  access: 'write',
  inputSchema: gmailBatchModifyLabelsActionInput,
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeGmailBatch({
      integration,
      messageIds: input.messageIds,
      operation: token => {
        const removals = [...new Set(input.removeLabelIds ?? [])]

        const additions = [...new Set(input.addLabelIds ?? [])].filter(id => !removals.includes(id))

        const addLabelIds = additions.length > 0 ? additions : undefined
        const removeLabelIds = removals.length > 0 ? removals : undefined
        const body = GmailModifyLabelsRequestBody.make({ addLabelIds, removeLabelIds })

        return {
          expectJson: true,
          build: messageId =>
            gmailRequest({
              token,
              method: 'POST',
              path: `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
              body
            })
        }
      }
    })
})

export const gmailBatchTrashAction = defineAction({
  id: 'gmail.batch_trash',
  description:
    'Move 1-100 unique Gmail messages to trash with individually addressed requests. Returns complete per-ID outcomes with exact counts.',
  access: 'destructive',
  inputSchema: Schema.Struct(GmailBatchTrashInput.fields),
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeGmailBatch({
      integration,
      messageIds: input.messageIds,
      operation: token => ({
        expectJson: true,
        build: messageId =>
          gmailRequest({
            token,
            method: 'POST',
            path: `/users/me/messages/${encodeURIComponent(messageId)}/trash`
          })
      })
    })
})

export const gmailBatchUntrashAction = defineAction({
  id: 'gmail.batch_untrash',
  description:
    'Restore 1-100 unique Gmail messages from trash with individually addressed requests. Returns complete per-ID outcomes with exact counts.',
  access: 'write',
  inputSchema: Schema.Struct(GmailBatchUntrashInput.fields),
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeGmailBatch({
      integration,
      messageIds: input.messageIds,
      operation: token => ({
        expectJson: true,
        build: messageId =>
          gmailRequest({
            token,
            method: 'POST',
            path: `/users/me/messages/${encodeURIComponent(messageId)}/untrash`
          })
      })
    })
})

export const gmailDeletePermanentlyAction = defineAction({
  id: 'gmail.delete_permanently',
  description:
    'Immediately and permanently delete 1-100 unique Gmail messages with individually addressed DELETE requests; this is not trash and does not claim backup erasure. Requires full-mail consent. Returns complete per-ID outcomes with exact counts.',
  access: 'destructive',
  inputSchema: Schema.Struct(GmailDeletePermanentlyInput.fields),
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeGmailBatch({
      integration,
      messageIds: input.messageIds,
      slot: GoogleGmailFullMailOAuthCredentialSlot,
      operation: token => ({
        expectJson: false,
        build: messageId =>
          gmailRequest({
            token,
            method: 'DELETE',
            path: `/users/me/messages/${encodeURIComponent(messageId)}`
          })
      })
    })
})

export const gmailActions = [
  gmailSearchAction,
  gmailListAction,
  gmailListDraftsAction,
  gmailGetMessageAction,
  gmailDraftReplyAction,
  gmailListAttachmentsAction,
  gmailGetAttachmentAction,
  gmailDraftComposeAction,
  gmailDraftUpdateAction,
  gmailSendMessageAction,
  gmailGetThreadAction,
  gmailListLabelsAction,
  gmailCreateLabelAction,
  gmailGetLabelAction,
  gmailUpdateLabelAction,
  gmailDeleteLabelAction,
  gmailModifyLabelsAction,
  gmailSetStarredAction,
  gmailSetReadAction,
  gmailBatchSetReadAction,
  gmailBatchSetStarredAction,
  gmailBatchModifyLabelsAction,
  gmailBatchTrashAction,
  gmailBatchUntrashAction,
  gmailDeletePermanentlyAction,
  gmailTrashAction,
  gmailUntrashAction,
  gmailDraftDeleteAction,
  gmailListSendAsAction,
  gmailListAccountsAction
]
