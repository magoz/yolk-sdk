import { ConnectorFileTransferError } from '../file-transfer.ts'
import type { ConnectorFileTransferBudget, ConnectorFileBytes } from '../file-transfer.ts'
import {
  ByteLimit,
  SafeText,
  credentialFailure,
  decodeInput,
  failTransfer,
  fileBytes,
  isBytes,
  validateTransfer
} from '../transfer-internal.ts'
import { Context, Effect, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { requiredStringConfig } from '../config.ts'
import { defineConnector } from '../connector.ts'
import {
  EmailBatchMessageIds,
  EmailBatchOperationOutput,
  EmailBatchOperationStatus,
  EmailBatchResultCode,
  EmailBatchSummary
} from '../email-batch.ts'

export {
  EmailBatchMessageIds,
  EmailBatchOperationOutput,
  EmailBatchOperationStatus,
  EmailBatchResultCode,
  EmailBatchResultItem,
  EmailBatchSummary
} from '../email-batch.ts'

import {
  CredentialSlot,
  type CredentialResolver,
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

const EmailHeaderName = Schema.Trimmed.check(Schema.isNonEmpty())

export class EmailMessageHeader extends Schema.Class<EmailMessageHeader>('EmailMessageHeader')({
  name: EmailHeaderName,
  value: Schema.String
}) {}

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

/**
 * IMAP keyword used as a portable email label (RFC 3501 `atom`).
 *
 * Keywords are ASCII printable characters except `atom-specials` (`(`, `)`, `{`, space,
 * CTLs, `%`, `*`, `"`, `\`, `]`). The pattern therefore also rejects IMAP system flags
 * such as `\Seen`, which always start with a backslash, plus any whitespace, control,
 * non-ASCII, or empty value. Surrounding whitespace is rejected rather than trimmed so
 * malformed keywords never silently become valid ones.
 */
export const EmailImapKeyword = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[!#$&'+,\-\/.0-9:;<=>?@A-Z\[^_`a-z|}~]+$/)
)

export type EmailImapKeyword = typeof EmailImapKeyword.Type

export class EmailMessageSummary extends Schema.Class<EmailMessageSummary>('EmailMessageSummary')({
  id: Schema.String,
  subject: Schema.optional(Schema.String),
  from: Schema.Array(EmailAddress),
  to: Schema.Array(EmailAddress),
  sentAt: Schema.optional(Schema.String),
  receivedAt: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  hasAttachments: Schema.Boolean,
  labels: Schema.optional(Schema.Array(EmailImapKeyword)),
  isRead: Schema.optional(Schema.Boolean),
  isFlagged: Schema.optional(Schema.Boolean)
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
  attachments: Schema.Array(EmailAttachmentMetadata),
  labels: Schema.optional(Schema.Array(EmailImapKeyword)),
  isRead: Schema.optional(Schema.Boolean),
  isFlagged: Schema.optional(Schema.Boolean),
  headers: Schema.Array(EmailMessageHeader)
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
  limit: Schema.optional(EmailPageSize),
  isRead: Schema.optional(Schema.Boolean),
  isFlagged: Schema.optional(Schema.Boolean)
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

export class EmailMoveInput extends Schema.Class<EmailMoveInput>('EmailMoveInput')({
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  destinationFolder: EmailFolderName
}) {}

const moveRequiresDifferentFolder = Schema.makeFilter<{
  readonly folder?: string
  readonly destinationFolder: string
}>(input =>
  (input.folder ?? 'INBOX') === input.destinationFolder
    ? {
        path: ['destinationFolder'],
        issue: 'move requires destinationFolder to differ from folder'
      }
    : undefined
)

const EmailMoveActionInput = EmailMoveInput.check(moveRequiresDifferentFolder)

export class EmailMoveRequest extends Schema.Class<EmailMoveRequest>('EmailMoveRequest')({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageId: EmailNonEmptyMessageId,
  folder: EmailFolderName,
  destinationFolder: EmailFolderName
}) {}

export class EmailSetFlagInput extends Schema.Class<EmailSetFlagInput>('EmailSetFlagInput')({
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  isFlagged: Schema.Boolean
}) {}

export class EmailSetFlagOutput extends Schema.Class<EmailSetFlagOutput>('EmailSetFlagOutput')({
  messageId: EmailNonEmptyMessageId,
  isFlagged: Schema.Boolean
}) {}

export class EmailSetFlagRequest extends Schema.Class<EmailSetFlagRequest>('EmailSetFlagRequest')({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageId: EmailNonEmptyMessageId,
  folder: EmailFolderName,
  isFlagged: Schema.Boolean
}) {}

export class EmailModifyLabelsInput extends Schema.Class<EmailModifyLabelsInput>(
  'EmailModifyLabelsInput'
)({
  messageId: EmailNonEmptyMessageId,
  folder: Schema.optional(EmailFolderName),
  addLabels: Schema.optional(Schema.Array(EmailImapKeyword)),
  removeLabels: Schema.optional(Schema.Array(EmailImapKeyword))
}) {}

const modifyLabelsRequiresField = Schema.makeFilter<{
  readonly addLabels?: ReadonlyArray<string>
  readonly removeLabels?: ReadonlyArray<string>
}>(input =>
  input.addLabels === undefined && input.removeLabels === undefined
    ? {
        path: ['addLabels'],
        issue: 'modify requires addLabels or removeLabels'
      }
    : undefined
)

const EmailModifyLabelsActionInput = EmailModifyLabelsInput.check(modifyLabelsRequiresField)

export class EmailModifyLabelsOutput extends Schema.Class<EmailModifyLabelsOutput>(
  'EmailModifyLabelsOutput'
)({
  messageId: EmailNonEmptyMessageId,
  labels: Schema.Chunk(EmailImapKeyword)
}) {}

export class EmailModifyLabelsRequest extends Schema.Class<EmailModifyLabelsRequest>(
  'EmailModifyLabelsRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageId: EmailNonEmptyMessageId,
  folder: EmailFolderName,
  addLabels: Schema.optional(Schema.Array(EmailImapKeyword)),
  removeLabels: Schema.optional(Schema.Array(EmailImapKeyword))
}) {}

export class EmailBatchSetReadInput extends Schema.Class<EmailBatchSetReadInput>(
  'EmailBatchSetReadInput'
)({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  isRead: Schema.Boolean
}) {}

const EmailBatchSetReadActionInput = Schema.Struct(EmailBatchSetReadInput.fields)

export class EmailBatchSetFlagInput extends Schema.Class<EmailBatchSetFlagInput>(
  'EmailBatchSetFlagInput'
)({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  isFlagged: Schema.Boolean
}) {}

const EmailBatchSetFlagActionInput = Schema.Struct(EmailBatchSetFlagInput.fields)

export class EmailBatchTrashInput extends Schema.Class<EmailBatchTrashInput>(
  'EmailBatchTrashInput'
)({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  trashFolder: Schema.optional(EmailFolderName)
}) {}

const EmailBatchTrashActionInput = Schema.Struct(EmailBatchTrashInput.fields)

export class EmailBatchUntrashInput extends Schema.Class<EmailBatchUntrashInput>(
  'EmailBatchUntrashInput'
)({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  destinationFolder: Schema.optional(EmailFolderName)
}) {}

const EmailBatchUntrashActionInput = Schema.Struct(EmailBatchUntrashInput.fields)

export class EmailBatchMoveInput extends Schema.Class<EmailBatchMoveInput>('EmailBatchMoveInput')({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  destinationFolder: EmailFolderName
}) {}

const EmailBatchMoveActionInput = Schema.Struct(EmailBatchMoveInput.fields).check(
  moveRequiresDifferentFolder
)

export class EmailBatchModifyLabelsInput extends Schema.Class<EmailBatchModifyLabelsInput>(
  'EmailBatchModifyLabelsInput'
)({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  addLabels: Schema.optional(Schema.Array(EmailImapKeyword)),
  removeLabels: Schema.optional(Schema.Array(EmailImapKeyword))
}) {}

const EmailBatchModifyLabelsActionInput = Schema.Struct(EmailBatchModifyLabelsInput.fields).check(
  modifyLabelsRequiresField
)

export class EmailDeletePermanentlyInput extends Schema.Class<EmailDeletePermanentlyInput>(
  'EmailDeletePermanentlyInput'
)({
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName)
}) {}

const EmailDeletePermanentlyActionInput = Schema.Struct(EmailDeletePermanentlyInput.fields)

export class EmailBatchSetReadRequest extends Schema.Class<EmailBatchSetReadRequest>(
  'EmailBatchSetReadRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: EmailFolderName,
  isRead: Schema.Boolean
}) {}

export class EmailBatchSetFlagRequest extends Schema.Class<EmailBatchSetFlagRequest>(
  'EmailBatchSetFlagRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: EmailFolderName,
  isFlagged: Schema.Boolean
}) {}

