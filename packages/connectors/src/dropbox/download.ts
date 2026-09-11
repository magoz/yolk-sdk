import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorBinaryHttpClient } from '../binary-http.ts'
import type { ConnectorBinaryHttpResponse } from '../binary-http.ts'
import type { CredentialResolver } from '../credential.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  DropboxContentReadOAuthCredentialSlot,
  dropboxAuthorizationHeaders,
  dropboxConnectorId,
  dropboxContentApiBaseUrl,
  resolveDropboxAccessToken
} from './shared.ts'

export const DropboxDownloadErrorCode = Schema.Literals([
  'invalid_input',
  'credential_failed',
  'transport_failed',
  'network_policy_rejected',
  'response_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'upstream_failed',
  'invalid_metadata',
  'not_a_file',
  'not_downloadable',
  'unexpected_redirect',
  'partial_content'
])
export type DropboxDownloadErrorCode = typeof DropboxDownloadErrorCode.Type

/** Safe boundary: deliberately contains no upstream message, URL, headers, body or cause. */
export class DropboxDownloadError extends Schema.TaggedErrorClass<DropboxDownloadError>()(
  'DropboxDownloadError',
  { code: DropboxDownloadErrorCode }
) {}

/** A Dropbox `/path`, `id:` file identifier, or `rev:` revision from discovery, never a share link. */
export interface DropboxDownloadInput {
  readonly path: string
}

/** Trusted host configuration, NEVER model/tool parameters. All limits are actual bytes. */
export interface DropboxDownloadBudget {
  readonly maxBytes: number
  readonly maxErrorBodyBytes: number
}

export class DropboxDownloadSource extends Schema.Class<DropboxDownloadSource>(
  'DropboxDownloadSource'
)({
  id: Schema.String,
  name: Schema.String,
  pathLower: Schema.optional(Schema.String),
  pathDisplay: Schema.optional(Schema.String),
  rev: Schema.String,
  size: Schema.Number,
  clientModified: Schema.String,
  serverModified: Schema.String,
  contentHash: Schema.optional(Schema.String)
}) {}

/** Host-only result, not an action output schema or model content. Bytes are never decoded. */
export interface DropboxDownloadResult {
  readonly bytes: Uint8Array
  readonly byteLength: number
  /** Metadata Dropbox returned alongside these bytes; the content hash is not verified here. */
  readonly source: DropboxDownloadSource
  readonly requested: DropboxDownloadInput
}

const fail = (code: DropboxDownloadErrorCode) => Effect.fail(new DropboxDownloadError({ code }))

// Dropbox path, id, rev, or namespace addressing. Control characters never belong in a header arg.
const DropboxPath = Schema.String.check(
  Schema.isPattern(
    /^(?:\/[^\u0000-\u001f\u007f]+|id:[^\u0000-\u001f\u007f\s]+|rev:[0-9a-f]{9,}|ns:[0-9]+\/[^\u0000-\u001f\u007f]+)(?![\s\S])/
  )
)
const Input = Schema.Struct({ path: DropboxPath })
const ByteLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
const Budget = Schema.Struct({ maxBytes: ByteLimit, maxErrorBodyBytes: ByteLimit })
const Metadata = Schema.Struct({
  '.tag': Schema.optional(Schema.Literal('file')),
  id: Schema.String.check(Schema.isNonEmpty()),
  name: Schema.String,
  path_lower: Schema.optional(Schema.NullOr(Schema.String)),
  path_display: Schema.optional(Schema.NullOr(Schema.String)),
  client_modified: Schema.String,
  server_modified: Schema.String,
  rev: Schema.String,
  size: ByteLimit,
  is_downloadable: Schema.optional(Schema.Boolean),
  content_hash: Schema.optional(Schema.String)
})
const ErrorBody = Schema.Struct({ error_summary: Schema.optional(Schema.String) })

const downloadUrl = `${dropboxContentApiBaseUrl}/files/download`

// Dropbox-API-Arg must be HTTP-header-safe JSON: every non-ASCII code unit becomes \uXXXX.
const headerSafeJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

const singleHeader = (headers: Readonly<Record<string, string>>, name: string) => {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name)
  return matches.length === 1 ? matches[0]?.[1] : undefined
}

const statusCode = (status: number): DropboxDownloadErrorCode => {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 413:
      return 'response_too_large'
    case 429:
      return 'rate_limited'
    case 206:
      return 'partial_content'
    default:
      return status >= 300 && status < 400 ? 'unexpected_redirect' : 'upstream_failed'
  }
}

