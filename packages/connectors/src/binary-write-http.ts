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

/**
 * One request to a provider-issued, pre-authenticated upload-session URL. The URL itself is a
 * bearer capability (for Outlook it embeds an auth token): it carries no Authorization header,
 * and it must never be logged, traced, persisted, or included in errors.
 */
export interface ConnectorBinaryUploadSessionRequest {
  /** PUT uploads one byte range; DELETE cancels the session with an empty body. */
  readonly method: 'PUT' | 'DELETE'
  readonly url: string
  /** Never contains Authorization; PUT sends Content-Range and Content-Type. */
  readonly headers: Readonly<Record<string, string>>
  readonly bytes: Uint8Array
  readonly redirect: 'manual'
  readonly credentials: 'omit'
  readonly maxUploadBytes: number
  /** PUT succeeds with 200 (more ranges expected) or 201 (complete); DELETE with 204. */
  readonly successStatuses: readonly [200, 201] | readonly [204]
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
  /**
   * Optional upload-session capability. Helpers that need it fail with
   * `upload_session_required` before any network request when a host omits it (or omits this
   * whole port). Only the pre-authenticated session requests use it: `addOutlookAttachment` sends
   * its authenticated Graph JSON POSTs (`fileAttachment`, `createUploadSession`) through the
   * regular `ConnectorHttpClient`, never through `request`.
   *
   * Hosts must: allowlist the exact origin and path shape before connecting (Outlook:
   * `https://outlook.office.com/api/{v1.0,v2.0,gv1.0,beta}/.../AttachmentSessions(...)` only); send the URL
   * unchanged; add no Authorization, cookies or ambient credentials; never log, trace or
   * persist the URL (including query strings) or bodies; follow no redirects; never retry;
   * enforce the same TLS, DNS/socket, timeout, cancellation and streamed byte limits as
   * `request`; and return response headers, including `Location` on a final 201.
   */
  readonly uploadSession?: (
    request: ConnectorBinaryUploadSessionRequest
  ) => Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError>
}

export class ConnectorBinaryWriteHttpClient extends Context.Service<
  ConnectorBinaryWriteHttpClient,
  ConnectorBinaryWriteHttpClientApi
>()('@yolk-sdk/connectors/ConnectorBinaryWriteHttpClient') {}
