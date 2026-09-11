import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  ByteLimit,
  SafeText,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  fileBytes,
  readBytes,
  safeToken,
  validateTransfer
} from '../transfer-internal.ts'
import { outlookReadSlot } from './mail.ts'
import { resolveMicrosoftAccessToken } from './shared.ts'

export interface OutlookDownloadAttachmentInput {
  readonly messageId: string
  readonly attachmentId: string
  readonly mailbox?: string
}
// Graph IDs are opaque base64 strings and can contain '/'; encode the complete segment.
const GraphId = SafeText.check(Schema.isPattern(/^(?!\.+$)\S+$/))
const Input = Schema.Struct({
  messageId: GraphId,
  attachmentId: GraphId,
  mailbox: Schema.optional(GraphId)
})
const Metadata = Schema.Struct({
  id: GraphId,
  '@odata.type': SafeText,
  name: Schema.optional(SafeText),
  contentType: Schema.optional(SafeText),
  size: Schema.optional(ByteLimit),
  isInline: Schema.optional(Schema.Boolean)
})
/** File attachments only. Item MIME and reference attachments are deliberately unsupported. */
export const downloadOutlookAttachment = (
  integration: ConnectorIntegration,
  input: OutlookDownloadAttachmentInput,
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'microsoft', budget)
    const target = yield* decodeInput(Input, input)
    const slot = yield* outlookReadSlot(integration, target.mailbox).pipe(
      Effect.catch(() => failTransfer('invalid_input'))
    )
    const token = yield* resolveMicrosoftAccessToken(integration, slot).pipe(
      Effect.mapError(credentialFailure),
      Effect.flatMap(safeToken)
    )
    const mailbox =
      target.mailbox === undefined ? '/me' : `/users/${encodeURIComponent(target.mailbox)}`
    const url = `https://graph.microsoft.com/v1.0${mailbox}/messages/${encodeURIComponent(target.messageId)}/attachments/${encodeURIComponent(target.attachmentId)}`
    const headers = { authorization: `Bearer ${token}`, prefer: 'IdType="ImmutableId"' }
    const r = yield* readBytes(
      `${url}?$select=id,name,contentType,size,isInline`,
      headers,
      limits,
      true
    )
    const metadata = yield* decodeMetadata(Metadata, r.bytes)
    if (metadata.id !== target.attachmentId) return yield* failTransfer('invalid_metadata')
    if (metadata['@odata.type'] !== '#microsoft.graph.fileAttachment')
      return yield* failTransfer('not_downloadable')
    // Graph size includes attachment metadata; do not pretend it is the exact raw-byte size.
    const body = yield* readBytes(`${url}/$value`, headers, limits)
    return {
      ...fileBytes(body.bytes),
      source: {
        messageId: target.messageId,
        attachmentId: metadata.id,
        name: metadata.name,
        contentType: metadata.contentType,
        isInline: metadata.isInline
      }
    }
  })
