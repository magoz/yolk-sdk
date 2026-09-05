import { Context, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import {
  CredentialSlot,
  UsernamePasswordCredential,
  resolveCredential,
  type RuntimeCredential
} from '../credential.ts'
import { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'

export const emailConnectorId = 'email'

export const emailIncomingCredentialSlotId = 'email.incoming'
export const emailSmtpCredentialSlotId = 'email.smtp'

export const EmailIncomingCredentialSlot = CredentialSlot.make({
  id: emailIncomingCredentialSlotId,
  kind: 'username_password'
})
export const EmailSmtpCredentialSlot = CredentialSlot.make({
  id: emailSmtpCredentialSlotId,
  kind: 'username_password'
})

export const emailIncomingProtocolConfigKey = 'incomingProtocol'
export const emailIncomingHostConfigKey = 'incomingHost'
export const emailIncomingPortConfigKey = 'incomingPort'
export const emailIncomingSecurityConfigKey = 'incomingSecurity'
export const emailSmtpProtocolConfigKey = 'smtpProtocol'
export const emailSmtpHostConfigKey = 'smtpHost'
export const emailSmtpPortConfigKey = 'smtpPort'
export const emailSmtpSecurityConfigKey = 'smtpSecurity'

export const EmailIncomingProtocol = Schema.Literals(['imap', 'pop3'])
export type EmailIncomingProtocol = typeof EmailIncomingProtocol.Type

export const EmailSmtpProtocol = Schema.Literal('smtp')
export type EmailSmtpProtocol = typeof EmailSmtpProtocol.Type

export const EmailSecurity = Schema.Literals(['none', 'starttls', 'tls'])
export type EmailSecurity = typeof EmailSecurity.Type

export class EmailIncomingConnection extends Schema.Class<EmailIncomingConnection>(
  'EmailIncomingConnection'
)({
  protocol: EmailIncomingProtocol,
  host: Schema.String,
  port: Schema.Int,
  security: EmailSecurity
}) {}

export class EmailImapConnection extends Schema.Class<EmailImapConnection>('EmailImapConnection')({
  protocol: Schema.Literal('imap'),
  host: Schema.String,
  port: Schema.Int,
  security: EmailSecurity
}) {}

export class EmailSmtpConnection extends Schema.Class<EmailSmtpConnection>('EmailSmtpConnection')({
  protocol: EmailSmtpProtocol,
  host: Schema.String,
  port: Schema.Int,
  security: EmailSecurity
}) {}

export class EmailAddress extends Schema.Class<EmailAddress>('EmailAddress')({
  address: Schema.String,
  name: Schema.optional(Schema.String)
}) {}

export class EmailBody extends Schema.Class<EmailBody>('EmailBody')({
  text: Schema.optional(Schema.String),
  html: Schema.optional(Schema.String)
}) {}

export class EmailAttachmentMetadata extends Schema.Class<EmailAttachmentMetadata>(
  'EmailAttachmentMetadata'
)({
  id: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  inline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.String)
}) {}

export const EmailAttachmentBase64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
)
export type EmailAttachmentBase64 = typeof EmailAttachmentBase64.Type

const EmailAttachmentSize = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

export class EmailAttachmentContent extends Schema.Class<EmailAttachmentContent>(
  'EmailAttachmentContent'
)({
  id: Schema.String,
  filename: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
  size: Schema.optional(EmailAttachmentSize),
  inline: Schema.optional(Schema.Boolean),
  contentId: Schema.optional(Schema.String),
  contentBase64: EmailAttachmentBase64
}) {}

export class EmailMessageSummary extends Schema.Class<EmailMessageSummary>('EmailMessageSummary')({
  id: Schema.String,
  subject: Schema.optional(Schema.String),
  from: Schema.Array(EmailAddress),
  to: Schema.Array(EmailAddress),
  sentAt: Schema.optional(Schema.String),
  receivedAt: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  hasAttachments: Schema.Boolean
}) {}