export class EmailBatchTrashRequest extends Schema.Class<EmailBatchTrashRequest>(
  'EmailBatchTrashRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: EmailFolderName,
  trashFolder: Schema.optional(EmailFolderName)
}) {}

export class EmailBatchUntrashRequest extends Schema.Class<EmailBatchUntrashRequest>(
  'EmailBatchUntrashRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: Schema.optional(EmailFolderName),
  destinationFolder: EmailFolderName
}) {}

export class EmailBatchMoveRequest extends Schema.Class<EmailBatchMoveRequest>(
  'EmailBatchMoveRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: EmailFolderName,
  destinationFolder: EmailFolderName
}) {}

export class EmailBatchModifyLabelsRequest extends Schema.Class<EmailBatchModifyLabelsRequest>(
  'EmailBatchModifyLabelsRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: EmailFolderName,
  addLabels: Schema.optional(Schema.Array(EmailImapKeyword)),
  removeLabels: Schema.optional(Schema.Array(EmailImapKeyword))
}) {}

export class EmailDeletePermanentlyRequest extends Schema.Class<EmailDeletePermanentlyRequest>(
  'EmailDeletePermanentlyRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  messageIds: EmailBatchMessageIds,
  folder: EmailFolderName
}) {}

export class EmailBatchMoveResultItem extends Schema.Class<EmailBatchMoveResultItem>(
  'EmailBatchMoveResultItem'
)({
  messageId: EmailNonEmptyMessageId,
  status: EmailBatchOperationStatus,
  code: Schema.optional(EmailBatchResultCode),
  movedMessageId: Schema.optional(EmailNonEmptyMessageId),
  folder: Schema.optional(EmailFolderName)
}) {}

/**
 * Every succeeded result from `email.batch_move`, `email.batch_trash`, or
 * `email.batch_untrash` must include destination `folder`. `movedMessageId` is
 * optional and must only be supplied when the adapter knows the destination
 * UIDVALIDITY/UID mapping; omit it and re-list the destination when no reliable
 * mapping is available, never reusing a stale source UID.
 */