// Dropbox reports endpoint-specific failures as HTTP 409 with an error_summary; classify only.
const conflictCode = (summary: string | undefined): DropboxDownloadErrorCode => {
  if (summary === undefined) return 'upstream_failed'
  if (summary.includes('not_found')) return 'not_found'
  if (summary.includes('not_file')) return 'not_a_file'
  if (summary.includes('unsupported_file')) return 'not_downloadable'
  if (summary.includes('restricted_content')) return 'forbidden'
  if (summary.includes('malformed_path')) return 'invalid_input'
  return 'upstream_failed'
}

// Best-effort bounded error-body classification; the body itself is never exposed.
const errorSummary = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: () => new DropboxDownloadError({ code: 'upstream_failed' })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
    Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
    Effect.result,
    Effect.map(result => (result._tag === 'Success' ? result.success.error_summary : undefined))
  )

const checkBody = (
  response: ConnectorBinaryHttpResponse,
  maxBytes: number,
  maxErrorBodyBytes: number
) => {
  const limit = response.status === 200 ? maxBytes : maxErrorBodyBytes
  if (response.bytes.byteLength > limit) return fail('response_too_large')
  if (
    response.status === 200 &&
    (!response.bodyComplete ||
      Object.keys(response.headers).some(name => name.toLowerCase() === 'content-range'))
  )
    return fail('partial_content')
  return Effect.void
}

/**
 * Download original file bytes using the current dropbox.oauth binding. Not registered in
 * DropboxConnector: a host must materialize and read the result with its own file pipeline.
 * The content endpoint is called once with GET; any redirect is rejected, never followed.
 */
export const downloadDropboxFile = (
  integration: ConnectorIntegration,
  input: DropboxDownloadInput,
  budget: DropboxDownloadBudget
): Effect.Effect<
  DropboxDownloadResult,
  DropboxDownloadError,
  ConnectorBinaryHttpClient | CredentialResolver
> =>
  Effect.gen(function* () {
    const requested = yield* Schema.decodeUnknownEffect(Input)(input).pipe(
      Effect.mapError(() => new DropboxDownloadError({ code: 'invalid_input' }))
    )
    const limits = yield* Schema.decodeUnknownEffect(Budget)(budget).pipe(
      Effect.mapError(() => new DropboxDownloadError({ code: 'invalid_input' }))
    )
    if (integration.connectorId !== dropboxConnectorId) return yield* fail('invalid_input')
    const token = yield* resolveDropboxAccessToken(
      integration,
      DropboxContentReadOAuthCredentialSlot
    ).pipe(Effect.mapError(() => new DropboxDownloadError({ code: 'credential_failed' })))
    const http = yield* ConnectorBinaryHttpClient
    const response = yield* http
      .request({
        method: 'GET',
        url: downloadUrl,
        headers: {
          ...dropboxAuthorizationHeaders(token),
          'dropbox-api-arg': headerSafeJson({ path: requested.path })
        },
        maxBytes: limits.maxBytes,
        maxErrorBodyBytes: limits.maxErrorBodyBytes,
        redirect: 'manual',
        credentials: 'omit'
      })
      .pipe(
        Effect.mapError(
          error =>
            new DropboxDownloadError({
              code:
                error.code === 'response_too_large'
                  ? 'response_too_large'
                  : error.code === 'network_policy_rejected'
                    ? 'network_policy_rejected'
                    : 'transport_failed'
            })
        ),
        Effect.tap(response => checkBody(response, limits.maxBytes, limits.maxErrorBodyBytes))
      )
    if (response.status === 409)
      return yield* fail(conflictCode(yield* errorSummary(response.bytes)))
    if (response.status !== 200) return yield* fail(statusCode(response.status))

    // Dropbox returns the served file's metadata in a response header, not the body.
    const result = singleHeader(response.headers, 'dropbox-api-result')
    if (result === undefined) return yield* fail('invalid_metadata')
    const metadata = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(result).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
      Effect.mapError(() => new DropboxDownloadError({ code: 'invalid_metadata' }))
    )
    if (
      (requested.path.startsWith('id:') && metadata.id !== requested.path) ||
      (requested.path.startsWith('rev:') && metadata.rev !== requested.path.slice('rev:'.length))
    )
      return yield* fail('invalid_metadata')
    if (metadata.is_downloadable === false) return yield* fail('not_downloadable')
    if (metadata.size !== response.bytes.byteLength) return yield* fail('partial_content')

    return {
      bytes: response.bytes,
      byteLength: response.bytes.byteLength,
      source: DropboxDownloadSource.make({
        id: metadata.id,
        name: metadata.name,
        pathLower: metadata.path_lower ?? undefined,
        pathDisplay: metadata.path_display ?? undefined,
        rev: metadata.rev,
        size: metadata.size,
        clientModified: metadata.client_modified,
        serverModified: metadata.server_modified,
        contentHash: metadata.content_hash
      }),
      requested
    }
  })