export class EmailMessage extends Schema.Class<EmailMessage>('EmailMessage')({
  id: Schema.String,
  messageId: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  from: Schema.Array(EmailAddress),
  to: Schema.Array(EmailAddress),
  cc: Schema.Array(EmailAddress),
  bcc: Schema.Array(EmailAddress),
  replyTo: Schema.Array(EmailAddress),
  sentAt: Schema.optional(Schema.String),
  receivedAt: Schema.optional(Schema.String),
  body: EmailBody,
  attachments: Schema.Array(EmailAttachmentMetadata)
}) {}

const EmailPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))

export const EmailFolderName = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand('EmailFolderName')
)
export type EmailFolderName = typeof EmailFolderName.Type

export class EmailListMessagesInput extends Schema.Class<EmailListMessagesInput>(
  'EmailListMessagesInput'
)({
  folder: Schema.optional(EmailFolderName),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(EmailPageSize)
}) {}

export class EmailListMessagesOutput extends Schema.Class<EmailListMessagesOutput>(
  'EmailListMessagesOutput'
)({
  messages: Schema.Array(EmailMessageSummary),
  nextCursor: Schema.optional(Schema.String)
}) {}

export class EmailGetMessageInput extends Schema.Class<EmailGetMessageInput>(
  'EmailGetMessageInput'
)({
  messageId: Schema.String,
  folder: Schema.optional(EmailFolderName)
}) {}

export class EmailGetMessageOutput extends Schema.Class<EmailGetMessageOutput>(
  'EmailGetMessageOutput'
)({
  message: EmailMessage
}) {}

export class EmailGetAttachmentInput extends Schema.Class<EmailGetAttachmentInput>(
  'EmailGetAttachmentInput'
)({
  messageId: Schema.String,
  attachmentId: Schema.String,
  folder: Schema.optionalKey(EmailFolderName)
}) {}

export class EmailGetAttachmentOutput extends Schema.Class<EmailGetAttachmentOutput>(
  'EmailGetAttachmentOutput'
)({
  attachment: EmailAttachmentContent
}) {}

const EmailNonEmptyMessageId = Schema.Trimmed.check(Schema.isNonEmpty())

export class EmailSetReadInput extends Schema.Class<EmailSetReadInput>('EmailSetReadInput')({
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  isRead: Schema.Boolean
}) {}

export class EmailSetReadOutput extends Schema.Class<EmailSetReadOutput>('EmailSetReadOutput')({
  messageId: EmailNonEmptyMessageId,
  isRead: Schema.Boolean
}) {}

export class EmailTrashInput extends Schema.Class<EmailTrashInput>('EmailTrashInput')({
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  trashFolder: Schema.optional(EmailFolderName)
}) {}

export class EmailUntrashInput extends Schema.Class<EmailUntrashInput>('EmailUntrashInput')({
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  destinationFolder: Schema.optional(EmailFolderName)
}) {}

export class EmailMoveMessageOutput extends Schema.Class<EmailMoveMessageOutput>(
  'EmailMoveMessageOutput'
)({
  moved: Schema.Literal(true),
  folder: EmailFolderName,
  messageId: Schema.optional(EmailNonEmptyMessageId)
}) {}

export class EmailSetReadRequest extends Schema.Class<EmailSetReadRequest>('EmailSetReadRequest')({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageId: EmailNonEmptyMessageId,
  folder: EmailFolderName,
  isRead: Schema.Boolean
}) {}

export class EmailTrashRequest extends Schema.Class<EmailTrashRequest>('EmailTrashRequest')({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageId: EmailNonEmptyMessageId,
  folder: EmailFolderName,
  trashFolder: Schema.optional(EmailFolderName)
}) {}

export class EmailUntrashRequest extends Schema.Class<EmailUntrashRequest>('EmailUntrashRequest')({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  destinationFolder: EmailFolderName
}) {}