export class EmailBatchMoveOutput extends Schema.Class<EmailBatchMoveOutput>(
  'EmailBatchMoveOutput'
)({
  results: Schema.Array(EmailBatchMoveResultItem),
  summary: EmailBatchSummary
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

export const EmailSentCopyStatus = Schema.Literals(['saved', 'failed', 'skipped', 'unsupported'])

export type EmailSentCopyStatus = typeof EmailSentCopyStatus.Type

/**
 * Host-owned Sent-copy details for `email.send_message`. The connector resolves the
 * IMAP connection and incoming credential and passes them with the SMTP request so
 * the host can render once, submit the same bytes, and append the Sent copy without
 * resubmission. Hosts own all APPEND mechanics; there is no separate append port.
 * `folder` selects the Sent mailbox; when omitted the host discovers it.
 */
export class EmailSentCopyRequest extends Schema.Class<EmailSentCopyRequest>(
  'EmailSentCopyRequest'
)({
  connection: EmailImapConnection,
  credential: UsernamePasswordCredential,
  folder: Schema.optional(EmailFolderName)
}) {}

/**
 * Sent-copy outcome for `email.send_message`. `saved` means the host stored the
 * submitted bytes; `failed` means storage failed or could not be confirmed after
 * SMTP acceptance (never resend); `skipped` means
 * saving was disabled via `saveToSentItems: false`; `unsupported` means saving was
 * requested but unavailable (POP3, missing IMAP incoming, or a legacy host that
 * omits `sentCopy`). A missing `sentCopy` from a legacy host is synthesized by the
 * action as `unsupported` (saving requested) or `skipped` (disabled), never `saved`.
 */
export class EmailSentCopyOutput extends Schema.Class<EmailSentCopyOutput>('EmailSentCopyOutput')({
  status: EmailSentCopyStatus,
  folder: Schema.optional(EmailFolderName)
}) {}

export class EmailSendMessageInput extends Schema.Class<EmailSendMessageInput>(
  'EmailSendMessageInput'
)({
  message: EmailComposeMessage,
  saveToSentItems: Schema.optional(Schema.Boolean),
  sentFolder: Schema.optional(EmailFolderName)
}) {}

const unverifiedSentCopyWarning =
  'SMTP submission was accepted, but its receipt or Sent-copy metadata could not be verified. Do not resend.'

export class EmailSendMessageOutput extends Schema.Class<EmailSendMessageOutput>(
  'EmailSendMessageOutput'
)({
  accepted: Schema.Literal(true),
  submissionId: Schema.optional(Schema.String),
  sentCopy: Schema.optional(EmailSentCopyOutput),
  warning: Schema.optional(Schema.Literal(unverifiedSentCopyWarning))
}) {}

// Ancillary metadata cannot erase an already-confirmed external submission.
const EmailSubmissionReceipt = Schema.Struct({
  accepted: Schema.Literal(true),
  submissionId: Schema.optional(Schema.Unknown)
})

export class EmailListMessagesRequest extends Schema.Class<EmailListMessagesRequest>(
  'EmailListMessagesRequest'
)({
  connection: EmailIncomingConnection,
  credential: UsernamePasswordCredential,
  folder: Schema.optional(EmailFolderName),
  cursor: Schema.optional(Schema.String),
  limit: EmailPageSize,
  isRead: Schema.optional(Schema.Boolean),
  isFlagged: Schema.optional(Schema.Boolean)
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
  message: EmailComposeMessage,
  sentCopy: Schema.optional(EmailSentCopyRequest)
}) {}

export interface EmailAttachmentBytesResult extends ConnectorFileBytes {
  readonly messageId: string
  readonly attachmentId: string
  readonly filename?: string
  readonly contentType?: string
}

export type EmailClientApi = {
  /** Optional host-only raw MIME attachment path. Bound actual decoded bytes while streaming,
   * preserve read flags (IMAP BODY.PEEK), cancel/release MIME streams, never base64 roundtrip.
   * POP3 may need a bounded full-message fetch. Host errors must contain codes only. */
  readonly getAttachmentBytes?: (
    input: EmailGetAttachmentRequest & { readonly maxBytes: number }
  ) => Effect.Effect<EmailAttachmentBytesResult, ConnectorFileTransferError>
  readonly listMessages: (
    input: EmailListMessagesRequest
  ) => Effect.Effect<ActionResult<EmailListMessagesOutput>, ConnectorError>
  /** Filter-aware list path. Filtered requests never fall back to listMessages. */
  readonly listMessagesFiltered?: (
    input: EmailListMessagesRequest
  ) => Effect.Effect<ActionResult<EmailListMessagesOutput>, ConnectorError>
  /**
   * Hosts MUST return the RFC 5322 message headers as `headers`: IMAP via `BODY.PEEK[HEADER]`,
   * POP3 via `TOP`. Return an empty array only when the server response contains no headers;
   * never omit headers to save a fetch.
   */
  readonly getMessage: (
    input: EmailGetMessageRequest
  ) => Effect.Effect<ActionResult<EmailGetMessageOutput>, ConnectorError>
  readonly getAttachment?: (
    input: EmailGetAttachmentRequest
  ) => Effect.Effect<ActionResult<EmailGetAttachmentOutput>, ConnectorError>
  readonly setRead?: (
    input: EmailSetReadRequest
  ) => Effect.Effect<ActionResult<EmailSetReadOutput>, ConnectorError>
  /**
   * Optional host-only IMAP flag mutation. Hosts resolve the UID from the opaque
   * `messageId` (which encodes UIDVALIDITY and UID) in `folder`, then set or clear the
   * `\Flagged` system flag with UID-addressed `STORE` (`+FLAGS.SILENT` to flag,
   * `-FLAGS.SILENT` to unflag), preserving every other flag and keyword. Hosts check
   * `PERMANENTFLAGS` first and return an `ActionResult.failure` when the server does not
   * support the flag.
   */
  readonly setFlag?: (
    input: EmailSetFlagRequest
  ) => Effect.Effect<ActionResult<EmailSetFlagOutput>, ConnectorError>
  readonly trash?: (
    input: EmailTrashRequest
  ) => Effect.Effect<ActionResult<EmailMoveMessageOutput>, ConnectorError>
  readonly untrash?: (
    input: EmailUntrashRequest
  ) => Effect.Effect<ActionResult<EmailMoveMessageOutput>, ConnectorError>
  /**
   * Optional host-only IMAP message relocation. Hosts resolve the UID from the opaque
   * `messageId` (which encodes UIDVALIDITY and UID) in `folder`, then move it to
   * `destinationFolder` with UID-addressed `MOVE` (RFC 6851) when the server advertises it,
   * otherwise `COPY` plus flagging `\Deleted` and expunging only the moved UID. Hosts preserve
   * flags and keywords, never blanket-expunge, reject identical source/destination folders
   * with a failure, and own partial-move reconciliation. Moved IDs
   * must use destination UIDVALIDITY/UID when known; omit `messageId` and re-list the
   * destination when no reliable mapping is available, never reusing a stale source UID.
   */
  readonly move?: (
    input: EmailMoveRequest
  ) => Effect.Effect<ActionResult<EmailMoveMessageOutput>, ConnectorError>
  /**
   * Optional host-only IMAP keyword-label mutation. Hosts resolve the UID from the opaque
   * `messageId` (which encodes UIDVALIDITY and UID) in `folder`, then apply keyword changes
   * with UID-addressed `STORE` using `+FLAGS.SILENT` for `addLabels` and `-FLAGS.SILENT`
   * for `removeLabels`, preserving every other keyword and system flag (never overwrite the
   * whole flags list). Hosts check `PERMANENTFLAGS` first and return an `ActionResult.failure`
   * for unsupported keywords; removals win when a keyword appears in both lists. Keywords
   * implicitly exist through message assignment, so there is no label-catalog lifecycle:
   * removing a keyword from all messages removes its usage. Returns the schema-validated
   * `messageId` plus the resulting keyword set as an Effect `Chunk` (for example via
   * `Chunk.fromIterable`), matching other `Chunk` domain outputs in this package.
   */
  readonly modifyLabels?: (
    input: EmailModifyLabelsRequest
  ) => Effect.Effect<ActionResult<EmailModifyLabelsOutput>, ConnectorError>
  /**
   * Batch methods process one source folder and return one result for every requested ID. Result
   * codes are sanitized classifications only; never expose raw provider errors. `unknown` marks an
   * ambiguous outcome and `not_attempted` marks an ID the host did not try.
   */
  readonly batchSetRead?: (
    input: EmailBatchSetReadRequest
  ) => Effect.Effect<ActionResult<EmailBatchOperationOutput>, ConnectorError>
  readonly batchSetFlag?: (
    input: EmailBatchSetFlagRequest
  ) => Effect.Effect<ActionResult<EmailBatchOperationOutput>, ConnectorError>
  readonly batchMove?: (
    input: EmailBatchMoveRequest
  ) => Effect.Effect<ActionResult<EmailBatchMoveOutput>, ConnectorError>
  readonly batchTrash?: (
    input: EmailBatchTrashRequest
  ) => Effect.Effect<ActionResult<EmailBatchMoveOutput>, ConnectorError>
  readonly batchUntrash?: (
    input: EmailBatchUntrashRequest
  ) => Effect.Effect<ActionResult<EmailBatchMoveOutput>, ConnectorError>
  readonly batchModifyLabels?: (
    input: EmailBatchModifyLabelsRequest
  ) => Effect.Effect<ActionResult<EmailBatchOperationOutput>, ConnectorError>
  /**
   * Permanently remove exactly the UID-scoped messages identified by messageIds from folder.
   * Hosts must never issue a blanket EXPUNGE and must not claim deletion from backups or provider
   * retention systems. Approval and authorization remain host policy.
   */
  readonly deletePermanently?: (
    input: EmailDeletePermanentlyRequest
  ) => Effect.Effect<ActionResult<EmailBatchOperationOutput>, ConnectorError>
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

const validationError = (integration: ConnectorIntegration, message: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message,
    connectorId: integration.connectorId
  })

const invalidHostOutput = (
  integration: ConnectorIntegration,
  message: string,
  error: Schema.SchemaError
) =>
  new ConnectorError({
    cause: 'validation_failed',
    message,
    connectorId: integration.connectorId,
    underlying: error
  })

const requiredHost = (integration: ConnectorIntegration, key: string) =>
  Effect.map(requiredStringConfig(integration, key), value => value.trim())

const enumConfig = <Value extends string>(input: {
  readonly integration: ConnectorIntegration
  readonly key: string
  readonly allowed: ReadonlyArray<Value>
  readonly fallback: Value
}) => {
  const value: unknown = Object.getOwnPropertyDescriptor(input.integration.config, input.key)?.value

  if (value === undefined) return Effect.succeed(input.fallback)

  const match = Predicate.isString(value)
    ? input.allowed.find(candidate => candidate === value)
    : undefined

  if (match !== undefined) return Effect.succeed(match)

  return Effect.fail(
    new ConnectorError({
      cause: 'validation_failed',
      message: `Invalid integration config ${input.key}; expected ${input.allowed.join(' | ')}`,
      connectorId: input.integration.connectorId,
      underlying: value
    })
  )
}

const portConfig = (
  integration: ConnectorIntegration,
  key: string,
  fallback: number
): Effect.Effect<number, ConnectorError> => {
  const value: unknown = Object.getOwnPropertyDescriptor(integration.config, key)?.value

  if (value === undefined) return Effect.succeed(fallback)

  const parsed = Predicate.isNumber(value)
    ? value
    : Predicate.isString(value) && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN

  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
    return Effect.succeed(parsed)
  }

  return Effect.fail(
    new ConnectorError({
      cause: 'validation_failed',
      message: `Invalid integration config ${key}; expected port 1-65535`,
      connectorId: integration.connectorId,
      underlying: value
    })
  )
}

const incomingDefaultPort = {
  imap: { tls: 993, starttls: 143, none: 143 },
  pop3: { tls: 995, starttls: 110, none: 110 }
} satisfies Record<EmailIncomingProtocol, Record<EmailSecurity, number>>

const smtpDefaultPort = {
  tls: 465,
  starttls: 587,
  none: 25
} satisfies Record<EmailSecurity, number>

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

    const defaultPort = incomingDefaultPort[protocol][security]

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

    const defaultPort = smtpDefaultPort[security]
    const port = yield* portConfig(integration, emailSmtpPortConfigKey, defaultPort)

    return EmailSmtpConnection.make({ protocol, host, port, security })
  })

