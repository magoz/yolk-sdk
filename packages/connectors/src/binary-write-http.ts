import { Context } from 'effect'
import type { Effect } from 'effect'
import type { ConnectorBinaryHttpError, ConnectorBinaryHttpResponse } from './binary-http.ts'

/** Separate optional port: existing GET-only adapters remain source compatible. */
export interface ConnectorBinaryWriteHttpRequest {
  readonly method: 'POST' | 'PUT'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly bytes: Uint8Array
  readonly redirect: 'manual'
  readonly credentials: 'omit'
  readonly maxUploadBytes: number
  /** Successful metadata responses are HTTP 200 or 201 only. */
  readonly successStatuses: readonly [200, 201]
  readonly maxBytes: number
  readonly maxErrorBodyBytes: number
}

export interface ConnectorBinaryWriteHttpClientApi {
  /**
   * Enforce upload and streamed response/error/header limits, TLS, public DNS/socket policy,
   * cancellation and no ambient credentials, logging or redirects, like the read port.
   * Return complete 200/201 bodies or fail. Never retry writes automatically: a transport
   * failure may mean bytes committed. Hosts reconcile ambiguous outcomes out of band.
   */
  readonly request: (
    request: ConnectorBinaryWriteHttpRequest
  ) => Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError>
}

export class ConnectorBinaryWriteHttpClient extends Context.Service<
  ConnectorBinaryWriteHttpClient,
  ConnectorBinaryWriteHttpClientApi
>()('@yolk-sdk/connectors/ConnectorBinaryWriteHttpClient') {}