export class EmailComposeMessage extends Schema.Class<EmailComposeMessage>('EmailComposeMessage')({
  from: Schema.optional(EmailAddress),
  to: Schema.Array(EmailAddress),
  cc: Schema.optional(Schema.Array(EmailAddress)),
  bcc: Schema.optional(Schema.Array(EmailAddress)),
  replyTo: Schema.optional(Schema.Array(EmailAddress)),
  subject: Schema.optional(Schema.String),
  body: EmailBody,
  inReplyTo: Schema.optional(Schema.String),
  references: Schema.optional(Schema.Array(Schema.String))
}) {}

export const EmailDraftId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand('EmailDraftId')
)
export type EmailDraftId = typeof EmailDraftId.Type

export class EmailCreateDraftInput extends Schema.Class<EmailCreateDraftInput>(
  'EmailCreateDraftInput'
)({
  message: EmailComposeMessage,
  folder: Schema.optional(EmailFolderName)
}) {}

export class EmailCreateDraftOutput extends Schema.Class<EmailCreateDraftOutput>(
  'EmailCreateDraftOutput'
)({
  saved: Schema.Literal(true),
  folder: EmailFolderName,
  draftId: Schema.optional(EmailDraftId)
}) {}

export class EmailSendMessageInput extends Schema.Class<EmailSendMessageInput>(
  'EmailSendMessageInput'
)({
  message: EmailComposeMessage
}) {}

export class EmailSendMessageOutput extends Schema.Class<EmailSendMessageOutput>(
  'EmailSendMessageOutput'
)({
  accepted: Schema.Literal(true),
  submissionId: Schema.optional(Schema.String)
}) {}

export class EmailListMessagesRequest extends Schema.Class<EmailListMessagesRequest>(
  'EmailListMessagesRequest'
)({
  connection: EmailIncomingConnection,
  credential: UsernamePasswordCredential,
  folder: Schema.optional(EmailFolderName),
  cursor: Schema.optional(Schema.String),
  limit: EmailPageSize
}) {}

export class EmailGetMessageRequest extends Schema.Class<EmailGetMessageRequest>(
  'EmailGetMessageRequest'
)({
  connection: EmailIncomingConnection,
  credential: UsernamePasswordCredential,
  messageId: Schema.String,
  folder: Schema.optional(EmailFolderName)
}) {}

export class EmailGetAttachmentRequest extends Schema.Class<EmailGetAttachmentRequest>(
  'EmailGetAttachmentRequest'
)({
  connection: EmailIncomingConnection,
  credential: UsernamePasswordCredential,
  messageId: Schema.String,
  attachmentId: Schema.String,
  folder: Schema.optional(EmailFolderName)
}) {}

export class EmailCreateDraftRequest extends Schema.Class<EmailCreateDraftRequest>(
  'EmailCreateDraftRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  message: EmailComposeMessage,
  folder: Schema.optional(EmailFolderName)
}) {}

export class EmailSendMessageRequest extends Schema.Class<EmailSendMessageRequest>(
  'EmailSendMessageRequest'
)({
  connection: EmailSmtpConnection,
  credential: UsernamePasswordCredential,
  message: EmailComposeMessage
}) {}

export type EmailClientApi = {
  readonly listMessages: (
    input: EmailListMessagesRequest
  ) => Effect.Effect<ActionResult<EmailListMessagesOutput>, ConnectorError>
  readonly getMessage: (
    input: EmailGetMessageRequest
  ) => Effect.Effect<ActionResult<EmailGetMessageOutput>, ConnectorError>
  readonly getAttachment?: (
    input: EmailGetAttachmentRequest
  ) => Effect.Effect<ActionResult<EmailGetAttachmentOutput>, ConnectorError>
  readonly setRead?: (
    input: EmailSetReadRequest
  ) => Effect.Effect<ActionResult<EmailSetReadOutput>, ConnectorError>
  readonly trash?: (
    input: EmailTrashRequest
  ) => Effect.Effect<ActionResult<EmailMoveMessageOutput>, ConnectorError>
  readonly untrash?: (
    input: EmailUntrashRequest
  ) => Effect.Effect<ActionResult<EmailMoveMessageOutput>, ConnectorError>
  readonly createDraft: (
    input: EmailCreateDraftRequest
  ) => Effect.Effect<ActionResult<EmailCreateDraftOutput>, ConnectorError>
  readonly sendMessage: (
    input: EmailSendMessageRequest
  ) => Effect.Effect<ActionResult<EmailSendMessageOutput>, ConnectorError>
}

