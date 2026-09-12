import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorFileTransferError } from '../file-transfer.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  ByteLimit,
  OpaqueId,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  fileBytes,
  readBytes,
  safeToken,
  validateTransfer
} from '../transfer-internal.ts'
import { GoogleGmailReadonlyOAuthCredentialSlot } from './oauth.ts'
import { resolveGoogleAccessToken } from './shared.ts'

export interface GmailDownloadAttachmentInput {
  readonly messageId: string
  readonly attachmentId: string
}

const Input = Schema.Struct({ messageId: OpaqueId, attachmentId: OpaqueId })

const Body = Schema.Struct({ size: ByteLimit, data: Schema.String })

/** Gmail returns JSON/base64url, not raw HTTP bytes. Decode internally; preserve existing base64 actions. */
export const downloadGmailAttachment = (
  integration: ConnectorIntegration,
  input: GmailDownloadAttachmentInput,
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'google', budget)
    const target = yield* decodeInput(Input, input)

    const token = yield* resolveGoogleAccessToken(
      integration,
      GoogleGmailReadonlyOAuthCredentialSlot
    ).pipe(Effect.mapError(credentialFailure), Effect.flatMap(safeToken))

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(target.messageId)}/attachments/${encodeURIComponent(target.attachmentId)}`
    // maxMetadataBytes is the host's separate JSON/base64 expansion budget.
    const response = yield* readBytes(url, { authorization: `Bearer ${token}` }, limits, true)
    const body = yield* decodeMetadata(Body, response.bytes)
    const unpadded = body.data.replace(/=+$/, '')
    const expectedPadding = (4 - (unpadded.length % 4)) % 4

    if (
      !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data) ||
      unpadded.length % 4 === 1 ||
      (body.data.includes('=') && body.data.length !== unpadded.length + expectedPadding)
    )
      return yield* failTransfer('invalid_metadata')
    const decodedLength = Math.floor((unpadded.length * 3) / 4)

    if (body.size > limits.maxBytes || decodedLength > limits.maxBytes)
      return yield* failTransfer('response_too_large')

    if (decodedLength !== body.size) return yield* failTransfer('invalid_metadata')

    const binary = yield* Effect.try({
      try: () =>
        atob(unpadded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(expectedPadding)),
      catch: () => new ConnectorFileTransferError({ code: 'invalid_metadata' })
    })

    if (btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== unpadded)
      return yield* failTransfer('invalid_metadata')
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))

    if (bytes.byteLength !== body.size) return yield* failTransfer('invalid_metadata')

    return { ...fileBytes(bytes), source: target }
  })