const usableCredential = (
  integration: ConnectorIntegration,
  credential: RuntimeCredential,
  slot: CredentialSlot
): Effect.Effect<UsernamePasswordCredential, ConnectorError> =>
  Match.value(credential).pipe(
    Match.tag('UsernamePasswordCredential', current => Effect.succeed(current)),
    Match.tag('ApiKeyCredential', 'BearerTokenCredential', 'OAuthCredential', () =>
      Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: `Credential slot ${slot.id} requires username/password`,
          connectorId: integration.connectorId,
          slotId: slot.id
        })
      )
    ),
    Match.exhaustive
  )

const requireRecipient = (integration: ConnectorIntegration, message: EmailComposeMessage) =>
  message.to.length > 0 || (message.cc?.length ?? 0) > 0 || (message.bcc?.length ?? 0) > 0
    ? Effect.void
    : Effect.fail(validationError(integration, 'Email submission requires at least one recipient'))

const rejectPop3Folder = (
  integration: ConnectorIntegration,
  connection: EmailIncomingConnection,
  folder: string | undefined
): Effect.Effect<void, ConnectorError> =>
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
  description:
    'List normalized messages from a configured IMAP or POP3 account, optionally filtering IMAP messages by read or flagged state.',
  access: 'read',
  inputSchema: EmailListMessagesInput,
  outputSchema: EmailListMessagesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const connection = yield* incomingConnection(integration)
      yield* rejectPop3Folder(integration, connection, input.folder)

      const filtered = input.isRead !== undefined || input.isFlagged !== undefined

      if (connection.protocol === 'pop3' && filtered) {
        return yield* Effect.fail(
          validationError(
            integration,
            'POP3 does not support read or flagged filters; configure IMAP or omit the filters'
          )
        )
      }

      const client = yield* EmailClient
      const listMessages = filtered ? client.listMessagesFiltered : client.listMessages

      if (listMessages === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support filtered message listing')
        )
      }

      const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)

      const request = EmailListMessagesRequest.make({
        connection,
        credential,
        folder: input.folder,
        cursor: input.cursor,
        limit: input.limit ?? 50,
        isRead: input.isRead,
        isFlagged: input.isFlagged
      })

      const result = yield* listMessages.call(client, request)

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailListMessagesOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid listMessages output', error)
        )
      )

      return ActionResult.success(output)
    })
})

