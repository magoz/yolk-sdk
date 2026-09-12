import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorIntegration } from '../integration.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import {
  ByteLimit,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  fileBytes,
  readBytes,
  validateTransfer
} from '../transfer-internal.ts'
import { resolveTelegramBotToken } from './shared.ts'

export const telegramHostedDownloadMaxBytes = 20_000_000

const FileId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))

const File = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    file_id: FileId,
    file_unique_id: Schema.optional(FileId),
    file_size: Schema.optional(ByteLimit),
    file_path: Schema.String.check(
      Schema.makeFilter(
        s =>
          /^[A-Za-z0-9_./-]+$/.test(s) &&
          !s.startsWith('/') &&
          s.split('/').every(p => p !== '' && p !== '.' && p !== '..')
      )
    )
  })
})

/** Hosted Bot API only. URLs contain the token: hosts must never log them. No local filesystem paths. */
export const downloadTelegramFile = (
  integration: ConnectorIntegration,
  input: { readonly fileId: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'telegram', budget)
    const target = yield* decodeInput(Schema.Struct({ fileId: FileId }), input)

    const token = yield* resolveTelegramBotToken(integration).pipe(
      Effect.mapError(credentialFailure)
    )

    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) return yield* failTransfer('credential_failed')

    const metadataResponse = yield* readBytes(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(target.fileId)}`,
      {},
      limits,
      true
    )

    const { result: file } = yield* decodeMetadata(File, metadataResponse.bytes)

    if (file.file_id !== target.fileId) return yield* failTransfer('invalid_metadata')
    const maxBytes = Math.min(limits.maxBytes, telegramHostedDownloadMaxBytes)

    if (file.file_size !== undefined && file.file_size > maxBytes)
      return yield* failTransfer('response_too_large')

    const r = yield* readBytes(
      `https://api.telegram.org/file/bot${token}/${file.file_path}`,
      {},
      { ...limits, maxBytes }
    )

    if (file.file_size !== undefined && file.file_size !== r.bytes.byteLength)
      return yield* failTransfer('partial_content')

    // getFile does not preserve original name/MIME. Never manufacture them from the path.
    return {
      ...fileBytes(r.bytes),
      source: { fileId: file.file_id, fileUniqueId: file.file_unique_id }
    }
  })
