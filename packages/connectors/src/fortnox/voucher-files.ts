// Fortnox voucher file connections (`connectfile` scope): attach archive files to vouchers. Sources:
// Fortnox OpenAPI `GET`/`POST /3/voucherfileconnections` (https://api.fortnox.se/apidocs; schemas
// `fortnox_Da_VoucherFileConnection*`), the archived resource page
// (developer.fortnox.se/documentation/resources/voucher-file-connections), and the scopes guide
// (https://www.fortnox.se/developer/guides-and-good-to-know/scopes: Voucher File Connections need
// `connectfile`).
//
// OpenAPI types `VoucherNumber` as a string in both the payload and the answer and documents no
// MetaInformation on the list; the archived examples send `VoucherNumber` as a string in answers
// and as an integer in the create request, and carry MetaInformation. Answers decode either form.
import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { closedInput, NullableInt, NullableString } from './fields.ts'
import {
  FortnoxFinancialYearId,
  FortnoxVoucherNumber,
  FortnoxVoucherSeriesCode
} from './bookkeeping.ts'
import { FortnoxArchiveFileId, FortnoxConnectFileOAuthCredentialSlot } from './files.ts'
import { FortnoxMetaInformation, readFortnox, singlePage, writeFortnox } from './shared.ts'
import { WireInt, WireNullableInt } from './wire.ts'

export class FortnoxVoucherFileConnection extends Schema.Class<FortnoxVoucherFileConnection>(
  'FortnoxVoucherFileConnection'
)({
  FileId: FortnoxArchiveFileId,
  /** File name, when Fortnox sends it. */
  Name: NullableString,
  VoucherSeries: FortnoxVoucherSeriesCode,
  VoucherNumber: FortnoxVoucherNumber,
  /** Financial year Id of the voucher. */
  VoucherYear: NullableInt,
  VoucherDescription: NullableString
}) {}

const VoucherFileConnectionApi = Schema.Struct({
  ...FortnoxVoucherFileConnection.fields,
  VoucherNumber: WireInt.pipe(Schema.decodeTo(FortnoxVoucherNumber)),
  VoucherYear: WireNullableInt
})

const connectionFromApi = (value: typeof VoucherFileConnectionApi.Type) =>
  FortnoxVoucherFileConnection.make(value)

export class FortnoxListVoucherFileConnectionsInput extends Schema.Class<FortnoxListVoucherFileConnectionsInput>(
  'FortnoxListVoucherFileConnectionsInput'
)({
  voucherSeries: FortnoxVoucherSeriesCode,
  voucherNumber: FortnoxVoucherNumber,
  financialYearId: FortnoxFinancialYearId
}) {}

export class FortnoxListVoucherFileConnectionsOutput extends Schema.Class<FortnoxListVoucherFileConnectionsOutput>(
  'FortnoxListVoucherFileConnectionsOutput'
)({ connections: Schema.Chunk(FortnoxVoucherFileConnection) }) {}

export class FortnoxCreateVoucherFileConnectionInput extends Schema.Class<FortnoxCreateVoucherFileConnectionInput>(
  'FortnoxCreateVoucherFileConnectionInput'
)({
  /** Archive file Id (an archive upload's `Id`, or an inbox file's `ArchiveFileId`). */
  FileId: FortnoxArchiveFileId,
  VoucherSeries: FortnoxVoucherSeriesCode,
  VoucherNumber: FortnoxVoucherNumber,
  /** Financial year Id of the voucher (`Year` on the voucher). */
  VoucherYear: FortnoxFinancialYearId
}) {}

const ConnectionsResponse = Schema.Struct({
  VoucherFileConnections: Schema.Array(VoucherFileConnectionApi),
  MetaInformation: Schema.optional(FortnoxMetaInformation)
}).check(singlePage)

const ConnectionResponse = Schema.Struct({ VoucherFileConnection: VoucherFileConnectionApi })

type VoucherKey = {
  readonly voucherSeries: string
  readonly voucherNumber: number
  readonly financialYearId: number
}

// The query filters are documented search parameters; rows are also matched here, so a filter
// Fortnox ignored never attributes another voucher's files to this one. OpenAPI does not mark
// VoucherYear required, so a row without it is matched by series and number (the voucheryear
// filter already selected the year).
const belongsTo = (key: VoucherKey) => (connection: FortnoxVoucherFileConnection) =>
  connection.VoucherSeries === key.voucherSeries &&
  connection.VoucherNumber === key.voucherNumber &&
  (connection.VoucherYear === undefined ||
    connection.VoucherYear === null ||
    connection.VoucherYear === key.financialYearId)

export const fortnoxListVoucherFileConnectionsAction = defineAction({
  id: 'fortnox.list_voucher_file_connections',
  description:
    'List the archive files attached to one Fortnox voucher, identified by voucherSeries, voucherNumber, and financialYearId. Each connection has the archive FileId and the voucher identity.',
  access: 'read',
  inputSchema: FortnoxListVoucherFileConnectionsInput,
  outputSchema: FortnoxListVoucherFileConnectionsOutput,
  execute: ({ integration, input }) => {
    const query = new URLSearchParams({
      voucherseries: input.voucherSeries,
      vouchernumber: String(input.voucherNumber),
      voucheryear: String(input.financialYearId)
    })

    return readFortnox(
      integration,
      FortnoxConnectFileOAuthCredentialSlot,
      `voucherfileconnections?${query}`,
      ConnectionsResponse,
      value =>
        FortnoxListVoucherFileConnectionsOutput.make({
          connections: Chunk.fromIterable(
            value.VoucherFileConnections.map(connectionFromApi).filter(belongsTo(input))
          )
        })
    )
  }
})

export const fortnoxCreateVoucherFileConnectionAction = defineAction({
  id: 'fortnox.create_voucher_file_connection',
  description:
    'Attach a file in the Fortnox archive to a voucher (verifikation) as its supporting document (underlag). FileId is an archive file Id: the Id an archive upload returned, or the ArchiveFileId of an inbox file (fortnox.get_inbox_folder). The voucher is identified by VoucherSeries, VoucherNumber, and VoucherYear (the financial year Id, Year on the voucher). Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxCreateVoucherFileConnectionInput.fields),
  outputSchema: FortnoxVoucherFileConnection,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxConnectFileOAuthCredentialSlot,
      'POST',
      'voucherfileconnections',
      {
        VoucherFileConnection: {
          FileId: input.FileId,
          // OpenAPI types the payload VoucherNumber as a string.
          VoucherNumber: String(input.VoucherNumber),
          VoucherSeries: input.VoucherSeries,
          VoucherYear: input.VoucherYear
        }
      },
      ConnectionResponse,
      value => connectionFromApi(value.VoucherFileConnection)
    )
})

export const fortnoxVoucherFileActions = [
  fortnoxListVoucherFileConnectionsAction,
  fortnoxCreateVoucherFileConnectionAction
] as const
