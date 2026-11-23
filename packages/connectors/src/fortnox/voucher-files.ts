// Fortnox voucher file connections (`connectfile` scope): attach archive files to vouchers. Sources:
// Fortnox OpenAPI `GET`/`POST /3/voucherfileconnections` (https://api.fortnox.se/apidocs; schemas
// `fortnox_Da_VoucherFileConnection*`), the archived resource page
// (developer.fortnox.se/documentation/resources/voucher-file-connections), and the scopes guide
// (https://www.fortnox.se/developer/guides-and-good-to-know/scopes: Voucher File Connections need
// `connectfile`).
//
// OpenAPI types `VoucherNumber` as a string in both the payload and the answer and documents no
// MetaInformation on the list; the archived examples send `VoucherNumber` as a string in answers
// and as an integer in the create request, and carry MetaInformation. Answers decode either form;
// the list requires MetaInformation, as every Fortnox list in this connector does.
import { Chunk, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import { closedInput, NullableInt, NullableString } from './fields.ts'
import {
  FortnoxFinancialYearId,
  FortnoxVoucherNumber,
  FortnoxVoucherSeriesCode
} from './bookkeeping.ts'
import { FortnoxArchiveFileId, FortnoxConnectFileOAuthCredentialSlot } from './files.ts'
import { FortnoxMetaInformation, readFortnox, writeFortnox } from './shared.ts'
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
  MetaInformation: FortnoxMetaInformation
})

const ConnectionResponse = Schema.Struct({ VoucherFileConnection: VoucherFileConnectionApi })

type VoucherKey = {
  readonly voucherSeries: string
  readonly voucherNumber: number
  readonly financialYearId: number
}

// Fortnox searches ignore case (ILIKE, parameters guide), so series codes compare case-insensitively.
const sameSeries = (left: string, right: string) => left.toUpperCase() === right.toUpperCase()

const sameVoucher = (key: VoucherKey, connection: FortnoxVoucherFileConnection) =>
  sameSeries(connection.VoucherSeries, key.voucherSeries) &&
  connection.VoucherNumber === key.voucherNumber

/** Pages read at most (500 rows each) before the list gives up instead of truncating. */
const connectionPageCap = 10

const connectionPageLimit = 500

const listFailure = (integration: ConnectorIntegration, message: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message,
    connectorId: integration.connectorId,
    actionId: 'fortnox.list_voucher_file_connections'
  })

// OpenAPI lists voucherseries, vouchernumber, and voucheryear as this endpoint's filters, but the
// parameters guide allows one resource-specific filter at a time (combined with global parameters
// such as `financialyear`) and searches match substrings. So the list sends `vouchernumber` plus
// the global `financialyear`, reads every page (up to the cap), and matches rows here: a filter
// Fortnox ignored never attributes another voucher's files to this one. A matching series and
// number without a VoucherYear cannot be told apart from another year's voucher and fails.
const listConnections = (integration: ConnectorIntegration, key: VoucherKey) =>
  Effect.gen(function* () {
    const connections: Array<FortnoxVoucherFileConnection> = []

    for (let page = 1; page <= connectionPageCap; page++) {
      const query = new URLSearchParams({
        vouchernumber: String(key.voucherNumber),
        financialyear: String(key.financialYearId),
        page: String(page),
        limit: String(connectionPageLimit)
      })

      const result = yield* readFortnox(
        integration,
        FortnoxConnectFileOAuthCredentialSlot,
        `voucherfileconnections?${query}`,
        ConnectionsResponse,
        value => value
      )

      if (Predicate.isTagged(result, 'Failure')) return result

      for (const row of result.value.VoucherFileConnections) {
        const connection = connectionFromApi(row)

        if (!sameVoucher(key, connection)) continue

        if (connection.VoucherYear === undefined || connection.VoucherYear === null) {
          return yield* listFailure(
            integration,
            'Fortnox listed a connection for this series and number without VoucherYear'
          )
        }

        if (connection.VoucherYear === key.financialYearId) connections.push(connection)
      }

      const meta = result.value.MetaInformation

      if (meta['@CurrentPage'] >= meta['@TotalPages']) {
        return ActionResult.success(
          FortnoxListVoucherFileConnectionsOutput.make({
            connections: Chunk.fromIterable(connections)
          })
        )
      }
    }

    return yield* listFailure(
      integration,
      `Fortnox voucher file connections span more than ${connectionPageCap} pages`
    )
  })

export const fortnoxListVoucherFileConnectionsAction = defineAction({
  id: 'fortnox.list_voucher_file_connections',
  description:
    'List the archive files attached to one Fortnox voucher, identified by voucherSeries, voucherNumber, and financialYearId. Each connection has the archive FileId and the voucher identity.',
  access: 'read',
  inputSchema: FortnoxListVoucherFileConnectionsInput,
  outputSchema: FortnoxListVoucherFileConnectionsOutput,
  execute: ({ integration, input }) => listConnections(integration, input)
})

export const fortnoxCreateVoucherFileConnectionAction = defineAction({
  id: 'fortnox.create_voucher_file_connection',
  description:
    'Attach a file in the Fortnox archive to a voucher (verifikation) as its supporting document (underlag). FileId is an archive file Id: the Id an archive upload returned (an inbox file’s ArchiveFileId from fortnox.get_inbox_folder may also work; not verified). The voucher is identified by VoucherSeries, VoucherNumber, and VoucherYear (the financial year Id, Year on the voucher). If the answer from Fortnox does not prove the requested connection (another file or voucher, or no year), the action fails with fortnox_voucher_mismatch: check the connections of the voucher before trying again. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxCreateVoucherFileConnectionInput.fields),
  outputSchema: FortnoxVoucherFileConnection,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxConnectFileOAuthCredentialSlot,
      'POST',
      // OpenAPI puts VoucherYear in the payload; the archived page marks it read-only and selects
      // the year in the URL (`financialyeardate`). Send it in the body and as the Id form
      // `financialyear` of the parameters guide, so either reading attaches to the requested year.
      `voucherfileconnections?financialyear=${encodeURIComponent(String(input.VoucherYear))}`,
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
    ).pipe(
      Effect.map(result => {
        if (!Predicate.isTagged(result, 'Success')) return result

        const connection = result.value
        const year = connection.VoucherYear

        // Without VoucherYear the answer cannot prove the requested year: fail rather than claim it.
        return connection.FileId === input.FileId &&
          sameSeries(connection.VoucherSeries, input.VoucherSeries) &&
          connection.VoucherNumber === input.VoucherNumber &&
          year === input.VoucherYear
          ? result
          : ActionResult.failure({
              code: 'fortnox_voucher_mismatch',
              message: `Fortnox answered with file ${connection.FileId} connected to voucher ${connection.VoucherSeries} ${connection.VoucherNumber} in financial year ${year ?? 'unknown'}, which does not prove the requested connection. The connection may exist: check fortnox.list_voucher_file_connections and do not create it again.`,
              underlying: {
                fileId: connection.FileId,
                voucherSeries: connection.VoucherSeries,
                voucherNumber: connection.VoucherNumber,
                financialYearId: year ?? null
              }
            })
      })
    )
})

export const fortnoxVoucherFileActions = [
  fortnoxListVoucherFileConnectionsAction,
  fortnoxCreateVoucherFileConnectionAction
] as const
