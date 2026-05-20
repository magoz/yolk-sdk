import { Effect } from 'effect'
import { ConnectorError } from './error.ts'
import type { ConnectorIntegration } from './integration.ts'

const configValue = (integration: ConnectorIntegration, key: string) =>
  Object.getOwnPropertyDescriptor(integration.config, key)?.value

export const requiredStringConfig = (integration: ConnectorIntegration, key: string) => {
  const value = configValue(integration, key)

  if (typeof value === 'string' && value.trim() !== '') {
    return Effect.succeed(value)
  }

  return Effect.fail(
    new ConnectorError({
      cause: 'validation_failed',
      message: `Missing integration config: ${key}`,
      connectorId: integration.connectorId
    })
  )
}

export const optionalStringConfig = (integration: ConnectorIntegration, key: string) => {
  const value = configValue(integration, key)

  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