export const emailGetMessageAction = defineAction({
  id: 'email.get_message',
  description:
    'Get one normalized message with required headers from a configured IMAP or POP3 account.',
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

      const result = yield* client.getMessage(
        EmailGetMessageRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder
        })
      )

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailGetMessageOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid getMessage output', error)
        )
      )

      return ActionResult.success(output)
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

      if (Predicate.isTagged(result, 'Failure')) {
        return result
      }

      const output = yield* Schema.decodeUnknownEffect(EmailGetAttachmentOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid attachment output', error)
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

/**
 * Build the optional Sent-copy request for `email.send_message`. Saving is requested
 * unless the caller explicitly opts out with `saveToSentItems: false`; in that case
 * no incoming config or credential is touched. When saving is requested, the IMAP
 * incoming connection and credential are resolved before SMTP invocation and passed
 * with the SMTP request so the host can append the Sent copy without resubmission.
 * Sent saving is best-effort configuration: POP3, a missing/unusable incoming
 * setup, or an opt-out sends via SMTP anyway and the output reports `unsupported`
 * (saving requested but unavailable) or `skipped` (disabled). SMTP submission is
 * never blocked by Sent-save prerequisites, and no raw credentials or errors leak
 * into the result.
 */
const resolveSentCopyRequest = (
  integration: ConnectorIntegration,
  input: EmailSendMessageInput
): Effect.Effect<EmailSentCopyRequest | undefined, never, CredentialResolver> =>
  Effect.gen(function* () {
    if (input.saveToSentItems === false) return undefined

    const incoming = yield* incomingConnection(integration).pipe(
      Effect.catch(() => Effect.succeed(undefined))
    )

    if (incoming === undefined || incoming.protocol !== 'imap') return undefined

    const credential = yield* Effect.gen(function* () {
      const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot)

      return yield* usableCredential(integration, resolved, EmailIncomingCredentialSlot)
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (credential === undefined) return undefined

    let request: EmailSentCopyRequest = {
      connection: EmailImapConnection.make({
        protocol: 'imap',
        host: incoming.host,
        port: incoming.port,
        security: incoming.security
      }),
      credential
    }

    if (input.sentFolder !== undefined) request = { ...request, folder: input.sentFolder }

    return EmailSentCopyRequest.make(request)
  })

export const emailSendMessageAction = defineAction({
  id: 'email.send_message',
  description:
    'Submit a normalized message to a configured SMTP server. Success reports SMTP acceptance ({ accepted: true }), not delivery. When Sent saving is requested (the default) and the incoming account uses IMAP, the connector attaches IMAP Sent-copy details so the host can store the same submitted bytes without resubmission; the returned sentCopy reports saved | failed | skipped | unsupported. A Sent-save failure after acceptance never means the message was not sent: do not resend.',
  access: 'destructive',
  inputSchema: EmailSendMessageInput,
  outputSchema: EmailSendMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      yield* requireRecipient(integration, input.message)
      const sentCopy = yield* resolveSentCopyRequest(integration, input)
      const connection = yield* smtpConnection(integration)
      const resolved = yield* resolveCredential(integration, EmailSmtpCredentialSlot)
      const credential = yield* usableCredential(integration, resolved, EmailSmtpCredentialSlot)
      const client = yield* EmailClient

      let request: EmailSendMessageRequest = { connection, credential, message: input.message }

      if (sentCopy !== undefined) request = { ...request, sentCopy }

      const result = yield* client.sendMessage(EmailSendMessageRequest.make(request))

      if (Predicate.isTagged(result, 'Failure')) return result

      const receipt = yield* Schema.decodeUnknownEffect(EmailSubmissionReceipt)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid sendMessage output', error)
        )
      )

      const output = yield* Schema.decodeUnknownEffect(EmailSendMessageOutput)(result.value).pipe(
        Effect.catch(() => {
          let unverified: EmailSendMessageOutput = {
            accepted: true,
            sentCopy: EmailSentCopyOutput.make({ status: 'failed' }),
            warning: unverifiedSentCopyWarning
          }

          if (Predicate.isString(receipt.submissionId)) {
            unverified = { ...unverified, submissionId: receipt.submissionId }
          }

          return Effect.succeed(EmailSendMessageOutput.make(unverified))
        })
      )

      if (output.sentCopy !== undefined) return ActionResult.success(output)

      // Legacy hosts omit sentCopy: synthesize the honest non-saved status. Saving
      // requested means storage was unavailable; disabled means it was skipped.
      let legacy: EmailSendMessageOutput = {
        accepted: true,
        sentCopy: EmailSentCopyOutput.make({
          status: input.saveToSentItems === false ? 'skipped' : 'unsupported'
        })
      }

      if (output.submissionId !== undefined)
        legacy = { ...legacy, submissionId: output.submissionId }

      return ActionResult.success(EmailSendMessageOutput.make(legacy))
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

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailSetReadOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid setRead output', error)
        )
      )

      return ActionResult.success(output)
    })
})

