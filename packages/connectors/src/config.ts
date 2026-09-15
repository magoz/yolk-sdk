import { Effect, Predicate } from 'effect'
import { ConnectorError } from './error.ts'
import type { ConnectorIntegration } from './integration.ts'

export const requiredStringConfig = (integration: ConnectorIntegration, key: string) => {
  const value: unknown = Object.getOwnPropertyDescriptor(integration.config, key)?.value

  if (Predicate.isString(value) && value.trim() !== '') {
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
  const value: unknown = Object.getOwnPropertyDescriptor(integration.config, key)?.value

  return Predicate.isString(value) && value.trim() !== '' ? value : undefined
}
