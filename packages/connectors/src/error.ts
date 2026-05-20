import * as Schema from 'effect/Schema'

export const ConnectorErrorCause = Schema.Literals([
  'action_not_found',
  'connector_mismatch',
  'credential_binding_missing',
  'credential_invalid',
  'credential_missing',
  'validation_failed'
])
export type ConnectorErrorCause = typeof ConnectorErrorCause.Type

export class ConnectorError extends Schema.TaggedErrorClass<ConnectorError>()('ConnectorError', {
  cause: ConnectorErrorCause,
  message: Schema.String,
  connectorId: Schema.optional(Schema.String),
  actionId: Schema.optional(Schema.String),
  slotId: Schema.optional(Schema.String),
  underlying: Schema.optional(Schema.Unknown)
}) {}