export const emailSetFlagAction = defineAction({
  id: 'email.set_flag',
  description:
    'Flag (isFlagged: true) or unflag (isFlagged: false) an IMAP message for follow-up. Folder defaults to INBOX; requires host setFlag support.',
  access: 'write',
  inputSchema: EmailSetFlagInput,
  outputSchema: EmailSetFlagOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const { connection, credential, client } = yield* emailMutationContext(
        integration,
        'Changing flag state'
      )

      if (client.setFlag === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support setFlag')
        )
      }

      const result = yield* client.setFlag(
        EmailSetFlagRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          isFlagged: input.isFlagged
        })
      )

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailSetFlagOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid setFlag output', error)
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

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailMoveMessageOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid trash output', error)
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

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailMoveMessageOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid untrash output', error)
        )
      )

      return ActionResult.success(output)
    })
})

export const emailModifyLabelsAction = defineAction({
  id: 'email.modify_labels',
  description:
    'Add or remove IMAP keyword labels on a message. Folder defaults to INBOX; requires host modifyLabels support. Keywords only, never system flags.',
  access: 'write',
  inputSchema: EmailModifyLabelsActionInput,
  outputSchema: EmailModifyLabelsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const { connection, credential, client } = yield* emailMutationContext(
        integration,
        'Modifying labels'
      )

      if (client.modifyLabels === undefined) {
        return yield* Effect.fail(
          validationError(integration, 'EmailClient does not support modifyLabels')
        )
      }

      const result = yield* client.modifyLabels(
        EmailModifyLabelsRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          addLabels: input.addLabels,
          removeLabels: input.removeLabels
        })
      )

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailModifyLabelsOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid modifyLabels output', error)
        )
      )

      return ActionResult.success(output)
    })
})

export const emailMoveAction = defineAction({
  id: 'email.move',
  description:
    'Move an IMAP message to destinationFolder, never delete it. Source folder defaults to INBOX and must differ from the destination; requires host move support. Returns the destination folder and the new message ID when known.',
  access: 'write',
  inputSchema: EmailMoveActionInput,
  outputSchema: EmailMoveMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const { connection, credential, client } = yield* emailMutationContext(integration, 'Move')

      if (client.move === undefined) {
        return yield* Effect.fail(validationError(integration, 'EmailClient does not support move'))
      }

      const result = yield* client.move(
        EmailMoveRequest.make({
          connection,
          credential,
          messageId: input.messageId,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          destinationFolder: input.destinationFolder
        })
      )

      if (Predicate.isTagged(result, 'Failure')) return result

      const output = yield* Schema.decodeUnknownEffect(EmailMoveMessageOutput)(result.value).pipe(
        Effect.mapError(error =>
          invalidHostOutput(integration, 'EmailClient returned invalid move output', error)
        )
      )

      return ActionResult.success(output)
    })
})

type EmailBatchOutputContract = {
  readonly results: ReadonlyArray<{
    readonly messageId: string
    readonly status: EmailBatchOperationStatus
    readonly folder?: string
  }>
  readonly summary: {
    readonly requested: number
    readonly succeeded: number
    readonly failed: number
    readonly unknown: number
    readonly notAttempted: number
  }
}

