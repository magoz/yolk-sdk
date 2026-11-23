// Fortnox SIE export (`bookkeeping` scope). Sources: Fortnox OpenAPI `GET /3/sie/{Type}`
// (https://api.fortnox.se/apidocs: "Retrieves a SIE file as streamed content",
// `application/octet-stream`; the tag example `https://api.fortnox.se/3/sie/4?financialyear=1`)
// and the archived resource page (developer.fortnox.se/documentation/resources/sie): type 1 year
// balances, 2 adds monthly period balances, 3 adds object (cost center, project) balances, 4 adds
// every voucher of the financial year. SIE files are IBM PC 8-bit text (`#FORMAT PC8`, code page
// 437) whose first record is `#FLAGGA` (SIE filformat 4C, section 5.8 and the `#FLAGGA` and
// `#FORMAT` records, https://sie.se/format/).
//
// The bytes are returned untouched (never decoded into the model's context): as an agent tool the
// action returns them as a file (ADR 0009). The complete-string `ConnectorHttpClient` cannot carry
// IBM437 bytes, so the action reads the optional host `ConnectorBinaryHttpClient` port and fails
// with `validation_failed` when the host provides none.
import { Effect, Option, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { bytesToBase64 } from '../base64-internal.ts'
import { ConnectorBinaryHttpClient } from '../binary-http.ts'
import { ConnectorError } from '../error.ts'
import { connectorActionFile } from '../file-output.ts'
import { ConnectorHttpResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import { FortnoxFinancialYearId } from './bookkeeping.ts'
import { FortnoxBookkeepingOAuthCredentialSlot } from './oauth.ts'
import { fortnoxApiBaseUrl, providerFailure, resolveFortnoxAccessToken } from './shared.ts'

/** SIE file types Fortnox exports: 1 year balances, 2 period balances, 3 object balances, 4 transactions. */
export const FortnoxSieType = Schema.Literals([1, 2, 3, 4])

export type FortnoxSieType = typeof FortnoxSieType.Type

/** Character encoding of every Fortnox SIE file (`#FORMAT PC8`). */
export const fortnoxSieEncoding = 'IBM437'

/**
 * Largest SIE file the action accepts (actual bytes, enforced by the host while streaming). Fortnox
 * documents no limit; a type 4 export holds every voucher of the year.
 */
export const fortnoxSieFileMaxBytes = 50 * 1024 * 1024

const maxErrorBodyBytes = 64 * 1024

export class FortnoxGetSieFileInput extends Schema.Class<FortnoxGetSieFileInput>(
  'FortnoxGetSieFileInput'
)({
  sieType: FortnoxSieType,
  financialYearId: FortnoxFinancialYearId
}) {}

const sieFileFields = {
  sieType: FortnoxSieType,
  financialYearId: FortnoxFinancialYearId,
  fileName: Schema.String,
  mimeType: Schema.Literal('text/plain'),
  encoding: Schema.Literal(fortnoxSieEncoding),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
}

/** The SIE file metadata the agent tool shows (the bytes become a file). */
export class FortnoxSieFile extends Schema.Class<FortnoxSieFile>('FortnoxSieFile')(sieFileFields) {}

export class FortnoxGetSieFileOutput extends Schema.Class<FortnoxGetSieFileOutput>(
  'FortnoxGetSieFileOutput'
)({
  ...sieFileFields,
  /** The untouched IBM437 file bytes as standard base64. */
  contentBase64: Schema.String
}) {}

const flagga = new TextEncoder().encode('#FLAGGA')

const isWhitespace = (byte: number | undefined) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a

/** A SIE file's first record is `#FLAGGA` (leading whitespace tolerated). */
const startsLikeSie = (bytes: Uint8Array) => {
  let start = 0

  while (start < bytes.length && isWhitespace(bytes[start])) start++

  return flagga.every((byte, offset) => bytes[start + offset] === byte)
}

const actionId = 'fortnox.get_sie_file'

const failure = (
  integration: ConnectorIntegration,
  cause: ConnectorError['cause'],
  message: string
) => new ConnectorError({ cause, message, connectorId: integration.connectorId, actionId })

const getSieFile = (integration: ConnectorIntegration, input: FortnoxGetSieFileInput) =>
  Effect.gen(function* () {
    const http = Option.getOrUndefined(yield* Effect.serviceOption(ConnectorBinaryHttpClient))

    if (http === undefined) {
      return yield* failure(
        integration,
        'validation_failed',
        'fortnox.get_sie_file needs the host ConnectorBinaryHttpClient port: SIE files are IBM437 bytes'
      )
    }

    const token = yield* resolveFortnoxAccessToken(
      integration,
      FortnoxBookkeepingOAuthCredentialSlot
    )

    const answer = yield* http
      .request({
        method: 'GET',
        url: `${fortnoxApiBaseUrl}/sie/${input.sieType}?financialyear=${input.financialYearId}`,
        headers: { authorization: `Bearer ${token}`, accept: 'application/octet-stream' },
        redirect: 'manual',
        credentials: 'omit',
        maxBytes: fortnoxSieFileMaxBytes,
        maxErrorBodyBytes
      })
      .pipe(Effect.result)

    if (Result.isFailure(answer)) {
      return answer.failure.code === 'response_too_large'
        ? ActionResult.failure({
            code: 'fortnox_response_too_large',
            message: `The Fortnox SIE file is larger than ${fortnoxSieFileMaxBytes} bytes; export a lower SIE type`
          })
        : yield* failure(
            integration,
            'transport_failed',
            `Fortnox SIE export failed: ${answer.failure.code}`
          )
    }

    const response = answer.success

    if (response.status !== 200) {
      // Error answers carry `ErrorInformation` JSON; a truncated body only loses its detail.
      return yield* providerFailure(
        ConnectorHttpResponse.make({
          status: response.status,
          headers: response.headers,
          body: new TextDecoder().decode(response.bytes)
        })
      )
    }

    if (
      !response.bodyComplete ||
      response.bytes.byteLength === 0 ||
      response.bytes.byteLength > fortnoxSieFileMaxBytes
    ) {
      return yield* failure(integration, 'validation_failed', 'Incomplete Fortnox SIE file')
    }

    if (!startsLikeSie(response.bytes)) {
      return yield* failure(
        integration,
        'validation_failed',
        'Fortnox SIE export answered a body that does not start with #FLAGGA'
      )
    }

    return ActionResult.success(
      FortnoxGetSieFileOutput.make({
        sieType: input.sieType,
        financialYearId: input.financialYearId,
        fileName: `fortnox-sie${input.sieType}-year-${input.financialYearId}.se`,
        mimeType: 'text/plain',
        encoding: fortnoxSieEncoding,
        byteLength: response.bytes.byteLength,
        contentBase64: bytesToBase64(response.bytes)
      })
    )
  })

export const fortnoxGetSieFileAction = defineAction({
  id: actionId,
  description:
    'Export the SIE file of one Fortnox financial year: sieType 1 (year opening and closing balances of every account), 2 (adds monthly period balances), 3 (adds cost center and project balances), or 4 (adds every voucher of the year). The file is IBM437 (code page 437, #FORMAT PC8) text and can be large. As an agent tool it returns { value, files }: value is the file metadata (fileName, encoding, byteLength) and files is a one-item array holding the SIE file (a FileRef with its fileId, or FileUnavailable when it was not stored); its text is not returned. Invoked directly it returns the bytes as base64.',
  access: 'read',
  inputSchema: FortnoxGetSieFileInput,
  outputSchema: FortnoxGetSieFileOutput,
  fileOutput: {
    schema: FortnoxSieFile,
    split: output => {
      const { contentBase64, ...metadata } = output

      return {
        value: FortnoxSieFile.make(metadata),
        files: [
          connectorActionFile({
            base64: contentBase64,
            mimeType: metadata.mimeType,
            filename: metadata.fileName
          })
        ]
      }
    }
  },
  execute: ({ integration, input }) => getSieFile(integration, input)
})

export const fortnoxSieActions = [fortnoxGetSieFileAction] as const
