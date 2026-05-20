import { Effect, Option } from 'effect'
import type { ConnectorAction } from './action.ts'
import { ConnectorError } from './error.ts'
import type { ActionResult } from './result.ts'
import type { ConnectorIntegration } from './integration.ts'

export type ConnectorInvokeInput = {
  readonly integration: ConnectorIntegration
  readonly action: string
  readonly input: unknown
}

export type Connector<Env = never, Error = never> = {
  readonly id: string
  readonly description?: string
  readonly actions: ReadonlyArray<ConnectorAction<Env, Error>>
  readonly invoke: (
    input: ConnectorInvokeInput
  ) => Effect.Effect<ActionResult<unknown>, Error | ConnectorError, Env>
}

export type DefineConnectorOptions<Env, Error> = {
  readonly id: string
  readonly description?: string
  readonly actions: ReadonlyArray<ConnectorAction<Env, Error>>
}

const connectorMismatchError = (connectorId: string, integration: ConnectorIntegration) =>
  new ConnectorError({
    cause: 'connector_mismatch',
    message: `Integration belongs to ${integration.connectorId}, not ${connectorId}`,
    connectorId
  })

const missingActionError = (connectorId: string, actionId: string) =>
  new ConnectorError({
    cause: 'action_not_found',
    message: `Connector action is not configured: ${actionId}`,
    connectorId,
    actionId
  })

export const defineConnector = <Env = never, Error = never>(
  options: DefineConnectorOptions<Env, Error>
): Connector<Env, Error> => ({
  id: options.id,
  description: options.description,
  actions: options.actions,
  invoke: input => {
    if (input.integration.connectorId !== options.id) {
      return Effect.fail(connectorMismatchError(options.id, input.integration))
    }

    const action = Option.fromNullishOr(options.actions.find(item => item.id === input.action))

    if (Option.isNone(action)) {
      return Effect.fail(missingActionError(options.id, input.action))
    }

    return action.value.execute({ integration: input.integration, input: input.input })
  }
})