const validateBatchOutput = <Output extends EmailBatchOutputContract>(input: {
  readonly integration: ConnectorIntegration
  readonly operation: string
  readonly requestedIds: ReadonlyArray<string>
  readonly outputSchema: Schema.Schema<Output> & { readonly DecodingServices: never }
  readonly value: unknown
  readonly moved: boolean
}) =>
  Effect.gen(function* () {
    const output = yield* Schema.decodeUnknownEffect(input.outputSchema)(input.value).pipe(
      Effect.mapError(error =>
        invalidHostOutput(
          input.integration,
          `EmailClient returned invalid ${input.operation} output`,
          error
        )
      )
    )

    const hasOrderedIds =
      output.results.length === input.requestedIds.length &&
      output.results.every((result, index) => result.messageId === input.requestedIds[index])

    const counts = {
      succeeded: 0,
      failed: 0,
      unknown: 0,
      notAttempted: 0
    }

    for (const result of output.results) {
      if (result.status === 'not_attempted') counts.notAttempted += 1
      else counts[result.status] += 1
    }

    const summaryMatches =
      output.summary.requested === input.requestedIds.length &&
      output.summary.succeeded === counts.succeeded &&
      output.summary.failed === counts.failed &&
      output.summary.unknown === counts.unknown &&
      output.summary.notAttempted === counts.notAttempted

    const successfulMovesHaveFolders =
      !input.moved ||
      output.results.every(result => result.status !== 'succeeded' || result.folder !== undefined)

    if (!hasOrderedIds || !summaryMatches || !successfulMovesHaveFolders) {
      return yield* Effect.fail(
        validationError(
          input.integration,
          `EmailClient returned inconsistent ${input.operation} output`
        )
      )
    }

    return output
  })

type EmailBatchHostMethod<Request, Output> = (
  request: Request
) => Effect.Effect<ActionResult<Output>, ConnectorError>

const executeEmailBatch = <Request, Output extends EmailBatchOutputContract>(input: {
  readonly integration: ConnectorIntegration
  readonly operation: string
  readonly methodName: string
  readonly requestedIds: ReadonlyArray<string>
  readonly getMethod: (client: EmailClientApi) => EmailBatchHostMethod<Request, Output> | undefined
  readonly makeRequest: (
    connection: EmailImapConnection,
    credential: UsernamePasswordCredential
  ) => Request
  readonly outputSchema: Schema.Schema<Output> & { readonly DecodingServices: never }
  readonly moved?: boolean
}) =>
  Effect.gen(function* () {
    const { connection, credential, client } = yield* emailMutationContext(
      input.integration,
      input.operation
    )

    const method = input.getMethod(client)

    if (method === undefined) {
      return yield* Effect.fail(
        validationError(input.integration, `EmailClient does not support ${input.methodName}`)
      )
    }

    const result = yield* method.call(client, input.makeRequest(connection, credential))

    if (Predicate.isTagged(result, 'Failure')) return result

    const output = yield* validateBatchOutput({
      integration: input.integration,
      operation: input.methodName,
      requestedIds: input.requestedIds,
      outputSchema: input.outputSchema,
      value: result.value,
      moved: input.moved ?? false
    })

    return ActionResult.success(output)
  })

export const emailBatchSetReadAction = defineAction({
  id: 'email.batch_set_read',
  description:
    'Mark 1-100 unique IMAP messages read or unread in one source folder. Requires host batchSetRead support.',
  access: 'write',
  inputSchema: EmailBatchSetReadActionInput,
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Changing read state in batch',
      methodName: 'batchSetRead',
      requestedIds: input.messageIds,
      getMethod: client => client.batchSetRead,
      makeRequest: (connection, credential) =>
        EmailBatchSetReadRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          isRead: input.isRead
        }),
      outputSchema: EmailBatchOperationOutput
    })
})

export const emailBatchSetFlagAction = defineAction({
  id: 'email.batch_set_flag',
  description:
    'Flag or unflag 1-100 unique IMAP messages in one source folder. Requires host batchSetFlag support.',
  access: 'write',
  inputSchema: EmailBatchSetFlagActionInput,
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Changing flag state in batch',
      methodName: 'batchSetFlag',
      requestedIds: input.messageIds,
      getMethod: client => client.batchSetFlag,
      makeRequest: (connection, credential) =>
        EmailBatchSetFlagRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          isFlagged: input.isFlagged
        }),
      outputSchema: EmailBatchOperationOutput
    })
})

export const emailBatchMoveAction = defineAction({
  id: 'email.batch_move',
  description:
    'Move 1-100 unique IMAP messages from one source folder to one destination folder. Requires host batchMove support. Every succeeded result includes destination folder; movedMessageId is optional and only supplied when the destination UIDVALIDITY/UID mapping is known.',
  access: 'write',
  inputSchema: EmailBatchMoveActionInput,
  outputSchema: EmailBatchMoveOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Moving messages in batch',
      methodName: 'batchMove',
      requestedIds: input.messageIds,
      getMethod: client => client.batchMove,
      makeRequest: (connection, credential) =>
        EmailBatchMoveRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          destinationFolder: input.destinationFolder
        }),
      outputSchema: EmailBatchMoveOutput,
      moved: true
    })
})

export const emailBatchTrashAction = defineAction({
  id: 'email.batch_trash',
  description:
    'Move 1-100 unique IMAP messages from one source folder to trash. Requires host batchTrash support. Every succeeded result includes destination folder; movedMessageId is optional and only supplied when the destination UIDVALIDITY/UID mapping is known.',
  access: 'destructive',
  inputSchema: EmailBatchTrashActionInput,
  outputSchema: EmailBatchMoveOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Trashing messages in batch',
      methodName: 'batchTrash',
      requestedIds: input.messageIds,
      getMethod: client => client.batchTrash,
      makeRequest: (connection, credential) =>
        EmailBatchTrashRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          trashFolder: input.trashFolder
        }),
      outputSchema: EmailBatchMoveOutput,
      moved: true
    })
})

