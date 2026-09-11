import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorIntegration } from '../integration.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import {
  ByteLimit,
  OpaqueId,
  SafeText,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  headerSafeJson,
  safeToken,
  validateTransfer,
  validateUpload,
  writeBytes
} from '../transfer-internal.ts'
import { DropboxContentWriteOAuthCredentialSlot, resolveDropboxAccessToken } from './shared.ts'

export const dropboxSingleUploadMaxBytes = 150_000_000
export interface DropboxCreateFileInput {
  readonly path: string
  readonly bytes: Uint8Array
}
export interface DropboxUpdateFileInput {
  readonly fileId: string
  readonly expectedRev: string
  readonly bytes: Uint8Array
}
const Create = Schema.Struct({
  path: SafeText.check(
    Schema.makeFilter(
      s =>
        s.startsWith('/') &&
        s
          .split('/')
          .slice(1)
          .every(p => p !== '' && p !== '.' && p !== '..') &&
        !s.includes('\\')
    )
  )
})
const Update = Schema.Struct({
  fileId: OpaqueId.check(Schema.isPattern(/^id:.+$/)),
  expectedRev: Schema.String.check(Schema.isPattern(/^[0-9a-f]{9,}$/))
})
const Metadata = Schema.Struct({
  id: OpaqueId.check(Schema.isPattern(/^id:.+$/)),
  name: SafeText,
  rev: Schema.String.check(Schema.isPattern(/^[0-9a-f]{9,}$/)),
  size: ByteLimit
})
const upload = (
  integration: ConnectorIntegration,
  input: DropboxCreateFileInput | DropboxUpdateFileInput,
  budget: ConnectorFileTransferBudget,
  updating: boolean
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'dropbox', budget)
    yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)
    yield* validateUpload(input.bytes, limits, dropboxSingleUploadMaxBytes)
    const target = updating ? yield* decodeInput(Update, input) : yield* decodeInput(Create, input)
    const path = 'fileId' in target ? target.fileId : target.path
    const mode = 'expectedRev' in target ? { '.tag': 'update', update: target.expectedRev } : 'add'
    const token = yield* resolveDropboxAccessToken(
      integration,
      DropboxContentWriteOAuthCredentialSlot
    ).pipe(Effect.mapError(credentialFailure), Effect.flatMap(safeToken))
    const response = yield* writeBytes({
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/upload',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'dropbox-api-arg': headerSafeJson({ path, mode, autorename: false, strict_conflict: true })
      },
      bytes: input.bytes,
      maxUploadBytes: Math.min(limits.maxBytes, dropboxSingleUploadMaxBytes),
      maxBytes: limits.maxMetadataBytes,
      maxErrorBodyBytes: limits.maxErrorBodyBytes,
      successStatuses: [200, 201],
      redirect: 'manual',
      credentials: 'omit'
    })
    const metadata = yield* decodeMetadata(Metadata, response.bytes)
    if (
      metadata.size !== input.bytes.byteLength ||
      ('fileId' in target && metadata.id !== target.fileId)
    )
      return yield* failTransfer('invalid_metadata')
    return metadata
  })
/** Atomic add: conflicts never rename or overwrite. No automatic retry. */
export const createDropboxFile = (
  integration: ConnectorIntegration,
  input: DropboxCreateFileInput,
  budget: ConnectorFileTransferBudget
) => upload(integration, input, budget, false)
/** Strict revision update: a missing/deleted target is a conflict, never a create. */
export const updateDropboxFile = (
  integration: ConnectorIntegration,
  input: DropboxUpdateFileInput,
  budget: ConnectorFileTransferBudget
) => upload(integration, input, budget, true)
