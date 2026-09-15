import * as Schema from 'effect/Schema'
import { CredentialBinding } from './credential.ts'
import { PortableMetadata } from './portable-metadata.ts'

export const IntegrationConfig = Schema.Record(Schema.String, Schema.Unknown)

export type IntegrationConfig = typeof IntegrationConfig.Type

export class ConnectorIntegration extends Schema.Class<ConnectorIntegration>(
  'ConnectorIntegration'
)({
  id: Schema.optional(Schema.String),
  connectorId: Schema.String,
  config: IntegrationConfig,
  credentialBindings: Schema.Array(CredentialBinding),
  metadata: Schema.optionalKey(PortableMetadata)
}) {}

export const makeIntegration = (input: {
  readonly id?: string
  readonly connectorId: string
  readonly config?: IntegrationConfig
  readonly credentialBindings?: ReadonlyArray<CredentialBinding>
  readonly metadata?: PortableMetadata
}) => {
  const fields = {
    id: input.id,
    connectorId: input.connectorId,
    config: input.config ?? {},
    credentialBindings: input.credentialBindings ?? []
  }

  if (input.metadata === undefined) return ConnectorIntegration.make(fields)

  return ConnectorIntegration.make({ ...fields, metadata: input.metadata })
}
