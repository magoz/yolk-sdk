import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorBinaryHttpClient } from './binary-http.ts'
import type { ConnectorBinaryHttpResponse } from './binary-http.ts'
import { ConnectorBinaryWriteHttpClient } from './binary-write-http.ts'
import type { ConnectorBinaryWriteHttpRequest } from './binary-write-http.ts'
import { ConnectorFileTransferError } from './file-transfer.ts'
import type { ConnectorFileTransferBudget } from './file-transfer.ts'
import type { ConnectorIntegration } from './integration.ts'

export const failTransfer = (code: ConnectorFileTransferError['code']) =>
  Effect.fail(new ConnectorFileTransferError({ code }))
export const isBytes = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
export const ByteLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
// Reject malformed UTF-16 before encodeURIComponent, dot normalization, control/header injection.
export const SafeText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(s => !/[\ud800-\udfff]/u.test(s) && !/[\u0000-\u001f\u007f]/.test(s))
)
export const OpaqueId = SafeText.check(Schema.isPattern(/^(?!\.+$)[^\s/\\?#]+$/))
export const Budget = Schema.Struct({
  maxBytes: ByteLimit,
  maxMetadataBytes: ByteLimit,
  maxErrorBodyBytes: ByteLimit
})
export const decodeInput = <A>(
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  input: unknown
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new ConnectorFileTransferError({ code: 'invalid_input' }))
  )
export const validateTransfer = (
  integration: ConnectorIntegration,
  connectorId: string,
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    if (integration.connectorId !== connectorId) return yield* failTransfer('invalid_input')
    return yield* decodeInput(Budget, budget)
  })
export const safeToken = (token: string) =>
  /^[\x21-\x7e]+$/.test(token) ? Effect.succeed(token) : failTransfer('credential_failed')
export const credentialFailure = () => new ConnectorFileTransferError({ code: 'credential_failed' })
export const singleHeader = (headers: Readonly<Record<string, string>>, name: string) => {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name)
  return entries.length === 1 ? entries[0]?.[1] : undefined
}
export const headerSafeJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
export const decodeMetadata = <A>(
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  bytes: Uint8Array
) =>
  Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: () => new ConnectorFileTransferError({ code: 'invalid_metadata' })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => new ConnectorFileTransferError({ code: 'invalid_metadata' }))
  )
export const checkResponse = (
  r: ConnectorBinaryHttpResponse,
  maxBytes: number,
  maxErrorBodyBytes: number,
  writing = false
) =>
  Effect.gen(function* () {
    const success = r.status === 200 || (writing && r.status === 201)
    if (!isBytes(r.bytes) || r.bytes.byteLength > (success ? maxBytes : maxErrorBodyBytes))
      return yield* failTransfer('response_too_large')
    if (success) {
      if (!r.bodyComplete || Object.keys(r.headers).some(k => k.toLowerCase() === 'content-range'))
        return yield* failTransfer('partial_content')
      return r
    }
    if (r.status >= 300 && r.status < 400) return yield* failTransfer('unexpected_redirect')
    switch (r.status) {
      case 401:
        return yield* failTransfer('unauthorized')
      case 403:
        return yield* failTransfer('forbidden')
      case 404:
        return yield* failTransfer('not_found')
      case 409:
      case 412:
        return yield* failTransfer('conflict')
      case 413:
        return yield* failTransfer('response_too_large')
      case 429:
        return yield* failTransfer('rate_limited')
      case 206:
        return yield* failTransfer('partial_content')
      default:
        return yield* failTransfer('upstream_failed')
    }
  })
export const readBytes = (
  url: string,
  headers: Readonly<Record<string, string>>,
  budget: ConnectorFileTransferBudget,
  metadata = false
) =>
  Effect.gen(function* () {
    const http = yield* ConnectorBinaryHttpClient
    const maxBytes = metadata ? budget.maxMetadataBytes : budget.maxBytes
    const response = yield* http
      .request({
        method: 'GET',
        url,
        headers,
        redirect: 'manual',
        credentials: 'omit',
        maxBytes,
        maxErrorBodyBytes: budget.maxErrorBodyBytes
      })
      .pipe(Effect.mapError(e => new ConnectorFileTransferError({ code: e.code })))
    return yield* checkResponse(response, maxBytes, budget.maxErrorBodyBytes)
  })
export const writeBytes = (request: ConnectorBinaryWriteHttpRequest) =>
  Effect.gen(function* () {
    const http = yield* ConnectorBinaryWriteHttpClient
    const response = yield* http
      .request(request)
      .pipe(Effect.mapError(e => new ConnectorFileTransferError({ code: e.code })))
    return yield* checkResponse(response, request.maxBytes, request.maxErrorBodyBytes, true)
  })
export const validateUpload = (
  bytes: Uint8Array,
  budget: ConnectorFileTransferBudget,
  providerLimit: number
) => {
  if (!isBytes(bytes)) return failTransfer('invalid_input')
  if (bytes.byteLength > providerLimit) return failTransfer('upload_session_required')
  if (bytes.byteLength > budget.maxBytes) return failTransfer('response_too_large')
  return Effect.void
}
export const fileBytes = (bytes: Uint8Array) => ({ bytes, byteLength: bytes.byteLength })

/** Syntax screen only. Hosts MUST enforce connection-time DNS/IP policy. No redirects. */
export const safeHttpsUrl = (raw: string) =>
  Effect.try({
    try: () => new URL(raw),
    catch: () => new ConnectorFileTransferError({ code: 'network_policy_rejected' })
  }).pipe(
    Effect.flatMap(url => {
      const h = url.hostname.toLowerCase()
      if (
        typeof raw !== 'string' ||
        !/^https:\/\/[a-zA-Z0-9]/.test(raw) ||
        /%(?![0-9a-f]{2})/i.test(raw) ||
        raw.includes('#') ||
        /[\ud800-\udfff]/u.test(raw) ||
        /[\s\\\u0000-\u001f\u007f]/.test(raw) ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== '443') ||
        !h.includes('.') ||
        !h.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|onion)$/.test(h) ||
        /^[\d.]+$/.test(h) ||
        h.includes(':') ||
        h.endsWith('.')
      )
        return failTransfer('network_policy_rejected')
      return Effect.succeed(url)
    })
  )