export const emailBatchUntrashAction = defineAction({
  id: 'email.batch_untrash',
  description:
    'Move 1-100 unique IMAP messages from one trash folder to one destination folder. Requires host batchUntrash support. Every succeeded result includes destination folder; movedMessageId is optional and only supplied when the destination UIDVALIDITY/UID mapping is known.',
  access: 'write',
  inputSchema: EmailBatchUntrashActionInput,
  outputSchema: EmailBatchMoveOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Restoring messages in batch',
      methodName: 'batchUntrash',
      requestedIds: input.messageIds,
      getMethod: client => client.batchUntrash,
      makeRequest: (connection, credential) =>
        EmailBatchUntrashRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder,
          destinationFolder: input.destinationFolder ?? EmailFolderName.make('INBOX')
        }),
      outputSchema: EmailBatchMoveOutput,
      moved: true
    })
})

export const emailBatchModifyLabelsAction = defineAction({
  id: 'email.batch_modify_labels',
  description:
    'Add or remove IMAP keyword labels on 1-100 unique messages in one source folder. Requires host batchModifyLabels support.',
  access: 'write',
  inputSchema: EmailBatchModifyLabelsActionInput,
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Modifying message labels in batch',
      methodName: 'batchModifyLabels',
      requestedIds: input.messageIds,
      getMethod: client => client.batchModifyLabels,
      makeRequest: (connection, credential) =>
        EmailBatchModifyLabelsRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder ?? EmailFolderName.make('INBOX'),
          addLabels: input.addLabels,
          removeLabels: input.removeLabels
        }),
      outputSchema: EmailBatchOperationOutput
    })
})

export const emailDeletePermanentlyAction = defineAction({
  id: 'email.delete_permanently',
  description:
    'Permanently remove exactly 1-100 unique UID-scoped IMAP messages from one source folder. Never blanket-expunges; host approval policy applies.',
  access: 'destructive',
  inputSchema: EmailDeletePermanentlyActionInput,
  outputSchema: EmailBatchOperationOutput,
  execute: ({ integration, input }) =>
    executeEmailBatch({
      integration,
      operation: 'Permanently deleting messages',
      methodName: 'deletePermanently',
      requestedIds: input.messageIds,
      getMethod: client => client.deletePermanently,
      makeRequest: (connection, credential) =>
        EmailDeletePermanentlyRequest.make({
          connection,
          credential,
          messageIds: input.messageIds,
          folder: input.folder ?? EmailFolderName.make('INBOX')
        }),
      outputSchema: EmailBatchOperationOutput
    })
})

export const emailActions = [
  emailListMessagesAction,
  emailGetMessageAction,
  emailGetAttachmentAction,
  emailCreateDraftAction,
  emailSendMessageAction,
  emailSetReadAction,
  emailSetFlagAction,
  emailTrashAction,
  emailUntrashAction,
  emailModifyLabelsAction,
  emailMoveAction,
  emailBatchSetReadAction,
  emailBatchSetFlagAction,
  emailBatchMoveAction,
  emailBatchTrashAction,
  emailBatchUntrashAction,
  emailBatchModifyLabelsAction,
  emailDeletePermanentlyAction
]

export const EmailConnector = defineConnector({
  id: emailConnectorId,
  description: 'Portable IMAP, POP3, and SMTP email connector actions.',
  actions: emailActions
})

/** Host-only attachment retrieval; old EmailClient adapters and base64 action remain unchanged. */
export const downloadEmailAttachment = (
  integration: ConnectorIntegration,
  input: { readonly messageId: string; readonly attachmentId: string; readonly folder?: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, emailConnectorId, budget)

    const target = yield* decodeInput(
      Schema.Struct({
        messageId: SafeText,
        attachmentId: SafeText,
        folder: Schema.optional(EmailFolderName)
      }),
      input
    )

    const connection = yield* incomingConnection(integration).pipe(
      Effect.catch(() => failTransfer('invalid_input'))
    )

    yield* rejectPop3Folder(integration, connection, target.folder).pipe(
      Effect.catch(() => failTransfer('invalid_input'))
    )

    const resolved = yield* resolveCredential(integration, EmailIncomingCredentialSlot).pipe(
      Effect.mapError(credentialFailure)
    )

    const credential = yield* usableCredential(
      integration,
      resolved,
      EmailIncomingCredentialSlot
    ).pipe(Effect.mapError(credentialFailure))

    const client = yield* EmailClient

    if (client.getAttachmentBytes === undefined) return yield* failTransfer('not_downloadable')
    const request = EmailGetAttachmentRequest.make({ connection, credential, ...target })

    const result = yield* client
      .getAttachmentBytes({ ...request, maxBytes: limits.maxBytes })
      .pipe(Effect.mapError(e => new ConnectorFileTransferError({ code: e.code })))

    const metadata = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        messageId: SafeText,
        attachmentId: SafeText,
        byteLength: ByteLimit,
        filename: Schema.optional(SafeText),
        contentType: Schema.optional(SafeText)
      })
    )(result).pipe(Effect.catch(() => failTransfer('invalid_metadata')))

    if (!isBytes(result.bytes) || result.bytes.byteLength > limits.maxBytes)
      return yield* failTransfer('response_too_large')

    if (
      metadata.byteLength !== result.bytes.byteLength ||
      metadata.messageId !== target.messageId ||
      metadata.attachmentId !== target.attachmentId
    )
      return yield* failTransfer('invalid_metadata')

    return { ...metadata, ...fileBytes(result.bytes) }
  })
