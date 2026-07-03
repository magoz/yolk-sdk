import { Effect } from 'effect'
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
