import { Chunk, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { CredentialSlot } from '../credential.ts'
import type { ConnectorIntegration } from '../integration.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import { OpaqueId, SafeText, decodeInput, fileBytes } from '../transfer-internal.ts'
import { NullableString } from './fields.ts'
import { FortnoxInvoiceOAuthCredentialSlot, fortnoxOAuthSlotId } from './oauth.ts'
import { FortnoxDocumentNumber, FortnoxGivenNumber, FortnoxPagination } from './schemas.ts'
import { FortnoxMetaInformation, paginationFromApi, readFortnox } from './shared.ts'
import { downloadFortnoxBytes, uploadFortnoxMultipart } from './transfer.ts'
import { WireNullableNumber } from './wire.ts'

export const fortnoxArchiveScope = 'archive'

export const fortnoxConnectFileScope = 'connectfile'

export const FortnoxArchiveOAuthCredentialSlot = CredentialSlot.make({
  id: fortnoxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [fortnoxArchiveScope]
})

export const FortnoxConnectFileOAuthCredentialSlot = CredentialSlot.make({
  id: fortnoxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [fortnoxConnectFileScope]
})

export class FortnoxListSupplierInvoiceFilesInput extends Schema.Class<FortnoxListSupplierInvoiceFilesInput>(
  'FortnoxListSupplierInvoiceFilesInput'
)({
  givenNumber: FortnoxGivenNumber,
  page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })))
}) {}

export class FortnoxSupplierInvoiceFile extends Schema.Class<FortnoxSupplierInvoiceFile>(
  'FortnoxSupplierInvoiceFile'
)({ fileId: OpaqueId, name: SafeText, givenNumber: FortnoxGivenNumber }) {}

export class FortnoxListSupplierInvoiceFilesOutput extends Schema.Class<FortnoxListSupplierInvoiceFilesOutput>(
  'FortnoxListSupplierInvoiceFilesOutput'
)({ files: Schema.Chunk(FortnoxSupplierInvoiceFile), pagination: FortnoxPagination }) {}

const Connections = Schema.Struct({
  SupplierInvoiceFileConnections: Schema.Array(
    Schema.Struct({ FileId: OpaqueId, Name: SafeText, SupplierInvoiceNumber: FortnoxGivenNumber })
  ),
  MetaInformation: FortnoxMetaInformation
})

