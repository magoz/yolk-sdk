import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorBinaryHttpClient } from '../binary-http.ts'
import type { ConnectorBinaryHttpResponse } from '../binary-http.ts'
import type { CredentialResolver } from '../credential.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { oneDriveReadSlot } from './drive.ts'
import { microsoftAuthorizationHeaders, microsoftConnectorId } from './oauth.ts'
import { microsoftGraphApiBaseUrl, resolveMicrosoftAccessToken } from './shared.ts'

export const OneDriveDownloadErrorCode = Schema.Literals([
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
  'remote_item_unresolved',
  'remote_item_limit',
  'invalid_redirect',
  'redirect_limit',
  'partial_content'
])
export type OneDriveDownloadErrorCode = typeof OneDriveDownloadErrorCode.Type

/** Safe boundary: deliberately contains no upstream message, URL, headers, body or cause. */
export class OneDriveDownloadError extends Schema.TaggedErrorClass<OneDriveDownloadError>()(
  'OneDriveDownloadError',
  { code: OneDriveDownloadErrorCode }
) {}

/** IDs from discovery, not browser URLs, paths, or preauthenticated download URLs. */
export interface OneDriveDownloadInput {
  readonly itemId: string
  readonly driveId?: string | undefined
}

/** Trusted host configuration, NEVER model/tool parameters. All limits are actual bytes. */
export interface OneDriveDownloadBudget {
  readonly maxBytes: number
  readonly maxMetadataBytes: number
  readonly maxErrorBodyBytes: number
}

export class OneDriveDownloadSource extends Schema.Class<OneDriveDownloadSource>(
  'OneDriveDownloadSource'
)({
  itemId: Schema.String,
  driveId: Schema.optional(Schema.String),
  name: Schema.String,
  mimeType: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  eTag: Schema.optional(Schema.String),
  cTag: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String)
}) {}

/** Host-only result, not an action output schema or model content. Bytes are never decoded. */
export interface OneDriveDownloadResult {
  readonly bytes: Uint8Array
  readonly byteLength: number
  /** Resolved target metadata observed BEFORE download; not a verified byte snapshot. */
  readonly source: OneDriveDownloadSource
  readonly requested: OneDriveDownloadInput
}

const fail = (code: OneDriveDownloadErrorCode) => Effect.fail(new OneDriveDownloadError({ code }))

// URL parsers normalize even percent-encoded dot segments. Reject rather than change identity.
const OpaqueId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^(?!\.+$)[^\u0000-\u0020\u007f]+$/)
)
const Input = Schema.Struct({ itemId: OpaqueId, driveId: Schema.optional(OpaqueId) })
const ByteLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
const Budget = Schema.Struct({
  maxBytes: ByteLimit,
  maxMetadataBytes: ByteLimit,
  maxErrorBodyBytes: ByteLimit
})
const RemoteItem = Schema.Struct({
  id: Schema.optional(OpaqueId),
  parentReference: Schema.optional(Schema.Struct({ driveId: Schema.optional(OpaqueId) }))
})
const Metadata = Schema.Struct({
  id: OpaqueId,
  name: Schema.String,
  size: Schema.optional(ByteLimit),
  webUrl: Schema.optional(Schema.String),
  eTag: Schema.optional(Schema.String),
  cTag: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String),
  parentReference: Schema.optional(Schema.Struct({ driveId: Schema.optional(OpaqueId) })),
  file: Schema.optional(Schema.Struct({ mimeType: Schema.optional(Schema.String) })),
  folder: Schema.optional(Schema.Unknown),
  deleted: Schema.optional(Schema.Unknown),
  remoteItem: Schema.optional(RemoteItem)
})
const metadataSelect = [
  'id',
  'name',
  'size',
  'webUrl',
  'eTag',
  'cTag',
  'createdDateTime',
  'lastModifiedDateTime',
  'parentReference',
  'file',
  'folder',
  'deleted',
  'remoteItem'
].join(',')
const maxRemoteItems = 4
const maxRedirects = 5

const itemUrl = (input: OneDriveDownloadInput) =>
  Effect.try({
    try: () => {
      const root =
        input.driveId === undefined ? '/me/drive' : `/drives/${encodeURIComponent(input.driveId)}`
      return `${microsoftGraphApiBaseUrl}${root}/items/${encodeURIComponent(input.itemId)}`
    },
    catch: () => new OneDriveDownloadError({ code: 'invalid_input' })
  })

// Conservative syntax screen, NOT DNS/network enforcement. Hosts must validate socket addresses.
const publicHttpsUrl = (value: string) => {
  if (
    !/^https:\/\//i.test(value) ||
    /[\s\\\u0000-\u001f\u007f]/.test(value) ||
    /%(?![\da-f]{2})/i.test(value) ||
    value.includes('#')
  )
    return undefined
  const authority = value.slice('https://'.length).split(/[/?]/, 1)[0]
  if (!authority || authority.includes('@') || authority.endsWith(':')) return undefined
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    host.includes(':') ||
    /^[\d.]+$/.test(host) ||
    !host.includes('.') ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)
  )
    return undefined
  return url
}

const locationHeader = (headers: Readonly<Record<string, string>>) => {
  const matches = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'location')
  return matches.length === 1 ? matches[0]?.[1] : undefined
}

const statusCode = (status: number): OneDriveDownloadErrorCode => {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 429:
      return 'rate_limited'
    case 413:
      return 'response_too_large'
    case 206:
      return 'partial_content'
    default:
      return 'upstream_failed'
  }
}

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
 * Download original file bytes using the current microsoft.oauth binding. Not registered in
 * MicrosoftConnector: a host must materialize and read the result with its own file pipeline.
 * Metadata redirects are rejected; all content redirects are unauthenticated, even back to Graph.
 */
