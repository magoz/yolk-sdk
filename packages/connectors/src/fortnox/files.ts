import { Chunk, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import type { ConnectorIntegration } from '../integration.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import {
  OpaqueId,
  SafeText,
  credentialFailure,
  decodeInput,
  failTransfer,
  fileBytes,
  readBytes,
  safeToken,
  singleHeader,
  validateTransfer
} from '../transfer-internal.ts'
import { FortnoxInvoiceOAuthCredentialSlot, fortnoxOAuthSlotId } from './oauth.ts'
import { FortnoxDocumentNumber, FortnoxGivenNumber, FortnoxPagination } from './schemas.ts'
import { FortnoxMetaInformation, paginationFromApi, readFortnox } from './shared.ts'

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
    const limits = yield* validateTransfer(integration, 'fortnox', budget)

    const credential = yield* resolveCredential(
      integration,
      preview ? FortnoxInvoiceOAuthCredentialSlot : FortnoxArchiveOAuthCredentialSlot
    ).pipe(Effect.mapError(credentialFailure))

    if (!Predicate.isTagged(credential, 'OAuthCredential') || credential.provider !== 'fortnox')
      return yield* failTransfer('credential_failed')
    const token = yield* safeToken(credential.accessToken)

    const path = preview
      ? `invoices/${encodeURIComponent(id)}/preview`
      : `archive/${encodeURIComponent(id)}`

    const response = yield* readBytes(
      `https://api.fortnox.se/3/${path}`,
      {
        authorization: `Bearer ${token}`,
        accept: preview ? 'application/pdf' : 'application/octet-stream'
      },
      limits
    )

    if (
      preview &&
      singleHeader(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/pdf'
    )
      return yield* failTransfer('invalid_metadata')

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