export const fortnoxListSupplierInvoiceFilesAction = defineAction({
  id: 'fortnox.list_supplier_invoice_files',
  access: 'read',
  description:
    'List archive file IDs connected to a supplier invoice by internal GivenNumber, not supplier InvoiceNumber. Repeat page/limit to paginate.',
  inputSchema: FortnoxListSupplierInvoiceFilesInput,
  outputSchema: FortnoxListSupplierInvoiceFilesOutput,
  execute: ({ integration, input }) => {
    const query = new URLSearchParams({ supplierinvoicenumber: input.givenNumber })

    if (input.page !== undefined) query.set('page', String(input.page))

    if (input.limit !== undefined) query.set('limit', String(input.limit))

    return readFortnox(
      integration,
      FortnoxConnectFileOAuthCredentialSlot,
      `supplierinvoicefileconnections?${query}`,
      Connections,
      value =>
        FortnoxListSupplierInvoiceFilesOutput.make({
          files: Chunk.fromIterable(
            value.SupplierInvoiceFileConnections.map(f =>
              FortnoxSupplierInvoiceFile.make({
                fileId: f.FileId,
                name: f.Name,
                givenNumber: f.SupplierInvoiceNumber
              })
            )
          ),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
  }
})

const FortnoxPreviewDownloadInput = Schema.Struct({ documentNumber: FortnoxDocumentNumber })

const FortnoxArchiveDownloadInput = Schema.Struct({ fileId: OpaqueId })

const download = <Id extends string>(
  integration: ConnectorIntegration,
  id: Id,
  budget: ConnectorFileTransferBudget,
  preview: boolean
) =>
  Effect.gen(function* () {
    const response = yield* downloadFortnoxBytes(
      integration,
      preview ? FortnoxInvoiceOAuthCredentialSlot : FortnoxArchiveOAuthCredentialSlot,
      preview ? `invoices/${encodeURIComponent(id)}/preview` : `archive/${encodeURIComponent(id)}`,
      budget,
      preview ? 'pdf' : 'binary'
    )

    return { ...fileBytes(response.bytes), source: { id, generatedPreview: preview } }
  })

/** Generated PDF; unlike /print, /preview does not mark the invoice Sent. */
export const downloadFortnoxInvoicePreview = (
  integration: ConnectorIntegration,
  input: { readonly documentNumber: FortnoxDocumentNumber },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const target = yield* decodeInput(FortnoxPreviewDownloadInput, input)

    return yield* download(integration, target.documentNumber, budget, true)
  })

/** Archive ID from discovery, not an external supplier-invoice URL connection. */
export const downloadFortnoxArchiveFile = (
  integration: ConnectorIntegration,
  input: { readonly fileId: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const target = yield* decodeInput(FortnoxArchiveDownloadInput, input)

    return yield* download(integration, target.fileId, budget, false)
  })

/** Id of a file in the Fortnox archive (a GUID; also the `FileId` of file connections). */
export const FortnoxArchiveFileId = OpaqueId.pipe(Schema.brand('FortnoxArchiveFileId'))

export type FortnoxArchiveFileId = typeof FortnoxArchiveFileId.Type

export class FortnoxArchiveFile extends Schema.Class<FortnoxArchiveFile>('FortnoxArchiveFile')({
  Id: FortnoxArchiveFileId,
  Name: NullableString,
  /** Id of the folder holding the file (`root` for the archive root). */
  Path: NullableString,
  /** Bytes. */
  Size: Schema.optional(Schema.NullOr(Schema.Finite)),
  Comments: NullableString
}) {}

// Fortnox OpenAPI (`fortnox_FileStorage_Folder_FileRow`) types Size as an integer; accept a numeric
// string too, as for inbox files.
const ArchiveUploadResponse = Schema.Struct({
  File: Schema.Struct({ ...FortnoxArchiveFile.fields, Size: WireNullableNumber })
})

/**
 * Fortnox documents no archive upload limit. 50 MiB is the same conservative single-request cap as
 * inbox uploads; larger files fail `upload_session_required`.
 */
export const fortnoxArchiveUploadMaxBytes = 50 * 1024 * 1024

export interface FortnoxArchiveUploadInput {
  /** Target archive folder Id; omit for the archive root. */
  readonly folderId?: string
  /** File name Fortnox stores, with extension. */
  readonly fileName: string
  /** Part media type; defaults to `application/octet-stream`. */
  readonly contentType?: string
  readonly bytes: Uint8Array
}

/**
 * Upload one file into the Fortnox archive: a single multipart/form-data POST
 * `/archive[?folderid={folderId}]` (form field `file`; root without a folder) with the `archive`
 * scope, never retried (Fortnox OpenAPI `POST /3/archive`, https://api.fortnox.se/apidocs). The
 * returned `Id` is the `FileId` that `fortnox.create_voucher_file_connection` attaches to a
 * voucher. A transport failure or an undecodable answer may still mean the file was stored.
 */
export const uploadFortnoxArchiveFile = (
  integration: ConnectorIntegration,
  input: FortnoxArchiveUploadInput,
  budget: ConnectorFileTransferBudget
) =>
  uploadFortnoxMultipart(integration, FortnoxArchiveOAuthCredentialSlot, budget, input, {
    path: 'archive',
    folderRequired: false,
    boundaryPrefix: 'yolk-fortnox-archive-',
    maxBytes: fortnoxArchiveUploadMaxBytes,
    response: ArchiveUploadResponse
  }).pipe(Effect.map(metadata => FortnoxArchiveFile.make(metadata.File)))
