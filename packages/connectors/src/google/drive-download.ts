import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { CredentialSlot } from '../credential.ts'
import type { ConnectorIntegration } from '../integration.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import {
  OpaqueId,
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
import { GoogleDriveFileOAuthCredentialSlot, googleOAuthSlotId } from './oauth.ts'
import { resolveGoogleAccessToken } from './shared.ts'

export const googleDriveReadonlyScope = 'https://www.googleapis.com/auth/drive.readonly'
export const GoogleDriveReadonlyOAuthCredentialSlot = CredentialSlot.make({
  id: googleOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [googleDriveReadonlyScope]
})
export const googleDriveExportMaxBytes = 10_000_000
export interface GoogleDriveDownloadInput {
  readonly fileId: string
  readonly resourceKey?: string
}
export interface GoogleDriveExportInput extends GoogleDriveDownloadInput {
  readonly mimeType: string
}
/** Host-owned consent selection; metadata-only consent never authorizes file content. */
export interface GoogleDriveDownloadBudget extends ConnectorFileTransferBudget {
  readonly contentAccess?: 'app_files' | 'readonly'
}
const Input = Schema.Struct({
  fileId: OpaqueId.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  resourceKey: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)))
})
const Metadata = Schema.Struct({
  id: OpaqueId,
  name: SafeText,
  mimeType: SafeText,
  size: Schema.optional(Schema.String.check(Schema.isPattern(/^\d+$/))),
  capabilities: Schema.Struct({ canDownload: Schema.Boolean }),
  downloadRestrictions: Schema.optional(
    Schema.Struct({
      effectiveDownloadRestrictionWithContext: Schema.optional(
        Schema.Struct({
          restrictedForReaders: Schema.optional(Schema.Boolean),
          restrictedForWriters: Schema.optional(Schema.Boolean)
        })
      )
    })
  )
})
// Focused, compatible standard exports. Vids, Forms, folders and shortcuts are not exports.
const exportTypes: Readonly<Record<string, readonly string[]>> = {
  'application/vnd.google-apps.document': [
    'application/pdf',
    'text/plain',
    'text/html',
    'application/zip',
    'application/rtf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/epub+zip',
    'text/markdown'
  ],
  'application/vnd.google-apps.spreadsheet': [
    'application/pdf',
    'text/csv',
    'text/tab-separated-values',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet'
  ],
  'application/vnd.google-apps.presentation': [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation'
  ],
  'application/vnd.google-apps.script': ['application/vnd.google-apps.script+json'],
  'application/vnd.google-apps.drawing': [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/svg+xml'
  ]
}
const transfer = (
  integration: ConnectorIntegration,
  input: GoogleDriveDownloadInput,
  budget: GoogleDriveDownloadBudget,
  mimeType?: string
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'google', budget)
    const target = yield* decodeInput(Input, input)
    const access = yield* decodeInput(
      Schema.Literals(['app_files', 'readonly']),
      budget.contentAccess ?? 'app_files'
    )
    if (mimeType !== undefined) yield* decodeInput(SafeText, mimeType)
    const token = yield* resolveGoogleAccessToken(
      integration,
      access === 'readonly'
        ? GoogleDriveReadonlyOAuthCredentialSlot
        : GoogleDriveFileOAuthCredentialSlot
    ).pipe(Effect.mapError(credentialFailure), Effect.flatMap(safeToken))
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (target.resourceKey !== undefined)
      headers['X-Goog-Drive-Resource-Keys'] = `${target.fileId}/${target.resourceKey}`
    const root = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(target.fileId)}`
    const fields =
      'id,name,mimeType,size,capabilities(canDownload),downloadRestrictions(effectiveDownloadRestrictionWithContext)'
    const metadataResponse = yield* readBytes(
      `${root}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
      headers,
      limits,
      true
    )
    const metadata = yield* decodeMetadata(Metadata, metadataResponse.bytes)
    if (metadata.id !== target.fileId) return yield* failTransfer('invalid_metadata')
    // canDownload is caller-specific. Role restriction flags alone do not identify caller role.
    if (!metadata.capabilities.canDownload) return yield* failTransfer('not_downloadable')
    if (mimeType === undefined && metadata.mimeType.startsWith('application/vnd.google-apps.'))
      return yield* failTransfer('not_downloadable')
    if (
      mimeType !== undefined &&
      (!Object.hasOwn(exportTypes, metadata.mimeType) ||
        !exportTypes[metadata.mimeType]?.includes(mimeType))
    )
      return yield* failTransfer('not_downloadable')
    const size = metadata.size === undefined ? undefined : Number(metadata.size)
    if (size !== undefined && !Number.isSafeInteger(size))
      return yield* failTransfer('invalid_metadata')
    if (mimeType === undefined && size !== undefined && size > limits.maxBytes)
      return yield* failTransfer('response_too_large')
    const url =
      mimeType === undefined
        ? `${root}?alt=media&supportsAllDrives=true`
        : `${root}/export?mimeType=${encodeURIComponent(mimeType)}`
    const r = yield* readBytes(url, headers, {
      ...limits,
      maxBytes:
        mimeType === undefined
          ? limits.maxBytes
          : Math.min(limits.maxBytes, googleDriveExportMaxBytes)
    })
    if (mimeType === undefined && size !== undefined && size !== r.bytes.byteLength)
      return yield* failTransfer('partial_content')
    return {
      ...fileBytes(r.bytes),
      source: {
        fileId: metadata.id,
        name: metadata.name,
        mimeType: mimeType ?? metadata.mimeType,
        sourceMimeType: metadata.mimeType,
        exported: mimeType !== undefined
      }
    }
  })
/** Blob bytes only; metadata checked before content. No abuse acknowledgement or shortcut chasing. */
export const downloadGoogleDriveFile = (
  integration: ConnectorIntegration,
  input: GoogleDriveDownloadInput,
  budget: GoogleDriveDownloadBudget
) => transfer(integration, input, budget)
/** Generated export, not original blob content. CSV/TSV cover the first sheet. */
export const exportGoogleDriveFile = (
  integration: ConnectorIntegration,
  input: GoogleDriveExportInput,
  budget: GoogleDriveDownloadBudget
) =>
  Effect.gen(function* () {
    const { mimeType } = yield* decodeInput(Schema.Struct({ mimeType: SafeText }), input)
    return yield* transfer(integration, input, budget, mimeType)
  })