export class EmailClient extends Context.Service<EmailClient, EmailClientApi>()(
  '@yolk-sdk/connectors/EmailClient'
) {}

const configValue = (integration: ConnectorIntegration, key: string) =>
  Object.getOwnPropertyDescriptor(integration.config, key)?.value

const validationError = (
  integration: ConnectorIntegration,
  message: string,
  underlying?: unknown
) =>
  new ConnectorError({
    cause: 'validation_failed',
    message,
    connectorId: integration.connectorId,
    underlying
  })

const requiredHost = (integration: ConnectorIntegration, key: string) => {
  const value = configValue(integration, key)
  if (typeof value === 'string' && value.trim() !== '') {
    return Effect.succeed(value.trim())
  }
  return Effect.fail(validationError(integration, `Missing integration config: ${key}`))
}

const enumConfig = <Value extends string>(input: {
  readonly integration: ConnectorIntegration
  readonly key: string
  readonly allowed: ReadonlyArray<Value>
  readonly fallback: Value
}) => {
  const value = configValue(input.integration, input.key)
  if (value === undefined) return Effect.succeed(input.fallback)
  const match =
    typeof value === 'string' ? input.allowed.find(candidate => candidate === value) : undefined
  if (match !== undefined) return Effect.succeed(match)
  return Effect.fail(
    validationError(
      input.integration,
      `Invalid integration config ${input.key}; expected ${input.allowed.join(' | ')}`,
      value
    )
  )
}

const portConfig = (
  integration: ConnectorIntegration,
  key: string,
  fallback: number
): Effect.Effect<number, ConnectorError> => {
  const value = configValue(integration, key)
  if (value === undefined) return Effect.succeed(fallback)

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN

  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
    return Effect.succeed(parsed)
  }

  return Effect.fail(
    validationError(integration, `Invalid integration config ${key}; expected port 1-65535`, value)
  )
}

const incomingConnection = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const protocol = yield* enumConfig({
      integration,
      key: emailIncomingProtocolConfigKey,
      allowed: ['imap', 'pop3'] as const,
      fallback: 'imap' as const
    })
    const host = yield* requiredHost(integration, emailIncomingHostConfigKey)
    const security = yield* enumConfig({
      integration,
      key: emailIncomingSecurityConfigKey,
      allowed: ['none', 'starttls', 'tls'] as const,
      fallback: 'tls' as const
    })
    const defaultPort =
      protocol === 'imap' ? (security === 'tls' ? 993 : 143) : security === 'tls' ? 995 : 110
    const port = yield* portConfig(integration, emailIncomingPortConfigKey, defaultPort)
    return EmailIncomingConnection.make({ protocol, host, port, security })
  })

const smtpConnection = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const protocol = yield* enumConfig({
      integration,
      key: emailSmtpProtocolConfigKey,
      allowed: ['smtp'] as const,
      fallback: 'smtp' as const
    })
    const host = yield* requiredHost(integration, emailSmtpHostConfigKey)
    const security = yield* enumConfig({
      integration,
      key: emailSmtpSecurityConfigKey,
      allowed: ['none', 'starttls', 'tls'] as const,
      fallback: 'starttls' as const
    })
    const defaultPort = security === 'tls' ? 465 : security === 'starttls' ? 587 : 25
    const port = yield* portConfig(integration, emailSmtpPortConfigKey, defaultPort)
    return EmailSmtpConnection.make({ protocol, host, port, security })
  })

const usableCredential = (
  integration: ConnectorIntegration,
  credential: RuntimeCredential,
  slot: CredentialSlot
) => {
  if (credential._tag === 'UsernamePasswordCredential') return Effect.succeed(credential)
  return Effect.fail(
    new ConnectorError({
      cause: 'credential_invalid',
      message: `Credential slot ${slot.id} requires username/password`,
      connectorId: integration.connectorId,
      slotId: slot.id
    })
  )
}