export const downloadOneDriveItem = (
  integration: ConnectorIntegration,
  input: OneDriveDownloadInput,
  budget: OneDriveDownloadBudget
): Effect.Effect<
  OneDriveDownloadResult,
  OneDriveDownloadError,
  ConnectorBinaryHttpClient | CredentialResolver
> =>
  Effect.gen(function* () {
    const requested = yield* Schema.decodeUnknownEffect(Input)(input).pipe(
      Effect.mapError(() => new OneDriveDownloadError({ code: 'invalid_input' }))
    )
    const limits = yield* Schema.decodeUnknownEffect(Budget)(budget).pipe(
      Effect.mapError(() => new OneDriveDownloadError({ code: 'invalid_input' }))
    )
    if (integration.connectorId !== microsoftConnectorId) return yield* fail('invalid_input')
    const slot = yield* oneDriveReadSlot(integration, requested.driveId).pipe(
      Effect.mapError(() => new OneDriveDownloadError({ code: 'invalid_input' }))
    )
    const token = yield* resolveMicrosoftAccessToken(integration, slot).pipe(
      Effect.mapError(() => new OneDriveDownloadError({ code: 'credential_failed' }))
    )
    const http = yield* ConnectorBinaryHttpClient
    const request = (url: string, headers: Readonly<Record<string, string>>, maxBytes: number) =>
      http
        .request({
          method: 'GET',
          url,
          headers,
          maxBytes,
          maxErrorBodyBytes: limits.maxErrorBodyBytes,
          redirect: 'manual',
          credentials: 'omit'
        })
        .pipe(
          Effect.mapError(
            error =>
              new OneDriveDownloadError({
                code:
                  error.code === 'response_too_large'
                    ? 'response_too_large'
                    : error.code === 'network_policy_rejected'
                      ? 'network_policy_rejected'
                      : 'transport_failed'
              })
          ),
          Effect.tap(response => checkBody(response, maxBytes, limits.maxErrorBodyBytes))
        )

    let target: OneDriveDownloadInput = requested
    const visited = new Set<string>()
    let remoteCount = 0
    while (true) {
      const url = yield* itemUrl(target)
      if (visited.has(url)) return yield* fail('remote_item_limit')
      visited.add(url)
      const response = yield* request(
        `${url}?${new URLSearchParams({ $select: metadataSelect })}`,
        { ...microsoftAuthorizationHeaders(token), accept: 'application/json' },
        limits.maxMetadataBytes
      )
      if (response.status !== 200) return yield* fail(statusCode(response.status))
      // This decoder is ONLY for the bounded Graph metadata response, never /content bytes.
      const metadata = yield* Effect.try({
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
        catch: () => new OneDriveDownloadError({ code: 'invalid_metadata' })
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
        Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
        Effect.mapError(() => new OneDriveDownloadError({ code: 'invalid_metadata' }))
      )
      if (
        metadata.id !== target.itemId ||
        (target.driveId !== undefined &&
          metadata.parentReference?.driveId !== undefined &&
          target.driveId !== metadata.parentReference.driveId)
      )
        return yield* fail('invalid_metadata')
      if (metadata.deleted !== undefined) return yield* fail('not_a_file')
      if (metadata.remoteItem !== undefined) {
        const itemId = metadata.remoteItem.id
        const driveId = metadata.remoteItem.parentReference?.driveId
        if (itemId === undefined || driveId === undefined)
          return yield* fail('remote_item_unresolved')
        if (remoteCount >= maxRemoteItems) return yield* fail('remote_item_limit')
        remoteCount++
        target = { itemId, driveId }
        continue
      }
      if (metadata.folder !== undefined || metadata.file === undefined)
        return yield* fail('not_a_file')
      if (metadata.size !== undefined && metadata.size > limits.maxBytes)
        return yield* fail('response_too_large')
      const source = OneDriveDownloadSource.make({
        itemId: metadata.id,
        driveId: metadata.parentReference?.driveId ?? target.driveId,
        name: metadata.name,
        mimeType: metadata.file.mimeType,
        webUrl:
          metadata.webUrl !== undefined && publicHttpsUrl(metadata.webUrl) !== undefined
            ? metadata.webUrl
            : undefined,
        size: metadata.size,
        eTag: metadata.eTag,
        cTag: metadata.cTag,
        createdDateTime: metadata.createdDateTime,
        lastModifiedDateTime: metadata.lastModifiedDateTime
      })
      // Use resolved metadata drive identity when available, including /me discovery.
      let contentUrl = `${yield* itemUrl({ itemId: source.itemId, driveId: source.driveId })}/content`
      let headers: Readonly<Record<string, string>> = microsoftAuthorizationHeaders(token)
      let redirects = 0
      while (true) {
        const content = yield* request(contentUrl, headers, limits.maxBytes)
        if (content.status === 200)
          return {
            bytes: content.bytes,
            byteLength: content.bytes.byteLength,
            source,
            requested
          }
        if (![301, 302, 303, 307, 308].includes(content.status))
          return yield* fail(statusCode(content.status))
        if (redirects >= maxRedirects) return yield* fail('redirect_limit')
        const location = locationHeader(content.headers)
        if (location === undefined || publicHttpsUrl(location) === undefined)
          return yield* fail('invalid_redirect')
        contentUrl = location
        headers = {} // Never restore ANY original headers, even when redirecting back to Graph.
        redirects++
      }
    }
  })
