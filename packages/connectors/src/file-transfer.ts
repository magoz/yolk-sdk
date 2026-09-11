import * as Schema from 'effect/Schema'

/** Code-only host boundary. Never attach provider bodies, URLs, credentials or causes. */
export class ConnectorFileTransferError extends Schema.TaggedErrorClass<ConnectorFileTransferError>()(
  'ConnectorFileTransferError',
  {
    code: Schema.Literals([
      'invalid_input',
      'credential_failed',
      'transport_failed',
      'network_policy_rejected',
      'response_too_large',
      'upload_session_required',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'upstream_failed',
      'invalid_metadata',
      'not_downloadable',
      'unexpected_redirect',
      'partial_content'
    ])
  }
) {}

/** Trusted host limits, never model parameters. Actual bytes, including decoded HTTP bodies. */
export interface ConnectorFileTransferBudget {
  readonly maxBytes: number
  readonly maxMetadataBytes: number
  readonly maxErrorBodyBytes: number
}

export interface ConnectorFileBytes {
  readonly bytes: Uint8Array
  readonly byteLength: number
}