const requireRecipient = (integration: ConnectorIntegration, message: EmailComposeMessage) =>
  message.to.length > 0 || (message.cc?.length ?? 0) > 0 || (message.bcc?.length ?? 0) > 0
    ? Effect.void
    : Effect.fail(validationError(integration, 'Email submission requires at least one recipient'))

const rejectPop3Folder = (
  integration: ConnectorIntegration,
  connection: EmailIncomingConnection,
  folder: string | undefined
) =>
  connection.protocol === 'pop3' && folder !== undefined
    ? Effect.fail(
        validationError(
          integration,
          'POP3 does not support folders; omit the folder input or configure IMAP'
        )
      )
    : Effect.void

const requireImap = (
  integration: ConnectorIntegration,
  connection: EmailIncomingConnection,
  operation = 'Draft creation'
): Effect.Effect<EmailImapConnection, ConnectorError> =>
  connection.protocol === 'imap'
    ? Effect.succeed(
        EmailImapConnection.make({
          protocol: connection.protocol,
          host: connection.host,
          port: connection.port,
          security: connection.security
        })
      )
    : Effect.fail(validationError(integration, `${operation} requires IMAP; POP3 is read-only`))

export const emailListMessagesAction = defineAction({
  id: 'email.list_messages',
  description: 'List normalized messages from a configured IMAP or POP3 account.',
  access: 'read',
  inputSchema: EmailListMessagesInput,
  outputSchema: EmailListMessagesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const connection = yield* incomingConnection(integration)
      yield* rejectPop3Folder(integration, connection, input.folder)
      const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)
      const client = yield* EmailClient
      return yield* client.listMessages(
        EmailListMessagesRequest.make({
          connection,
          credential,
          folder: input.folder,
          cursor: input.cursor,
          limit: input.limit ?? 50
        })
      )
    })
})

export const emailGetMessageAction = defineAction({
  id: 'email.get_message',
  description: 'Get one normalized message from a configured IMAP or POP3 account.',
  access: 'read',
  inputSchema: EmailGetMessageInput,
  outputSchema: EmailGetMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const connection = yield* incomingConnection(integration)
      yield* rejectPop3Folder(integration, connection, input.folder)
      const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)
      const client = yield* EmailClient
      return yield* client.getMessage(
        EmailGetMessageRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder
        })
      )
    })
})

export const emailGetAttachmentAction = defineAction({
  id: 'email.get_attachment',
  description: 'Get one decoded attachment from a configured IMAP or POP3 account as base64.',
  access: 'read',
  inputSchema: EmailGetAttachmentInput,
  outputSchema: EmailGetAttachmentOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const connection = yield* incomingConnection(integration)
      yield* rejectPop3Folder(integration, connection, input.folder)
      const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)
      const client = yield* EmailClient
      const getAttachment = client.getAttachment
      if (getAttachment === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support attachment retrieval')
        )
      }
      const result = yield* getAttachment(
        EmailGetAttachmentRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          attachmentId: input.attachmentId,
          folder: input.folder
        })
      )
      if (result._tag === 'Failure') {
        return result
      }
      const output = yield* Schema.decodeUnknownEffect(EmailGetAttachmentOutput)(result.value).pipe(
        Effect.mapError(error =>
          validationError(integration, 'EmailClient returned invalid attachment output', error)
        )
      )
      return ActionResult.success(output)
    })
})

export const emailCreateDraftAction = defineAction({
  id: 'email.create_draft',
  description: 'Save a normalized message draft in a configured IMAP account.',
  access: 'write',
  inputSchema: EmailCreateDraftInput,
  outputSchema: EmailCreateDraftOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const incoming = yield* incomingConnection(integration)
      const connection = yield* requireImap(integration, incoming)
      const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)
      const client = yield* EmailClient
      return yield* client.createDraft(
        EmailCreateDraftRequest.make({
          connection,
          credential,
          message: input.message,
          folder: input.folder
        })
      )
    })
})

