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
  safeToken,
  validateTransfer,
  validateUpload,
  writeBytes
} from '../transfer-internal.ts'
import { oneDriveWriteSlot } from './drive.ts'
import { resolveMicrosoftAccessToken } from './shared.ts'

export const oneDriveSingleUploadMaxBytes = 250_000_000
export interface OneDriveCreateFileInput {
  readonly driveId?: string
  readonly parentItemId: string
  readonly name: string
  readonly bytes: Uint8Array
}
export interface OneDriveUpdateFileInput {
  readonly driveId?: string
  readonly itemId: string
  readonly bytes: Uint8Array
  readonly acknowledgeOverwrite: true
}
const Name = SafeText.check(
  Schema.makeFilter(
    s => !/["*:<>?\/\\|]/.test(s) && s !== '.' && s !== '..' && s.trim() === s && !s.endsWith('.')
  )
)
const Create = Schema.Struct({
  driveId: Schema.optional(OpaqueId),
  parentItemId: OpaqueId,
  name: Name
})
const Update = Schema.Struct({
  driveId: Schema.optional(OpaqueId),
  itemId: OpaqueId,
  acknowledgeOverwrite: Schema.Literal(true)
})
const Metadata = Schema.Struct({
  id: OpaqueId,
  name: SafeText,
  size: ByteLimit,
  eTag: SafeText,
  cTag: Schema.optional(SafeText),
  file: Schema.Struct({ mimeType: Schema.optional(SafeText) })
})
const upload = (
  integration: ConnectorIntegration,
  input: OneDriveCreateFileInput | OneDriveUpdateFileInput,
  budget: ConnectorFileTransferBudget,
  updating: boolean
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'microsoft', budget)
    yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)
    yield* validateUpload(input.bytes, limits, oneDriveSingleUploadMaxBytes)
    const target = updating ? yield* decodeInput(Update, input) : yield* decodeInput(Create, input)
    const slot = yield* oneDriveWriteSlot(integration, target.driveId).pipe(
      Effect.catch(() => failTransfer('invalid_input'))
    )
    const token = yield* resolveMicrosoftAccessToken(integration, slot).pipe(
      Effect.mapError(credentialFailure),
      Effect.flatMap(safeToken)
    )
    const root =
      target.driveId === undefined ? '/me/drive' : `/drives/${encodeURIComponent(target.driveId)}`
    const path =
      'itemId' in target
        ? `/items/${encodeURIComponent(target.itemId)}/content`
        : `/items/${encodeURIComponent(target.parentItemId)}:/${encodeURIComponent(target.name)}:/content?@microsoft.graph.conflictBehavior=fail`
    const response = yield* writeBytes({
      method: 'PUT',
      url: `https://graph.microsoft.com/v1.0${root}${path}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      bytes: input.bytes,
      maxUploadBytes: Math.min(limits.maxBytes, oneDriveSingleUploadMaxBytes),
      maxBytes: limits.maxMetadataBytes,
      maxErrorBodyBytes: limits.maxErrorBodyBytes,
      successStatuses: [200, 201],
      redirect: 'manual',
      credentials: 'omit'
    })
    const metadata = yield* decodeMetadata(Metadata, response.bytes)
    if (
      metadata.size !== input.bytes.byteLength ||
      ('itemId' in target && metadata.id !== target.itemId) ||
      ('name' in target && metadata.name !== target.name)
    )
      return yield* failTransfer('invalid_metadata')
    return {
      itemId: metadata.id,
      name: metadata.name,
      size: metadata.size,
      eTag: metadata.eTag,
      cTag: metadata.cTag
    }
  })
/** Conflict-failing creation, never the provider's default replacement behavior. */
export const createOneDriveFile = (
  integration: ConnectorIntegration,
  input: OneDriveCreateFileInput,
  budget: ConnectorFileTransferBudget
) => upload(integration, input, budget, false)
/** Unconditional replacement by stable ID. Explicit acknowledgement is NOT atomic CAS. */
export const updateOneDriveFile = (
  integration: ConnectorIntegration,
  input: OneDriveUpdateFileInput,
  budget: ConnectorFileTransferBudget
) => upload(integration, input, budget, true)
