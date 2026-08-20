import { Chunk, Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import type { CredentialSlot } from '../credential.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import {
  GoogleGmailComposeOAuthCredentialSlot,
  GoogleGmailDraftReplyOAuthCredentialSlot,
  GoogleGmailModifyOAuthCredentialSlot,
  GoogleGmailReadonlyOAuthCredentialSlot,
  GoogleGmailSettingsOAuthCredentialSlot,
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

export class GmailGetThreadInput extends Schema.Class<GmailGetThreadInput>(
  'GmailGetThreadInput'
)({
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
  pageToken: Schema.optional(Schema.String)
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

export class GmailThreadAttachment extends Schema.Class<GmailThreadAttachment>(
  'GmailThreadAttachment'
)({
  partId: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  attachmentId: Schema.optional(Schema.String),
  inline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.String)
}) {}

export class GmailThreadMessage extends Schema.Class<GmailThreadMessage>('GmailThreadMessage')({
  id: Schema.String,
  threadId: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
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

const GmailAttachmentSize = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

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
  payload: Schema.optional(Schema.Unknown)
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

const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const unknownField = (value: unknown, key: string) =>
  isUnknownRecord(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

const unknownStringField = (value: unknown, key: string) => {
  const field = unknownField(value, key)
  return typeof field === 'string' ? field : undefined
}

const unknownNumberField = (value: unknown, key: string) => {
  const field = unknownField(value, key)
  return typeof field === 'number' ? field : undefined
}

const unknownArrayField = (value: unknown, key: string) => {
  const field = unknownField(value, key)
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

const gmailPartHeaders = (part: unknown) =>
  unknownArrayField(part, 'headers').flatMap(header => {
    const name = unknownStringField(header, 'name')
    const value = unknownStringField(header, 'value')
    return name === undefined || value === undefined ? [] : [{ name, value }]
  })

const selectedGmailPartHeaders = (part: unknown) =>
  gmailPartHeaders(part).filter(header => gmailThreadHeaderNames.has(header.name.toLowerCase()))

const gmailPartHeader = (part: unknown, name: string) =>
  gmailPartHeaders(part).find(header => header.name.toLowerCase() === name.toLowerCase())?.value

const decodeBase64Bytes = (value: string, urlEncoded: boolean) => {
  const compact = value.replaceAll(/\s/g, '')
  const normalized = urlEncoded
    ? compact.replaceAll('-', '+').replaceAll('_', '/')
    : compact
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

const decodeGmailTextBody = (part: unknown) => {
  const body = unknownField(part, 'body')
  const data = unknownStringField(body, 'data')
  if (data === undefined) return undefined

  const bytes = decodeBase64Bytes(data, true)
  if (bytes === undefined) return undefined

  const value = new TextDecoder().decode(bytes)
  const transferEncoding = gmailPartHeader(part, 'content-transfer-encoding')?.toLowerCase()
  if (transferEncoding === 'quoted-printable') return decodeQuotedPrintable(value)
  if (transferEncoding === 'base64') {
    const transferredBytes = decodeBase64Bytes(value, false)
    return transferredBytes === undefined ? undefined : new TextDecoder().decode(transferredBytes)
  }
  return value
}

type GmailCollectedParts = {
  readonly plain: Array<string>
  readonly html: Array<string>
  readonly attachments: Array<GmailThreadAttachment>
}

const collectGmailParts = (part: unknown, collected: GmailCollectedParts): void => {
  if (!isUnknownRecord(part)) return

  const partId = unknownStringField(part, 'partId')
  const filename = unknownStringField(part, 'filename')
  const mimeType = unknownStringField(part, 'mimeType')
  const body = unknownField(part, 'body')
  const size = unknownNumberField(body, 'size')
  const attachmentId = unknownStringField(body, 'attachmentId')
  const hasFilename = filename !== undefined && filename.trim() !== ''
  const contentDisposition = gmailPartHeader(part, 'content-disposition')?.trim().toLowerCase()
  const contentId = gmailPartHeader(part, 'content-id')
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
      new GmailThreadAttachment({
        ...(partId === undefined ? {} : { partId }),
        ...(hasFilename ? { filename } : {}),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(size === undefined ? {} : { size }),
        ...(attachmentId === undefined ? {} : { attachmentId }),
        ...(isInline ? { inline: true } : {}),
        ...(contentId === undefined ? {} : { contentId })
      })
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

  for (const child of unknownArrayField(part, 'parts')) {
    collectGmailParts(child, collected)
  }
}

const gmailAttachmentsFromPayload = (payload: unknown) => {
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

  return new GmailThreadMessage({
    id: message.id,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.labelIds === undefined ? {} : { labelIds: message.labelIds }),
    ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
    ...(message.internalDate === undefined ? {} : { internalDate: message.internalDate }),
    headers: selectedGmailPartHeaders(message.payload),
    ...(body === undefined ? {} : { body }),
    ...(body === undefined ? {} : { bodyMimeType: usesPlain ? 'text/plain' : 'text/html' }),
    attachments: collected.attachments
  })
}

const normalizeGmailThread = (thread: typeof GmailThreadWireOutput.Type) =>
  new GmailThreadOutput({
    id: thread.id,
    ...(thread.historyId === undefined ? {} : { historyId: thread.historyId }),
    messages: (thread.messages ?? []).map(normalizeGmailThreadMessage)
  })

const base64UrlToBase64 = (value: string) => {
  const withoutPadding = value.replace(/=+$/, '')
  const base64 = withoutPadding.replaceAll('-', '+').replaceAll('_', '/')
  return `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
}

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

    switch (result._tag) {
      case 'Failure':
        return result
      case 'Success':
        return ActionResult.success(sendAsEmailsFromOutput(result.value))
    }
  })

const fetchOptionalSendAsEmails = (token: string) =>
  fetchSendAsEmails(token).pipe(
    Effect.map(result => (result._tag === 'Success' ? result.value : new Set<string>()))
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
    if (sendAsEmails._tag === 'Failure') return sendAsEmails

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
  description: 'Search Gmail messages for the integration account.',
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
      'Gmail modify labels failed',
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
      if (fromValidation._tag === 'Failure') return fromValidation

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
      if (fromValidation._tag === 'Failure') return fromValidation

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

      const original = yield* decodeJsonResponse(GmailMessageOutput, messageResponse)
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
                if (result._tag === 'Failure') return Effect.succeed(result)

                const fromValidation = validateFromAddress(requestedFrom, result.value)
                return Effect.succeed(
                  fromValidation._tag === 'Failure'
                    ? fromValidation
                    : ActionResult.success(result.value)
                )
              })
            )

      if (sendAsEmailsResult._tag === 'Failure') return sendAsEmailsResult

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
  gmailGetThreadAction,
  gmailListLabelsAction,
  gmailModifyLabelsAction,
  gmailTrashAction,
  gmailUntrashAction,
  gmailDraftDeleteAction,
  gmailListSendAsAction,
  gmailListAccountsAction
]