export const emailSendMessageAction = defineAction({
  id: 'email.send_message',
  description: 'Submit a normalized message to a configured SMTP server.',
  access: 'destructive',
  inputSchema: EmailSendMessageInput,
  outputSchema: EmailSendMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      yield* requireRecipient(integration, input.message)
      const connection = yield* smtpConnection(integration)
      const resolved = yield* resolveCredential(integration, EmailSmtpCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailSmtpCredentialSlot)
      const client = yield* EmailClient
      return yield* client.sendMessage(
        EmailSendMessageRequest.make({ connection, credential, message: input.message })
      )
    })
})

const emailMutationContext = (integration: ConnectorIntegration, operation: string) =>
  Effect.gen(function* () {
    const incoming = yield* incomingConnection(integration)
    const connection = yield* requireImap(integration, incoming, operation)
    const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)
    const credential = yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)
    const client = yield* EmailClient
    return { connection, credential, client }
  })

export const emailSetReadAction = defineAction({
  id: 'email.set_read',
  description:
    'Mark an IMAP message read (isRead: true) or unread (isRead: false). Folder defaults to INBOX; requires host setRead support.',
  access: 'write',
  inputSchema: EmailSetReadInput,
  outputSchema: EmailSetReadOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const { connection, credential, client } = yield* emailMutationContext(
        integration,
        'Changing read state'
      )
      if (client.setRead === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support setRead')
        )
      }
      const result = yield* client.setRead(
        EmailSetReadRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          isRead: input.isRead
        })
      )
      if (result._tag === 'Failure') return result
      const output = yield* Schema.decodeUnknownEffect(EmailSetReadOutput)(result.value).pipe(
        Effect.mapError(error =>
          validationError(integration, 'EmailClient returned invalid setRead output', error)
        )
      )
      return ActionResult.success(output)
    })
})

export const emailTrashAction = defineAction({
  id: 'email.trash',
  description:
    'Move an IMAP message to trash, never permanently delete it. Source folder defaults to INBOX; host discovers trash unless trashFolder is supplied.',
  access: 'destructive',
  inputSchema: EmailTrashInput,
  outputSchema: EmailMoveMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const { connection, credential, client } = yield* emailMutationContext(integration, 'Trash')
      if (client.trash === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support trash')
        )
      }
      const result = yield* client.trash(
        EmailTrashRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          trashFolder: input.trashFolder
        })
      )
      if (result._tag === 'Failure') return result
      const output = yield* Schema.decodeUnknownEffect(EmailMoveMessageOutput)(result.value).pipe(
        Effect.mapError(error =>
          validationError(integration, 'EmailClient returned invalid trash output', error)
        )
      )
      return ActionResult.success(output)
    })
})

export const emailUntrashAction = defineAction({
  id: 'email.untrash',
  description:
    'Move an IMAP message out of trash to destinationFolder (default: INBOX), not its original folder. Host discovers the source trash folder unless folder is supplied.',
  access: 'write',
  inputSchema: EmailUntrashInput,
  outputSchema: EmailMoveMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const { connection, credential, client } = yield* emailMutationContext(integration, 'Untrash')
      if (client.untrash === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support untrash')
        )
      }
      const result = yield* client.untrash(
        EmailUntrashRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder,
          destinationFolder: input.destinationFolder ?? EmailFolderName.make('INBOX')
        })
      )
      if (result._tag === 'Failure') return result
      const output = yield* Schema.decodeUnknownEffect(EmailMoveMessageOutput)(result.value).pipe(
        Effect.mapError(error =>
          validationError(integration, 'EmailClient returned invalid untrash output', error)
        )
      )
      return ActionResult.success(output)
    })
})

export const emailActions = [
  emailListMessagesAction,
  emailGetMessageAction,
  emailGetAttachmentAction,
  emailCreateDraftAction,
  emailSendMessageAction,
  emailSetReadAction,
  emailTrashAction,
  emailUntrashAction
]

export const EmailConnector = defineConnector({
  id: emailConnectorId,
  description: 'Portable IMAP, POP3, and SMTP email connector actions.',
  actions: emailActions
})
