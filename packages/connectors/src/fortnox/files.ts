import { Chunk, Effect } from 'effect'
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
import { FortnoxPagination } from './schemas.ts'
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
  givenNumber: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })))
}) {}
export class FortnoxSupplierInvoiceFile extends Schema.Class<FortnoxSupplierInvoiceFile>(
  'FortnoxSupplierInvoiceFile'
)({ fileId: OpaqueId, name: SafeText, givenNumber: SafeText }) {}
export class FortnoxListSupplierInvoiceFilesOutput extends Schema.Class<FortnoxListSupplierInvoiceFilesOutput>(
  'FortnoxListSupplierInvoiceFilesOutput'
)({ files: Schema.Chunk(FortnoxSupplierInvoiceFile), pagination: FortnoxPagination }) {}
const Connections = Schema.Struct({
  SupplierInvoiceFileConnections: Schema.Array(
    Schema.Struct({ FileId: OpaqueId, Name: SafeText, SupplierInvoiceNumber: SafeText })
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
const download = (
  integration: ConnectorIntegration,
  input: unknown,
  budget: ConnectorFileTransferBudget,
  preview: boolean
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'fortnox', budget)
    const target = yield* decodeInput(Schema.Struct({ id: OpaqueId }), input)
    const credential = yield* resolveCredential(
      integration,
      preview ? FortnoxInvoiceOAuthCredentialSlot : FortnoxArchiveOAuthCredentialSlot
    ).pipe(Effect.mapError(credentialFailure))
    if (credential._tag !== 'OAuthCredential' || credential.provider !== 'fortnox')
      return yield* failTransfer('credential_failed')
    const token = yield* safeToken(credential.accessToken)
    const path = preview
      ? `invoices/${encodeURIComponent(target.id)}/preview`
      : `archive/${encodeURIComponent(target.id)}`
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
    return { ...fileBytes(response.bytes), source: { id: target.id, generatedPreview: preview } }
  })
/** Generated PDF; unlike /print, /preview does not mark the invoice Sent. */
export const downloadFortnoxInvoicePreview = (
  integration: ConnectorIntegration,
  input: { readonly documentNumber: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const target = yield* decodeInput(Schema.Struct({ documentNumber: OpaqueId }), input)
    return yield* download(integration, { id: target.documentNumber }, budget, true)
  })
/** Archive ID from discovery, not an external supplier-invoice URL connection. */
export const downloadFortnoxArchiveFile = (
  integration: ConnectorIntegration,
  input: { readonly fileId: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const target = yield* decodeInput(Schema.Struct({ fileId: OpaqueId }), input)
    return yield* download(integration, { id: target.fileId }, budget, false)
  })
