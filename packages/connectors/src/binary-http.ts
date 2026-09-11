import { Context } from 'effect'
import type { Effect } from 'effect'
import * as Schema from 'effect/Schema'

/** Host-only transport failure. Do not attach URLs, headers, bodies, or wrapped causes. */
export class ConnectorBinaryHttpError extends Schema.TaggedErrorClass<ConnectorBinaryHttpError>()(
  'ConnectorBinaryHttpError',
  { code: Schema.Literals(['transport_failed', 'response_too_large', 'network_policy_rejected']) }
) {}

/** Single-hop request; the host must never add ambient credentials or follow redirects. */
export interface ConnectorBinaryHttpRequest {
  readonly method: 'GET'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly redirect: 'manual'
  readonly credentials: 'omit'
  /** Maximum actual decoded response bytes for HTTP 200, enforced while streaming. */
  readonly maxBytes: number
  /** Separate actual-byte bound for every non-200 body, including redirects and errors. */
  readonly maxErrorBodyBytes: number
}

export interface ConnectorBinaryHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly bytes: Uint8Array
  /** False only for bounded non-200 bodies. A successful body must be complete. */
  readonly bodyComplete: boolean
}

export interface ConnectorBinaryHttpClientApi {
  /**
   * Hosts enforce connection-time public DNS/IP policy on EVERY hop, TLS verification,
   * timeouts, cancellation and streamed byte limits (including decompression). No automatic
   * redirects, cookie jar, ambient auth, or URL/header/body logging. Oversize HTTP 200 must
   * fail with response_too_large, never succeed with a truncated body. Non-200 bodies may
   * be truncated at their separate bound with bodyComplete=false. Always close/cancel I/O.
   */
  readonly request: (
    request: ConnectorBinaryHttpRequest
  ) => Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError>
}

/** Optional host port, independent of the existing complete-string ConnectorHttpClient. */
export class ConnectorBinaryHttpClient extends Context.Service<
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpClientApi
>()('@yolk-sdk/connectors/ConnectorBinaryHttpClient') {}
